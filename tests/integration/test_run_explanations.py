from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from apps.api.app import db, jobs, main, market, screening_execution, worker


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "explain.db")
    monkeypatch.setattr(market, "daily_bar_source_available", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(market, "source_fingerprint", lambda: (str(tmp_path / "bars.parquet"), 12, 1))
    monkeypatch.setattr(market, "cached_profile", lambda: {"available": True, "last_date": "2026-09-14"})
    monkeypatch.setattr(market, "latest_market_date", lambda _as_of: "2026-09-14")
    monkeypatch.setattr(market, "security_codes", lambda _as_of: ["600000.SH", "600001.SH"])
    with TestClient(main.app) as session:
        yield session


def _authorized(client):
    conversation = client.post("/api/v1/conversations", json={"entry_scope": "screening", "workflow_type": "screening"}).json()
    prompt = "收盘价高于20日均线，筛一下"
    message = client.post(f"/api/v1/conversations/{conversation['id']}/messages", json={
        "client_message_id": "explain-message", "base_revision": 0, "content": prompt,
    }).json()
    task = {
        "task_id": conversation["id"], "revision": 1, "original_user_messages": [prompt],
        "conditions": [{"condition_id": "ma-close", "library": "technical", "source_quote": "收盘价高于20日均线",
                        "expression": {"op": "indicator_compare", "window": 20}, "description": "收盘价高于20日均线"}],
        "references": [{"reference_id": "r-ma", "condition_id": "ma-close"}],
        "logic_tree": {"op": "condition", "reference_id": "r-ma"},
        "scope": {"universe": {"kind": "all_a_shares", "watchlist_id": None, "stock_codes": []},
                  "as_of": "2026-09-14", "report_lookback_calendar_days": None,
                  "news_lookback_calendar_days": None, "price_basis": None, "ranking": None},
        "unresolved": [],
    }
    saved = client.post(f"/api/v1/conversations/{conversation['id']}/revisions", json={
        "base_revision": 0, "source_message_id": message["message_id"], "task": task,
    })
    assert saved.status_code == 201, saved.text
    from apps.api.app import conversation_store
    conversation_store.finish_turn(conversation["id"], message["turn_id"], 1, "succeeded", "已确认", {
        "intent": "execute", "intent_message_id": message["message_id"],
        "execution_authorization_message_id": message["message_id"], "task_revision": 1,
        "execution_authorized": True, "ready_to_execute": True, "tool_call_ids": [], "model_metadata": {},
    }, pending_execute_message_id=message["message_id"])
    return conversation["id"], message["turn_id"]


def test_explanation_reads_saved_decision_after_current_market_changes(client, monkeypatch):
    conversation_id, turn_id = _authorized(client)
    def evaluate(condition, reference, stock_code, as_of):
        return {"stock_code": stock_code, "condition_id": condition["condition_id"],
                "reference_id": reference["reference_id"], "state": "true" if stock_code == "600000.SH" else "false",
                "evaluation_status": "completed", "reason_code": "condition_met" if stock_code == "600000.SH" else "condition_not_met",
                "explanation": f"保存的 {as_of} 口径判断", "actual_values": {"close": 21},
                "thresholds": {"window": 20}, "units": {"close": "price"}, "data_as_of": as_of}
    monkeypatch.setattr(screening_execution, "evaluate_reference", evaluate)
    queued = client.post(f"/api/v1/conversations/{conversation_id}/turns/{turn_id}/execute")
    assert queued.status_code == 202, queued.text
    assert worker.execute_job(queued.json()["job_id"]) is True
    monkeypatch.setattr(market, "get_bars", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must not read current bars")))

    response = client.get(f"/api/v1/conversations/{conversation_id}/screening-runs/{queued.json()['run_id']}/explanation",
                          params={"stock_code": "600000.SH"})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["read_only"] is True and payload["uses_current_data"] is False
    assert payload["status"] == "succeeded"
    assert payload["decision"]["state"] == "true"
    assert payload["decision"]["condition_decisions"][0]["actual_values"] == {"close": 21}
    assert payload["task"]["scope"]["as_of"] == "2026-09-14"

    research = client.post("/api/v1/conversations", json={"entry_scope": "screening", "workflow_type": "research"}).json()
    request = {
        "client_message_id": "recheck-saved-decision", "base_revision": 0, "content": "解释这只股票入选的原始依据",
        "source_refs": [{"kind": "screening_run", "source_id": payload["run_id"], "stock_code": "600000.SH"}],
    }
    path = f"/api/v1/conversations/{research['id']}/messages"
    answer = client.post(path, json=request)
    assert answer.status_code == 202, answer.text
    frozen = answer.json()["source_refs"][0]
    assert (frozen["conversation_id"], frozen["task_revision"], frozen["as_of"], frozen["stock_code"]) == (
        conversation_id, 1, "2026-09-14", "600000.SH",
    )
    assert frozen["decision"] == payload["decision"]
    retry = client.post(path, json=request)
    assert retry.json()["turn_id"] == answer.json()["turn_id"]
    request["source_refs"][0]["stock_code"] = "600001.SH"
    assert client.post(path, json=request).status_code == 409


def test_conversation_rechecks_a_selected_batch_without_another_run(client, monkeypatch):
    from apps.api.app import conversation_store, screening_tools
    from apps.api.app.tool_protocol import ToolCall

    cid, turn_id = _authorized(client)
    monkeypatch.setattr(screening_execution, "evaluate_reference", lambda condition, reference, stock_code, as_of: {
        "stock_code": stock_code, "condition_id": condition["condition_id"], "reference_id": reference["reference_id"],
        "state": "true", "evaluation_status": "completed", "reason_code": "condition_met", "explanation": "入选原始依据",
        "actual_values": {"close": 21}, "thresholds": {"window": 20}, "units": {"close": "price"}, "data_as_of": as_of,
    })
    run_a = client.post(f"/api/v1/conversations/{cid}/turns/{turn_id}/execute").json()
    assert worker.execute_job(run_a["job_id"])
    run_b = client.post(f"/api/v1/conversations/{cid}/turns/{turn_id}/execute", json={
        "action": "button", "revision": 1, "request_id": "run-b",
    }).json()
    assert run_b["run_id"] != run_a["run_id"]
    assert worker.execute_job(run_b["job_id"])
    monkeypatch.setattr(market, "get_bars", lambda *args, **kwargs: pytest.fail("历史追问读取了当前行情"))
    message = client.post(f"/api/v1/conversations/{cid}/messages", json={
        "client_message_id": "first-match", "base_revision": 1, "content": "为什么第一只入选？把实际值和门槛都列出来。",
        "source_refs": [{"kind": "screening_run", "source_id": run_a["run_id"]}],
    }).json()
    conversation_store.start_turn(cid, message["turn_id"])
    context = screening_tools.ToolContext(cid, message["turn_id"], 1)
    result = screening_tools.registry.dispatch(ToolCall("why", "read_screening_run", {
        "run_id": None, "wait_seconds": 0, "state": "true", "query": "", "offset": 0, "limit": 1,
    }), context)
    assert result["ok"], result
    assert result["result"]["run"]["id"] == run_a["run_id"]
    assert result["result"]["decisions"]["items"][0]["condition_decisions"][0]["actual_values"] == {"close": 21}
    execute = screening_tools.registry.dispatch(ToolCall("write", "execute_screening_task", {"revision": 1}), context)
    assert execute["error"]["code"] == "execution_not_explicit"
    task = conversation_store.get_task_revision(cid, 1)
    proposed = screening_tools.registry.dispatch(ToolCall("revision", "propose_screening_task", {"task": task.model_dump(mode="json")}), context)
    assert proposed["error"]["code"] == "screening_result_read_only"
    assert len(client.get(f"/api/v1/conversations/{cid}/screening-runs").json()["items"]) == 2


def test_explanation_requires_a_saved_decision_for_requested_security(client):
    conversation_id, turn_id = _authorized(client)
    queued = client.post(f"/api/v1/conversations/{conversation_id}/turns/{turn_id}/execute").json()
    response = client.get(f"/api/v1/conversations/{conversation_id}/screening-runs/{queued['run_id']}/explanation",
                          params={"stock_code": "600099.SH"})
    assert response.status_code == 404
    assert response.json()["code"] == "decision_not_found"
