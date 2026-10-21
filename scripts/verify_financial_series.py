"""Audit the stored real financial series without sending further provider requests."""
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import replace
from datetime import date, datetime, timedelta
from decimal import Decimal, localcontext
import hashlib
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from apps.api.app import db, financial_facts, financial_metrics, financial_probe, financial_sync
from apps.api.app.financial_contracts import ZONE, timestamp
from apps.api.app.security_context import LOCAL_ACTOR, actor_scope
from apps.api.app.storage import application_paths


def quarter_before(period):
    day = date.fromisoformat(period)
    year, month = (day.year - 1, 12) if day.month == 3 else (day.year, day.month - 3)
    return date(year, month, {3: 31, 6: 30, 9: 30, 12: 31}[month]).isoformat()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", default="2026-10-20")
    parser.add_argument("--start-year", type=int, default=2021)
    args = parser.parse_args()
    with actor_scope(replace(LOCAL_ACTOR, maintenance=True)):
        folder = application_paths().artifact_root / "financial-series" / ("validation-" + datetime.now(ZONE).strftime("%Y%m%d-%H%M%S"))
        folder.mkdir(parents=True, exist_ok=False)
        summary, timings, annual_checks, ttm_checks = [], [], 0, 0
        names = [item["code"] for item in financial_metrics.catalog()]
        flow_metrics = ["revenue", "net_profit", "parent_net_profit", "operating_cashflow", "capital_expenditure"]
        for company in financial_probe.PILOT_COMPANIES:
            code = company["code"]
            snapshots = {}
            for basis in ("annual", "cumulative", "quarter", "ttm"):
                query = financial_metrics.FinancialQuery(stock_code=code, as_of=args.as_of, start_year=args.start_year,
                                                        basis=basis, mode="latest", metrics=names)
                begin = time.perf_counter()
                result = financial_metrics.freeze(query)
                timings.append(time.perf_counter() - begin)
                assert financial_metrics.read_calculation(result["calculation_id"]) == result
                snapshots[basis] = result
                (folder / f"{code}-{basis}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            quarters = {row["period"]: row["values"] for row in snapshots["quarter"]["rows"]}
            with localcontext() as ctx:
                ctx.prec = 80
                for row in snapshots["annual"]["rows"]:
                    year = row["period"][:4]
                    for metric in flow_metrics:
                        inputs = [quarters.get(year + suffix, {}).get(metric) for suffix in ("-03-31", "-06-30", "-09-30", "-12-31")]
                        annual = row["values"][metric]
                        if annual["status"] == "ok" and all(p and p["status"] == "ok" for p in inputs):
                            assert sum(Decimal(p["value"]) for p in inputs) == Decimal(annual["value"]), (code, year, metric)
                            annual_checks += 1
                for row in snapshots["ttm"]["rows"]:
                    dates = [row["period"]]
                    for _ in range(3):
                        dates.append(quarter_before(dates[-1]))
                    for metric in flow_metrics:
                        inputs = [quarters.get(period, {}).get(metric) for period in dates]
                        ttm = row["values"][metric]
                        if ttm["status"] == "ok" and all(p and p["status"] == "ok" for p in inputs):
                            assert sum(Decimal(p["value"]) for p in inputs) == Decimal(ttm["value"]), (code, row["period"], metric)
                            ttm_checks += 1
            records, facts = financial_facts.read_company(code)
            observed = min(timestamp(r["first_observed_at"]).astimezone(ZONE).date() for r in records)
            before = observed - timedelta(days=1)
            strict = financial_metrics.calculate(financial_metrics.FinancialQuery(
                stock_code=code, as_of=before, start_year=min(args.start_year, before.year), basis="annual",
                mode="as_of", metrics=flow_metrics))
            assert not any(p["value"] is not None for row in strict["rows"] for p in row["values"].values())
            periods = sorted({r["report_period"] for r in records})
            for fact in facts.values():
                assert fact["value"] is None if fact["status"] != "reported" else Decimal(fact["value"]).is_finite()
            summary.append({"stock_code": code, "name": company["name"], "source_versions": len(records), "facts": len(facts),
                            "source_periods": len(periods), "first_period": periods[0], "last_period": periods[-1],
                            "coverage": {basis: value["coverage"] for basis, value in snapshots.items()},
                            "historical_before_first_observation": before.isoformat(),
                            "snapshot_ids": {basis: value["calculation_id"] for basis, value in snapshots.items()}})
        with db.connect() as connection:
            hashes = [row[0] for row in connection.execute("SELECT DISTINCT response_hash FROM financial_sync_observations")]
            fact_counts = {row[0]: row[1] for row in connection.execute("SELECT status,COUNT(*) FROM financial_facts GROUP BY status")}
            earliest = connection.execute("SELECT MIN(first_observed_at) FROM financial_source_records").fetchone()[0]
        root = application_paths().evidence_root / "financial-sources/responses"
        for value in hashes:
            assert hashlib.sha256((root / f"{value}.json").read_bytes()).hexdigest() == value
        report = {"status": "passed", "as_of": args.as_of, "start_year": args.start_year, "companies": summary,
                  "annual_equals_four_quarters_checks": annual_checks, "ttm_equals_four_quarters_checks": ttm_checks,
                  "verified_response_hashes": len(hashes), "fact_states": fact_counts, "earliest_observation": earliest,
                  "query_seconds": {"max": max(timings), "median": sorted(timings)[len(timings) // 2]},
                  "note": "验证数值计算、快照及来源完整性；缺失和重述差异保留，未替代逐项原文核验。"}
        path = folder / "verification.json"
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": report["status"], "companies": len(summary), "annual_checks": annual_checks,
                          "ttm_checks": ttm_checks, "raw_responses_verified": len(hashes), "report": str(path),
                          "fact_states": fact_counts, "query_seconds": report["query_seconds"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
