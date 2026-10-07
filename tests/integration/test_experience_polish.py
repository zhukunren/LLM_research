from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from apps.api.app import db, conversation_api, conversation_store, research_project_api


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "experience.db")
    db.init_db()
    monkeypatch.setattr(research_project_api.research_pdf, "export_note", lambda project_id, note_id, **kwargs: {"url": f"/notes/{note_id}/pdf"})
    app = FastAPI()
    app.include_router(conversation_api.router)
    app.include_router(research_project_api.router)
    with TestClient(app) as session:
        yield session


def create_conversation(client):
    response = client.post("/api/v1/conversations", json={"entry_scope": "report", "workflow_type": "research"})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def answer(cid, state="succeeded", text="## 结论\n仍需核对现金流。"):
    turn = conversation_store.add_user_message(cid, "question", 0, "核对现金流，不执行筛选。")
    conversation_store.start_turn(cid, turn["turn_id"])
    conversation_store.finish_turn(cid, turn["turn_id"], 0, state, text, {"ready_to_execute": False})
    return conversation_store.get_conversation(cid)["messages"][-1]


def test_independent_notes_reuse_inbox_and_keep_source_scope_and_membership(client):
    cid = create_conversation(client)
    source = answer(cid)
    before = conversation_store.get_conversation(cid)
    url = f"/api/v1/conversations/{cid}/notes/from-message"
    first = client.post(url, json={"message_id": source["id"]})
    assert first.status_code == 200, first.text
    note = first.json()
    repeated = client.post(url, json={"message_id": source["id"]}).json()
    assert repeated["id"] == note["id"]
    after = conversation_store.get_conversation(cid)
    assert after["project_id"] is None
    assert after["messages"] == before["messages"]
    assert after["research_scope"] == before["research_scope"]
    assert note["source_conversation_id"] == cid and note["source_message_id"] == source["id"]
    assert note["body"] == source["content"]
    inbox = client.get(f"/api/v1/research-projects/{note['project_id']}").json()
    assert inbox["name"] == "研究收件箱" and len(inbox["notes"]) == 1
    other = create_conversation(client)
    other_source = answer(other)
    saved = client.post(f"/api/v1/conversations/{other}/notes/from-message", json={"message_id": other_source["id"]}).json()
    assert saved["project_id"] == note["project_id"]
    assert client.post(f"/api/v1/conversations/{other}/notes/from-message", json={"message_id": source["id"]}).status_code == 404
    with db.connect() as connection:
        assert connection.execute("SELECT count(*) FROM research_projects").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM screening_task_runs").fetchone()[0] == 0


def test_failed_and_user_messages_cannot_create_inbox_notes(client):
    cid = create_conversation(client)
    source = answer(cid, "failed", "Codex 运行失败：process closed stdout")
    url = f"/api/v1/conversations/{cid}/notes/from-message"
    assert client.post(url, json={"message_id": source["id"]}).status_code == 422
    user = conversation_store.get_conversation(cid)["messages"][0]
    assert client.post(url, json={"message_id": user["id"]}).status_code == 404
    assert client.get("/api/v1/research-projects").json()["items"] == []


def test_active_tasks_are_filtered_before_limit(client):
    pending = create_conversation(client)
    conversation_store.add_user_message(pending, "queued", 0, "等待核验")
    completed = create_conversation(client)
    answer(completed)
    response = client.get("/api/v1/conversations?active_only=true&limit=1")
    assert response.status_code == 200
    assert [item["id"] for item in response.json()["items"]] == [pending]
    assert response.json()["items"][0]["last_turn_state"] == "awaiting_agent"
