from __future__ import annotations

from pathlib import Path
from threading import Event, Thread
import time

from fastapi.testclient import TestClient
import pytest

from apps.api.app import codex_runtime, conversation_store, db, jobs, main, market, program_conditions, research_scan_service, research_turn_service, research_workspace, runtime_executor, screening_service, worker
from apps.api.app.screening_contracts import CustomProgram, ScreeningTaskRevision
from apps.api.app.screening_tools import ToolContext, registry
from apps.api.app.tool_protocol import ToolCall


@pytest.fixture
def research(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "research.db")
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
    monkeypatch.setattr(market, "daily_bar_source_available", lambda: True)
    monkeypatch.setattr(market, "source_fingerprint", lambda: ("synthetic.parquet", 1000, 123))
    monkeypatch.setattr(market, "cached_profile", lambda: {"available": True, "last_date": "2026-09-14"})
    monkeypatch.setattr(market, "latest_market_date", lambda _: "2026-09-14")
    monkeypatch.setattr(market, "security_codes", lambda _: ["600000.SH"])
    monkeypatch.setattr(market, "iter_recent_bars", lambda *_: iter([]))
    db.init_db()
    cid = conversation_store.create_conversation("screening", workflow_type="research")["id"]
    msg = conversation_store.add_user_message(cid, "request", 0, "验证研究方法。")
    return cid, msg["turn_id"]


def test_unavailable_runtime_does_not_claim_or_queue_the_turn(research, monkeypatch):
    cid, tid = research
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": False, "reason": "runtime missing"})
    with TestClient(main.app) as client:
        response = client.post(f"/api/v1/conversations/{cid}/turns/{tid}/process")
    assert response.status_code == 503
    turn = conversation_store.get_turn(cid, tid)
    assert turn["state"] == "awaiting_agent" and turn["job"] is None


@pytest.mark.parametrize("running", [False, True])
def test_stop_turn_atomically_cancels_its_job_and_preserves_outputs(research, running):
    cid, tid = research
    turn = research_turn_service.enqueue_turn(cid, tid)
    lease = jobs.claim(turn["job"]["id"]) if running else None
    if running:
        conversation_store.start_turn(cid, tid)
    output = research_workspace.write_output(cid, "partial.md", "Research checkpoint")
    with TestClient(main.app) as client:
        route = f"/api/v1/conversations/{cid}/turns/{tid}"
        cancelled = client.post(route + "/cancel")
        assert cancelled.json()["state"] == "cancelled"
        assert cancelled.json()["job"]["state"] == "cancelled"
        assert client.post(route + "/cancel").json()["state"] == "cancelled"
        assert client.post(route + "/process").status_code == 200
    assert Path(output["path"]).read_text() == "Research checkpoint"
    assert jobs.claim(turn["job"]["id"]) is None
    if lease:
        assert lease.finish("succeeded", "late") is False
    with pytest.raises(conversation_store.ConversationConflict):
        conversation_store.finish_turn(cid, tid, 0, "succeeded", "late", {})
    assert conversation_store.add_user_message(cid, "followup", 0, "继续研究")["state"] == "awaiting_agent"


def test_job_cancellation_also_cancels_the_conversation_turn(research):
    cid, tid = research
    turn = research_turn_service.enqueue_turn(cid, tid)
    assert jobs.cancel(turn["job"]["id"])["state"] == "cancelled"
    assert conversation_store.get_turn(cid, tid)["state"] == "cancelled"


def test_expired_codex_job_is_failed_without_replaying_and_rejects_late_tools(research):
    cid, tid = research
    turn = research_turn_service.enqueue_turn(cid, tid)
    old_lease = jobs.claim(turn["job"]["id"])
    conversation_store.start_turn(cid, tid)
    with db.connect() as connection:
        connection.execute("UPDATE jobs SET lease_expires_at='2000-01-01' WHERE id=?", (old_lease.id,))
    rejected = registry.dispatch(ToolCall("late", "get_research_state", {}), ToolContext(cid, tid, 0, workflow_type="research"))
    assert rejected["error"]["code"] == "conversation_turn_inactive"
    assert jobs.claim(old_lease.id) is None
    interrupted = conversation_store.get_turn(cid, tid)
    assert interrupted["state"] == interrupted["job"]["state"] == "failed"
    assert interrupted["result"]["error_code"] == "turn_interrupted"
    assert old_lease.finish("succeeded", "late") is False
    assert conversation_store.add_user_message(cid, "followup", 0, "接着研究")["state"] == "awaiting_agent"


def test_failure_before_start_releases_the_queued_turn_and_job(research, monkeypatch):
    cid, tid = research
    queued = research_turn_service.enqueue_turn(cid, tid)
    def fail_start(*_):
        raise conversation_store.ConversationConflict("启动失败")
    monkeypatch.setattr(conversation_store, "start_turn", fail_start)
    worker.execute_job(queued["job"]["id"])
    failed = conversation_store.get_turn(cid, tid)
    assert failed["state"] == failed["job"]["state"] == "failed"
    assert "启动失败" in failed["response_text"]


def test_background_codex_can_wait_for_scan_without_blocking_computation(research, monkeypatch):
    cid, tid = research
    queued = research_turn_service.enqueue_turn(cid, tid)
    stop, completed = Event(), Event()
    observed = {}
    def evaluate(_condition, _reference, codes, _bars, **_kwargs):
        return {code: {"state": "true", "evaluation_status": "completed", "reason_code": "condition_met"} for code in codes}
    monkeypatch.setattr(program_conditions, "evaluate_batch", evaluate)
    def process(conversation_id, turn_id):
        scan = research_scan_service.enqueue_scan(conversation_id, turn_id, name="并行研究", as_of=None,
            universe="all_a_shares", stock_codes=[], program=CustomProgram.model_validate({
                "contract_version": "python-screen-v1", "source_code": "def screen(context, frames, params):\n    return {}",
                "required_fields": ["close"], "required_history_bars": 1}))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            saved = research_scan_service.get_scan(conversation_id, scan["scan_id"])
            if saved["status"] == "succeeded":
                observed["scan"] = saved
                break
            time.sleep(0.01)
        else:
            raise AssertionError("scan was blocked by the waiting Codex turn")
        conversation_store.finish_turn(conversation_id, turn_id, 0, "succeeded", "计算完成", {})
        completed.set()
        return conversation_store.get_turn(conversation_id, turn_id)
    monkeypatch.setattr(codex_runtime, "process_conversation_turn", process)
    thread = Thread(target=worker.run_worker, kwargs={"poll_seconds": 0.01, "stop_event": stop})
    thread.start()
    try:
        assert completed.wait(8)
        deadline = time.monotonic() + 2
        while conversation_store.get_turn(cid, tid)["job"]["state"] == "running" and time.monotonic() < deadline:
            time.sleep(0.01)
        assert observed["scan"]["status"] == "succeeded"
        assert conversation_store.get_turn(cid, tid)["job"]["state"] == "succeeded"
    finally:
        stop.set()
        thread.join(timeout=3)
    assert not thread.is_alive()


def test_authorized_screening_handoff_runs_without_a_browser(research, monkeypatch):
    cid, tid = research
    monkeypatch.setattr(runtime_executor, "readiness", lambda: {"ready": True})
    conversation_store.finish_turn(cid, tid, 0, "cancelled", "准备正式筛选测试", {})
    conversation_store.update_workflow(cid, workflow_type="screening", base_revision=0)
    tid = conversation_store.add_user_message(cid, "execute", 0, "收盘价大于10，筛一下")["turn_id"]
    queued = research_turn_service.enqueue_turn(cid, tid)
    def process(conversation_id, turn_id):
        message = conversation_store.get_turn(conversation_id, turn_id)["user_message_id"]
        task = ScreeningTaskRevision.model_validate({
            "task_id": cid, "revision": 1, "original_user_messages": ["收盘价大于10，筛一下"],
            "conditions": [{"condition_id": "price", "library": "technical", "source_quote": "收盘价", "description": "价格实验",
                            "program": {"contract_version": "python-screen-v1", "source_code": "def screen(context, frames, params):\n    return {}",
                                        "required_fields": ["close"], "required_history_bars": 1},
                            "implementation_id": "llm-python-screen", "implementation_version": "python-screen-v1"}],
            "references": [{"reference_id": "price-ref", "condition_id": "price"}],
            "logic_tree": {"op": "condition", "reference_id": "price-ref"},
            "scope": {"universe": {"kind": "all_a_shares", "stock_codes": []}, "as_of": "2026-09-14"},
        })
        conversation_store.save_task_revision(cid, 0, message, task, turn_id=tid)
        conversation_store.finish_turn(cid, tid, 1, "succeeded", "执行已授权", {
            "ready_to_execute": True, "execution_authorized": True, "execution_authorization_message_id": message,
            "task_revision": 1}, pending_execute_message_id=message)
        return conversation_store.get_turn(cid, tid)
    monkeypatch.setattr(codex_runtime, "process_conversation_turn", process)
    worker.execute_job(queued["job"]["id"])
    runs = screening_service.list_task_runs(cid)
    assert len(runs) == 1 and runs[0]["status"] == "queued"
    assert conversation_store.get_conversation(cid)["pending_execution"] is False
    assert research_turn_service.enqueue_turn(cid, tid)["job"]["state"] == "succeeded"
    assert len(screening_service.list_task_runs(cid)) == 1
