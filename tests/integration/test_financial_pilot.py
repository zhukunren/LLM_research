from dataclasses import replace
from datetime import date
from decimal import Decimal
import json
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from apps.api.app import db, financial_probe, financial_store, jobs, main, worker
from apps.api.app.financial_contracts import select_version
from apps.api.app.security_context import AccessDenied, LOCAL_ACTOR, actor_scope
from apps.api.app.tushare_client import TushareError, TushareSnapshot
from apps.api.app.tushare_endpoints import ENDPOINTS


class Provider:
    def __init__(self):
        self.calls = []
        self.denied = {"anns_d"}
        self.empty = set()
        self.amount = "123456789012345.6789"
        self.fail_at = None
        self.after_response = None

    def query_snapshot(self, endpoint, *, fields, **params):
        self.calls.append((endpoint, params))
        if self.fail_at == len(self.calls):
            raise RuntimeError("simulated process interruption")
        if endpoint in self.denied:
            raise TushareError("公告数据尚未开通", kind="denied", provider_code=2002)
        code = params["ts_code"]
        values = {field: None for field in fields.split(",")}
        values.update(ts_code=code, end_date=params.get("period", params.get("end_date")),
                      ann_date="20260331", f_ann_date="20260331", report_type="1",
                      comp_type={"600036.SH": "2", "601318.SH": "3", "600030.SH": "4"}.get(code, "1"),
                      update_flag="1", revenue=self.amount, total_assets=self.amount, n_cashflow_act=self.amount,
                      profit_dedt=self.amount)
        if endpoint == "anns_d":
            values.update(ann_date="20261001", title="合成财报", url="https://example.com/report.pdf")
        payload = {"code": 0, "data": {"fields": fields.split(","), "items":
                   [] if endpoint in self.empty else [[values[field] for field in fields.split(",")]]}}
        body = json.dumps(payload, ensure_ascii=False).encode()
        if self.after_response:
            self.after_response()
        return TushareSnapshot(body, json.loads(body, parse_float=Decimal))


@pytest.fixture
def pilot(tmp_path, monkeypatch):
    config = tmp_path / "config.ini"
    config.write_text("[tushare]\ntoken_env=FINANCIAL_TEST_TOKEN\n", encoding="utf-8")
    monkeypatch.setenv("LLMR_CONFIG_FILE", str(config))
    monkeypatch.setenv("LLMR_AUTH_MODE", "local")
    monkeypatch.setenv("LLMR_STATE_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("FINANCIAL_TEST_TOKEN", "financial-test-credential")
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    provider = Provider()
    monkeypatch.setattr(financial_probe, "create_probe_client", lambda: provider)
    with TestClient(main.app) as client:
        yield SimpleNamespace(client=client, provider=provider, root=tmp_path)


def start(pilot, key="first"):
    response = pilot.client.post("/api/v1/maintenance/financial-probe",
                                 json={"request_id": key, "as_of": "2026-10-20", "period": "2025-12-31"})
    assert response.status_code == 202, response.text
    return financial_store.read_run(response.json()["run_id"])


def test_real_job_pipeline_keeps_versions_and_separate_permission_evidence(pilot):
    run = start(pilot)
    assert start(pilot)["id"] == run["id"]
    assert worker.execute_job(run["job_id"])
    result = pilot.client.get(f"/api/v1/financial-data/probes/{run['id']}").json()
    assert result["state"] == "succeeded"
    assert result["summary"]["checked"] == 74
    assert result["summary"]["attempted"] == 65
    assert result["summary"]["companies_with_rows"] == 10
    assert result["summary"]["denied"] == 1 and result["summary"]["skipped"] == 9
    assert all(item["status"] == "equal" for item in result["comparisons"])
    assert "financial-test-credential" not in json.dumps(result)
    assert "credential_id" not in result
    source = next(c for c in result["checks"] if c["endpoint"] == "income")
    record_id = source["record_ids"][0]
    evidence = pilot.client.get(f"/api/v1/financial-data/records/{record_id}").json()
    assert evidence["record"]["facts"][0]["value"] == pilot.provider.amount
    assert len(evidence["observations"]) == 2  # ordinary and VIP keep separate provenance
    assert evidence["record"]["historical_revision_verified"] is False
    capabilities = pilot.client.get("/api/v1/financial-data/status").json()["capabilities"]
    assert next(c for c in capabilities if c["endpoint"] == "anns_d")["status"] == "denied"
    assert next(c for c in capabilities if c["endpoint"] == "income")["status"] == "available"
    assert list((pilot.root / "state" / "financial-sources" / "responses").glob("*.json"))
    with db.connect() as connection, pytest.raises(sqlite3.IntegrityError, match="immutable"):
        connection.execute("UPDATE financial_source_records SET content_hash='changed' WHERE id=?", (record_id,))


def test_empty_response_is_unknown_not_denied_or_full_coverage(pilot):
    pilot.provider.empty.add("fina_indicator")
    run = start(pilot)
    worker.execute_job(run["job_id"])
    status = financial_probe.status()
    assert next(c for c in status["capabilities"] if c["endpoint"] == "fina_indicator")["status"] == "unknown"
    checks = [c for c in status["latest"]["checks"] if c["endpoint"] == "fina_indicator"]
    assert len(checks) == 10 and all(c["status"] == "empty" and c["attempted"] for c in checks)
    assert all(c["coverage"] == "sample_only" for c in checks)
    assert next(c for c in status["latest"]["comparisons"] if c["family"] == "fina_indicator")["status"] == "unverified"


def test_equivalent_raw_versions_are_visible_without_false_conflict(pilot):
    from apps.api.app.financial_contracts import normalize_record
    run = start(pilot)
    assert run["input"]["contract"]["version"] == run["input"]["contract_version"]
    sample = run["input"]["samples"][0]
    snapshot = pilot.provider.query_snapshot(sample["endpoint"], fields=",".join(sample["fields"]), **sample["params"])
    row = dict(zip(snapshot.payload["data"]["fields"], snapshot.payload["data"]["items"][0], strict=True))
    records = [normalize_record("income", {**row, "update_flag": flag}, observed_at="2026-10-20T08:00:00Z") for flag in ("0", "1")]
    response_hash = financial_store.save_response(snapshot.body)
    result = {**sample, "checked_at": "2026-10-20T08:00:00Z", "attempted": True, "status": "available",
              "record_ids": [r["id"] for r in records], "response_hash": response_hash}
    assert financial_store.save_check(run, sample["key"], result, records)
    loaded = financial_store.read_run(run["id"])
    assert loaded["summary"]["equivalent_groups"] == 1
    assert loaded["summary"]["conflict_groups"] == 0
    assert loaded["version_resolution"][0]["version_count"] == 2


def test_new_probe_cannot_silently_reuse_a_different_active_scope(pilot):
    start(pilot)
    response = pilot.client.post("/api/v1/maintenance/financial-probe", json={
        "request_id": "different", "as_of": "2026-10-20", "period": "2024-12-31"})
    assert response.status_code == 422


def test_rotation_does_not_reuse_old_permissions(pilot, monkeypatch):
    run = start(pilot)
    worker.execute_job(run["job_id"])
    monkeypatch.setenv("FINANCIAL_TEST_TOKEN", "new-credential")
    status = financial_probe.status()
    assert all(c["status"] == "unknown" for c in status["capabilities"])
    assert status["latest"]["credential_matches"] is False


def test_same_date_revision_is_preserved_and_stays_a_conflict(pilot):
    first = start(pilot)
    worker.execute_job(first["job_id"])
    data = financial_store.read_run(first["id"])
    source_id = next(c for c in data["checks"] if c["endpoint"] == "income")["record_ids"][0]
    original = pilot.client.get(f"/api/v1/financial-data/records/{source_id}").json()["record"]
    pilot.provider.amount = "999.01"
    second = start(pilot, key="revised")
    worker.execute_job(second["job_id"])
    versions = financial_store.read_versions(original["logical_key"], original["schema_hash"])
    assert len(versions) == 2
    assert select_version(versions, mode="latest")["status"] == "conflict"
    assert select_version(versions, mode="as_of", as_of=date(2025, 12, 31))["status"] == "historical_evidence_missing"
    assert pilot.client.get(f"/api/v1/financial-data/records/{source_id}").json()["record"] == original


def test_interrupted_worker_resumes_without_requerying_committed_samples(pilot):
    run = start(pilot)
    lease = jobs.claim(run["job_id"])
    pilot.provider.fail_at = 2
    with pytest.raises(RuntimeError, match="interruption"):
        financial_probe.execute(lease)
    assert financial_store.read_run(run["id"])["summary"]["checked"] == 1
    with db.connect() as connection:
        connection.execute("UPDATE jobs SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?", (lease.id,))
    pilot.provider.fail_at = None
    worker.execute_job(run["job_id"])
    assert financial_store.read_run(run["id"])["state"] == "succeeded"
    assert pilot.provider.calls.count(("income", {"ts_code": "600519.SH", "period": "20251231"})) == 1


def test_cancel_after_network_prevents_publishing_late_records(pilot):
    run = start(pilot)
    pilot.provider.after_response = lambda: jobs.cancel(run["job_id"])
    worker.execute_job(run["job_id"])
    result = financial_store.read_run(run["id"])
    assert result["state"] == "cancelled" and result["summary"]["checked"] == 0
    with db.connect() as connection:
        assert connection.execute("SELECT count(*) FROM financial_source_records").fetchone()[0] == 0


def test_credentials_changed_while_queued_stop_before_network(pilot, monkeypatch):
    run = start(pilot)
    monkeypatch.setenv("FINANCIAL_TEST_TOKEN", "changed-before-execution")
    worker.execute_job(run["job_id"])
    assert not pilot.provider.calls
    assert financial_store.read_run(run["id"])["state"] == "partial"


def test_missing_configuration_does_not_send_a_request(pilot, monkeypatch):
    monkeypatch.delenv("FINANCIAL_TEST_TOKEN")
    def missing():
        raise TushareError("尚未配置", kind="not_configured")
    monkeypatch.setattr(financial_probe, "create_probe_client", missing)
    run = start(pilot)
    worker.execute_job(run["job_id"])
    result = financial_store.read_run(run["id"])
    assert result["state"] == "partial" and result["summary"]["attempted"] == 0
    assert not pilot.provider.calls


def test_admin_check_and_workspace_isolation_apply_to_new_services(pilot):
    with actor_scope(replace(LOCAL_ACTOR, platform_admin=False)):
        with pytest.raises(AccessDenied):
            financial_probe.start(financial_probe.ProbeRequest(request_id="bad", as_of="2026-10-20"))
    with actor_scope(replace(LOCAL_ACTOR, user_id="alice", tenant_id="org", legacy=False, maintenance=True)):
        db.init_db()
        own = financial_probe.start(financial_probe.ProbeRequest(request_id="private", as_of="2026-10-20"))["run_id"]
    with actor_scope(replace(LOCAL_ACTOR, user_id="bob", tenant_id="org", legacy=False, maintenance=True)):
        db.init_db()
        with pytest.raises(LookupError):
            financial_store.read_run(own)
        assert financial_probe.status()["latest"] is None
