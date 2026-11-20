from __future__ import annotations

import json
import pytest
from fastapi.testclient import TestClient

from apps.api.app import codex_runtime, db, main
from apps.api.app.db import connect, json_dump, utc_now


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "plan-references.db")
    with TestClient(main.app) as session:
        with connect() as connection:
            for version in (1, 2):
                snapshot = {"conditions": [{"description": f"固定条件 v{version}"}], "scope": {"as_of": "2026-11-16"}}
                connection.execute("INSERT INTO saved_screening_tasks(id,name,version,task_json,created_at) VALUES(?,?,?,?,?)", ("plan", "立刻开始筛选", version, json_dump(snapshot), utc_now()))
            connection.execute("INSERT INTO filters(id,library,name,version,dsl_json,created_at) VALUES(?,?,?,?,?,?)", ("condition", "technical", "均线条件", 1, json_dump({"expression": {"op": "above_sma", "window": 20}}), utc_now()))
            strategy = {"name": "量价组合", "top_n": 30, "tree": {"op": "filter_ref", "filter_id": "condition", "version": 1}}
            connection.execute("INSERT INTO strategies(id,name,version,strategy_json,created_at) VALUES(?,?,?,?,?)", ("strategy", "量价组合", 3, json_dump(strategy), utc_now()))
        yield session


def conversation(client):
    response = client.post("/api/v1/conversations", json={"entry_scope": "screening", "workflow_type": "screening"})
    assert response.status_code == 200
    return response.json()["id"]


@pytest.mark.parametrize("kind,asset_id,version", [("saved_screening_task", "plan", 1), ("screening_strategy", "strategy", 3)])
def test_plan_reference_freezes_exact_version_and_only_becomes_turn_context_when_submitted(client, kind, asset_id, version):
    owner = conversation(client)
    for url in ("/api/v1/saved-screening-tasks?include_history=true", "/api/v1/strategies?include_history=true"):
        assert client.get(url).status_code == 200
    assert client.get(f"/api/v1/conversations/{owner}").json()["messages"] == []
    body = {"client_message_id": "execute-plan", "base_revision": 0, "content": "请执行选股，采用引用的固定版本方案。", "source_refs": [{"kind": kind, "source_id": asset_id, "version": version}]}
    response = client.post(f"/api/v1/conversations/{owner}/messages", json=body)
    assert response.status_code == 202, response.text
    frozen = response.json()["source_refs"][0]
    assert frozen["version"] == version
    assert len(frozen["source_sha256"]) == 64
    if kind == "saved_screening_task":
        assert frozen["snapshot"]["conditions"][0]["description"] == "固定条件 v1"
    else:
        assert frozen["assets"][0]["version"] == 1
        assert frozen["assets"][0]["snapshot"]["expression"]["window"] == 20
    restored = client.get(f"/api/v1/conversations/{owner}").json()
    assert restored["task_revision"] == 0 and restored["pending_execution"] is False
    assert restored["active_run_id"] is None
    prompt = json.loads(codex_runtime._prompt(owner, response.json()["turn_id"]))
    assert prompt["source_references"] == [frozen]
    assert "version-pinned" in prompt["screening_plan_policy"]
    with connect() as connection:
        if kind == "saved_screening_task":
            connection.execute("UPDATE saved_screening_tasks SET task_json='{}' WHERE id=? AND version=?", (asset_id, version))
        else:
            connection.execute("UPDATE filters SET dsl_json='{}' WHERE id='condition' AND version=1")
    assert client.get(f"/api/v1/conversations/{owner}").json()['messages'][0]['source_refs'] == [frozen]
    assert client.post(f"/api/v1/conversations/{owner}/messages", json=body).json()["idempotent_replay"] is True


def test_changed_plan_version_is_not_a_message_retry(client):
    owner = conversation(client)
    body = {"client_message_id": "same-message", "base_revision": 0, "content": "执行引用方案", "source_refs": [{"kind": "saved_screening_task", "source_id": "plan", "version": 1}]}
    assert client.post(f"/api/v1/conversations/{owner}/messages", json=body).status_code == 202
    body["source_refs"][0]["version"] = 2
    assert client.post(f"/api/v1/conversations/{owner}/messages", json=body).status_code == 409


@pytest.mark.parametrize("reference", [
    {"kind": "saved_screening_task", "source_id": "plan"},
    {"kind": "screening_strategy", "source_id": "strategy", "version": 0},
    {"kind": "saved_screening_task", "source_id": "missing", "version": 1},
    {"kind": "screening_strategy", "source_id": "strategy", "version": 3, "page_number": 1},
])
def test_invalid_or_missing_plan_cannot_create_a_turn(client, reference):
    owner = conversation(client)
    response = client.post(f"/api/v1/conversations/{owner}/messages", json={"client_message_id": "bad", "base_revision": 0, "content": "执行方案", "source_refs": [reference]})
    assert response.status_code == 422
    assert client.get(f"/api/v1/conversations/{owner}").json()["messages"] == []


def test_a_missing_condition_version_blocks_the_entire_strategy_reference(client):
    owner = conversation(client)
    with connect() as connection:
        connection.execute("DELETE FROM filters WHERE id='condition'")
    response = client.post(f"/api/v1/conversations/{owner}/messages", json={"client_message_id": "broken", "base_revision": 0, "content": "执行方案", "source_refs": [{"kind": "screening_strategy", "source_id": "strategy", "version": 3}]})
    assert response.status_code == 422
    assert client.get(f"/api/v1/conversations/{owner}").json()["messages"] == []


def test_execute_button_intent_is_frozen_and_question_wording_does_not_erase_it(client):
    from apps.api.app.execution_policy import message_requests_execution, requests_execution
    owner = conversation(client)
    body = {"client_message_id": "button", "base_revision": 0, "content": "请执行选股，核对订单是否增长。", "execute_plan": True, "source_refs": [{"kind": "saved_screening_task", "source_id": "plan", "version": 1}]}
    response = client.post(f"/api/v1/conversations/{owner}/messages", json=body)
    assert response.status_code == 202, response.text
    stored = client.get(f"/api/v1/conversations/{owner}").json()['messages'][0]
    assert stored['source_refs'][0]['execution_requested'] is True
    assert requests_execution(stored['content']) is False
    assert message_requests_execution(stored) is True
    assert message_requests_execution({**stored, 'content': '不要执行，先核对是否增长'}) is False
    assert client.post(f"/api/v1/conversations/{owner}/messages", json=body).status_code == 200
    assert client.post(f"/api/v1/conversations/{owner}/messages", json={**body, 'execute_plan': False}).status_code == 409


@pytest.mark.parametrize('workflow,source_refs', [('research', [{'kind': 'saved_screening_task', 'source_id': 'plan', 'version': 1}]), ('screening', [])])
def test_execute_plan_button_requires_one_plan_and_screening_workflow(client, workflow, source_refs):
    owner = client.post('/api/v1/conversations', json={'entry_scope': 'screening', 'workflow_type': workflow}).json()['id']
    response = client.post(f'/api/v1/conversations/{owner}/messages', json={'client_message_id': 'button', 'base_revision': 0, 'content': '执行方案', 'execute_plan': True, 'source_refs': source_refs})
    assert response.status_code == 422
    assert client.get(f'/api/v1/conversations/{owner}').json()['messages'] == []
