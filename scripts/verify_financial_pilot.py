"""Run/review the first financial-contract delivery using the configured official token."""
from __future__ import annotations

import argparse
from dataclasses import replace
from datetime import datetime
import json
from pathlib import Path
import sqlite3
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from apps.api.app import db, financial_probe, financial_store, worker
from apps.api.app.financial_contracts import ZONE, digest
from apps.api.app.security_context import LOCAL_ACTOR, actor_scope
from apps.api.app.storage import application_paths
from apps.api.app.tushare_endpoints import manifest


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Run a bounded official financial pilot (10 companies, at most 74 requests).")
    parser.add_argument("--as-of", default=datetime.now(ZONE).date().isoformat())
    parser.add_argument("--period", help="Report period YYYY-MM-DD; defaults to the prior calendar year end")
    parser.add_argument("--resume", help="Resume a queued run, or export its saved evidence")
    args = parser.parse_args()
    # Explicit maintenance scope, consistent with existing local administration scripts.
    with actor_scope(replace(LOCAL_ACTOR, maintenance=True)):
        target = db.database_path()
        if target.exists():
            with sqlite3.connect(target) as source:
                exists = source.execute("SELECT 1 FROM sqlite_master WHERE name='financial_probe_runs'").fetchone()
                if not exists:
                    backup = application_paths().state_root / "backups" / f"before-financial-contracts-{uuid4().hex}.db"
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    with sqlite3.connect(backup) as destination:
                        source.backup(destination)
                    print(json.dumps({"database_backup": str(backup)}, ensure_ascii=False), flush=True)
        db.init_db()
        run_id = args.resume or financial_probe.start(financial_probe.ProbeRequest(
            request_id="pilot-" + uuid4().hex, as_of=args.as_of, period=args.period))["run_id"]
        run = financial_store.read_run(run_id)
        print(json.dumps({"run_id": run_id, "job_id": run["job_id"], "planned": run["summary"]["planned"]}, ensure_ascii=False), flush=True)
        if run["state"] == "queued":
            worker.execute_job(run["job_id"], kinds=("financial_probe",))
        run = financial_store.read_run(run_id)
        run["credential_matches"] = run.pop("credential_id") == financial_probe.credential_id()
        output = application_paths().artifact_root / "financial-pilots" / run_id
        output.mkdir(parents=True, exist_ok=True)
        # A running job is never described as a completed verification.
        path = output / ("result.json" if run["state"] not in {"queued", "running"} else "progress.json")
        content = json.dumps(run, ensure_ascii=False, indent=2)
        if path.exists() and path.read_text(encoding="utf-8") != content:
            path = path.with_name(f"{path.stem}-{uuid4().hex[:8]}.json")
        path.write_text(content, encoding="utf-8")
        frozen_contract = run["input"].get("contract")
        if frozen_contract is None and digest(manifest()) == run["input"]["contract_hash"]:
            frozen_contract = manifest()
        if frozen_contract is not None:
            (output / "contracts.json").write_text(json.dumps(frozen_contract, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"state": run["state"], "summary": run["summary"], "comparisons": run["comparisons"],
                          "result": str(path), "message": run["message"]}, ensure_ascii=False), flush=True)
        if run["state"] in {"failed", "queued", "running", "cancelled"}:
            return 1
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
