import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from apps.api.app import condition_language, db, main, market, worker


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    monkeypatch.setattr(condition_language, "llm_settings", lambda: {"configured": False})
    profile = lambda: {"available": True, "last_date": "2026-09-14", "securities": 3, "sha256": "fixture"}
    monkeypatch.setattr(market, "cached_profile", profile)
    monkeypatch.setattr(worker, "cached_profile", profile)
    monkeypatch.setattr(market, "source_fingerprint", lambda: ("fixture", 100, 1))
    monkeypatch.setattr(worker, "source_fingerprint", lambda: ("fixture", 100, 1))
    records = {
        "600000.SH": [{"close": value, "volume": 100., "quality_valid": True, "trade_date": f"2026-09-{day:02}"} for day, value in [(12, 10.), (13, 11.), (14, 12.)]],
        "600001.SH": [{"close": value, "volume": 100., "quality_valid": True, "trade_date": f"2026-09-{day:02}"} for day, value in [(12, 10.), (13, 9.), (14, 8.)]],
        "600002.SH": [{"close": 12., "volume": 100., "quality_valid": True, "trade_date": "2026-09-13"}],
    }
    monkeypatch.setattr(worker, "iter_recent_bars", lambda *_: iter(records.items()))
    monkeypatch.setattr(market, "get_bars", lambda code, *_: records.get(code, []))
    with TestClient(main.app) as session:
        yield session


def compile_and_save(client, prompt="收盘价高于2日均线且近2个交易日涨幅大于5%"):
    draft = client.post("/api/v1/condition-drafts", json={"prompt": prompt}).json()
    assert draft["status"] == "ready"
    response = client.post(f"/api/v1/condition-drafts/{draft['id']}/confirm", json={})
    assert response.status_code == 200, response.text
    return draft, response.json()


def run_strategy(client, saved, **extra):
    strategy = client.post("/api/v1/strategies", json={"name": "自然语言组合", "tree": saved["tree"], "top_n": 1}).json()
    run = client.post("/api/v1/screening-runs", json={"strategy_id": strategy["id"], "strategy_version": strategy["version"], "as_of": "2026-09-14", "mode": "exploratory", **extra})
    assert run.status_code == 200, run.text
    return run.json()


def test_condition_submissions_replay_once_even_with_concurrent_retries(client):
    _, saved = compile_and_save(client)
    body = {"name": "防重复组合", "tree": saved["tree"], "top_n": 30, "request_id": "save-once"}
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: client.post("/api/v1/strategies", json=body), range(6)))
    assert all(response.status_code == 200 for response in responses)
    strategy = responses[0].json()
    assert all(response.json() == strategy for response in responses)
    assert len(client.get("/api/v1/strategies?include_history=true").json()["items"]) == 1
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM audit_events WHERE entity_type='strategy'").fetchone()[0] == 1
    run_body = {"request_id": "run-once", "strategy_id": strategy["id"], "strategy_version": 1,
                "as_of": "2026-09-14", "mode": "exploratory"}
    with ThreadPoolExecutor(max_workers=4) as pool:
        runs = list(pool.map(lambda _: client.post("/api/v1/screening-runs", json=run_body), range(6)))
    assert all(response.status_code == 200 for response in runs)
    assert all(response.json() == runs[0].json() for response in runs)
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM screening_runs").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM jobs WHERE kind='screening'").fetchone()[0] == 1


def test_submission_ids_reject_changed_payload_and_replay_before_dynamic_checks(client, monkeypatch):
    _, saved = compile_and_save(client)
    body = {"name": "固定组合", "tree": saved["tree"], "request_id": "save-identity"}
    strategy = client.post("/api/v1/strategies", json=body).json()
    assert client.post("/api/v1/strategies", json={**body, "name": "其他组合"}).status_code == 409
    run_body = {"request_id": "run-identity", "strategy_id": strategy["id"], "strategy_version": 1,
                "as_of": "2026-09-14", "mode": "exploratory"}
    first = client.post("/api/v1/screening-runs", json=run_body)
    assert first.status_code == 200
    monkeypatch.setattr(market, "cached_profile", lambda: {"available": False})
    assert client.post("/api/v1/screening-runs", json=run_body).json() == first.json()
    assert client.post("/api/v1/screening-runs", json={**run_body, "as_of": "2026-09-13"}).status_code == 409


def test_blocked_submission_replays_without_creating_jobs(client, monkeypatch):
    _, saved = compile_and_save(client)
    strategy = client.post("/api/v1/strategies", json={"name": "正式组合", "tree": saved["tree"]}).json()
    monkeypatch.setattr(main, "_strategy_blockers", lambda *_: ["尚未确认行情口径"])
    body = {"request_id": "blocked-once", "strategy_id": strategy["id"], "strategy_version": 1, "as_of": "2026-09-14"}
    first = client.post("/api/v1/screening-runs", json=body).json()
    assert first["status"] == "blocked_dependency"
    assert client.post("/api/v1/screening-runs", json=body).json() == first
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM screening_runs").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


@pytest.mark.parametrize("scope", ["strategy", "screening"])
def test_submission_record_and_resources_rollback_together(client, monkeypatch, scope):
    _, saved = compile_and_save(client)
    strategy = client.post("/api/v1/strategies", json={"name": "原组合", "tree": saved["tree"]}).json()
    if scope == "strategy":
        path = "/api/v1/strategies"
        body = {"id": strategy["id"], "name": "新版本", "tree": saved["tree"], "request_id": "rollback"}
    else:
        path = "/api/v1/screening-runs"
        body = {"request_id": "rollback", "strategy_id": strategy["id"], "strategy_version": 1,
                "as_of": "2026-09-14", "mode": "exploratory"}
    remember = main._remember_submission
    def fail_after_record(*args):
        remember(*args)
        raise RuntimeError("simulated interrupted write")
    monkeypatch.setattr(main, "_remember_submission", fail_after_record)
    with pytest.raises(RuntimeError, match="simulated interrupted write"):
        client.post(path, json=body)
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM condition_submission_requests").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM strategies").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM screening_runs").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    monkeypatch.setattr(main, "_remember_submission", remember)
    assert client.post(path, json=body).status_code == 200


def test_full_flow_keeps_each_atom_provenance_preview_and_all_decisions(client):
    draft, saved = compile_and_save(client)
    assert len(saved["filters"]) == 2
    for item in saved["filters"]:
        assert item["provenance"]["original_prompt"] == draft["prompt"]
        assert item["provenance"]["draft_id"] == draft["id"]
        assert item["contract"]["summary"]
    preview = client.post(f"/api/v1/condition-drafts/{draft['id']}/preview", json={"stock_code": "600000.SH", "as_of": "2026-09-14"}).json()
    assert preview["state"] == "true"
    assert len(preview["details"]) == 2
    run = run_strategy(client, saved)
    worker.execute_screening(run["job_id"])
    result = client.get(f"/api/v1/screening-runs/{run['id']}").json()
    assert result["result"]["counts"] == {"evaluated": 3, "true": 1, "false": 1, "unknown": 1}
    assert result["status"] == "partial"
    for state, code in [("true", "600000.SH"), ("false", "600001.SH"), ("unknown", "600002.SH")]:
        decision = client.get(f"/api/v1/screening-runs/{run['id']}/decisions?state={state}").json()
        assert decision["total"] == 1
        item = decision["items"][0]
        assert item["stock_code"] == code
        assert item["logic"]["state"] == state
        assert len(item["details"]) == 2
        assert item["details"][0]["provenance"]["original_prompt"] == draft["prompt"]


def test_confirm_is_idempotent_and_different_confirmation_does_not_duplicate(client):
    draft, saved = compile_and_save(client)
    again = client.post(f"/api/v1/condition-drafts/{draft['id']}/confirm", json={})
    assert again.json() == saved
    conflict = client.post(f"/api/v1/condition-drafts/{draft['id']}/confirm", json={"edits": {"c1": {"name": "新名"}}})
    assert conflict.status_code == 409
    assert len(client.get("/api/v1/filters").json()["items"]) == 2


def test_unresolved_intent_cannot_save_any_partial_rule(client):
    draft = client.post("/api/v1/condition-drafts", json={"prompt": "市值小于100亿且收盘价高于20日均线"}).json()
    assert draft["status"] == "needs_clarification"
    assert client.post(f"/api/v1/condition-drafts/{draft['id']}/confirm", json={}).status_code == 422
    assert client.get("/api/v1/filters").json()["items"] == []
    legacy = client.post("/api/v1/filters/draft", json={"prompt": "收盘价高于20日均线且RSI14小于30", "library": "technical"}).json()
    assert legacy["validation"]["valid"] is False


def test_refinement_retains_original_prompt_and_rejects_bad_edits(client):
    first = client.post("/api/v1/condition-drafts", json={"prompt": "最近涨得比较好"}).json()
    second = client.post("/api/v1/condition-drafts", json={"prompt": "近5个交易日涨幅大于5%", "previous_draft_id": first["id"]}).json()
    assert second["original_prompt"] == first["prompt"]
    assert client.post(f"/api/v1/condition-drafts/{second['id']}/confirm", json={"edits": {"c1": {"parameters": {"window": 0}}}}).status_code == 422
    assert client.get("/api/v1/filters").json()["items"] == []
    saved = client.post(f"/api/v1/condition-drafts/{second['id']}/confirm", json={"edits": {"c1": {"parameters": {"value": 8}}}}).json()
    assert saved["filters"][0]["expression"]["value"] == 8
    assert saved["filters"][0]["provenance"]["original_expression"]["value"] == 5


def test_pool_membership_and_condition_versions_are_fixed_when_queued(client):
    _, saved = compile_and_save(client, "收盘价大于9元")
    pool = client.post("/api/v1/watchlists", json={"name": "测试股票池"}).json()
    client.post(f"/api/v1/watchlists/{pool['id']}/items", json={"stock_code": "600000.SH"})
    run = run_strategy(client, saved, watchlist_id=pool["id"])
    client.delete(f"/api/v1/watchlists/{pool['id']}/items/600000.SH")
    client.post(f"/api/v1/watchlists/{pool['id']}/items", json={"stock_code": "600001.SH"})
    condition = saved["filters"][0]
    update = {"id": condition["id"], "base_version": 1, "library": "technical", "name": "更高价格", "expression": {**condition["expression"], "value": 100}}
    assert client.post("/api/v1/filters", json=update).json()["version"] == 2
    assert client.post("/api/v1/filters", json=update).status_code == 409
    worker.execute_screening(run["job_id"])
    result = client.get(f"/api/v1/screening-runs/{run['id']}").json()
    assert result["context"]["universe"]["codes"] == ["600000.SH"]
    assert result["result"]["counts"]["evaluated"] == 1
    assert result["result"]["results"][0]["stock_code"] == "600000.SH"
    assert result["result"]["results"][0]["details"][0]["version"] == 1
    revised = client.get(f"/api/v1/filters/{condition['id']}").json()
    assert revised["provenance"]["original_prompt"] == "收盘价大于9元"


def test_stock_without_market_history_is_counted_unknown_and_negation_stays_unknown(client):
    _, saved = compile_and_save(client, "排除收盘价大于9元")
    pool = client.post("/api/v1/watchlists", json={"name": "待补数据池"}).json()
    with db.connect() as connection:
        connection.execute("INSERT INTO watchlist_items VALUES(?,?,?,?)", (pool["id"], "999999.SH", "fixture", db.utc_now()))
    run = run_strategy(client, saved, watchlist_id=pool["id"])
    worker.execute_screening(run["job_id"])
    result = client.get(f"/api/v1/screening-runs/{run['id']}").json()
    assert result["result"]["counts"] == {"evaluated": 1, "true": 0, "false": 0, "unknown": 1}
    assert result["result"]["unknown_sample"][0]["logic"]["state"] == "unknown"


def test_empty_pool_rejected_and_retry_preserves_snapshot(client):
    _, saved = compile_and_save(client)
    pool = client.post("/api/v1/watchlists", json={"name": "空池"}).json()
    strategy = client.post("/api/v1/strategies", json={"name": "条件", "tree": saved["tree"]}).json()
    response = client.post("/api/v1/screening-runs", json={"strategy_id": strategy["id"], "strategy_version": 1, "as_of": "2026-09-14", "mode": "exploratory", "watchlist_id": pool["id"]})
    assert response.status_code == 422
    run = run_strategy(client, saved)
    context = client.get(f"/api/v1/screening-runs/{run['id']}").json()["context"]
    client.post(f"/api/v1/jobs/{run['job_id']}/cancel")
    retry = client.post(f"/api/v1/jobs/{run['job_id']}/retry").json()
    assert client.get(f"/api/v1/screening-runs/{retry['run_id']}").json()["context"] == context


def test_changed_market_snapshot_does_not_silently_execute(client, monkeypatch):
    _, saved = compile_and_save(client)
    run = run_strategy(client, saved)
    monkeypatch.setattr(worker, "source_fingerprint", lambda: ("fixture", 200, 2))
    worker.execute_screening(run["job_id"])
    assert client.get(f"/api/v1/screening-runs/{run['id']}").json()["status"] == "failed"
    assert client.get(f"/api/v1/screening-runs/{run['id']}/decisions").json()["total"] == 0


def test_preview_and_screening_both_reject_stale_stock_prices(client):
    draft, _ = compile_and_save(client, "收盘价大于9元")
    preview = client.post(f"/api/v1/condition-drafts/{draft['id']}/preview", json={"stock_code": "600002.SH", "as_of": "2026-09-14"}).json()
    assert preview["state"] == "unknown"
    assert "更早" in preview["details"][0]["reason"]


def test_old_worker_cannot_claim_new_protocol_or_overwrite_completed_results(client):
    _, saved = compile_and_save(client)
    run = run_strategy(client, saved)
    with pytest.raises(sqlite3.IntegrityError, match="current condition execution worker"):
        with db.connect() as connection:
            connection.execute("UPDATE jobs SET state='running',lease_owner='old-uuid' WHERE id=?", (run["job_id"],))
    worker.execute_screening(run["job_id"])
    before = client.get(f"/api/v1/screening-runs/{run['id']}").json()["result"]
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        with db.connect() as connection:
            connection.execute("UPDATE screening_runs SET result_json='{}',status='partial' WHERE id=?", (run["id"],))
    assert client.get(f"/api/v1/screening-runs/{run['id']}").json()["result"] == before


def test_process_cleanup_only_targets_services_in_this_checkout(tmp_path):
    from scripts.service_processes import service_kind
    root = tmp_path / "project"
    root.mkdir()
    assert service_kind(["python.exe", "-m", "apps.api.app.worker"], str(root), root) == "worker"
    assert service_kind(["python.exe", "-m", "apps.api.app.worker"], str(tmp_path), root) is None
    assert service_kind(["python.exe", "-c", "apps.api.app.worker"], str(root), root) is None
    vite = root / "apps/web/node_modules/vite/bin/vite.js"
    assert service_kind(["node.exe", str(vite)], str(root / "apps/web"), root) == "web"
    assert service_kind(["node.exe", str(tmp_path / "another/vite.js")], str(root), root) is None


def test_adding_a_result_again_preserves_existing_research_notes(client):
    pool = client.post("/api/v1/watchlists", json={"name": "研究池"}).json()
    endpoint = f"/api/v1/watchlists/{pool['id']}/items"
    original = client.post(endpoint, json={"stock_code": "600000.SH", "note": "我的研究笔记"}).json()
    repeated = client.post(endpoint, json={"stock_code": "600000.SH", "note": "来自筛选", "replace_note": False}).json()
    assert repeated["note"] == "我的研究笔记"
    assert repeated["added_at"] == original["added_at"]


def test_saved_draft_preview_uses_confirmed_edits_even_when_reopened_without_edits(client):
    draft = client.post("/api/v1/condition-drafts", json={"prompt": "收盘价大于9元"}).json()
    endpoint = f"/api/v1/condition-drafts/{draft['id']}"
    edits = {"c1": {"parameters": {"value": 100}}}
    confirmed = client.post(endpoint + "/confirm", json={"edits": edits})
    assert confirmed.status_code == 200
    payload = {"stock_code": "600000.SH", "as_of": "2026-09-14"}
    reopened = client.post(endpoint + "/preview", json=payload)
    assert reopened.status_code == 200
    assert reopened.json()["state"] == "false"
    assert reopened.json()["details"][0]["threshold"] == 100
    assert client.post(endpoint + "/preview", json={**payload, "edits": edits}).json()["state"] == "false"
    changed = client.post(endpoint + "/preview", json={**payload, "edits": {"c1": {"parameters": {"value": 9}}}})
    assert changed.status_code == 409
