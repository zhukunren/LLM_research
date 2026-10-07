from __future__ import annotations

from pathlib import Path
import shutil
import sqlite3

from fastapi.testclient import TestClient
import pytest

from apps.api.app import conversation_store, db, main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "boundaries.db")
    with TestClient(main.app) as session:
        yield session


def create(client, workflow="research", depth="standard"):
    response = client.post("/api/v1/conversations", json={
        "entry_scope": "technical", "research_mode": "research",
        "workflow_type": workflow, "research_depth": depth,
    })
    assert response.status_code == 200, response.text
    return response.json()


def message(client, cid, *, key="first", base=0, scope_revision=None, content="分析公司的研发投入"):
    payload = {"client_message_id": key, "base_revision": base, "content": content}
    if scope_revision is not None:
        payload["research_scope_revision"] = scope_revision
    return client.post(f"/api/v1/conversations/{cid}/messages", json=payload)


def complete_research(client, text="营收变化是待验证的研究线索，尚未形成选股条件。"):
    conversation = create(client)
    cid = conversation["id"]
    user = message(client, cid).json()
    conversation_store.start_turn(cid, user["turn_id"])
    conversation_store.finish_turn(cid, user["turn_id"], 0, "succeeded", text, {"runtime": "test"})
    restored = client.get(f"/api/v1/conversations/{cid}").json()
    source = next(item for item in restored["messages"] if item["role"] == "assistant")
    return restored, source, user


def test_workflow_and_depth_are_independent_and_legacy_modes_still_work(client):
    research = create(client, depth="deep")
    assert research["task_id"] is None
    assert research["research_mode"] == "advanced"
    assert research["research_scope"]["as_of"] is None
    cid = research["id"]
    switched = client.patch(f"/api/v1/conversations/{cid}/workflow", json={
        "workflow_type": "screening", "base_revision": 0,
    }).json()
    assert switched["workflow_type"] == "screening" and switched["research_depth"] == "deep"
    assert switched["research_mode"] == "screening"
    assert client.patch(f"/api/v1/conversations/{cid}/workflow", json={
        "research_depth": "standard", "base_revision": 0,
    }).status_code == 409
    legacy = client.patch(f"/api/v1/conversations/{cid}/mode", json={"research_mode": "advanced"})
    assert legacy.status_code == 200
    assert legacy.json()["workflow_type"] == "research" and legacy.json()["research_depth"] == "deep"
    listed = client.get("/api/v1/conversations").json()["items"][0]
    assert listed["workflow_type"] == "research" and listed["task_id"] is None
    combined = client.post("/api/v1/conversations", json={"entry_scope": "screening", "research_mode": "advanced"}).json()
    assert combined["workflow_type"] == "research" and combined["research_depth"] == "deep"


def test_research_scope_patch_preserves_other_fields_and_can_explicitly_clear(client):
    cid = create(client)["id"]
    url = f"/api/v1/conversations/{cid}/research-scope"
    assert client.patch(url, json={"base_revision": 0}).status_code == 422
    assert client.patch(url, json={"base_revision": 0, "as_of": "2026-09-14",
                                   "stock_codes": ["600000.SH"], "report_lookback_calendar_days": 30}).status_code == 200
    result = client.patch(url, json={"base_revision": 1, "stock_codes": ["600001.SH"]}).json()
    assert result["research_scope"]["as_of"] == "2026-09-14"
    assert result["research_scope"]["report_lookback_calendar_days"] == 30
    cleared = client.patch(url, json={"base_revision": 2, "as_of": None}).json()
    assert cleared["research_scope"]["as_of"] is None and cleared["research_scope"]["stock_codes"] == ["600001.SH"]


def test_research_scope_is_versioned_validated_and_frozen_on_turn(client):
    cid = create(client, depth="deep")["id"]
    updated = client.patch(f"/api/v1/conversations/{cid}/research-scope", json={
        "base_revision": 0, "as_of": "2026-09-14", "stock_codes": ["600000.sh"],
        "report_lookback_calendar_days": 30,
    })
    assert updated.status_code == 200
    assert updated.json()["research_scope_revision"] == 1
    scope = updated.json()["research_scope"]
    assert scope["stock_codes"] == ["600000.SH"]
    assert client.patch(f"/api/v1/conversations/{cid}/research-scope", json={
        "base_revision": 0, "as_of": None, "stock_codes": [],
    }).status_code == 409
    assert message(client, cid, scope_revision=0).status_code == 409
    accepted = message(client, cid, scope_revision=1).json()
    turn = client.get(f"/api/v1/conversations/{cid}/turns/{accepted['turn_id']}").json()
    assert turn["workflow_type"] == "research" and turn["research_depth"] == "deep"
    assert turn["research_scope"] == scope and turn["research_scope_revision"] == 1
    assert client.patch(f"/api/v1/conversations/{cid}/research-scope", json={
        "base_revision": 1, "as_of": "2026-09-15", "stock_codes": [],
    }).status_code == 409
    assert client.patch(f"/api/v1/conversations/{cid}/workflow", json={"workflow_type": "screening"}).status_code == 409
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        with db.connect() as connection:
            connection.execute("UPDATE conversation_turns SET research_scope_json='{}' WHERE id=?", (turn["id"],))


@pytest.mark.parametrize("patch", [
    {"as_of": "2026-02-30"}, {"stock_codes": ["bad"]},
    {"stock_codes": ["600000.SH", "600000.sh"]}, {"report_lookback_calendar_days": 0},
])
def test_invalid_research_scope_cannot_mutate_state(client, patch):
    cid = create(client)["id"]
    response = client.patch(f"/api/v1/conversations/{cid}/research-scope", json={"base_revision": 0, **patch})
    assert response.status_code == 422
    assert client.get(f"/api/v1/conversations/{cid}").json()["research_scope_revision"] == 0


def test_research_messages_and_completion_ignore_screening_revision_changes(client):
    cid = create(client)["id"]
    with db.connect() as connection:
        connection.execute("UPDATE conversations SET task_revision=3 WHERE id=?", (cid,))
    accepted = message(client, cid, base=0)
    assert accepted.status_code == 202
    user = accepted.json()
    with db.connect() as connection:
        connection.execute("UPDATE conversations SET task_revision=4 WHERE id=?", (cid,))
    conversation_store.start_turn(cid, user["turn_id"])
    with db.connect() as connection:
        connection.execute("UPDATE conversations SET task_revision=5 WHERE id=?", (cid,))
    conversation_store.finish_turn(cid, user["turn_id"], 0, "succeeded", "研究结果已完成", {})
    assert client.get(f"/api/v1/conversations/{cid}/turns/{user['turn_id']}").json()["state"] == "succeeded"
    assert message(client, cid, base=0).json()["idempotent_replay"] is True
    assert message(client, cid, base=1).status_code == 409


def test_screening_keeps_revision_guards_and_research_cannot_write_a_task(client):
    cid = create(client, workflow="screening")["id"]
    user = message(client, cid).json()
    with db.connect() as connection:
        connection.execute("UPDATE conversations SET task_revision=1 WHERE id=?", (cid,))
    with pytest.raises(conversation_store.ConversationConflict):
        conversation_store.start_turn(cid, user["turn_id"])
    research = create(client)
    research_user = message(client, research["id"]).json()
    response = client.post(f"/api/v1/conversations/{research['id']}/revisions", json={
        "base_revision": 0, "source_message_id": research_user["message_id"],
        "task": {"task_id": research["id"], "revision": 1},
    })
    assert response.status_code == 422
    with pytest.raises(conversation_store.ConversationStoreError):
        conversation_store.set_pending_execute_message(research["id"], 0, research_user["message_id"])


def test_identical_message_retry_keeps_frozen_sources_after_catalog_changes(client):
    cid = create(client)["id"]
    with db.connect() as connection:
        connection.execute("""INSERT INTO documents(id,sha256,filename,title,pages,extracted_chars,parse_status,source_path,imported_at)
            VALUES('retry-report','retry-hash','retry.pdf','来源报告',1,5,'indexed','synthetic',?)""", (db.utc_now(),))
        connection.execute("INSERT INTO document_pages(document_id,page_number,text) VALUES('retry-report',1,'研报原文')")
    body = {"client_message_id": "with-source", "base_revision": 0, "research_scope_revision": 0,
            "content": "分析本页", "source_refs": [{"kind": "report_page", "source_id": "retry-report", "page_number": 1}]}
    first = client.post(f"/api/v1/conversations/{cid}/messages", json=body).json()
    with db.connect() as connection:
        connection.execute("UPDATE documents SET available_at='2026-09-14',available_at_status='confirmed' WHERE id='retry-report'")
    replay = client.post(f"/api/v1/conversations/{cid}/messages", json=body)
    assert replay.status_code == 200 and replay.json()["source_refs"] == first["source_refs"]
    assert replay.json()["source_refs"][0]["availability_status"] == "filename_candidate"


def test_conversion_creates_only_an_editable_draft_with_immutable_provenance(client):
    source, assistant, _ = complete_research(client)
    body = {"request_id": "convert-1", "source_message_id": assistant["id"],
            "instructions": "截至2026-09-14，在全部A股中查找近20日均量高于前20日均量的股票。"}
    converted = client.post(f"/api/v1/conversations/{source['id']}/screening-draft", json=body)
    assert converted.status_code == 201, converted.text
    draft = converted.json()
    assert draft["turn_id"] is None and draft["conversation_id"] != source["id"]
    assert "不执行筛选" in draft["draft_prompt"]
    restored = client.get(f"/api/v1/conversations/{draft['conversation_id']}").json()
    assert restored["workflow_type"] == "screening" and restored["task_revision"] == 0
    assert restored["messages"] == [] and restored["turns"] == []
    assert restored["pending_execution"] is False
    origin = restored["screening_draft_source"]
    assert origin["source_text"] == assistant["content"]
    assert origin["source_conversation_id"] == source["id"] and origin["source_message_id"] == assistant["id"]
    assert origin["instructions"] == body["instructions"] and origin["draft_prompt"] == draft["draft_prompt"]
    replay = client.post(f"/api/v1/conversations/{source['id']}/screening-draft", json=body)
    assert replay.status_code == 200 and replay.json()["conversation_id"] == draft["conversation_id"]
    assert client.post(f"/api/v1/conversations/{source['id']}/screening-draft", json={
        **body, "instructions": "改为近10日均量比较",
    }).status_code == 409
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM screening_task_runs").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM screening_task_revisions").fetchone()[0] == 0
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        with db.connect() as connection:
            connection.execute("UPDATE screening_draft_sources SET instructions='changed' WHERE draft_conversation_id=?", (draft["conversation_id"],))
    assert message(client, draft["conversation_id"], content=draft["draft_prompt"]).status_code == 202


def test_conversion_rejects_user_foreign_and_empty_sources_and_preserves_full_text(client):
    source, assistant, user = complete_research(client, text="待核验的研究原文。" * 1000)
    foreign, foreign_assistant, _ = complete_research(client)
    url = f"/api/v1/conversations/{source['id']}/screening-draft"
    for source_id in [user["message_id"], foreign_assistant["id"]]:
        assert client.post(url, json={"request_id": source_id, "source_message_id": source_id,
                                      "instructions": "比较近20日均量"}).status_code == 422
    assert client.post(url, json={"request_id": "empty", "source_message_id": assistant["id"], "instructions": "   "}).status_code == 422
    result = client.post(url, json={"request_id": "long", "source_message_id": assistant["id"], "instructions": "比较近20日均量"}).json()
    assert len(result["draft_prompt"]) <= 8000
    assert result["source"]["source_text"] == assistant["content"]
    assert client.get(f"/api/v1/conversations/{source['id']}").json()["messages"] == source["messages"]


def test_conversion_uses_the_source_turn_scope_and_depth_after_research_changes(client):
    cid = create(client, depth="deep")["id"]
    scope_url = f"/api/v1/conversations/{cid}/research-scope"
    first_scope = client.patch(scope_url, json={"base_revision": 0, "as_of": "2026-09-14", "stock_codes": ["600000.SH"]}).json()
    user = message(client, cid, scope_revision=1).json()
    conversation_store.start_turn(cid, user["turn_id"])
    conversation_store.finish_turn(cid, user["turn_id"], 0, "succeeded", "较早日期的研究结论仍待核验。", {})
    source = next(item for item in client.get(f"/api/v1/conversations/{cid}").json()["messages"] if item["role"] == "assistant")
    assert client.patch(scope_url, json={"base_revision": 1, "as_of": "2026-10-04", "stock_codes": ["600001.SH"]}).status_code == 200
    assert client.patch(f"/api/v1/conversations/{cid}/workflow", json={"research_depth": "standard"}).status_code == 200
    converted = client.post(f"/api/v1/conversations/{cid}/screening-draft", json={
        "request_id": "frozen-source", "source_message_id": source["id"], "instructions": "比较指定日期的20日均量。",
    })
    assert converted.status_code == 201
    origin = converted.json()["source"]
    assert origin["source_turn_id"] == user["turn_id"]
    assert origin["source_workflow_type"] == "research" and origin["source_research_depth"] == "deep"
    assert origin["source_research_scope"] == first_scope["research_scope"]
    assert origin["source_research_scope_revision"] == 1
    restored = client.get(f"/api/v1/conversations/{converted.json()['conversation_id']}").json()
    assert restored["screening_draft_source"]["source_research_scope"] == first_scope["research_scope"]


def test_screening_reply_does_not_become_research_evidence_after_workflow_switch(client):
    cid = create(client, workflow="screening")["id"]
    user = message(client, cid).json()
    conversation_store.start_turn(cid, user["turn_id"])
    conversation_store.finish_turn(cid, user["turn_id"], 0, "succeeded", "这是选股方案答复。", {})
    source = next(item for item in client.get(f"/api/v1/conversations/{cid}").json()["messages"] if item["role"] == "assistant")
    assert client.patch(f"/api/v1/conversations/{cid}/workflow", json={"workflow_type": "research"}).status_code == 200
    response = client.post(f"/api/v1/conversations/{cid}/screening-draft", json={
        "request_id": "wrong-source-type", "source_message_id": source["id"], "instructions": "比较20日均量。",
    })
    assert response.status_code == 422
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM screening_draft_sources").fetchone()[0] == 0


def test_legacy_assistant_without_a_turn_keeps_unknown_scope_provenance(client):
    cid = create(client)["id"]
    assert client.patch(f"/api/v1/conversations/{cid}/research-scope", json={
        "base_revision": 0, "as_of": "2026-10-04", "stock_codes": ["600001.SH"],
    }).status_code == 200
    with db.connect() as connection:
        connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES('legacy-assistant',?,'assistant','旧研究文字',?)", (cid, db.utc_now()))
    converted = client.post(f"/api/v1/conversations/{cid}/screening-draft", json={
        "request_id": "legacy-source", "source_message_id": "legacy-assistant", "instructions": "比较20日均量。",
    })
    assert converted.status_code == 201
    origin = converted.json()["source"]
    assert origin["source_turn_id"] is None and origin["source_workflow_type"] is None
    assert origin["source_research_scope"] is None and origin["source_research_scope_revision"] is None


def test_migration_preserves_legacy_tasks_messages_and_maps_workflow_axes(tmp_path, monkeypatch):
    full_migrations = Path(db.MIGRATIONS_DIR)
    legacy_migrations = tmp_path / "legacy-migrations"
    legacy_migrations.mkdir()
    for migration in full_migrations.glob("*.sql"):
        if migration.name < "027":
            shutil.copyfile(migration, legacy_migrations / migration.name)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "legacy.db")
    monkeypatch.setattr(db, "MIGRATIONS_DIR", legacy_migrations)
    db.init_db()
    original_task = '{"task_id":"screen-old","revision":1,"original_user_messages":["旧选股要求"]}'
    with db.connect() as connection:
        for cid, revision in [("research-old", 0), ("screen-old", 1)]:
            connection.execute("INSERT INTO conversations(id,entry_scope,research_mode,task_revision,created_at,updated_at) VALUES(?,'screening','advanced',?,?,?)", (cid, revision, db.utc_now(), db.utc_now()))
            connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES(?,?,'user','旧研究原文',?)", (cid + "-message", cid, db.utc_now()))
        connection.execute("INSERT INTO screening_task_revisions(conversation_id,revision,source_message_id,task_json,created_at) VALUES('screen-old',1,'screen-old-message',?,?)", (original_task, db.utc_now()))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", full_migrations)
    db.init_db()
    db.init_db()
    assert conversation_store.get_conversation("research-old")["workflow_type"] == "research"
    screened = conversation_store.get_conversation("screen-old")
    assert screened["workflow_type"] == "screening" and screened["research_depth"] == "deep"
    assert screened["task_id"] == "screen-old" and screened["messages"][0]["content"] == "旧研究原文"
    with db.connect() as connection:
        assert connection.execute("SELECT task_json FROM screening_task_revisions WHERE conversation_id='screen-old'").fetchone()[0] == original_task
