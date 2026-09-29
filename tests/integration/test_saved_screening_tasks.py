from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from apps.api.app import db, main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "saved-tasks.db")
    with TestClient(main.app) as session:
        yield session


def _task(conversation_id: str):
    prompt = "收盘价高于自定义趋势线且研报支持订单增长"
    program = {
        "contract_version": "python-screen-v1",
        "source_code": "def screen(context, frames, params):\n    return {}\n",
        "required_fields": ["close"], "required_history_bars": 2,
        "parameters": {"limit": 1},
        "parameter_specs": {"limit": {"label": "下限", "type": "integer", "minimum": 1, "maximum": 10}},
    }
    return {
        "task_id": conversation_id, "revision": 1, "original_user_messages": [prompt],
        "conditions": [
            {"condition_id": "technical", "library": "technical", "source_quote": "收盘价高于自定义趋势线",
             "description": "自定义趋势线", "expression": {}, "program": program,
             "implementation_id": "llm-python-screen", "implementation_version": "python-screen-v1"},
            {"condition_id": "report", "library": "report", "source_quote": "研报支持订单增长",
             "description": "研报支持订单增长", "expression": {"question": "研报支持订单增长", "fact_requirement": "actual", "quantifier": "exists", "source_ids": None},
             "implementation_id": "report-evidence-v1", "implementation_version": "1"},
        ],
        "references": [{"reference_id": "technical-ref", "condition_id": "technical"},
                        {"reference_id": "report-ref", "condition_id": "report"}],
        "logic_tree": {"op": "all", "children": [{"op": "condition", "reference_id": "technical-ref"}, {"op": "condition", "reference_id": "report-ref"}]},
        "scope": {"universe": {"kind": "explicit", "stock_codes": ["600000.SH"]}, "as_of": "2026-09-14",
                  "report_lookback_calendar_days": 30, "news_lookback_calendar_days": None,
                  "price_basis": None, "ranking": None},
        "unresolved": [],
    }


def _conversation(client):
    conversation = client.post("/api/v1/conversations", json={"entry_scope": "screening"}).json()
    message = client.post(f"/api/v1/conversations/{conversation['id']}/messages", json={
        "client_message_id": "save-task-message", "base_revision": 0,
        "content": "收盘价高于自定义趋势线且研报支持订单增长",
    }).json()
    response = client.post(f"/api/v1/conversations/{conversation['id']}/revisions", json={
        "base_revision": 0, "source_message_id": message["message_id"], "task": _task(conversation["id"]),
    })
    assert response.status_code == 201, response.text
    from apps.api.app import conversation_store
    conversation_store.finish_turn(conversation["id"], message["turn_id"], 1, "succeeded", "条件已确认", {
        "intent": "edit", "task_revision": 1, "execution_authorized": False, "ready_to_execute": False,
    })
    return conversation["id"], message["message_id"]


def test_save_is_separate_from_execution_and_replays_identically(client):
    conversation_id, message_id = _conversation(client)
    saved = client.post(f"/api/v1/conversations/{conversation_id}/saved-screening-tasks", json={
        "name": "趋势与研报订单", "request_id": "save-1", "revision": 1,
    })
    assert saved.status_code == 201, saved.text
    payload = saved.json()
    assert payload["version"] == 1
    assert client.get(f"/api/v1/conversations/{conversation_id}/screening-runs").json()["items"] == []
    replay = client.post(f"/api/v1/conversations/{conversation_id}/saved-screening-tasks", json={
        "name": "趋势与研报订单", "request_id": "save-2", "revision": 1, "asset_id": payload["id"],
    })
    assert replay.status_code == 201 and replay.json()["idempotent_replay"] is True
    assert replay.json()["version"] == 1
    listed = client.get("/api/v1/saved-screening-tasks").json()
    assert len(listed["items"]) == 1 and listed["items"][0]["task"]["logic_tree"]["op"] == "all"


def test_lost_save_response_replays_without_an_asset_id_and_rejects_changed_request(client):
    conversation_id, _ = _conversation(client)
    url = f"/api/v1/conversations/{conversation_id}/saved-screening-tasks"
    payload = {"name": "稳定保存", "request_id": "lost-response", "revision": 1}
    first = client.post(url, json=payload)
    replay = client.post(url, json=payload)
    assert first.status_code == replay.status_code == 201
    assert replay.json()["id"] == first.json()["id"]
    assert replay.json()["idempotent_replay"] is True
    changed = client.post(url, json={**payload, "name": "不同内容"})
    assert changed.status_code == 409
    assert len(client.get("/api/v1/saved-screening-tasks").json()["items"]) == 1


def test_reuse_creates_new_conversation_revision_without_mutating_saved_asset(client):
    conversation_id, _message_id = _conversation(client)
    saved = client.post(f"/api/v1/conversations/{conversation_id}/saved-screening-tasks", json={
        "name": "可复用跨库任务", "request_id": "save-reuse", "revision": 1,
    }).json()
    new_message_response = client.post(f"/api/v1/conversations/{conversation_id}/messages", json={
        "client_message_id": "reuse-message", "base_revision": 1, "content": "复用这个条件",
    })
    assert new_message_response.status_code == 202, new_message_response.text
    new_message = new_message_response.json()
    reused = client.post(f"/api/v1/conversations/{conversation_id}/saved-screening-tasks/{saved['id']}/reuse", json={
        "base_revision": 1, "source_message_id": new_message["message_id"], "version": 1,
    })
    assert reused.status_code == 201, reused.text
    assert reused.json()["revision"] == 2
    current = client.get(f"/api/v1/conversations/{conversation_id}/revisions/2").json()
    original = client.get(f"/api/v1/saved-screening-tasks/{saved['id']}?version=1").json()
    assert current["task_id"] == conversation_id
    assert current["revision"] == 2
    assert current["logic_tree"] == original["task"]["logic_tree"]
    assert current["conditions"][0]["program"]["source_code"] == original["task"]["conditions"][0]["program"]["source_code"]
    assert original["task"]["revision"] == 1

    # Reuse finishes the message turn, so the user can immediately continue.
    resumed = client.get(f"/api/v1/conversations/{conversation_id}").json()
    assert resumed["turns"][0]["state"] == "succeeded"
    assert resumed["turns"][0]["result"]["execution_authorized"] is False
    assert resumed["pending_execution"] is False
    assert client.get(f"/api/v1/conversations/{conversation_id}/screening-runs").json()["items"] == []
    replay = client.post(f"/api/v1/conversations/{conversation_id}/saved-screening-tasks/{saved['id']}/reuse", json={
        "base_revision": 1, "source_message_id": new_message["message_id"], "version": 1,
    })
    assert replay.status_code == 201 and replay.json()["idempotent_replay"] is True
    after_replay = client.get(f"/api/v1/conversations/{conversation_id}").json()
    assert len(after_replay["messages"]) == len(resumed["messages"])
    followup = client.post(f"/api/v1/conversations/{conversation_id}/messages", json={
        "client_message_id": "after-reuse", "base_revision": 2, "content": "把截止日改为2026-09-28",
    })
    assert followup.status_code == 202, followup.text


def test_reuse_rolls_back_revision_when_turn_cannot_be_published(client, monkeypatch):
    from apps.api.app import conversation_store

    conversation_id, _ = _conversation(client)
    saved = client.post(f"/api/v1/conversations/{conversation_id}/saved-screening-tasks", json={
        "name": "原子复用", "request_id": "save-atomic", "revision": 1,
    }).json()
    message = client.post(f"/api/v1/conversations/{conversation_id}/messages", json={
        "client_message_id": "reuse-atomic", "base_revision": 1, "content": "复用这个任务",
    }).json()

    def fail_publish(*args, **kwargs):
        raise conversation_store.ConversationConflict("发布回合失败")

    monkeypatch.setattr(conversation_store, "finish_turn", fail_publish)
    response = client.post(f"/api/v1/conversations/{conversation_id}/saved-screening-tasks/{saved['id']}/reuse", json={
        "base_revision": 1, "source_message_id": message["message_id"], "version": 1,
    })
    assert response.status_code == 409
    current = client.get(f"/api/v1/conversations/{conversation_id}").json()
    assert current["task_revision"] == 1
    assert current["turns"][0]["state"] == "awaiting_agent"
    assert client.get(f"/api/v1/conversations/{conversation_id}/revisions/2").status_code == 404


def test_reuse_does_not_overwrite_a_running_model_turn(client):
    from apps.api.app import conversation_store

    conversation_id, _ = _conversation(client)
    saved = client.post(f"/api/v1/conversations/{conversation_id}/saved-screening-tasks", json={
        "name": "不要覆盖正在处理的要求", "request_id": "save-running", "revision": 1,
    }).json()
    message = client.post(f"/api/v1/conversations/{conversation_id}/messages", json={
        "client_message_id": "reuse-running", "base_revision": 1, "content": "修改条件",
    }).json()
    conversation_store.start_turn(conversation_id, message["turn_id"])
    response = client.post(f"/api/v1/conversations/{conversation_id}/saved-screening-tasks/{saved['id']}/reuse", json={
        "base_revision": 1, "source_message_id": message["message_id"], "version": 1,
    })
    assert response.status_code == 409
    current = client.get(f"/api/v1/conversations/{conversation_id}").json()
    assert current["task_revision"] == 1
    assert current["turns"][0]["state"] == "running"


def test_save_rejects_incomplete_task_and_unknown_revision(client):
    conversation_id, _message_id = _conversation(client)
    response = client.post(f"/api/v1/conversations/{conversation_id}/saved-screening-tasks", json={
        "name": "不存在", "request_id": "bad", "revision": 99,
    })
    assert response.status_code == 404
