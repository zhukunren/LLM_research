from datetime import date
import json
import sqlite3
from types import SimpleNamespace

import pytest

from apps.api.app import db, financial_facts, financial_probe, financial_sync, jobs, worker
from apps.api.app.tushare_client import TushareSnapshot, TushareError
from apps.api.app import financial_metrics, main
from fastapi.testclient import TestClient
from dataclasses import replace
from apps.api.app.security_context import LOCAL_ACTOR, actor_scope, AccessDenied


class Provider:
    def __init__(self):
        self.calls, self.fail, self.amount = [], False, "123456789.12"

    def query_snapshot(self, name, *, fields, **params):
        self.calls.append((name, params))
        if self.fail:
            raise TushareError("临时超时", kind="transient_error")
        records = []
        for year in (2024, 2025):
            values = {key: None for key in fields.split(",")}
            values.update(ts_code=params["ts_code"], end_date=f"{year}1231", ann_date=f"{year + 1}0315",
                          f_ann_date=f"{year + 1}0315", report_type="1", comp_type="1", update_flag="1",
                          revenue=self.amount, total_assets=self.amount, n_cashflow_act=self.amount, profit_dedt=self.amount)
            if params.get("report_type", "1") != "1":
                continue
            if params.get("period") and params["period"] != values["end_date"]:
                continue
            if params.get("start_date"):
                field = "end_date" if name == "fina_indicator" else "ann_date"
                if not params["start_date"] <= values[field] <= params["end_date"]:
                    continue
            records.append([values[key] for key in fields.split(",")])
        payload = {"code": 0, "data": {"fields": fields.split(","), "items": records}}
        return TushareSnapshot(json.dumps(payload).encode(), payload)


@pytest.fixture
def setup_store(tmp_path, monkeypatch):
    monkeypatch.setenv("LLMR_AUTH_MODE", "local")
    monkeypatch.setenv("LLMR_CONFIG_FILE", str(tmp_path / "none.ini"))
    monkeypatch.setenv("LLMR_STATE_ROOT", str(tmp_path / "state"))
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    monkeypatch.setattr(financial_probe, "PILOT_COMPANIES", ({"code": "600519.SH", "name": "样本", "category": "一般工商业"},))
    monkeypatch.setattr(financial_probe, "credential_id", lambda: "test-credential")
    provider = Provider()
    monkeypatch.setattr(financial_probe, "create_probe_client", lambda: provider)
    db.init_db()
    return provider


def start():
    request = financial_sync.SyncRequest(request_id="series", start_year=2025, as_of="2026-04-10")
    return financial_sync.read_run(financial_sync.start(request)["run_id"])


def test_ordinary_acquisition_preserves_raw_versions_and_missing_period_attempts(setup_store):
    run = start()
    worker.execute_job(run["job_id"])
    result = financial_sync.read_run(run["id"])
    assert result["state"] == "succeeded", result["summary"]
    assert all(not name.endswith("_vip") for name, _ in setup_store.calls)
    assert result["fallback_planned"]
    assert any(p["kind"] == "missing_period" and p["result"]["status"] == "empty" for p in result["parts"])
    records, facts = financial_facts.read_company("600519.SH")
    revenue = [f for f in facts.values() if f["metric_code"] == "revenue"]
    assert len(revenue) == 2 and all(f["value"] == "123456789.12" for f in revenue)
    source = financial_facts.provenance(revenue[0]["id"])
    assert source["observations"][0]["response_hash"]
    assert records and not records[0]["historical_revision_verified"]
    with db.connect() as connection, pytest.raises(sqlite3.IntegrityError, match="immutable"):
        connection.execute("UPDATE financial_facts SET value_decimal='0'")


def test_failed_endpoints_resume_and_do_not_overwrite_attempt_evidence(setup_store):
    setup_store.fail = True
    run = start()
    worker.execute_job(run["job_id"])
    failed = financial_sync.read_run(run["id"])
    assert failed["state"] == "partial" and len(setup_store.calls) == 4
    setup_store.fail = False
    resumed = financial_sync.retry(run["id"])
    worker.execute_job(resumed["job_id"])
    complete = financial_sync.read_run(run["id"])
    assert complete["state"] == "succeeded"
    assert any(p["attempt"] == 2 for p in complete["parts"])
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM financial_sync_attempts WHERE json_extract(result_json,'$.status')='transient_error'").fetchone()[0] == 4


def test_large_response_splits_without_publishing_a_truncated_page(setup_store):
    run = start()
    part = run["parts"][0]
    payload = {"code": 0, "data": {"fields": part["fields"], "items": [[None] * len(part["fields"])] * 100}}
    client = SimpleNamespace(query_snapshot=lambda *a, **k: TushareSnapshot(json.dumps(payload).encode(), payload))
    result, records, children = financial_sync.collect(part, run["input"], client)
    assert result["status"] == "split" and not records and len(children) == 2
    assert children[0]["params"]["start_date"] == part["params"]["start_date"]
    assert children[1]["params"]["end_date"] == part["params"]["end_date"]


def test_cancellation_after_collection_does_not_publish_facts(setup_store, monkeypatch):
    run = start()
    old = setup_store.query_snapshot
    def cancel(*args, **kwargs):
        response = old(*args, **kwargs)
        jobs.cancel(run["job_id"])
        return response
    monkeypatch.setattr(setup_store, "query_snapshot", cancel)
    worker.execute_job(run["job_id"])
    assert financial_sync.read_run(run["id"])["state"] == "cancelled"
    assert not financial_facts.read_company("600519.SH")[1]


def test_series_api_freezes_inputs_and_rejects_saving_a_changed_result(setup_store):
    run = start()
    worker.execute_job(run["job_id"])
    with TestClient(main.app) as client:
        params = {"as_of": "2026-04-10", "start_year": 2025, "basis": "annual", "mode": "latest", "metrics": "revenue"}
        response = client.get("/api/v1/companies/600519.SH/financials", params=params)
        assert response.status_code == 200, response.text
        data = response.json()
        point = data["rows"][0]["values"]["revenue"]
        assert point["value"] == "123456789.12"
        provenance = client.get("/api/v1/financial-facts/" + point["input_fact_ids"][0] + "/provenance")
        assert provenance.status_code == 200
        assert provenance.json()["fact"]["value"] == point["value"]
        saved = client.post("/api/v1/financial-data/calculations?expected_id=" + data["calculation_id"], json=data["request"])
        assert saved.status_code == 200 and saved.json()["saved"]
        old_id = data["calculation_id"]
        setup_store.amount = "999"
        request = financial_sync.SyncRequest(request_id="new-sources", start_year=2025, as_of="2026-04-10")
        updated = financial_sync.read_run(financial_sync.start(request)["run_id"])
        worker.execute_job(updated["job_id"])
        stale = client.post("/api/v1/financial-data/calculations?expected_id=" + old_id, json=data["request"])
        assert stale.status_code == 409
        frozen = client.get("/api/v1/financial-data/calculations/" + old_id).json()
        assert frozen["rows"][0]["values"]["revenue"]["value"] == "123456789.12"
        assert client.get("/api/v1/companies/invalid/financials", params=params).status_code == 422
        with db.connect() as connection, pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("UPDATE financial_calculations SET result_json='{}'")


def test_historical_api_and_private_workspaces_do_not_return_later_or_foreign_values(setup_store):
    run = start()
    worker.execute_job(run["job_id"])
    query = financial_metrics.FinancialQuery(stock_code="600519.SH", as_of="2026-04-10", start_year=2025, metrics=["revenue"])
    saved = financial_metrics.freeze(query)
    strict = financial_metrics.calculate(query.model_copy(update={"mode": "as_of"}))
    assert all(row["values"]["revenue"]["value"] is None for row in strict["rows"])
    with actor_scope(replace(LOCAL_ACTOR, role="viewer")):
        with pytest.raises(AccessDenied):
            financial_metrics.freeze(query)
    with actor_scope(replace(LOCAL_ACTOR, user_id="other", tenant_id="org", legacy=False, maintenance=True)):
        db.init_db()
        with pytest.raises(LookupError):
            financial_metrics.read_calculation(saved["calculation_id"])
        assert not financial_facts.read_company("600519.SH")[0]
