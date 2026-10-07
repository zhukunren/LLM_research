from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import sqlite3

from fastapi.testclient import TestClient
import pytest

from apps.api.app import conversation_store, db, jobs, main, market, runtime_executor, screening_execution, screening_service, worker


def test_codex_executes_and_reads_results_in_same_active_turn(client, monkeypatch):
    from apps.api.app.screening_contracts import ScreeningTaskRevision
    from apps.api.app.screening_tools import ToolContext, registry
    from apps.api.app.tool_protocol import ToolCall
    cid = conversation_store.create_conversation("screening", workflow_type="screening")["id"]
    prompt = "收盘价高于20日均线，筛一下"
    msg = conversation_store.add_user_message(cid, "research-execute", 0, prompt)
    conversation_store.start_turn(cid, msg["turn_id"])
    task = ScreeningTaskRevision.model_validate(task_payload(cid, prompt))
    conversation_store.save_task_revision(cid, 0, msg["message_id"], task, turn_id=msg["turn_id"])
    context = ToolContext(cid, msg["turn_id"], 1, as_of="2026-09-14", universe_kind="all_a_shares")
    call = registry.dispatch(ToolCall("execute", "execute_screening_task", {"revision": 1}), context)
    assert call["ok"], call
    run_id = call["result"]["run_id"]
    replay = registry.dispatch(ToolCall("execute-again", "execute_screening_task", {"revision": 1}), context)
    assert replay["result"]["run_id"] == run_id
    assert conversation_store.get_pending_execute_message(cid) is None
    assert conversation_store.get_turn(cid, msg["turn_id"])["state"] == "running"
    read = registry.dispatch(ToolCall("results", "read_screening_run", {
        "run_id": run_id, "wait_seconds": 0, "state": "", "query": "", "offset": 0, "limit": 20,
    }), context)
    assert read["ok"] and read["result"]["run"]["status"] == "queued"
    assert len(screening_service.list_task_runs(cid)) == 1
    # The same original execution request can repair the program in a new revision.
    task.revision = 2
    conversation_store.save_task_revision(cid, 1, msg["message_id"], task, turn_id=msg["turn_id"])
    from dataclasses import replace
    updated_context = replace(context, task_revision=2)
    second = registry.dispatch(ToolCall("execute-repaired", "execute_screening_task", {"revision": 2}), updated_context)
    assert second["ok"] and second["result"]["run_id"] != run_id
    assert len(screening_service.list_task_runs(cid)) == 2


def test_active_research_cannot_execute_from_discussion_only(client):
    from apps.api.app.screening_contracts import ScreeningTaskRevision
    from apps.api.app.screening_tools import ToolContext, registry
    from apps.api.app.tool_protocol import ToolCall
    cid = conversation_store.create_conversation("screening", workflow_type="screening")["id"]
    prompt = "只讨论收盘价高于20日均线，不要执行"
    msg = conversation_store.add_user_message(cid, "discussion", 0, prompt)
    conversation_store.start_turn(cid, msg["turn_id"])
    conversation_store.save_task_revision(cid, 0, msg["message_id"], ScreeningTaskRevision.model_validate(task_payload(cid, prompt)))
    context = ToolContext(cid, msg["turn_id"], 1)
    result = registry.dispatch(ToolCall("execute", "execute_screening_task", {"revision": 1}), context)
    assert result["error"]["code"] == "execution_not_explicit"
    assert screening_service.list_task_runs(cid) == []


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "screening-v2.db")
    monkeypatch.setattr(market, "daily_bar_source_available", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(market, "source_fingerprint", lambda: (str(tmp_path / "synthetic.parquet"), 12_000, 123))
    monkeypatch.setattr(market, "cached_profile", lambda: {"available": True, "last_date": "2026-09-14"})
    monkeypatch.setattr(market, "latest_market_date", lambda _as_of: "2026-09-14")
    monkeypatch.setattr(market, "security_codes", lambda _as_of: ["600000.SH", "600001.SH", "600002.SH"])
    with TestClient(main.app) as session:
        yield session


def task_payload(conversation_id: str, prompt: str, *, universe=None, custom_program=False):
    condition = {
        "condition_id": "ma-close",
        "library": "technical",
        "source_quote": "收盘价高于20日均线",
        "expression": {"op": "indicator_compare", "window": 20},
        "description": "收盘价高于20日均线",
    }
    if custom_program:
        condition.update({
            "expression": {},
            "program": {
                "contract_version": "python-screen-v1",
                "source_code": "def screen(context, frames, params):\n    return {}\n",
                "required_fields": ["close"],
                "required_history_bars": 1,
                "parameters": {},
                "parameter_specs": {},
            },
            "implementation_id": "llm-python-screen",
            "implementation_version": "python-screen-v1",
        })
    return {
        "task_id": conversation_id,
        "revision": 1,
        "original_user_messages": [prompt],
        "conditions": [condition],
        "references": [{"reference_id": "r-ma", "condition_id": "ma-close"}],
        "logic_tree": {"op": "condition", "reference_id": "r-ma"},
        "scope": {
            "universe": universe or {"kind": "all_a_shares", "watchlist_id": None, "stock_codes": []},
            "as_of": "2026-09-14",
            "report_lookback_calendar_days": None,
            "news_lookback_calendar_days": None,
            "price_basis": None,
            "ranking": None,
        },
        "unresolved": [],
    }


def create_authorized_turn(client: TestClient, *, universe=None, watchlist_id=None, custom_program=False):
    conversation = client.post("/api/v1/conversations", json={"entry_scope": "screening", "workflow_type": "screening"}).json()
    prompt = "收盘价高于20日均线，筛一下"
    message_response = client.post(
        f"/api/v1/conversations/{conversation['id']}/messages",
        json={"client_message_id": "execute-message", "base_revision": 0, "content": prompt},
    )
    assert message_response.status_code == 202, message_response.text
    message = message_response.json()
    if watchlist_id:
        selected_universe = {"kind": "watchlist", "watchlist_id": watchlist_id, "stock_codes": []}
    else:
        selected_universe = universe
    saved = client.post(
        f"/api/v1/conversations/{conversation['id']}/revisions",
        json={
            "base_revision": 0,
            "source_message_id": message["message_id"],
            "task": task_payload(
                conversation["id"], prompt, universe=selected_universe, custom_program=custom_program
            ),
        },
    )
    assert saved.status_code == 201, saved.text
    conversation_store.finish_turn(
        conversation["id"],
        message["turn_id"],
        1,
        "succeeded",
        "筛选条件已确认，执行授权已记录。",
        {
            "intent": "execute",
            "intent_message_id": message["message_id"],
            "execution_authorization_message_id": message["message_id"],
            "task_revision": 1,
            "execution_authorized": True,
            "ready_to_execute": True,
            "tool_call_ids": [],
            "model_metadata": {},
        },
        pending_execute_message_id=message["message_id"],
    )
    return conversation["id"], message["turn_id"]


def test_frozen_run_uses_exact_universe_and_persists_every_stock_decision(client, monkeypatch):
    conversation_id, turn_id = create_authorized_turn(client)

    def evaluate(_condition, reference, stock_code, as_of):
        if stock_code == "600000.SH":
            state, reason, explanation = "true", "condition_met", "合成样例符合条件"
        elif stock_code == "600001.SH":
            state, reason, explanation = "false", "condition_not_met", "合成样例不符合条件"
        else:
            state, reason, explanation = "unknown", "data_missing", "合成样例缺少行情"
        return {
            "stock_code": stock_code,
            "condition_id": "ma-close",
            "reference_id": reference["reference_id"],
            "state": state,
            "evaluation_status": "completed",
            "reason_code": reason,
            "explanation": explanation,
            "data_as_of": as_of,
        }

    monkeypatch.setattr(screening_execution, "evaluate_reference", evaluate)
    queued = client.post(
        f"/api/v1/conversations/{conversation_id}/turns/{turn_id}/execute"
    )

    assert queued.status_code == 202, queued.text
    payload = queued.json()
    assert payload["status"] == "queued"
    assert payload["task_revision"] == 1
    assert client.get(f"/api/v1/conversations/{conversation_id}").json()["pending_execution"] is False
    assert worker.execute_job(payload["job_id"]) is True

    run = client.get(
        f"/api/v1/conversations/{conversation_id}/screening-runs/{payload['run_id']}"
    ).json()
    run_list = client.get(f"/api/v1/conversations/{conversation_id}/screening-runs").json()
    decisions = client.get(
        f"/api/v1/conversations/{conversation_id}/screening-runs/{payload['run_id']}/decisions"
    ).json()

    assert run["status"] == "partial", run["job"]
    assert [item["id"] for item in run_list["items"]] == [payload["run_id"]]
    assert run["universe"] == {"kind": "all_a_shares", "size": 3}
    assert run["result"]["coverage"] == {
        "target_total": 3,
        "true_count": 1,
        "false_count": 1,
        "unknown_count": 1,
        "failed_count": 0,
        "not_evaluated_count": 0,
    }
    assert [(item["stock_code"], item["state"]) for item in decisions["items"]] == [
        ("600000.SH", "true"),
        ("600001.SH", "false"),
        ("600002.SH", "unknown"),
    ]
    with pytest.raises(sqlite3.IntegrityError, match="snapshots are immutable"):
        with db.connect() as connection:
            connection.execute(
                "UPDATE screening_task_runs SET snapshot_json='{}' WHERE id=?", (payload["run_id"],)
            )
    with pytest.raises(sqlite3.IntegrityError, match="requests are immutable"):
        with db.connect() as connection:
            connection.execute(
                "UPDATE execution_requests SET request_json='{}' WHERE id=?",
                (payload["execution_request_id"],),
            )


def test_enqueue_is_concurrent_idempotent_and_old_worker_cannot_claim_protocol(client):
    conversation_id, turn_id = create_authorized_turn(client)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _index: screening_service.enqueue_turn(conversation_id, turn_id), range(4)))

    assert len({item["execution_request_id"] for item in results}) == 1
    assert len({item["run_id"] for item in results}) == 1
    assert sum(not item["idempotent_replay"] for item in results) == 1
    job_id = results[0]["job_id"]
    with pytest.raises(sqlite3.IntegrityError, match="conversation screening worker"):
        with db.connect() as connection:
            connection.execute(
                "UPDATE jobs SET state='running',lease_owner='legacy:old-worker' WHERE id=?",
                (job_id,),
            )

    lease = jobs.claim(job_id)
    assert lease is not None
    assert lease.owner.startswith("screening-task-v1:")


def create_button_turn(client, *, incomplete=False):
    from apps.api.app.screening_contracts import ScreeningTaskRevision
    cid = conversation_store.create_conversation("screening", workflow_type="screening")["id"]
    prompt = "帮我整理收盘价高于20日均线的条件，先不执行"
    message = conversation_store.add_user_message(cid, "draft", 0, prompt)
    raw = task_payload(cid, prompt)
    if incomplete:
        raw["unresolved"] = [{"kind": "clarification", "source_quote": "条件", "question": "需补充条件"}]
    conversation_store.save_task_revision(cid, 0, message["message_id"], ScreeningTaskRevision.model_validate(raw))
    conversation_store.finish_turn(cid, message["turn_id"], 1, "succeeded", "方案已整理。",
                                   {"task_revision": 1, "ready_to_execute": False, "execution_authorized": False})
    return cid, message["turn_id"]


def test_button_executes_without_language_authorization_and_retries_same_run(client):
    cid, tid = create_button_turn(client)
    url = f"/api/v1/conversations/{cid}/turns/{tid}/execute"
    before = client.get(f"/api/v1/conversations/{cid}").json()["messages"]
    assert client.post(url).status_code == 409
    payload = {"action": "button", "revision": 1, "request_id": "click-one"}
    first = client.post(url, json=payload)
    assert first.status_code == 202, first.text
    repeated = client.post(url, json=payload).json()
    assert repeated["run_id"] == first.json()["run_id"]
    assert repeated["idempotent_replay"] is True
    second_click = client.post(url, json={**payload, "request_id": "click-two"})
    assert second_click.status_code == 202
    assert second_click.json()["run_id"] != repeated["run_id"]
    after = client.get(f"/api/v1/conversations/{cid}").json()["messages"]
    assert after == before
    with db.connect() as connection:
        record = connection.execute("SELECT request_json FROM execution_requests WHERE id=?", (first.json()["execution_request_id"],)).fetchone()
    assert db.json_load(record[0])["action"] == "button"


def test_button_requires_current_revision_completed_turn_and_complete_task(client):
    cid, tid = create_button_turn(client)
    url = f"/api/v1/conversations/{cid}/turns/{tid}/execute"
    payload = {"action": "button", "revision": 1, "request_id": "click"}
    assert client.post(url, json={"action": "button"}).status_code == 422
    assert client.post(url, json={**payload, "revision": 2}).json()["code"] == "revision_conflict"
    conversation_store.add_user_message(cid, "new-message", 1, "修改条件")
    assert client.post(url, json=payload).json()["code"] == "revision_conflict"
    assert screening_service.list_task_runs(cid) == []
    incomplete_cid, incomplete_tid = create_button_turn(client, incomplete=True)
    response = client.post(f"/api/v1/conversations/{incomplete_cid}/turns/{incomplete_tid}/execute", json=payload)
    assert response.status_code == 422
    assert response.json()["code"] == "task_incomplete"


def test_button_preserves_market_fingerprint_check(client, monkeypatch):
    cid, tid = create_button_turn(client)
    def changed_source(_as_of):
        monkeypatch.setattr(market, "source_fingerprint", lambda: ("changed", 12000, 456))
        return ["600000.SH"]
    monkeypatch.setattr(market, "security_codes", changed_source)
    response = client.post(f"/api/v1/conversations/{cid}/turns/{tid}/execute",
                           json={"action": "button", "revision": 1, "request_id": "click"})
    assert response.status_code == 409
    assert response.json()["code"] == "source_changed"
    assert screening_service.list_task_runs(cid) == []


def test_watchlist_membership_is_frozen_when_the_run_is_queued(client, monkeypatch):
    with db.connect() as connection:
        connection.execute("INSERT INTO watchlists(id,name,created_at) VALUES('wl-1','冻结股票池',?)", (db.utc_now(),))
        connection.execute(
            "INSERT INTO watchlist_items(watchlist_id,stock_code,added_at) VALUES('wl-1','600000.SH',?)",
            (db.utc_now(),),
        )
    conversation_id, turn_id = create_authorized_turn(client, watchlist_id="wl-1")
    observed = []

    def evaluate(_condition, reference, stock_code, as_of):
        observed.append(stock_code)
        return {
            "stock_code": stock_code,
            "condition_id": "ma-close",
            "reference_id": reference["reference_id"],
            "state": "unknown",
            "evaluation_status": "not_evaluated",
            "reason_code": "unsupported_capability",
            "explanation": "测试执行器未计算合成条件",
            "data_as_of": as_of,
        }

    monkeypatch.setattr(screening_execution, "evaluate_reference", evaluate)
    queued = client.post(f"/api/v1/conversations/{conversation_id}/turns/{turn_id}/execute").json()
    with db.connect() as connection:
        connection.execute("DELETE FROM watchlist_items WHERE watchlist_id='wl-1'")
        connection.execute(
            "INSERT INTO watchlist_items(watchlist_id,stock_code,added_at) VALUES('wl-1','600001.SH',?)",
            (db.utc_now(),),
        )

    worker.execute_job(queued["job_id"])

    run = client.get(f"/api/v1/conversations/{conversation_id}/screening-runs/{queued['run_id']}").json()
    assert observed == ["600000.SH"]
    assert run["universe"] == {"kind": "watchlist", "size": 1}


def test_edit_after_queue_only_changes_the_next_task_revision(client, monkeypatch):
    conversation_id, turn_id = create_authorized_turn(client)
    queued = client.post(f"/api/v1/conversations/{conversation_id}/turns/{turn_id}/execute").json()
    edit_text = "把均线周期改成40日"
    edit = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"client_message_id": "edit-while-queued", "base_revision": 1, "content": edit_text},
    ).json()
    next_revision = task_payload(conversation_id, "收盘价高于20日均线，筛一下")
    next_revision["revision"] = 2
    next_revision["original_user_messages"].append(edit_text)
    next_revision["conditions"][0]["source_quote"] = edit_text
    next_revision["conditions"][0]["expression"]["window"] = 40
    next_revision["conditions"][0]["description"] = "收盘价高于40日均线"
    saved = client.post(
        f"/api/v1/conversations/{conversation_id}/revisions",
        json={"base_revision": 1, "source_message_id": edit["message_id"], "task": next_revision},
    )
    assert saved.status_code == 201, saved.text

    observed_windows = []

    def evaluate(condition, reference, stock_code, as_of):
        observed_windows.append(condition["expression"]["window"])
        return {
            "stock_code": stock_code,
            "condition_id": condition["condition_id"],
            "reference_id": reference["reference_id"],
            "state": "true",
            "evaluation_status": "completed",
            "reason_code": "condition_met",
            "explanation": "受控版本快照测试",
            "data_as_of": as_of,
        }

    monkeypatch.setattr(screening_execution, "evaluate_reference", evaluate)
    worker.execute_job(queued["job_id"])

    run = client.get(f"/api/v1/conversations/{conversation_id}/screening-runs/{queued['run_id']}").json()
    conversation = client.get(f"/api/v1/conversations/{conversation_id}").json()
    assert run["task_revision"] == 1
    assert run["task"]["conditions"][0]["expression"]["window"] == 20
    assert conversation["task_revision"] == 2
    assert observed_windows == [20, 20, 20]


def test_cancelled_run_rejects_late_worker_finalization(client):
    conversation_id, turn_id = create_authorized_turn(client)
    queued = client.post(f"/api/v1/conversations/{conversation_id}/turns/{turn_id}/execute").json()
    lease = jobs.claim(queued["job_id"])
    assert lease is not None

    assert jobs.cancel(queued["job_id"])["state"] == "cancelled"
    assert lease.finish("succeeded", "late result", result={"should_not_publish": True}, decisions=[] ) is False

    run = client.get(f"/api/v1/conversations/{conversation_id}/screening-runs/{queued['run_id']}").json()
    decisions = client.get(
        f"/api/v1/conversations/{conversation_id}/screening-runs/{queued['run_id']}/decisions"
    ).json()
    assert run["status"] == "cancelled"
    assert run["result"] == {}
    assert decisions["total"] == 0


def test_market_source_change_after_enqueue_fails_without_publishing_decisions(client, monkeypatch):
    conversation_id, turn_id = create_authorized_turn(client)
    queued = client.post(f"/api/v1/conversations/{conversation_id}/turns/{turn_id}/execute").json()
    monkeypatch.setattr(market, "source_fingerprint", lambda: ("different-synthetic-source", 999, 456))

    worker.execute_job(queued["job_id"])

    run = client.get(f"/api/v1/conversations/{conversation_id}/screening-runs/{queued['run_id']}").json()
    decisions = client.get(
        f"/api/v1/conversations/{conversation_id}/screening-runs/{queued['run_id']}/decisions"
    ).json()
    assert run["status"] == "failed"
    assert "行情来源在排队后发生变化" in run["job"]["message"]
    assert decisions["total"] == 0


def test_unavailable_condition_is_unknown_for_every_stock_not_a_false_match(client):
    conversation_id, turn_id = create_authorized_turn(client)
    queued = client.post(f"/api/v1/conversations/{conversation_id}/turns/{turn_id}/execute").json()

    worker.execute_job(queued["job_id"])
    run = client.get(f"/api/v1/conversations/{conversation_id}/screening-runs/{queued['run_id']}").json()
    decisions = client.get(
        f"/api/v1/conversations/{conversation_id}/screening-runs/{queued['run_id']}/decisions"
    ).json()

    assert run["status"] == "partial", run["job"]
    assert run["result"]["coverage"]["unknown_count"] == 3
    assert {item["state"] for item in decisions["items"]} == {"unknown"}
    assert {item["condition_decisions"][0]["reason_code"] for item in decisions["items"]} == {
        "unsupported_capability"
    }


def test_custom_program_run_is_rejected_before_enqueue_when_local_dependencies_are_unavailable(client, monkeypatch):
    conversation_id, turn_id = create_authorized_turn(client, custom_program=True)
    monkeypatch.setattr(runtime_executor, "readiness", lambda: {"ready": False, "reason": "NumPy unavailable"})

    response = client.post(f"/api/v1/conversations/{conversation_id}/turns/{turn_id}/execute")

    assert response.status_code == 503
    assert response.json()["code"] == "runtime_unavailable"
    assert client.get(f"/api/v1/conversations/{conversation_id}/screening-runs").json()["items"] == []
