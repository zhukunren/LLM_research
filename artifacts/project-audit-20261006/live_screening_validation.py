"""Exercise real HTTP + worker against the audit DB copy and read-only real bars."""
from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import traceback
from uuid import uuid4

import requests

AUDIT = Path(__file__).resolve().parent
ROOT = AUDIT.parents[1]
BASE = "http://127.0.0.1:8066/api/v1"
AS_OF = "2026-09-14"
CODES = ["600000.SH", "600519.SH"]
SOURCE = ROOT / "data" / "stock_data" / "stock_daily.parquet"
REPORT_PATH = AUDIT / "live-screening-validation.json"
LOG_PATH = AUDIT / "live-screening-validation.log"
session = requests.Session()
session.trust_env = False
report = {"status": "running", "api": BASE, "as_of": AS_OF, "stock_codes": CODES,
          "started_at": datetime.now(timezone(timedelta(hours=8))).isoformat(),
          "database": str(AUDIT / "live" / "app.db"), "http_calls": [], "runs": []}


def log(message):
    with LOG_PATH.open("a", encoding="utf-8") as stream:
        stream.write(message + "\n")
    print(message, flush=True)


def request(method, path, payload=None):
    response = session.request(method, BASE + path, json=payload, timeout=90)
    report["http_calls"].append({"method": method, "path": path, "status": response.status_code,
                                 "request_id": response.headers.get("X-Request-ID")})
    log(f"HTTP {method} {path} -> {response.status_code}")
    if not response.ok:
        raise AssertionError(f"HTTP failure: {response.status_code} {response.text[:2000]}")
    return response


def execute_strategy(name, condition, group, expected, expected_status):
    strategy = request("POST", "/strategies", {
        "request_id": "audit-strategy-" + uuid4().hex,
        "name": name, "top_n": 10,
        "tree": {"op": "filter_ref", "filter_id": condition["id"], "version": condition["version"]},
    }).json()
    payload = {"request_id": "audit-screen-" + uuid4().hex,
               "strategy_id": strategy["id"], "strategy_version": strategy["version"],
               "as_of": AS_OF, "mode": "exploratory", "watchlist_id": group["id"]}
    queued = request("POST", "/screening-runs", payload).json()
    assert queued["status"] == "queued" and queued["job_id"]
    assert request("POST", "/screening-runs", payload).json() == queued
    job = request("GET", "/jobs/" + queued["job_id"]).json()
    assert job["kind"] == "screening" and job["state"] == "queued"
    log("Execute only owned job " + queued["job_id"])
    worker = subprocess.run(
        [sys.executable, str(AUDIT / "live_server.py"), "--job", queued["job_id"]],
        cwd=ROOT, env=os.environ.copy(), capture_output=True, text=True, encoding="utf-8", timeout=180,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    log(f"Worker exit={worker.returncode}; stdout={worker.stdout.strip()}; stderr={worker.stderr.strip()[:4000]}")
    assert worker.returncode == 0 and worker.stdout.strip() == "True"
    run = request("GET", "/screening-runs/" + queued["id"]).json()
    assert run["status"] == expected_status, run
    assert run["as_of"] == AS_OF and run["mode"] == "exploratory"
    assert run["context"]["effective_market_date"] == AS_OF
    assert run["context"]["universe"]["codes"] == CODES
    assert run["result"]["data_snapshot"]["watermark"] == report["market_source"]["last_date"]
    assert run["result"]["data_snapshot"]["sha256"] == report["market_source"]["sha256"]
    assert run["result"]["data_snapshot"]["watermark"] >= AS_OF
    assert run["result"]["data_snapshot"]["price_basis"] == "unknown"
    all_decisions = request("GET", f"/screening-runs/{queued['id']}/decisions?limit=100").json()
    assert all_decisions["total"] == 2
    decisions = {item["stock_code"]: item for item in all_decisions["items"]}
    assert {code: item["state"] for code, item in decisions.items()} == expected
    for code, item in decisions.items():
        assert item["as_of"] == AS_OF
        assert item["close"] == report["latest_bars"][code]["close"]
        assert all(detail["data_date"] == AS_OF for detail in item["details"])
    for state in ("true", "false", "unknown"):
        filtered = request("GET", f"/screening-runs/{queued['id']}/decisions?state={state}&limit=100").json()
        wanted = {code for code, decision_state in expected.items() if decision_state == state}
        assert filtered["total"] == len(wanted)
        assert {item["stock_code"] for item in filtered["items"]} == wanted
        assert run["result"]["counts"][state] == len(wanted)
    assert run["result"]["counts"]["evaluated"] == 2
    exported = request("GET", f"/screening-runs/{queued['id']}/export")
    assert "text/csv" in exported.headers["Content-Type"]
    csv_path = AUDIT / f"live-screening-{queued['id'][:8]}.csv"
    csv_path.write_bytes(exported.content)
    rows = list(csv.DictReader(io.StringIO(exported.content.decode("utf-8-sig"))))
    hits = {code for code, state in expected.items() if state == "true"}
    if hits:
        assert {row["证券代码"] for row in rows} == hits
        assert all(row["截止日"] == AS_OF and row["实际日期"] == AS_OF for row in rows)
    else:
        assert len(rows) == 1 and rows[0]["证券代码"] == ""
        assert json.loads(rows[0]["条件详情"])["counts"]["unknown"] == 2
    assert request("POST", "/screening-runs", payload).json() == queued
    report["runs"].append({"name": name, "condition": condition, "strategy": strategy,
                           "queued": queued, "run": run, "decisions": all_decisions,
                           "csv": str(csv_path), "csv_rows": rows,
                           "worker": {"exit_code": worker.returncode, "stdout": worker.stdout,
                                      "stderr": worker.stderr}})
    log(f"PASS {name}: {run['result']['counts']}; run status={run['status']}")


def main():
    LOG_PATH.write_text("Live screening validation against isolated DB copy\n", encoding="utf-8")
    before = SOURCE.stat()
    report["source_stat_before"] = {"size": before.st_size, "mtime_ns": before.st_mtime_ns}
    source = request("GET", "/data/status").json()
    report["market_source"] = {key: source.get(key) for key in ("last_date", "sha256", "bytes", "price_basis", "rows", "securities")}
    report["latest_bars"] = {}
    for code in CODES:
        bars = request("GET", f"/securities/{code}/bars?as_of={AS_OF}&limit=3").json()
        assert bars["items"][-1]["trade_date"] == AS_OF and bars["items"][-1]["quality_valid"]
        report["latest_bars"][code] = bars["items"][-1]
    threshold = sum(row["close"] for row in report["latest_bars"].values()) / 2
    report["threshold"] = threshold
    group = request("POST", "/watchlists", {"name": "审查实机测试：真实两股 " + uuid4().hex[:8]}).json()
    report["watchlist"] = group
    for code in CODES:
        request("POST", f"/watchlists/{group['id']}/items", {
            "stock_code": code, "note": "仅在审查数据库副本中用于实机验证", "replace_note": True})
    group_csv = request("GET", f"/watchlists/{group['id']}/export")
    (AUDIT / "live-screening-watchlist.csv").write_bytes(group_csv.content)
    assert {row["证券代码"] for row in csv.DictReader(io.StringIO(group_csv.content.decode("utf-8-sig")))} == set(CODES)
    condition = request("POST", "/filters", {
        "library": "technical", "name": "审查：真实收盘价高于两股中点", "description": "确定性本地条件，无模型调用",
        "expression": {"op": "metric_compare", "metric": "close", "window": 1, "operator": "gt", "value": threshold},
    }).json()
    expected = {code: "true" if row["close"] > threshold else "false" for code, row in report["latest_bars"].items()}
    assert set(expected.values()) == {"true", "false"}
    execute_strategy("审查实机：价格真假", condition, group, expected, "succeeded")
    unevaluated = request("POST", "/filters", {
        "library": "report", "name": "审查：没有评估结果时保留未知", "description": "只保存条件，不调用研报评估或模型",
        "expression": {"op": "evidence_query", "evaluation_mode": "rubric", "combine": "all", "lookback_calendar_days": 30,
                       "criteria": [{"id": "audit_orders", "label": "订单增长", "question": "订单是否有明确增长证据？", "signals": [], "counter_signals": []}]},
    }).json()
    execute_strategy("审查实机：缺失研报评估为未知", unevaluated, group, {code: "unknown" for code in CODES}, "partial")
    for item in report["runs"][-1]["decisions"]["items"]:
        assert "没有" in item["details"][0]["reason"] and "研报评估" in item["details"][0]["reason"]
    after = SOURCE.stat()
    report["source_stat_after"] = {"size": after.st_size, "mtime_ns": after.st_mtime_ns}
    assert report["source_stat_before"] == report["source_stat_after"]
    report["model_calls"] = 0
    report["status"] = "passed"


try:
    main()
except Exception:
    report["status"] = "failed"
    report["error"] = traceback.format_exc()
    log(report["error"])
finally:
    report["finished_at"] = datetime.now(timezone(timedelta(hours=8))).isoformat()
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    log("Validation status: " + report["status"])

sys.exit(0 if report["status"] == "passed" else 1)
