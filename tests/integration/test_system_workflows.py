from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from apps.api.app import db, jobs, main, market, report_evidence, worker


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    profile = lambda: {"available": True, "last_date": "2026-09-14", "securities": 1, "sha256": "fixture"}
    monkeypatch.setattr(market, "cached_profile", profile)
    monkeypatch.setattr(worker, "cached_profile", profile)
    monkeypatch.setattr(worker, "iter_recent_bars", lambda *_: iter([("600000.SH", [
        {"trade_date": f"2026-09-{day:02}", "close": close, "quality_valid": True}
        for day, close in enumerate([10., 10., 10., 7., 8.], start=10)
    ])]))
    with TestClient(main.app) as session:
        yield session


def create_run(client):
    condition = client.post("/api/v1/filters", json={"library": "technical", "name": "均线条件", "expression": {
        "op": "indicator_compare", "indicator": "sma", "field": "close", "window": 2, "operator": "lt", "compare_field": "close",
    }}).json()
    first = {"op": "filter_ref", "filter_id": condition["id"], "version": 1, "score_weight": 2}
    second = {**first, "parameter_overrides": {"window": 4}, "score_weight": 3}
    strategy = client.post("/api/v1/strategies", json={"name": "复用条件", "tree": {"op": "any", "children": [first, second]}, "top_n": 10}).json()
    response = client.post("/api/v1/screening-runs", json={"strategy_id": strategy["id"], "strategy_version": 1, "as_of": "2026-09-14", "mode": "exploratory"})
    assert response.status_code == 200
    return condition, strategy, response.json()


def test_parameter_overrides_execute_independently_and_versions_remain_frozen(client):
    condition, strategy, run = create_run(client)
    revised = client.post("/api/v1/filters", json={"id": condition["id"], "library": "technical", "name": "新均线", "expression": {**condition["expression"], "window": 5}})
    assert revised.json()["version"] == 2
    worker.execute_screening(run["job_id"])
    result = client.get(f"/api/v1/screening-runs/{run['id']}").json()
    assert result["status"] == "succeeded"
    hit = result["result"]["results"][0]
    assert hit["score"] == 2
    assert [item["state"] for item in hit["details"]] == ["true", "false"]
    assert [item["window"] for item in hit["details"]] == [2, 4]
    history = client.get("/api/v1/filters?include_history=true").json()["items"]
    assert len(history) == 2
    assert client.get(f"/api/v1/filters/{condition['id']}?version=1").json()["expression"]["window"] == 2
    assert client.get("/api/v1/strategies").json()["items"][0]["tree"] == strategy["tree"]


@pytest.mark.parametrize("override", [{"window": True}, {"window": 1}, {"window": 2.5}, {"op": "sql"}, []])
def test_invalid_strategy_parameters_are_rejected_before_queuing(client, override):
    condition, _, _ = create_run(client)
    response = client.post("/api/v1/strategies", json={"name": "非法覆写", "tree": {
        "op": "filter_ref", "filter_id": condition["id"], "version": 1, "parameter_overrides": override,
    }})
    assert response.status_code == 422


def test_nested_not_groups_and_duplicate_references_survive_save_and_reload(client):
    condition, _, _ = create_run(client)
    ref = {"op": "filter_ref", "filter_id": condition["id"], "version": 1}
    tree = {"op": "not", "children": [{"op": "any", "children": [ref, {"op": "not", "children": [ref]}]}]}
    saved = client.post("/api/v1/strategies", json={"name": "整体取反", "tree": tree}).json()
    restored = next(item for item in client.get("/api/v1/strategies?include_history=true").json()["items"] if item["id"] == saved["id"])
    assert restored["tree"] == tree


def test_two_workers_cannot_claim_same_job_and_expired_owner_cannot_finish(client):
    _, _, run = create_run(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        leases = list(pool.map(jobs.claim, [run["job_id"], run["job_id"]]))
    active = [lease for lease in leases if lease]
    assert len(active) == 1
    original = active[0]
    with db.connect() as connection:
        connection.execute("UPDATE jobs SET lease_expires_at='2000-01-01' WHERE id=?", (run["job_id"],))
    recovered = jobs.claim(run["job_id"])
    assert recovered and recovered.owner != original.owner
    assert not original.finish("succeeded", "stale result", {"stale": True})
    assert recovered.finish("succeeded", "recovered result", {"recovered": True})
    assert client.get(f"/api/v1/screening-runs/{run['id']}").json()["result"] == {"recovered": True}


def test_cancellation_during_last_batch_cannot_be_overwritten_by_success(client, monkeypatch):
    _, _, run = create_run(client)
    source = worker.iter_recent_bars("2026-09-14", 500)

    def cancelling_scanner(*_):
        yield from source
        jobs.cancel(run["job_id"])

    monkeypatch.setattr(worker, "iter_recent_bars", cancelling_scanner)
    worker.execute_screening(run["job_id"])
    assert client.get(f"/api/v1/jobs/{run['job_id']}").json()["state"] == "cancelled"
    assert client.get(f"/api/v1/screening-runs/{run['id']}").json()["status"] == "cancelled"


def test_retry_is_idempotent_and_preserves_original_cancelled_run(client):
    _, _, original = create_run(client)
    client.post(f"/api/v1/jobs/{original['job_id']}/cancel")
    first = client.post(f"/api/v1/jobs/{original['job_id']}/retry").json()
    again = client.post(f"/api/v1/jobs/{original['job_id']}/retry").json()
    assert first == again
    assert first["run_id"] != original["id"]
    worker.execute_screening(first["job_id"])
    assert client.get(f"/api/v1/screening-runs/{first['run_id']}").json()["status"] == "succeeded"
    assert client.get(f"/api/v1/screening-runs/{original['id']}").json()["status"] == "cancelled"


def test_early_worker_exception_fails_task_without_stalling_queue(client, monkeypatch):
    _, _, run = create_run(client)
    monkeypatch.setattr(worker, "cached_profile", lambda: (_ for _ in ()).throw(OSError("unavailable data")))
    assert worker.execute_job(run["job_id"])
    assert client.get(f"/api/v1/screening-runs/{run['id']}").json()["status"] == "failed"
    assert jobs.claim(run["job_id"]) is None


def test_empty_scan_is_partial_and_invalid_dates_return_validation_error(client, monkeypatch):
    _, strategy, run = create_run(client)
    monkeypatch.setattr(worker, "iter_recent_bars", lambda *_: iter([]))
    worker.execute_screening(run["job_id"])
    assert client.get(f"/api/v1/screening-runs/{run['id']}").json()["status"] == "partial"
    response = client.post("/api/v1/screening-runs", json={"strategy_id": strategy["id"], "strategy_version": 1, "as_of": "2026-99-99", "mode": "exploratory"})
    assert response.status_code == 422


def test_missing_data_does_not_queue_a_successful_empty_run(client, monkeypatch):
    _, strategy, _ = create_run(client)
    monkeypatch.setattr(market, "cached_profile", lambda: {"available": False})
    response = client.post("/api/v1/screening-runs", json={"strategy_id": strategy["id"], "strategy_version": 1, "as_of": "2026-09-14", "mode": "exploratory"})
    assert response.status_code == 422
    assert response.json()["code"] == "market_data_unavailable"


def test_repeated_worker_crashes_stop_automatic_requeue(client):
    _, _, run = create_run(client)
    for _ in range(jobs.MAX_ATTEMPTS):
        assert jobs.claim(run["job_id"])
        with db.connect() as connection:
            connection.execute("UPDATE jobs SET lease_expires_at='2000-01-01' WHERE id=?", (run["job_id"],))
    assert jobs.claim(run["job_id"]) is None
    assert client.get(f"/api/v1/screening-runs/{run['id']}").json()["status"] == "failed"


def test_report_job_with_no_documents_is_partial_and_can_be_reloaded(client, monkeypatch):
    monkeypatch.setattr(main, "llm_settings", lambda: {"configured": True, "model": "fixture"})
    monkeypatch.setattr(main, "model_name", lambda: "fixture")
    condition = client.post("/api/v1/filters", json={"library": "report", "name": "研报口径", "expression": {
        "op": "evidence_query", "evaluation_mode": "rubric", "combine": "all", "lookback_calendar_days": 30,
        "criteria": [{"id": "orders", "label": "订单", "question": "订单是否增长？", "signals": [], "counter_signals": []}],
    }}).json()
    evaluation = client.post(f"/api/v1/filters/{condition['id']}/evaluate-reports?version=1", json={"as_of": "2026-09-14"}).json()
    worker.execute_report_evaluation(evaluation["job_id"])
    saved = client.get(f"/api/v1/report-evaluations/{evaluation['id']}").json()
    assert saved["status"] == "partial"
    history = client.get(f"/api/v1/report-evaluations?filter_id={condition['id']}&version=1").json()
    assert history["items"][0]["id"] == evaluation["id"]
    retry = client.post(f"/api/v1/jobs/{evaluation['job_id']}/retry").json()
    assert retry["evaluation_run_id"] != evaluation["id"]


def test_cancel_during_model_call_does_not_publish_evidence_or_binding(client, monkeypatch):
    monkeypatch.setattr(main, "llm_settings", lambda: {"configured": True, "model": "fixture"})
    monkeypatch.setattr(main, "model_name", lambda: "fixture")
    monkeypatch.setattr(worker, "llm_settings", lambda: {"configured": True, "model": "fixture"})
    condition = client.post("/api/v1/filters", json={"library": "report", "name": "取消验收", "expression": {
        "op": "evidence_query", "evaluation_mode": "rubric", "combine": "all", "lookback_calendar_days": 30,
        "criteria": [{"id": "orders", "label": "订单", "question": "订单是否增长？", "signals": [], "counter_signals": []}],
    }}).json()
    with db.connect() as connection:
        connection.execute("INSERT INTO documents(id,sha256,filename,title,pages,extracted_chars,parse_status,source_path,imported_at,available_at,available_at_status) VALUES('cancel-doc','hash','report.pdf','报告',1,30,'indexed','test',?,'2026-09-10','confirmed')", (db.utc_now(),))
        connection.execute("INSERT INTO document_pages VALUES('cancel-doc',1,'600000.SH 公司订单同比增长。')")
    run = client.post(f"/api/v1/filters/{condition['id']}/evaluate-reports?version=1", json={"as_of": "2026-09-14"}).json()

    def cancelled_response(*_):
        jobs.cancel(run["job_id"])
        return {"security_candidates": [{"reported_code": "600000.SH", "role": "issuer", "page": 1, "quote": "600000.SH 公司订单同比增长。"}], "criteria_results": []}

    monkeypatch.setattr(report_evidence, "_completion", cancelled_response)
    worker.execute_report_evaluation(run["job_id"])
    assert client.get(f"/api/v1/report-evaluations/{run['id']}").json()["status"] == "cancelled"
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM report_assessment_cache").fetchone()[0] == 0
        assert connection.execute("SELECT stock_code_status FROM documents WHERE id='cancel-doc'").fetchone()[0] == "filename_candidate"


def test_concurrent_condition_saves_allocate_distinct_versions(client):
    condition, _, _ = create_run(client)
    payload = {"id": condition["id"], "library": "technical", "name": "并发编辑", "expression": condition["expression"]}
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post("/api/v1/filters", json=payload), range(2)))
    assert all(response.status_code == 200 for response in responses)
    assert {response.json()["version"] for response in responses} == {2, 3}
