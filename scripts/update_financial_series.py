"""Populate the ten-company ordinary-interface financial store, preserving source versions."""
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
sys.path.insert(0, str(ROOT))
from apps.api.app import db, financial_probe, financial_sync, worker
from apps.api.app.financial_contracts import ZONE
from apps.api.app.security_context import LOCAL_ACTOR, actor_scope
from apps.api.app.storage import application_paths


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--as-of", default=datetime.now(ZONE).date().isoformat())
    parser.add_argument("--start-year", type=int)
    parser.add_argument("--resume")
    args = parser.parse_args()
    with actor_scope(replace(LOCAL_ACTOR, maintenance=True)):
        source = db.database_path()
        if source.exists():
            with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as connection:
                if not connection.execute("SELECT 1 FROM sqlite_master WHERE name='financial_facts'").fetchone():
                    backup = application_paths().state_root / "backups" / ("before-financial-series-" + uuid4().hex + ".db")
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    with sqlite3.connect(backup) as destination:
                        connection.backup(destination)
                    print(json.dumps({"database_backup": str(backup)}, ensure_ascii=False), flush=True)
        db.init_db()
        if args.resume:
            run = financial_sync.read_run(args.resume)
            if run["state"] in {"partial", "failed", "cancelled"}:
                financial_sync.retry(args.resume)
            run_id = args.resume
        else:
            run_id = financial_sync.start(financial_sync.SyncRequest(
                request_id="series-" + uuid4().hex, as_of=args.as_of, start_year=args.start_year))["run_id"]
        run = financial_sync.read_run(run_id)
        print(json.dumps({"run_id": run_id, "job_id": run["job_id"], "summary": run["summary"]}, ensure_ascii=False), flush=True)
        if run["state"] == "queued":
            worker.execute_job(run["job_id"], kinds=("financial_sync",))
        run = financial_sync.read_run(run_id)
        run["credential_matches"] = run.pop("credential_id") == financial_probe.credential_id()
        folder = application_paths().artifact_root / "financial-series" / run_id
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / ("acquisition-" + uuid4().hex[:8] + ".json")
        path.write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"run_id": run_id, "state": run["state"], "summary": run["summary"], "result": str(path)}, ensure_ascii=False), flush=True)
        return 0 if run["state"] in {"succeeded", "partial"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
