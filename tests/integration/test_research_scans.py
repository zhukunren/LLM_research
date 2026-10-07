from __future__ import annotations

import csv
from datetime import date
from io import StringIO, BytesIO
import sqlite3

from fastapi.testclient import TestClient
import pytest
from pypdf import PdfReader

from apps.api.app import conversation_store, db, jobs, main, market, program_conditions, research_scan_service as scans, worker
from apps.api.app.screening_contracts import CustomProgram
from apps.api.app.screening_tools import ToolContext, registry
from apps.api.app.tool_protocol import ToolCall


RANK_PROGRAM = """def screen(context, frames, params):
    codes = context['stock_codes']
    ranked = sorted(codes, key=lambda code: frames[code]['close'][-1], reverse=True)
    return {'decisions': {code: ranked.index(code) < 2 for code in codes},
            'metrics': {code: {'rank': ranked.index(code) + 1, 'universe_size': len(codes)} for code in codes}}
"""


@pytest.fixture
def research(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "research.db")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "synthetic.parquet")
    monkeypatch.setattr(market, "daily_bar_source_available", lambda: True)
    monkeypatch.setattr(market, "source_fingerprint", lambda: (str(tmp_path / "synthetic.parquet"), 1000, 123))
    monkeypatch.setattr(market, "cached_profile", lambda: {"available": True, "last_date": "2026-09-14"})
    monkeypatch.setattr(market, "latest_market_date", lambda as_of: "2026-09-14" if as_of >= "2026-09-14" else None)
    monkeypatch.setattr(market, "security_codes", lambda as_of: ["600000.SH", "600001.SH", "600002.SH", "600003.SH"])
    monkeypatch.setattr(market, "iter_recent_bars", lambda as_of, history, codes: iter([
        (code, [{"trade_date": "2026-09-14", "close": float(int(code[:6]) - 599990), "quality_valid": True}])
        for code in codes]))
    db.init_db()
    cid = conversation_store.create_conversation("screening", workflow_type="research")["id"]
    msg = conversation_store.add_user_message(cid, "research", 0, "自主计算排名，只研究，不创建正式筛选。")
    conversation_store.start_turn(cid, msg["turn_id"])
    return cid, msg["turn_id"]


def program(source=RANK_PROGRAM):
    return CustomProgram.model_validate({"contract_version": "python-screen-v1", "source_code": source,
                                         "required_fields": ["close"], "required_history_bars": 1})


def enqueue(research, **overrides):
    args = dict(name="价格排序实验", program=program(), as_of=None, universe="all_a_shares", stock_codes=[])
    return scans.enqueue_scan(*research, **{**args, **overrides})


def fake_evaluate(_condition, _reference, codes, _bars, **_kwargs):
    return {code: {"state": "true", "evaluation_status": "completed", "reason_code": "condition_met",
                   "metrics": {"price": 10}, "data_as_of": "2026-09-14"} for code in codes}


def test_autonomous_mcp_scan_ranks_the_entire_universe_without_business_writes(research, monkeypatch):
    cid, tid = research
    monkeypatch.setattr(scans, "BATCH_SIZE", 2)
    result = registry.dispatch(ToolCall("scan", "start_research_scan", {
        "name": "价格排序实验", "program": program().model_dump(mode="json"),
    }), ToolContext(cid, tid, 0, workflow_type="research"))
    assert result["ok"], result
    queued = result["result"]
    assert queued["execution_mode"] == "cross_sectional"
    assert worker.execute_job(queued["job_id"])
    scan = scans.get_scan(cid, queued["scan_id"])
    assert scan["status"] == "succeeded", scan
    assert scan["result"]["coverage"]["true_count"] == 2
    decisions = scans.list_decisions(cid, scan["id"])["items"]
    assert all(item["metrics"]["universe_size"] == 4 for item in decisions)
    assert [item["stock_code"] for item in decisions if item["state"] == "true"] == ["600002.SH", "600003.SH"]
    with TestClient(main.app) as client:
        result = client.get(scan["export_url"])
        assert result.status_code == 200 and result.headers["content-type"] == "application/pdf"
        exported = "\n".join(page.extract_text() for page in PdfReader(BytesIO(result.content)).pages)
        assert "张家港营业部" in exported and "600003.SH" in exported and "universe_size" in exported
    with db.connect() as connection:
        for table in ("screening_task_runs", "execution_requests", "screening_task_revisions", "observation_executions"):
            assert connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    assert conversation_store.get_conversation(cid)["task_revision"] == 0


def test_scan_is_idempotent_and_frozen_results_remain_readable_in_a_followup(research, monkeypatch):
    cid, tid = research
    queued = enqueue(research)
    assert enqueue(research)["scan_id"] == queued["scan_id"]
    monkeypatch.setattr(program_conditions, "evaluate_batch", fake_evaluate)
    worker.execute_job(queued["job_id"])
    with db.connect() as connection, pytest.raises(sqlite3.IntegrityError):
        connection.execute("UPDATE research_scans SET snapshot_json='{}' WHERE id=?", (queued["scan_id"],))
    conversation_store.finish_turn(cid, tid, 0, "succeeded", "研究文件与扫描已保留。", {})
    next_turn = conversation_store.add_user_message(cid, "followup", 0, "读取刚才排名，不重新计算。")
    conversation_store.start_turn(cid, next_turn["turn_id"])
    monkeypatch.setattr(market, "source_fingerprint", lambda: ("new-source", 2000, 456))
    saved = registry.dispatch(ToolCall("read", "read_research_scan", {"scan_id": queued["scan_id"]}),
                              ToolContext(cid, next_turn["turn_id"], 0, workflow_type="research"))
    assert saved["ok"] and saved["result"]["scan"]["uses_current_data"] is False
    assert saved["result"]["decisions"]["total"] == 4
    assert saved["result"]["scan"]["source_fingerprint"][1:] == [1000, 123]


@pytest.mark.parametrize("overrides,code", [
    ({"as_of": date(2026, 9, 15)}, "date_after_watermark"),
    ({"as_of": date(2026, 9, 10)}, "date_without_bars"),
    ({"universe": "explicit", "stock_codes": ["600000.SH", "600000.SH"]}, "invalid_universe"),
    ({"universe": "explicit", "stock_codes": ["AAPL.US"]}, "market_unavailable"),
    ({"execution_mode": "invalid"}, "invalid_execution_mode"),
])
def test_scan_validates_the_frozen_scope(research, overrides, code):
    with pytest.raises(scans.ResearchScanError) as caught:
        enqueue(research, **overrides)
    assert caught.value.code == code
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM research_scans").fetchone()[0] == 0


def test_per_stock_checkpoints_resume_without_repeating_completed_securities(research, monkeypatch):
    class WorkerCrash(BaseException):
        pass
    cid, _ = research
    monkeypatch.setattr(scans, "BATCH_SIZE", 2)
    queued = enqueue(research, execution_mode="per_stock")
    calls = []
    def evaluate(*args, **kwargs):
        calls.append(list(args[2]))
        if len(calls) == 2:
            raise WorkerCrash()
        return fake_evaluate(*args, **kwargs)
    monkeypatch.setattr(program_conditions, "evaluate_batch", evaluate)
    lease = jobs.claim(queued["job_id"])
    with lease, pytest.raises(WorkerCrash):
        scans.execute_scan(lease)
    assert scans.list_decisions(cid, queued["scan_id"])["total"] == 2
    assert scans.get_scan(cid, queued["scan_id"])["job"]["progress"] == 0.5
    with db.connect() as connection:
        connection.execute("UPDATE jobs SET lease_expires_at='2000-01-01' WHERE id=?", (queued["job_id"],))
    assert worker.execute_job(queued["job_id"])
    assert calls == [["600000.SH", "600001.SH"], ["600002.SH", "600003.SH"], ["600002.SH", "600003.SH"]]
    assert scans.get_scan(cid, queued["scan_id"])["status"] == "succeeded"
    assert lease.finish("succeeded", "late") is False


def test_source_replacement_invalidates_checkpoints_and_export(research, monkeypatch):
    cid, _ = research
    monkeypatch.setattr(scans, "BATCH_SIZE", 2)
    queued = enqueue(research, execution_mode="per_stock")
    calls = 0
    def evaluate(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            monkeypatch.setattr(market, "source_fingerprint", lambda: ("replacement", 2000, 456))
        return fake_evaluate(*args, **kwargs)
    monkeypatch.setattr(program_conditions, "evaluate_batch", evaluate)
    worker.execute_job(queued["job_id"])
    scan = scans.get_scan(cid, queued["scan_id"])
    assert scan["status"] == "failed" and not scan["result"]["result_valid"]
    assert scan["result"]["coverage"]["not_evaluated_count"] == 2
    records = list(csv.DictReader(StringIO(''.join(scans.export_csv(cid, queued["scan_id"])).lstrip('\ufeff'))))
    assert len(records) == 2 and all(item["scan_status"] == "failed" and item["result_valid"] == "False" for item in records)


def test_program_errors_remain_failed_unknown_and_can_be_repaired(research, monkeypatch):
    cid, _ = research
    def broken(*args, **kwargs):
        raise program_conditions.ProgramConditionError("missing_field")
    monkeypatch.setattr(program_conditions, "evaluate_batch", broken)
    queued = enqueue(research)
    worker.execute_job(queued["job_id"])
    scan = scans.get_scan(cid, queued["scan_id"])
    assert scan["status"] == "failed" and "missing_field" in scan["result"]["error"]
    decisions = scans.list_decisions(cid, queued["scan_id"])["items"]
    assert all(item["state"] == "unknown" and item["evaluation_status"] == "failed" for item in decisions)
    monkeypatch.setattr(program_conditions, "evaluate_batch", fake_evaluate)
    repaired = enqueue(research, program=program(RANK_PROGRAM + "\n# repaired"))
    assert repaired["scan_id"] != queued["scan_id"]
    worker.execute_job(repaired["job_id"])
    assert scans.get_scan(cid, repaired["scan_id"])["status"] == "succeeded"


def test_cancellation_blocks_late_checkpoints_and_foreign_conversation_access(research, monkeypatch):
    cid, _ = research
    queued = enqueue(research)
    other = conversation_store.create_conversation("screening", workflow_type="research")["id"]
    with TestClient(main.app) as client:
        base = f"/api/v1/conversations/{other}/research-scans/{queued['scan_id']}"
        assert client.get(base).status_code == 404
        assert client.get(base + "/export").status_code == 404
        assert client.post(base + "/cancel").status_code == 404
        assert client.get(f"/api/v1/conversations/{cid}/research-scans/{queued['scan_id']}/export").status_code == 409
    def evaluate(*args, **kwargs):
        jobs.cancel(queued["job_id"])
        return fake_evaluate(*args, **kwargs)
    monkeypatch.setattr(program_conditions, "evaluate_batch", evaluate)
    worker.execute_job(queued["job_id"])
    assert scans.get_scan(cid, queued["scan_id"])["status"] == "cancelled"
    assert scans.list_decisions(cid, queued["scan_id"])["total"] == 0
    assert scans.get_scan(cid, queued["scan_id"])["result"]["coverage"]["not_evaluated_count"] == 4
    assert not scans.get_scan(cid, queued["scan_id"])["result"]["result_valid"]


def test_worker_crash_after_error_checkpoint_does_not_turn_failure_into_success(research, monkeypatch):
    class WorkerCrash(BaseException):
        pass
    cid, _ = research
    queued = enqueue(research)
    original_finish = jobs.JobLease.finish
    def broken(*_args, **_kwargs):
        raise program_conditions.ProgramConditionError("missing_field")
    def interrupted_finish(*_args, **_kwargs):
        raise WorkerCrash()
    monkeypatch.setattr(program_conditions, "evaluate_batch", broken)
    monkeypatch.setattr(jobs.JobLease, "finish", interrupted_finish)
    with pytest.raises(WorkerCrash):
        worker.execute_job(queued["job_id"])
    monkeypatch.setattr(jobs.JobLease, "finish", original_finish)
    with db.connect() as connection:
        connection.execute("UPDATE jobs SET lease_expires_at='2000-01-01' WHERE id=?", (queued["job_id"],))
    worker.execute_job(queued["job_id"])
    saved = scans.get_scan(cid, queued["scan_id"])
    assert saved["status"] == "failed" and "missing_field" in saved["result"]["error"]
    assert not saved["result"]["result_valid"]
