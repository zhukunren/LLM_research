from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from apps.api.app import conversation_store, db, main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "conversation-test.db")
    with TestClient(main.app) as session:
        yield session


def create_conversation(client, scope="technical", workflow_type="screening"):
    response = client.post("/api/v1/conversations", json={"entry_scope": scope, "workflow_type": workflow_type})
    assert response.status_code == 200, response.text
    return response.json()


def post_user_message(client, conversation_id, message_id="message-1", base_revision=0, content="收盘价高于20日均线，筛一下"):
    return client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "client_message_id": message_id,
            "base_revision": base_revision,
            "content": content,
        },
    )


def task_revision(conversation_id, revision=1):
    prompt = "收盘价高于20日均线，筛一下"
    return {
        "task_id": conversation_id,
        "revision": revision,
        "original_user_messages": [prompt],
        "conditions": [
            {
                "condition_id": "ma",
                "library": "technical",
                "source_quote": "收盘价高于20日均线",
                "expression": {"op": "indicator_compare", "window": 20},
                "description": "收盘价高于20日均线",
            }
        ],
        "references": [{"reference_id": "r1", "condition_id": "ma"}],
        "logic_tree": {"op": "condition", "reference_id": "r1"},
        "scope": {
            "universe": {"kind": "explicit", "stock_codes": ["600000.SH"]},
            "as_of": "2026-09-14",
        },
        "unresolved": [],
    }


def test_migration_010_is_applied_once_and_conversation_survives_reload(client):
    conversation = create_conversation(client, "report")
    db.init_db()
    row = client.get(f"/api/v1/conversations/{conversation['id']}").json()
    versions = client.get("/api/v1/conversations", params={"scope": "report"}).json()["items"]

    assert row["task_revision"] == 0
    assert row["entry_scope"] == "report"
    assert row["messages"] == []
    assert [item["id"] for item in versions] == [conversation["id"]]
    with db.connect() as connection:
        assert connection.execute(
            "SELECT count(*) FROM schema_migrations WHERE version='010_conversations.sql'"
        ).fetchone()[0] == 1


def test_research_mode_persists_and_cannot_change_during_an_active_turn(client, monkeypatch):
    monkeypatch.setenv("LLMR_RESEARCH_MODE", "advanced")
    created = create_conversation(client, workflow_type="research")
    cid = created["id"]
    assert created["research_mode"] == "advanced"
    url = f"/api/v1/conversations/{cid}/mode"
    assert client.patch(url, json={"research_mode": "screening"}).status_code == 200
    assert client.get(f"/api/v1/conversations/{cid}").json()["research_mode"] == "screening"
    assert client.get("/api/v1/conversations").json()["items"][0]["research_mode"] == "screening"
    assert client.patch(url, json={"research_mode": "invalid"}).status_code == 422
    assert post_user_message(client, cid).status_code == 202
    assert client.patch(url, json={"research_mode": "research"}).status_code == 409


def test_existing_v009_database_keeps_conditions_when_migration_010_runs(tmp_path, monkeypatch):
    migration_source = Path(db.MIGRATIONS_DIR)
    legacy_migrations = tmp_path / "legacy-migrations"
    legacy_migrations.mkdir()
    for path in sorted(migration_source.glob("00*.sql")):
        shutil.copy2(path, legacy_migrations / path.name)
    database_path = tmp_path / "existing-v009.db"
    monkeypatch.setattr(db, "DB_PATH", database_path)
    monkeypatch.setattr(db, "MIGRATIONS_DIR", legacy_migrations)

    db.init_db()
    with db.connect() as connection:
        connection.execute(
            """INSERT INTO filters(id,library,name,description,version,dsl_json,created_at)
               VALUES('legacy-filter','technical','20日均线','旧条件',1,'{}','2026-09-01')"""
        )
    monkeypatch.setattr(db, "MIGRATIONS_DIR", migration_source)

    db.init_db()
    db.init_db()
    with db.connect() as connection:
        saved = connection.execute(
            "SELECT id,name,version FROM filters WHERE id='legacy-filter'"
        ).fetchone()
        migration = connection.execute(
            "SELECT version FROM schema_migrations WHERE version='010_conversations.sql'"
        ).fetchone()
        table = connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'"
        ).fetchone()

    assert tuple(saved) == ("legacy-filter", "20日均线", 1)
    assert migration is not None
    assert table is not None


def test_existing_v013_database_keeps_legacy_assets_and_applies_saved_task_migration(tmp_path, monkeypatch):
    migration_source = Path(db.MIGRATIONS_DIR)
    legacy_migrations = tmp_path / "legacy-migrations-v013"
    legacy_migrations.mkdir()
    for path in sorted(migration_source.glob("00*.sql")):
        if path.name != "014_saved_screening_tasks.sql":
            shutil.copy2(path, legacy_migrations / path.name)
    database_path = tmp_path / "existing-v013.db"
    monkeypatch.setattr(db, "DB_PATH", database_path)
    monkeypatch.setattr(db, "MIGRATIONS_DIR", legacy_migrations)
    db.init_db()
    with db.connect() as connection:
        connection.execute(
            "INSERT INTO filters(id,library,name,description,version,dsl_json,created_at) VALUES('legacy-v013','technical','旧条件','旧',1,'{}','2026-09-01')"
        )
        connection.execute(
            "INSERT INTO patterns(id,name,version,pattern_json,created_at) VALUES('legacy-shape','旧形态',1,'{}','2026-09-01')"
        )
    monkeypatch.setattr(db, "MIGRATIONS_DIR", migration_source)
    db.init_db()
    with db.connect() as connection:
        legacy_filter = connection.execute("SELECT name FROM filters WHERE id='legacy-v013'").fetchone()
        legacy_pattern = connection.execute("SELECT name FROM patterns WHERE id='legacy-shape'").fetchone()
        saved_table = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='saved_screening_tasks'").fetchone()
        migration = connection.execute("SELECT version FROM schema_migrations WHERE version='014_saved_screening_tasks.sql'").fetchone()
    assert legacy_filter[0] == "旧条件"
    assert legacy_pattern[0] == "旧形态"
    assert saved_table is not None and migration is not None


def test_user_message_is_persisted_and_duplicate_request_is_idempotent(client):
    conversation = create_conversation(client)
    first = post_user_message(client, conversation["id"])
    replay = post_user_message(client, conversation["id"])
    restored = client.get(f"/api/v1/conversations/{conversation['id']}").json()

    assert first.status_code == 202
    assert replay.status_code == 200
    assert replay.json()["idempotent_replay"] is True
    assert replay.json()["message_id"] == first.json()["message_id"]
    assert replay.json()["turn_id"] == first.json()["turn_id"]
    assert len(restored["messages"]) == 1
    assert restored["messages"][0]["content"] == "收盘价高于20日均线，筛一下"
    assert restored["turns"][0]["state"] == "awaiting_agent"


def test_reused_message_key_cannot_hide_different_content(client):
    conversation = create_conversation(client)
    post_user_message(client, conversation["id"], message_id="message-1")
    response = post_user_message(
        client, conversation["id"], message_id="message-1", content="删除全部条件"
    )
    assert response.status_code == 409
    assert len(client.get(f"/api/v1/conversations/{conversation['id']}").json()["messages"]) == 1


def test_report_page_context_is_validated_and_frozen_on_user_message(client):
    with db.connect() as connection:
        connection.execute(
            """INSERT INTO documents(
                   id,sha256,filename,title,pages,extracted_chars,parse_status,source_path,imported_at,
                   available_at,available_at_status,stock_code,stock_code_status
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                "doc-1", "a" * 64, "report.pdf", "订单研究", 2, 24, "indexed",
                "example-source.pdf", "2026-09-12T00:00:00+00:00",
                "2026-09-10", "confirmed", "600000.SH", "confirmed",
            ),
        )
        connection.execute(
            "INSERT INTO document_pages(document_id,page_number,text) VALUES(?,?,?)",
            ("doc-1", 2, "公司实际订单增加"),
        )

    conversation = create_conversation(client, "report")
    body = {
        "client_message_id": "report-page-message",
        "base_revision": 0,
        "content": "这页报告说了什么？",
        "source_refs": [
            {"kind": "report_page", "source_id": "doc-1", "page_number": 2}
        ],
    }
    response = client.post(f"/api/v1/conversations/{conversation['id']}/messages", json=body)
    restored = client.get(f"/api/v1/conversations/{conversation['id']}").json()
    replay = client.post(f"/api/v1/conversations/{conversation['id']}/messages", json=body)

    assert response.status_code == 202
    assert response.json()["source_refs"][0] == {
        "kind": "report_page",
        "source_id": "doc-1",
        "source_sha256": "a" * 64,
        "title": "订单研究",
        "page_number": 2,
        "available_at": "2026-09-10",
        "availability_status": "confirmed",
        "stock_code": "600000.SH",
        "security_binding_status": "confirmed",
    }
    assert restored["messages"][0]["source_refs"][0]["page_number"] == 2
    assert replay.status_code == 200
    assert replay.json()["idempotent_replay"] is True


def test_missing_report_page_context_does_not_create_a_message(client):
    conversation = create_conversation(client, "report")
    response = client.post(
        f"/api/v1/conversations/{conversation['id']}/messages",
        json={
            "client_message_id": "bad-page",
            "base_revision": 0,
            "content": "查看这一页",
            "source_refs": [
                {"kind": "report_page", "source_id": "missing-report", "page_number": 99}
            ],
        },
    )

    assert response.status_code == 422
    assert client.get(f"/api/v1/conversations/{conversation['id']}").json()["messages"] == []


def test_stale_revision_and_active_turn_reject_new_messages(client):
    conversation = create_conversation(client)
    accepted = post_user_message(client, conversation["id"])
    stale = post_user_message(
        client, conversation["id"], message_id="message-2", base_revision=1
    )
    active = post_user_message(
        client, conversation["id"], message_id="message-3", content="再加一个条件"
    )

    assert accepted.status_code == 202
    assert stale.status_code == 409
    assert active.status_code == 409
    assert len(client.get(f"/api/v1/conversations/{conversation['id']}").json()["messages"]) == 1


def test_task_revision_is_frozen_and_identical_retries_do_not_duplicate(client):
    conversation = create_conversation(client)
    message = post_user_message(client, conversation["id"]).json()
    payload = {
        "base_revision": 0,
        "source_message_id": message["message_id"],
        "task": task_revision(conversation["id"]),
    }
    saved = client.post(f"/api/v1/conversations/{conversation['id']}/revisions", json=payload)
    replay = client.post(f"/api/v1/conversations/{conversation['id']}/revisions", json=payload)
    restored = client.get(
        f"/api/v1/conversations/{conversation['id']}/revisions/1"
    ).json()

    assert saved.status_code == 201, saved.text
    assert replay.status_code == 200, replay.text
    assert replay.json()["idempotent_replay"] is True
    assert restored["original_user_messages"] == ["收盘价高于20日均线，筛一下"]
    assert client.get(f"/api/v1/conversations/{conversation['id']}").json()["task_revision"] == 1
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        with db.connect() as connection:
            connection.execute(
                """UPDATE screening_task_revisions SET task_json='{}'
                   WHERE conversation_id=? AND revision=1""",
                (conversation["id"],),
            )


def test_revision_conflict_and_foreign_source_are_rejected(client):
    first = create_conversation(client)
    second = create_conversation(client)
    first_message = post_user_message(client, first["id"]).json()
    second_message = post_user_message(client, second["id"], content="收盘价高于20日均线，筛一下").json()

    valid = {
        "base_revision": 0,
        "source_message_id": first_message["message_id"],
        "task": task_revision(first["id"]),
    }
    assert client.post(f"/api/v1/conversations/{first['id']}/revisions", json=valid).status_code == 201

    stale_task = task_revision(first["id"])
    stale_task["conditions"][0]["description"] = "收盘价高于20日均线并保留历史"
    stale = {
        **valid,
        "task": stale_task,
    }
    assert client.post(f"/api/v1/conversations/{first['id']}/revisions", json=stale).status_code == 409

    foreign = {
        "base_revision": 0,
        "source_message_id": second_message["message_id"],
        "task": task_revision(first["id"]),
    }
    assert client.post(f"/api/v1/conversations/{first['id']}/revisions", json=foreign).status_code == 422
    assert client.get(f"/api/v1/conversations/{first['id']}/revisions/2").status_code == 404


def test_conversation_and_turn_identifiers_cannot_be_crossed(client):
    first = create_conversation(client)
    second = create_conversation(client)
    message = post_user_message(client, first["id"]).json()

    assert client.get(f"/api/v1/conversations/{second['id']}/turns/{message['turn_id']}").status_code == 404
    assert client.get("/api/v1/conversations/does-not-exist").status_code == 404


def test_get_user_message_rejects_foreign_and_assistant_message_ids(client):
    first = create_conversation(client)
    second = create_conversation(client)
    user = post_user_message(client, first["id"]).json()

    with pytest.raises(conversation_store.ConversationNotFound):
        conversation_store.get_user_message(second["id"], user["message_id"])

    conversation_store.finish_turn(
        first["id"],
        user["turn_id"],
        0,
        "succeeded",
        "这是一条助手回复。",
        {},
    )
    messages = client.get(f"/api/v1/conversations/{first['id']}").json()["messages"]
    assistant = next(item for item in messages if item["role"] == "assistant")

    with pytest.raises(conversation_store.ConversationNotFound):
        conversation_store.get_user_message(first["id"], assistant["id"])
