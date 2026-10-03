from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from apps.api.app import codex_runtime, conversation_store, db, main, research_projects, research_workspace


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "projects.db")
    with TestClient(main.app) as session:
        yield session


def project(client, name="白酒盈利改善"):
    result = client.post("/api/v1/research-projects", json={"name": name, "objective": "验证实际经营改善", "request_id": name})
    assert result.status_code == 200, result.text
    return result.json()


def conversation(client, project_id=None):
    result = client.post("/api/v1/conversations", json={"entry_scope": "screening", "project_id": project_id})
    assert result.status_code == 200, result.text
    return result.json()


def assistant_answer(cid, content="经营判断仍需要原文验证。"):
    request = conversation_store.add_user_message(cid, "question", 0, "研究现金流，不执行筛选。")
    conversation_store.start_turn(cid, request["turn_id"])
    conversation_store.finish_turn(cid, request["turn_id"], 0, "succeeded", content, {"runtime": "codex", "ready_to_execute": False})
    return next(item for item in conversation_store.get_conversation(cid)["messages"] if item["role"] == "assistant")


def test_project_create_retry_conflict_search_summary_and_reload(client):
    saved = project(client)
    repeated = project(client)
    assert saved["id"] == repeated["id"]
    assert client.post("/api/v1/research-projects", json={"name": "另一个主题", "objective": "", "request_id": saved["name"]}).status_code == 409
    assert client.post("/api/v1/research-projects", json={"name": "   ", "request_id": "empty"}).status_code == 422
    db.init_db()
    detail = client.get(f"/api/v1/research-projects/{saved['id']}").json()
    assert detail["name"] == saved["name"] and detail["notes"] == []
    summary = client.get("/api/v1/research-projects").json()["items"][0]
    assert (summary["company_count"], summary["conversation_count"], summary["note_count"]) == (0, 0, 0)


def test_company_association_is_idempotent_without_rewriting_screening_scope(client):
    saved = project(client)
    url = f"/api/v1/research-projects/{saved['id']}"
    for _ in range(2):
        assert client.post(url + "/companies", json={"stock_code": "600519.SH"}).status_code == 200
    assert len(client.get(url).json()["companies"]) == 1
    assert client.post(url + "/companies", json={"stock_code": "../invalid"}).status_code == 422
    created = conversation(client, saved["id"])
    assert created["task_revision"] == 0
    assert client.get(f"/api/v1/conversations/{created['id']}").json()["project_id"] == saved["id"]
    assert client.get("/api/v1/conversations").json()["items"][0]["project_id"] == saved["id"]
    assert client.get("/api/v1/research-projects").json()["items"][0]["conversation_count"] == 1
    assert client.delete(url + "/companies/600519.SH").json()["companies"] == []


def test_attach_existing_conversation_preserves_history_and_blocks_active_turn(client):
    saved = project(client)
    created = conversation(client)
    cid = created["id"]
    url = f"/api/v1/conversations/{cid}/project"
    assert client.patch(url, json={"project_id": saved["id"]}).status_code == 200
    answer = assistant_answer(cid)
    before = client.get(f"/api/v1/conversations/{cid}").json()
    assert client.patch(url, json={"project_id": None}).status_code == 200
    after = client.get(f"/api/v1/conversations/{cid}").json()
    assert after["messages"] == before["messages"] and after["messages"][-1]["id"] == answer["id"]
    request = conversation_store.add_user_message(cid, "next", 0, "继续研究")
    assert request["state"] == "awaiting_agent"
    assert client.patch(url, json={"project_id": saved["id"]}).status_code == 409
    assert client.patch(url, json={"project_id": "absent"}).status_code == 404


def test_notes_validate_company_preserve_revision_and_reject_stale_overwrites(client):
    saved = project(client)
    url = f"/api/v1/research-projects/{saved['id']}"
    payload = {"title": "收入能否兑现", "body": "这是待验证的假设。", "stock_code": "600519.SH", "validation_plan": "核对下一期公告", "invalidation_condition": "现金流持续恶化", "request_id": "note-1"}
    assert client.post(url + "/notes", json=payload).status_code == 422
    client.post(url + "/companies", json={"stock_code": "600519.SH"})
    note = client.post(url + "/notes", json=payload).json()
    assert client.post(url + "/notes", json=payload).json()["id"] == note["id"]
    assert client.post(url + "/notes", json={**payload, "body": "不同内容"}).status_code == 409
    update = {key: value for key, value in payload.items() if key != "request_id"}
    update.update(base_revision=1, status="challenged", body="发现反方证据")
    endpoint = url + f"/notes/{note['id']}"
    latest = client.patch(endpoint, json=update).json()
    assert latest["revision"] == 2 and latest["status"] == "challenged"
    assert client.patch(endpoint, json={**update, "body": "迟到编辑"}).status_code == 409
    assert client.get(url).json()["notes"][0]["body"] == "发现反方证据"
    client.delete(url + "/companies/600519.SH")
    assert client.patch(endpoint, json={**update, "base_revision": 2}).status_code == 200
    assert client.get(url).json()["notes"][0]["stock_code"] == "600519.SH"
    history = client.get(endpoint + "/history").json()["items"]
    assert [item["revision"] for item in history] == [3, 2, 1]
    assert history[-1]["body"] == "这是待验证的假设。"
    assert history[-1]["status"] == "watching" and history[1]["status"] == "challenged"
    other = project(client, "其他项目")
    assert client.get(f"/api/v1/research-projects/{other['id']}/notes/{note['id']}/history").status_code == 404
    with db.connect() as connection:
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("UPDATE research_note_versions SET snapshot_json='{}' WHERE note_id=?", (note["id"],))


def test_save_answer_once_keeps_original_message_and_rejects_other_project(client):
    saved, other = project(client), project(client, "其他研究")
    created = conversation(client, saved["id"])
    answer = assistant_answer(created["id"], "# 待核验判断\n\n[表格](outputs/table.csv)")
    url = f"/api/v1/research-projects/{saved['id']}"
    note = client.post(url + "/notes/from-message", json={"message_id": answer["id"]}).json()
    assert note["body"] == answer["content"]
    assert note["source_conversation_id"] == created["id"] and note["source_message_id"] == answer["id"]
    edited = {key: note[key] for key in ("title", "body", "stock_code", "validation_plan", "invalidation_condition", "status")}
    client.patch(url + f"/notes/{note['id']}", json={**edited, "body": "人工补充", "base_revision": 1})
    replay = client.post(url + "/notes/from-message", json={"message_id": answer["id"]}).json()
    assert replay["id"] == note["id"] and replay["body"] == "人工补充"
    assert client.post(f"/api/v1/research-projects/{other['id']}/notes/from-message", json={"message_id": answer["id"]}).status_code == 404
    user_message = client.get(f"/api/v1/conversations/{created['id']}").json()["messages"][0]
    assert client.post(url + "/notes/from-message", json={"message_id": user_message["id"]}).status_code == 404
    assert conversation_store.get_conversation(created["id"])["messages"][-1]["content"] == answer["content"]
    history = client.get(url + f"/notes/{note['id']}/history").json()["items"]
    assert len(history) == 2 and history[-1]["body"] == answer["content"]


def test_project_artifacts_keep_source_links_after_reassignment(client):
    saved, other = project(client), project(client, "另一个项目")
    first, second = conversation(client, saved["id"]), conversation(client, other["id"])
    answer = assistant_answer(first["id"])
    client.post(f"/api/v1/research-projects/{saved['id']}/notes/from-message", json={"message_id": answer["id"]})
    for created, filename in ((first, "table.csv"), (second, "private.csv")):
        output = research_workspace.directory(created["id"]) / "outputs"
        output.mkdir(parents=True)
        (output / filename).write_text("value\n1\n", encoding="utf-8")
    url = f"/api/v1/research-projects/{saved['id']}/files"
    items = client.get(url).json()["items"]
    assert [item["name"] for item in items] == ["table.csv"]
    assert items[0]["conversation_id"] == first["id"]
    assert client.get(items[0]["url"]).status_code == 200
    client.patch(f"/api/v1/conversations/{first['id']}/project", json={"project_id": other["id"]})
    assert [item["name"] for item in client.get(url).json()["items"]] == ["table.csv"]
    assert client.get("/api/v1/research-projects/absent/files").status_code == 404


def test_archiving_is_versioned_and_blocks_new_project_writes(client):
    saved = project(client)
    url = f"/api/v1/research-projects/{saved['id']}"
    payload = {"name": saved["name"], "objective": saved["objective"], "status": "archived", "base_revision": 1}
    assert client.patch(url, json=payload).status_code == 200
    assert client.patch(url, json={**payload, "name": "迟到修改"}).status_code == 409
    assert client.post(url + "/companies", json={"stock_code": "600519.SH"}).status_code == 409
    assert client.post(url + "/notes", json={"title": "笔记", "request_id": "archived"}).status_code == 409
    assert client.post("/api/v1/conversations", json={"entry_scope": "screening", "project_id": saved["id"]}).status_code == 422
    assert client.patch(url, json={**payload, "base_revision": 2, "status": "active"}).status_code == 200
    created = conversation(client, saved["id"])
    conversation_store.add_user_message(created["id"], "active", 0, "研究")
    assert client.patch(url, json={**payload, "base_revision": 3}).status_code == 409


def test_project_context_reaches_codex_without_changing_execution_authorization(client):
    saved = project(client)
    url = f"/api/v1/research-projects/{saved['id']}"
    client.post(url + "/companies", json={"stock_code": "600519.SH"})
    client.post(url + "/notes", json={"title": "旧观点", "body": "过期判断" * 1000, "status": "invalidated", "request_id": "long-note"})
    created = conversation(client, saved["id"])
    request = conversation_store.add_user_message(created["id"], "only-read", 0, "研究五粮液，不执行。")
    prompt = json.loads(codex_runtime._prompt(created["id"], request["turn_id"]))
    assert prompt["current_user_request"] == "研究五粮液，不执行。"
    assert prompt["confirmed_screening_task"] is None and prompt["task_revision"] == 0
    context = prompt["research_project"]
    assert context["stock_codes"] == ["600519.SH"]
    assert context["recent_notes"][0]["body_truncated"] is True
    assert context["recent_notes"][0]["status"] == "invalidated"
    assert "not verified facts" in context["instructions"]
    assert research_projects.conversation_context(conversation(client)["id"]) is None


def test_migration_preserves_legacy_conversations_and_asset_versions(tmp_path, monkeypatch):
    source = Path(db.MIGRATIONS_DIR)
    legacy = tmp_path / "migrations"
    legacy.mkdir()
    for migration in source.glob("*.sql"):
        if migration.name < "023":
            shutil.copy2(migration, legacy / migration.name)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "legacy.db")
    monkeypatch.setattr(db, "MIGRATIONS_DIR", legacy)
    db.init_db()
    with db.connect() as connection:
        connection.execute("INSERT INTO conversations(id,entry_scope,created_at,updated_at) VALUES('old','report','2026-09-01','2026-09-01')")
        connection.execute("INSERT INTO filters(id,library,name,version,dsl_json,created_at) VALUES('original','technical','旧条件',3,'{}','2026-09-01')")
    monkeypatch.setattr(db, "MIGRATIONS_DIR", source)
    db.init_db()
    db.init_db()
    with db.connect() as connection:
        assert tuple(connection.execute("SELECT entry_scope,project_id FROM conversations WHERE id='old'").fetchone()) == ("report", None)
        assert connection.execute("SELECT version FROM filters WHERE id='original'").fetchone()[0] == 3
        assert connection.execute("SELECT count(*) FROM schema_migrations WHERE version='023_research_projects.sql'").fetchone()[0] == 1
