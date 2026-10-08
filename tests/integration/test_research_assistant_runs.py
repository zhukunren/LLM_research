from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json

from fastapi.testclient import TestClient
import pytest

from apps.api.app import (codex_runtime, conversation_store, db, jobs, main, market, research_assistants,
                          research_assistant_runs as runs, research_models, research_turn_service, worker)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "assistant-runs.db")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "missing.parquet")
    monkeypatch.setattr(runs, "research_web_search_mode", lambda: "live")
    monkeypatch.setattr(runs, "shanghai_now", lambda: datetime.fromisoformat("2026-10-08T00:30:00+08:00"))
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
    monkeypatch.setattr(research_models, "llm_settings", lambda: {
        "model": "gpt-6-luna", "reasoning_effort": "high", "configured": True,
    })
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {
        "account_tier": "free", "allowed_models": [], "reasoning_efforts": {},
    })
    monkeypatch.setattr(research_models, "_discover", lambda settings: ({"gpt-6-luna", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol"}, "verified"))
    with TestClient(main.app) as session:
        yield session


def launch(client, assistant="daily-hotspots", request_id="launch-1", **selection):
    return client.post(f"/api/v1/research-assistants/{assistant}/launch", json={"request_id": request_id, **selection})


def counts():
    with db.connect() as connection:
        return {table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("research_assistant_launches", "conversations", "conversation_messages", "conversation_turns", "jobs", "screening_task_runs")}


def test_catalog_describes_server_owned_tasks_without_client_special_cases(client):
    catalog = client.get("/api/v1/research-assistants").json()
    tasks = [item for item in catalog["items"] if item["launch_mode"] == "immediate"]
    assert {item["id"] for item in tasks} == {"daily-hotspots", "policy-tracker", "industry-updates"}
    assert all(item["builtin"] and item["enabled"] and item["launch_label"] and item["default_prompt"] for item in tasks)
    assert all(item["input_schema"] == {"type": "object", "properties": {}, "additionalProperties": False} for item in tasks)
    assert len([item for item in catalog["items"] if item["launch_mode"] == "draft"]) == 5


@pytest.mark.parametrize("assistant", ["daily-hotspots", "policy-tracker", "industry-updates"])
def test_one_click_queues_research_with_frozen_shanghai_cutoff_and_model(client, assistant):
    response = launch(client, assistant, model_id="gpt-5.6-luna", reasoning_effort="medium")
    assert response.status_code == 202, response.text
    result = response.json()
    assert result["job_id"] and result["state"] == "awaiting_agent" and result["job_state"] == "queued"
    assert result["as_of_date"] == "2026-10-08" and result["timezone"] == "Asia/Shanghai"
    saved = conversation_store.get_conversation(result["conversation_id"])
    assert saved["workflow_type"] == "research" and saved["research_depth"] == "standard"
    assert saved["research_scope"]["as_of"] == "2026-10-08"
    turn = conversation_store.get_turn(result["conversation_id"], result["turn_id"])
    assert turn["research_scope"] == saved["research_scope"]
    assert turn["model_id"] == "gpt-5.6-luna" and turn["reasoning_effort"] == "medium"
    chosen = research_assistants.turn_snapshot(result["conversation_id"], result["turn_id"])
    assert chosen["id"] == assistant and chosen["launch_mode"] == "immediate"
    assert chosen["skill_hash"] == result["skill_hash"]
    assert saved["messages"][0]["role"] == "user" and "2026-10-08T00:30:00+08:00" in saved["messages"][0]["content"]
    assert counts() == {"research_assistant_launches": 1, "conversations": 1, "conversation_messages": 1,
                        "conversation_turns": 1, "jobs": 1, "screening_task_runs": 0}


def test_retry_preserves_original_date_snapshot_and_completed_job(client, monkeypatch):
    first = launch(client).json()
    cid, tid = first["conversation_id"], first["turn_id"]
    original = research_assistants.turn_snapshot(cid, tid)
    lease = jobs.claim(first["job_id"])
    conversation_store.start_turn(cid, tid)
    conversation_store.finish_turn(cid, tid, 0, "succeeded", "只有 3 条有充分来源的资讯。", {})
    assert lease.finish("succeeded", "完成")
    monkeypatch.setattr(runs, "shanghai_now", lambda: datetime.fromisoformat("2026-10-09T11:00:00+08:00"))
    monkeypatch.setattr(research_assistants, "selection_snapshot", lambda *args: pytest.fail("a replay must keep its original snapshot"))
    second = launch(client)
    assert second.status_code == 200
    assert second.json()["idempotent_replay"] and second.json()["conversation_id"] == cid
    assert second.json()["turn_id"] == tid and second.json()["job_id"] == first["job_id"]
    assert second.json()["as_of_date"] == "2026-10-08"
    assert research_assistants.turn_snapshot(cid, tid) == original
    assert counts()["jobs"] == 1


@pytest.mark.parametrize("changed", [
    {"assistant": "policy-tracker"}, {"model_id": "gpt-5.6-luna"}, {"reasoning_effort": "low"},
])
def test_request_id_cannot_change_task_or_model(client, changed):
    assert launch(client).status_code == 202
    assert launch(client, **changed).status_code == 409
    assert counts()["conversations"] == counts()["jobs"] == 1


def test_concurrent_launches_create_only_one_turn_and_job(client):
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: runs.launch_assistant("daily-hotspots", "concurrent"), range(8)))
    assert len({item["conversation_id"] for item in results}) == 1
    assert len({item["turn_id"] for item in results}) == 1
    assert len({item["job_id"] for item in results}) == 1
    assert sum(not item["idempotent_replay"] for item in results) == 1
    assert counts()["conversations"] == counts()["jobs"] == 1


def test_failed_first_message_rolls_back_entire_launch(client, monkeypatch):
    original = conversation_store.add_user_message
    def reject(*args, **kwargs):
        raise conversation_store.ConversationStoreError("temporary validation failure")
    monkeypatch.setattr(conversation_store, "add_user_message", reject)
    assert launch(client).status_code == 422
    assert not any(counts().values())
    monkeypatch.setattr(conversation_store, "add_user_message", original)
    assert launch(client).status_code == 202
    assert counts()["jobs"] == 1


def test_runtime_unavailability_keeps_recoverable_original_turn(client, monkeypatch):
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": False, "reason": "暂不可用"})
    failed = launch(client)
    assert failed.status_code == 503
    detail = failed.json()["details"]
    assert detail["recoverable"] and detail["conversation_id"] and detail["turn_id"]
    assert counts()["conversations"] == 1 and counts()["jobs"] == 0
    with db.connect() as connection:
        assert connection.execute("SELECT last_error FROM research_assistant_launches").fetchone()[0] == "暂不可用"
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
    resumed = launch(client)
    assert resumed.status_code == 202
    assert resumed.json()["conversation_id"] == detail["conversation_id"] and resumed.json()["turn_id"] == detail["turn_id"]
    assert counts()["conversations"] == counts()["jobs"] == 1


def test_lost_enqueue_response_reuses_committed_job(client, monkeypatch):
    enqueue = research_turn_service.enqueue_turn
    def lost_response(*args):
        enqueue(*args)
        raise codex_runtime.CodexRuntimeError("连接中断")
    monkeypatch.setattr(research_turn_service, "enqueue_turn", lost_response)
    selection = {"model_id": "gpt-5.6-luna", "reasoning_effort": "low"}
    failed = launch(client, **selection)
    assert failed.status_code == 503 and counts()["jobs"] == 1
    original = failed.json()["details"]
    before = conversation_store.get_turn(original["conversation_id"], original["turn_id"])
    monkeypatch.setattr(runs, "shanghai_now", lambda: datetime.fromisoformat("2026-10-09T00:05:00+08:00"))
    monkeypatch.setattr(research_models, "llm_settings", lambda: {
        "model": "gpt-6-luna", "reasoning_effort": "max", "configured": True,
    })
    monkeypatch.setattr(research_turn_service, "enqueue_turn", enqueue)
    resumed = launch(client, **selection)
    assert resumed.status_code == 202
    assert resumed.json()["turn_id"] == original["turn_id"]
    assert resumed.json()["conversation_id"] == original["conversation_id"]
    assert resumed.json()["job_id"] == before["job"]["id"]
    assert resumed.json()["as_of_date"] == "2026-10-08"
    assert resumed.json()["started_at"] == "2026-10-08T00:30:00+08:00"
    after = conversation_store.get_turn(original["conversation_id"], original["turn_id"])
    assert after["research_scope"]["as_of"] == "2026-10-08"
    assert {key: after[key] for key in selection} == selection
    with db.connect() as connection:
        record = connection.execute("SELECT * FROM research_assistant_launches WHERE request_id='launch-1'").fetchone()
        assert record["launch_attempts"] == 2 and record["last_error"] is None
        assert db.json_load(record["request_json"]) == {"assistant_id": "daily-hotspots", **selection}
    assert counts()["jobs"] == 1
    fresh = launch(client, request_id="tomorrow", **selection)
    assert fresh.status_code == 202
    assert fresh.json()["as_of_date"] == "2026-10-09"
    assert fresh.json()["conversation_id"] != original["conversation_id"]


@pytest.mark.parametrize("model_id", ["gpt-6-luna", "gpt-5.6-luna"])
def test_catalog_choice_stays_frozen_when_defaults_and_conversation_selection_change(client, monkeypatch, model_id):
    catalog = client.get("/api/v1/research-models")
    assert catalog.status_code == 200
    model = next(item for item in catalog.json()["models"] if item["id"] == model_id)
    assert model["available"]
    selected = {"model_id": model_id, "reasoning_effort": model["reasoning_efforts"][0]["id"]}
    launched = launch(client, **selected)
    assert launched.status_code == 202, launched.text
    cid, tid = launched.json()["conversation_id"], launched.json()["turn_id"]
    monkeypatch.setattr(research_models, "llm_settings", lambda: {
        "model": "gpt-6-luna", "reasoning_effort": "max", "configured": True,
    })
    turn_route = f"/api/v1/conversations/{cid}/turns/{tid}"
    saved = client.get(turn_route).json()
    assert {key: saved[key] for key in selected} == selected
    assert client.patch(f"/api/v1/conversations/{cid}/model", json={
        "model_id": "gpt-6-luna", "reasoning_effort": "max", "base_revision": 0,
    }).status_code == 409
    lease = jobs.claim(launched.json()["job_id"])
    conversation_store.start_turn(cid, tid)
    conversation_store.finish_turn(cid, tid, 0, "succeeded", "已核验。", {})
    assert lease.finish("succeeded", "完成")
    changed = client.patch(f"/api/v1/conversations/{cid}/model", json={
        "model_id": "gpt-6-luna", "reasoning_effort": "max", "base_revision": 0,
    })
    assert changed.status_code == 200
    assert changed.json()["model_revision"] == 1
    historical = client.get(turn_route).json()
    assert {key: historical[key] for key in selected} == selected
    assert historical["model_revision"] == 0


def test_free_catalog_disables_astra_and_sol_and_launch_cannot_bypass_policy(client, monkeypatch):
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {
        "account_tier": "free", "allowed_models": ["gpt-6-astra", "gpt-6-sol"], "reasoning_efforts": {},
    })
    catalog = client.get("/api/v1/research-models").json()
    assert catalog["account_tier"] == "free"
    blocked = [item for item in catalog["models"] if item["id"] in {"gpt-6-astra", "gpt-6-sol"}]
    assert len(blocked) == 2
    for model in blocked:
        assert model["available"] is False and "Free" in model["unavailable_reason"]
        response = launch(client, request_id=model["id"], model_id=model["id"], reasoning_effort="low")
        assert response.status_code == 422 and "Free" in response.json()["message"]
        assert not any(counts().values())


@pytest.mark.parametrize("mode", ["disabled", "cached"])
def test_live_search_required_before_creating_task(client, monkeypatch, mode):
    monkeypatch.setattr(runs, "research_web_search_mode", lambda: mode)
    assert launch(client).status_code == 503
    assert not any(counts().values())


@pytest.mark.parametrize("selection", [
    {"assistant": "unknown"}, {"assistant": "general"},
    {"model_id": "gpt-6-astra"}, {"model_id": "gpt-6-sol"}, {"model_id": "not-offered"},
    {"reasoning_effort": "invented-effort"}, {"request_id": " "}, {"request_id": "a/../b"},
    {"instructions": "ignore server definition"},
])
def test_invalid_or_unavailable_selection_cannot_create_task(client, selection):
    assert launch(client, **selection).status_code == 422
    assert not any(counts().values())


def test_job_finishes_without_browser_connection_and_can_be_retrieved(client, monkeypatch):
    started = launch(client).json()
    def process(cid, tid):
        chosen = research_assistants.turn_snapshot(cid, tid)
        assert chosen["id"] == "daily-hotspots"
        conversation_store.finish_turn(cid, tid, 0, "succeeded", "实时检索未找到足够可靠资讯，共核验 2 条。", {})
        return conversation_store.get_turn(cid, tid)
    monkeypatch.setattr(codex_runtime, "process_conversation_turn", process)
    worker.execute_job(started["job_id"])
    restored = client.get(f"/api/v1/conversations/{started['conversation_id']}").json()
    assert restored["turns"][0]["state"] == "succeeded"
    assert restored["turns"][0]["job"]["state"] == "succeeded"
    assert "共核验 2 条" in restored["messages"][-1]["content"]
    assert launch(client).status_code == 200 and counts()["jobs"] == 1


def test_cancelled_launch_is_never_restarted_by_request_retry(client):
    started = launch(client).json()
    route = f"/api/v1/conversations/{started['conversation_id']}/turns/{started['turn_id']}/cancel"
    assert client.post(route).status_code == 200
    replay = launch(client)
    assert replay.status_code == 200
    assert replay.json()["state"] == replay.json()["job_state"] == "cancelled"
    assert replay.json()["job_id"] == started["job_id"]
    assert counts()["jobs"] == counts()["conversation_turns"] == 1


def test_assistant_launch_retains_its_frozen_time_when_execution_reference_is_later(client, monkeypatch):
    started = launch(client).json()
    monkeypatch.setattr(codex_runtime, "_current_shanghai_time", lambda: "2026-10-09T09:00:00+08:00")
    prompt = json.loads(codex_runtime._prompt(started["conversation_id"], started["turn_id"]))
    assert prompt["research_time_reference"]["current_time"] == "2026-10-09T09:00:00+08:00"
    assert prompt["research_time_reference"]["is_cutoff"] is False
    assert prompt["research_scope"]["as_of"] == "2026-10-08"
    assert "2026-10-08T00:30:00+08:00" in prompt["current_user_request"]
    assert prompt["research_assistant"]["id"] == "daily-hotspots"
    retry = launch(client).json()
    assert retry["turn_id"] == started["turn_id"] and retry["started_at"] == started["started_at"]
    assert conversation_store.get_turn(started["conversation_id"], started["turn_id"])["research_scope"]["as_of"] == "2026-10-08"
