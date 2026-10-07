"""Serve current application against an isolated copy of the real local database."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[2]
AUDIT = Path(__file__).resolve().parent
LIVE = AUDIT / "live"
LIVE.mkdir(exist_ok=True)
sys.path.insert(0, str(ROOT))
os.environ["LLMR_DB_PATH"] = str(LIVE / "app.db")
os.environ["LLMR_DATA_ROOT"] = str(ROOT / "data")
os.environ["LLMR_CODEX_HOME"] = str(LIVE / "codex-home")
os.environ["LLMR_WEB_PORT"] = "8066"


def prepare():
    source_path = ROOT / "runtime" / "app.db"
    with sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True) as source, sqlite3.connect(LIVE / "app.db") as target:
        source.backup(target)
    baseline = {"sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(), "source": str(source_path)}
    (AUDIT / "live-baseline.json").write_text(json.dumps(baseline, indent=2), encoding="utf-8")
    from apps.api.app import db
    db.init_db()
    with db.connect() as connection:
        baseline["copied_jobs"] = [dict(row) for row in connection.execute("SELECT kind,state,COUNT(*) AS count FROM jobs GROUP BY kind,state")]
        connection.execute("UPDATE jobs SET state='cancelled',message='Audit copy: existing work excluded' WHERE state IN ('queued','running')")
        connection.execute("UPDATE conversation_turns SET state='cancelled' WHERE state IN ('queued','running')")
    (AUDIT / "live-baseline.json").write_text(json.dumps(baseline, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"isolated_database": str(LIVE / "app.db"), "source_sha256": baseline["sha256"], "copied_jobs": baseline["copied_jobs"]}, ensure_ascii=False))


if __name__ == "__main__":
    if "--prepare" in sys.argv:
        prepare()
    elif "--job" in sys.argv:
        from apps.api.app.worker import execute_job
        print(execute_job(sys.argv[sys.argv.index("--job") + 1]))
    else:
        from apps.api.app import settings
        settings.REPORT_UPLOAD_DIR = LIVE / "uploads" / "reports"
        settings.PATTERN_UPLOAD_DIR = LIVE / "uploads" / "patterns"
        from apps.api.app.main import app
        import uvicorn
        uvicorn.run(app, host="127.0.0.1", port=8066)
