import shutil
import sqlite3

import pytest
from fastapi.testclient import TestClient

from apps.api.app import codex_runtime, conversation_store, db, main, market, research_models


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "models.db")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "absent.parquet")
    monkeypatch.setattr(research_models, "llm_settings", lambda: {"configured": True, "model": "gpt-6-luna", "reasoning_effort": "high"})
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {"account_tier": "free", "allowed_models": [], "reasoning_efforts": {}})
    monkeypatch.setattr(research_models, "_discover", lambda _: (set(research_models.MODEL_DEFINITIONS), "verified"))
    with TestClient(main.app) as session:
        yield session


def create(client, **kwargs):
    return client.post("/api/v1/conversations", json={"entry_scope": "screening", "workflow_type": "research", **kwargs})


def test_catalog_free_and_capability_discovery_fail_closed(client, monkeypatch):
    data = client.get("/api/v1/research-models").json()
    assert data["account_tier"] == "free"
    assert data["default_model_id"] == "gpt-6-luna"
    available = {item["id"] for item in data["models"] if item["available"]}
    assert available == {"gpt-6-luna", "gpt-5.6-luna"}
    assert all(item["unavailable_reason"] for item in data["models"] if not item["available"])
    assert "api_key" not in str(data) and "base_url" not in str(data)
    monkeypatch.setattr(research_models, "_discover", lambda _: ({"gpt-6-luna", "fake-model"}, "verified"))
    data = client.get("/api/v1/research-models").json()
    assert {item["id"] for item in data["models"] if item["available"]} == {"gpt-6-luna"}
    assert "fake-model" not in str(data)


@pytest.mark.parametrize("model", ["gpt-6-astra", "gpt-6-sol", "unknown"])
def test_unavailable_model_cannot_be_selected_or_substituted(client, model):
    assert create(client, model_id=model).status_code == 422
    original = create(client).json()
    response = client.patch(f"/api/v1/conversations/{original['id']}/model", json={"model_id": model, "reasoning_effort": "low", "base_revision": 0})
    assert response.status_code == 422
    assert client.get(f"/api/v1/conversations/{original['id']}").json()["model_id"] == "gpt-6-luna"


def test_reasoning_and_model_revision_are_frozen_and_locked(client):
    original = create(client, model_id="gpt-5.6-luna", reasoning_effort="low").json()
    cid = original["id"]
    assert original["model_id"] == "gpt-5.6-luna" and original["reasoning_effort"] == "low"
    assert create(client, model_id="gpt-5.6-luna", reasoning_effort="ultra").status_code == 422
    selection = {"model_id": "gpt-6-luna", "reasoning_effort": "max", "base_revision": 0}
    changed = client.patch(f"/api/v1/conversations/{cid}/model", json=selection)
    assert changed.status_code == 200 and changed.json()["model_revision"] == 1
    assert client.patch(f"/api/v1/conversations/{cid}/model", json=selection).status_code == 409
    body = {"client_message_id": "first", "base_revision": 0, "content": "读取公开资料", "model_revision": 0}
    assert client.post(f"/api/v1/conversations/{cid}/messages", json=body).status_code == 409
    body["model_revision"] = 1
    response = client.post(f"/api/v1/conversations/{cid}/messages", json=body)
    assert response.status_code == 202, response.text
    tid = response.json()["turn_id"]
    assert response.json()["model_id"] == "gpt-6-luna" and response.json()["reasoning_effort"] == "max"
    assert client.patch(f"/api/v1/conversations/{cid}/model", json={**selection, "reasoning_effort": "low", "base_revision": 1}).status_code == 409
    assert client.post(f"/api/v1/conversations/{cid}/messages", json=body).status_code == 200
    assert client.post(f"/api/v1/conversations/{cid}/messages", json={**body, "model_revision": 0}).status_code == 409
    with db.connect() as connection:
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("UPDATE conversation_turns SET reasoning_effort='low' WHERE id=?", (tid,))
    conversation_store.start_turn(cid, tid)
    conversation_store.finish_turn(cid, tid, 0, "succeeded", "已完成", {})
    client.patch(f"/api/v1/conversations/{cid}/model", json={**selection, "reasoning_effort": "low", "base_revision": 1})
    assert client.get(f"/api/v1/conversations/{cid}/turns/{tid}").json()["reasoning_effort"] == "max"
    assert client.get("/api/v1/conversations").json()["items"][0]["reasoning_effort"] == "low"


def test_legacy_message_and_nested_creation_transaction(client):
    cid = create(client).json()["id"]
    accepted = client.post(f"/api/v1/conversations/{cid}/messages", json={"client_message_id": "legacy", "base_revision": 0, "content": "读取资料"})
    assert accepted.status_code == 202, accepted.text
    with pytest.raises(RuntimeError):
        with db.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            nested = conversation_store.create_conversation("news", _connection=connection)
            raise RuntimeError("rollback parent transaction")
    with pytest.raises(conversation_store.ConversationNotFound):
        conversation_store.get_conversation(nested["id"])


def test_free_policy_cannot_be_bypassed_by_allowlist(client, monkeypatch):
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {"account_tier": "free", "allowed_models": ["gpt-6-astra"], "reasoning_efforts": {}})
    assert create(client, model_id="gpt-6-astra").status_code == 422
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {"account_tier": "paid", "allowed_models": ["gpt-6-astra"], "reasoning_efforts": {}})
    assert create(client, model_id="gpt-6-astra", reasoning_effort="low").status_code == 200


def test_queued_turn_rechecks_account_policy_before_model_execution(client, monkeypatch, tmp_path):
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {"account_tier": "paid", "allowed_models": [], "reasoning_efforts": {}})
    cid = create(client, model_id="gpt-6-astra", reasoning_effort="low").json()["id"]
    turn = conversation_store.add_user_message(cid, "paid-before-downgrade", 0, "读取资料")
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {"account_tier": "free", "allowed_models": [], "reasoning_efforts": {}})
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
    monkeypatch.setattr(codex_runtime, "_sdk", lambda: (None,) * 6)
    monkeypatch.setattr(codex_runtime.research_workspace, "prepare", lambda *_: {"workspace": str(tmp_path)})
    with pytest.raises(codex_runtime.CodexRuntimeError, match="Free"):
        codex_runtime.run_conversation_turn(cid, turn["turn_id"])


@pytest.mark.parametrize("old_model", ["gpt-6-astra", "retired-custom-model"])
@pytest.mark.parametrize("has_turn_result", [True, False])
def test_existing_model_evidence_survives_migration_without_silent_default_substitution(tmp_path, monkeypatch, old_model, has_turn_result):
    current_migrations = _prepare_legacy_database(tmp_path, monkeypatch)
    now = db.utc_now()
    with db.connect() as connection:
        connection.execute("INSERT INTO conversations(id,entry_scope,research_mode,research_depth,created_at,updated_at) VALUES('legacy','news','advanced','deep',?,?)", (now, now))
        connection.execute("INSERT INTO codex_threads(conversation_id,thread_id,model,created_at,updated_at) VALUES('legacy','legacy-thread',?,?,?)", (old_model, now, now))
        connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES('legacy-question','legacy','user','旧研究问题',?)", (now,))
        result = {"model": old_model, "reasoning_effort": "max"} if has_turn_result else {}
        connection.execute("""INSERT INTO conversation_turns(id,conversation_id,user_message_id,base_revision,state,research_depth,result_json,created_at,updated_at)
                              VALUES('legacy-turn','legacy','legacy-question',0,'succeeded','deep',?,?,?)""", (db.json_dump(result), now, now))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", current_migrations)
    db.init_db()
    conversation = conversation_store.get_conversation("legacy")
    assert conversation["model_id"] == old_model
    assert conversation["turns"][0]["model_id"] == old_model
    assert conversation["turns"][0]["reasoning_effort"] == "max"
    with pytest.raises(conversation_store.ConversationStoreError):
        conversation_store.add_user_message("legacy", "must-not-fallback", 0, "继续分析", model_revision=0)


def _prepare_legacy_database(tmp_path, monkeypatch):
    current_migrations = db.MIGRATIONS_DIR
    legacy_migrations = tmp_path / "legacy-migrations"
    legacy_migrations.mkdir()
    for migration in current_migrations.glob("*.sql"):
        if migration.name < "031":
            shutil.copy2(migration, legacy_migrations / migration.name)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "legacy-model.db")
    monkeypatch.setattr(db, "MIGRATIONS_DIR", legacy_migrations)
    monkeypatch.setattr(research_models, "llm_settings", lambda: {"configured": True, "model": "gpt-6-luna", "reasoning_effort": "high"})
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {"account_tier": "free", "allowed_models": [], "reasoning_efforts": {}})
    monkeypatch.setattr(research_models, "_discover", lambda _: ({"gpt-6-luna", "gpt-5.6-luna", "gpt-6-astra"}, "verified"))
    db.init_db()
    return current_migrations


@pytest.mark.parametrize("latest_result", ['broken-json', 'null', '[]', '{"model":null}', '{"model":""}', '{"model":"   "}', '{"model":42}', '{"model":"https://private@example.com","reasoning_effort":"invalid"}'])
def test_migration_handles_invalid_evidence_and_prefers_actual_turn_over_thread_binding(tmp_path, monkeypatch, latest_result):
    current_migrations = _prepare_legacy_database(tmp_path, monkeypatch)
    now = db.utc_now()
    with db.connect() as connection:
        connection.execute("INSERT INTO conversations(id,entry_scope,created_at,updated_at) VALUES('legacy','news',?,?)", (now, now))
        connection.execute("INSERT INTO codex_threads(conversation_id,thread_id,model,created_at,updated_at) VALUES('legacy','thread','gpt-6-astra',?,?)", (now, now))
        for key, result in [("actual", '{"model":"gpt-5.6-luna","reasoning_effort":"low"}'), ("latest", latest_result)]:
            connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES(?,'legacy','user','旧问题',?)", (key, now))
            connection.execute("""INSERT INTO conversation_turns(id,conversation_id,user_message_id,base_revision,state,research_depth,result_json,created_at,updated_at)
                                  VALUES(?,'legacy',?,0,'succeeded','deep',?,?,?)""", (key, key, result, now, now))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", current_migrations)
    db.init_db()
    # Inspect snapshots directly: old malformed result JSON is intentionally not
    # interpreted by the model migration and must not block the upgrade.
    with db.connect() as connection:
        conversation = connection.execute("SELECT * FROM conversations WHERE id='legacy'").fetchone()
        actual = connection.execute("SELECT * FROM conversation_turns WHERE id='actual'").fetchone()
        latest = connection.execute("SELECT * FROM conversation_turns WHERE id='latest'").fetchone()
    assert conversation["model_id"] == actual["model_id"] == "gpt-5.6-luna"
    assert conversation["reasoning_effort"] == actual["reasoning_effort"] == "low"
    assert latest["model_id"] == "gpt-6-astra" and latest["reasoning_effort"] == "max"


def test_evidence_free_legacy_default_is_pinned_when_first_new_message_is_sent(tmp_path, monkeypatch):
    current_migrations = _prepare_legacy_database(tmp_path, monkeypatch)
    now = db.utc_now()
    with db.connect() as connection:
        connection.execute("INSERT INTO conversations(id,entry_scope,research_depth,created_at,updated_at) VALUES('legacy','news','deep',?,?)", (now, now))
    monkeypatch.setattr(db, "MIGRATIONS_DIR", current_migrations)
    db.init_db()
    old = conversation_store.get_conversation("legacy")
    assert old["model_id"] == "gpt-6-luna" and old["reasoning_effort"] == "max"
    turn = conversation_store.add_user_message("legacy", "first-new-message", 0, "开始分析", model_revision=0)
    monkeypatch.setattr(research_models, "llm_settings", lambda: {"configured": True, "model": "gpt-5.6-luna", "reasoning_effort": "low"})
    current = conversation_store.get_conversation("legacy")
    assert current["model_id"] == "gpt-6-luna" and current["reasoning_effort"] == "max"
    assert conversation_store.get_turn("legacy", turn["turn_id"])["model_id"] == "gpt-6-luna"


def test_message_retry_retains_original_frozen_model_after_user_switches_models(client):
    cid = create(client, model_id="gpt-5.6-luna", reasoning_effort="low").json()["id"]
    body = {"client_message_id": "already-accepted", "base_revision": 0, "content": "读取资料", "model_revision": 0}
    accepted = client.post(f"/api/v1/conversations/{cid}/messages", json=body).json()
    conversation_store.start_turn(cid, accepted["turn_id"])
    conversation_store.finish_turn(cid, accepted["turn_id"], 0, "succeeded", "已完成", {})
    assert client.patch(f"/api/v1/conversations/{cid}/model", json={"model_id": "gpt-6-luna", "reasoning_effort": "high", "base_revision": 0}).status_code == 200
    replay = client.post(f"/api/v1/conversations/{cid}/messages", json=body)
    assert replay.status_code == 200
    assert replay.json()["turn_id"] == accepted["turn_id"]
    assert replay.json()["model_id"] == "gpt-5.6-luna" and replay.json()["reasoning_effort"] == "low"
    assert client.post(f"/api/v1/conversations/{cid}/messages", json={**body, "client_message_id": "new-stale"}).status_code == 409
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM conversation_turns WHERE conversation_id=?", (cid,)).fetchone()[0] == 1


@pytest.mark.parametrize("model", ["gpt-6-astra", "gpt-6-sol", "unknown-model"])
def test_launch_refuses_forbidden_models_atomically(client, monkeypatch, model):
    from apps.api.app import research_assistant_runs
    monkeypatch.setattr(research_assistant_runs, "research_web_search_mode", lambda: "live")
    response = client.post("/api/v1/research-assistants/daily-hotspots/launch", json={"request_id": "forbidden-model", "model_id": model, "reasoning_effort": "high"})
    assert response.status_code == 422, response.text
    with db.connect() as connection:
        for table in ["conversations", "conversation_messages", "conversation_turns", "research_assistant_launches"]:
            assert connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
