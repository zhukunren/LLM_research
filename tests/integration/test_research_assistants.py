from pathlib import Path
from types import SimpleNamespace
import json
import sqlite3

from fastapi.testclient import TestClient
import pytest

from apps.api.app import codex_runtime, conversation_store, db, main, market, research_assistants


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "assistants.db")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "missing.parquet")
    with TestClient(main.app) as session:
        yield session


def create(client, assistant="general", workflow="research"):
    return client.post("/api/v1/conversations", json={"entry_scope": "screening", "workflow_type": workflow, "assistant_id": assistant})


def message(client, cid, key="request", revision=0):
    return client.post(f"/api/v1/conversations/{cid}/messages", json={"client_message_id": key, "base_revision": 0, "content": "核对经营证据", "assistant_revision": revision})


def custom(client, instructions="先核对现金回款，再解释利润。"):
    result = client.post("/api/v1/research-assistants", json={"name": "现金流核验", "description": "核验现金回款", "instructions": instructions})
    assert result.status_code == 201, result.text
    return result.json()


def update(client, profile, **changes):
    body = {key: profile[key] for key in ("name", "description", "instructions", "enabled")}
    return client.put(f"/api/v1/research-assistants/{profile['id']}", json={**body, "base_revision": profile["revision"], **changes})


def finish(cid, tid):
    conversation_store.start_turn(cid, tid)
    conversation_store.finish_turn(cid, tid, 0, "succeeded", "已核验。", {})


@pytest.mark.parametrize("assistant", ["general", "financial", "reports", "supply-chain", "risk"])
def test_presets_are_selectable_and_message_snapshots_are_immutable(client, tmp_path, assistant):
    catalog = client.get("/api/v1/research-assistants").json()
    assert catalog["default_id"] == "general"
    assert {item["id"] for item in catalog["items"]} >= {"general", "financial", "reports", "supply-chain", "risk"}
    response = create(client, assistant)
    assert response.status_code == 200, response.text
    cid = response.json()["id"]
    accepted = message(client, cid)
    assert accepted.status_code == 202, accepted.text
    tid = accepted.json()["turn_id"]
    restored = client.get(f"/api/v1/conversations/{cid}").json()
    assert restored["assistant"]["id"] == assistant
    assert restored["turns"][0]["assistant"] == restored["assistant"]
    assert "skill_content" not in restored["assistant"]
    snapshot = research_assistants.turn_snapshot(cid, tid)
    path = research_assistants.materialize_skill(tmp_path / "work", snapshot)
    assert path.read_text(encoding="utf-8") == snapshot["skill_content"]
    assert snapshot["skill_hash"] == path.parent.name
    with db.connect() as connection:
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("UPDATE conversation_turns SET assistant_snapshot_json='{}' WHERE id=?", (tid,))


def test_custom_versions_are_pinned_and_switching_checks_idle_state_and_revision(client):
    profile = custom(client)
    cid = create(client, profile["id"]).json()["id"]
    original = message(client, cid).json()
    first = research_assistants.turn_snapshot(cid, original["turn_id"])
    changed = update(client, profile, instructions="改用新的研究方法。")
    assert changed.status_code == 200 and changed.json()["revision"] == 2
    assert first == research_assistants.turn_snapshot(cid, original["turn_id"])
    assert client.get(f"/api/v1/conversations/{cid}").json()["assistant"]["revision"] == 1
    assert client.patch(f"/api/v1/conversations/{cid}/assistant", json={"assistant_id": profile["id"], "base_revision": 0}).status_code == 409
    finish(cid, original["turn_id"])
    selected = client.patch(f"/api/v1/conversations/{cid}/assistant", json={"assistant_id": profile["id"], "base_revision": 0})
    assert selected.status_code == 200 and selected.json()["assistant"]["revision"] == 2
    assert selected.json()["assistant_revision"] == 1
    assert message(client, cid, key="stale", revision=0).status_code == 409
    replay = message(client, cid)
    assert replay.status_code == 200 and replay.json()["assistant"]["revision"] == 1
    assert message(client, cid, revision=1).status_code == 409
    second = message(client, cid, key="fresh", revision=1)
    assert second.status_code == 202 and second.json()["assistant"]["revision"] == 2
    assert update(client, profile, name="过期覆盖").status_code == 409


def test_disabling_hides_new_choices_without_breaking_existing_conversations(client):
    profile = custom(client)
    cid = create(client, profile["id"]).json()["id"]
    disabled = update(client, profile, enabled=False)
    assert disabled.status_code == 200
    assert profile["id"] not in {item["id"] for item in client.get("/api/v1/research-assistants").json()["items"]}
    assert profile["id"] in {item["id"] for item in client.get("/api/v1/research-assistants?include_disabled=true").json()["items"]}
    assert create(client, profile["id"]).status_code == 422
    assert message(client, cid).status_code == 202
    assert client.get(f"/api/v1/conversations/{cid}").json()["assistant"]["id"] == profile["id"]


def test_presets_are_readonly_and_selection_cannot_change_screening_permissions(client):
    general = client.get("/api/v1/research-assistants").json()["items"][0]
    assert update(client, general, instructions="改写内置助手").status_code == 409
    assert create(client, "../other").status_code == 422
    assert create(client, "financial", "screening").status_code == 422
    cid = create(client, "financial").json()["id"]
    assert client.patch(f"/api/v1/conversations/{cid}/workflow", json={"workflow_type": "screening"}).status_code == 200
    restored = client.get(f"/api/v1/conversations/{cid}").json()
    assert restored["assistant"]["id"] == "general"
    assert client.patch(f"/api/v1/conversations/{cid}/assistant", json={"assistant_id": "risk", "base_revision": 1}).status_code == 422
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM screening_task_runs").fetchone()[0] == 0


def test_custom_creation_retries_do_not_duplicate_and_invalid_content_is_rejected(client):
    body = {"name": "原文核对", "description": "", "instructions": "核对原文。", "request_id": "retry-create"}
    first = client.post("/api/v1/research-assistants", json=body)
    second = client.post("/api/v1/research-assistants", json=body)
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert client.post("/api/v1/research-assistants", json={**body, "instructions": "不同内容"}).status_code == 409
    assert client.post("/api/v1/research-assistants", json={"name": " ", "instructions": " "}).status_code == 422
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM research_assistants").fetchone()[0] == 1


def test_migration_preserves_existing_conversation_and_message_rows(tmp_path, monkeypatch):
    import shutil
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    source = db.MIGRATIONS_DIR
    for file in source.glob("*.sql"):
        if file.name < "030_research_assistants.sql":
            shutil.copyfile(file, migrations / file.name)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "legacy.db")
    monkeypatch.setattr(db, "MIGRATIONS_DIR", migrations)
    db.init_db()
    with db.connect() as connection:
        connection.execute("INSERT INTO conversations(id,entry_scope,created_at,updated_at) VALUES('old','screening','2026-10-01','2026-10-01')")
        connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES('old-message','old','user','保留已有研究','2026-10-01')")
    shutil.copyfile(source / "030_research_assistants.sql", migrations / "030_research_assistants.sql")
    db.init_db()
    restored = conversation_store.get_conversation("old")
    assert restored["assistant"]["id"] == "general" and restored["assistant_revision"] == 0
    assert restored["messages"][0]["content"] == "保留已有研究"


def test_runtime_loads_the_frozen_selected_skill_not_the_later_edit(client, tmp_path, monkeypatch):
    import openai_codex
    profile = custom(client, "ASSISTANT_VERSION_ONE：先核对原始现金流量表。")
    cid = create(client, profile["id"]).json()["id"]
    tid = message(client, cid).json()["turn_id"]
    conversation_store.start_turn(cid, tid)
    assert update(client, profile, instructions="ASSISTANT_VERSION_TWO：已更新的方法。").status_code == 200
    captured = {}

    class FakeCodex:
        def __init__(self, config): self._client = SimpleNamespace()
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def thread_start(self, **kwargs): return SimpleNamespace(id="assistant-thread", turn=self.turn)
        def turn(self, inputs, **kwargs):
            captured["skill"] = Path(inputs[0].path).read_text(encoding="utf-8")
            captured["prompt"] = json.loads(inputs[1].text)
            events = [SimpleNamespace(method="item/completed", payload={"item": {"type": "agentMessage", "phase": "final_answer", "text": "已核验。"}}), SimpleNamespace(method="turn/completed", payload={"turn": {"status": "completed"}})]
            return SimpleNamespace(id="native-turn", stream=lambda: iter(events))

    monkeypatch.setenv("LLMR_CODEX_HOME", str(tmp_path / "codex-state"))
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
    monkeypatch.setattr(codex_runtime, "llm_settings", lambda: {"model": "test-model", "base_url": "https://example.invalid", "api_key": "test-key", "reasoning_effort": "high"})
    monkeypatch.setattr(codex_runtime, "_sdk", lambda: (openai_codex.ApprovalMode, FakeCodex, openai_codex.CodexConfig, openai_codex.Sandbox, openai_codex.SkillInput, openai_codex.TextInput))
    assert codex_runtime.run_conversation_turn(cid, tid)["response"] == "已核验。"
    assert "ASSISTANT_VERSION_ONE" in captured["skill"] and "ASSISTANT_VERSION_TWO" not in captured["skill"]
    assert captured["prompt"]["research_assistant"]["id"] == profile["id"]
    assert captured["prompt"]["research_assistant"]["revision"] == 1
    assert captured["prompt"]["workflow_type"] == "research"
