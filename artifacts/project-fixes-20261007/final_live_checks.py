"""Finish only the explicitly selected QA PDF jobs and verify rejected writes."""
from pathlib import Path
from datetime import datetime, timedelta, timezone
import json
import os
import sqlite3
import subprocess
import sys
import traceback
from uuid import uuid4

import requests

AUDIT = Path(__file__).resolve().parent
ROOT = AUDIT.parents[1]
DATABASE = AUDIT / "live" / "app.db"
PROJECT = "a6275616-bccd-4526-8f05-5bc2beeed220"
NOTES = ("d2a4c8ca-aef1-42ed-9396-ab8906d3760e", "4b38ef06-339d-41bf-ab5c-98e195510943")
BASE = "http://127.0.0.1:8066/api/v1"
report = {"status": "running", "database": str(DATABASE), "model_calls": 0,
          "project_id": PROJECT, "note_ids": NOTES, "pdf_jobs": []}
session = requests.Session()
session.trust_env = False
LOG = AUDIT / "live-observation-validation.log"
LOG.write_text("Final audit-owned PDF cleanup and rejected-write checks\n", encoding="utf-8")


def log(message):
    with LOG.open("a", encoding="utf-8") as stream:
        stream.write(message + "\n")
    print(message, flush=True)


def read(query, parameters=()):
    with sqlite3.connect(DATABASE.as_uri() + "?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(query, parameters)]


try:
    jobs = read("""SELECT j.id,j.state,e.id export_id,e.source_id note_id,e.source_revision
        FROM research_pdf_exports e JOIN jobs j ON j.id=e.job_id
        WHERE e.project_id=? AND e.source_kind='note' AND e.source_id IN (?,?)
        AND j.kind='research_pdf' AND j.state='queued' ORDER BY e.rowid""", (PROJECT, *NOTES))
    for job in jobs:
        log("Execute selected PDF job " + job["id"] + " for note " + job["note_id"])
        completed = subprocess.run(
            [sys.executable, str(AUDIT / "live_server.py"), "--job", job["id"]], cwd=ROOT,
            capture_output=True, text=True, encoding="utf-8", timeout=180,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        final = read("SELECT state FROM jobs WHERE id=?", (job["id"],))[0]["state"]
        report["pdf_jobs"].append({**job, "final_state": final, "exit_code": completed.returncode,
                                   "stdout": completed.stdout, "stderr": completed.stderr})
        assert completed.returncode == 0 and completed.stdout.strip() == "True" and final == "succeeded"
    report["selected_pending_pdf_jobs"] = read("""SELECT COUNT(*) count FROM research_pdf_exports e JOIN jobs j ON j.id=e.job_id
        WHERE e.project_id=? AND e.source_kind='note' AND e.source_id IN (?,?)
        AND j.kind='research_pdf' AND j.state IN ('queued','running')""", (PROJECT, *NOTES))[0]["count"]
    assert report["selected_pending_pdf_jobs"] == 0
    before_sync = read("SELECT COUNT(*) count FROM jobs WHERE kind='data_sync'")[0]["count"]
    blocked = session.post(BASE + "/maintenance/refresh", json={}, headers={"Origin": "http://127.0.0.1:8068"}, timeout=30)
    after_sync = read("SELECT COUNT(*) count FROM jobs WHERE kind='data_sync'")[0]["count"]
    report["origin_rejection"] = {"status": blocked.status_code, "response": blocked.json(),
                                  "data_sync_jobs_before": before_sync, "data_sync_jobs_after": after_sync}
    assert blocked.status_code == 403 and before_sync == after_sync == 0
    report["private_news_request_count"] = read("SELECT COUNT(*) count FROM news_url_imports WHERE request_id='fix-private-url-check'")[0]["count"]
    assert report["private_news_request_count"] == 0
    sources = read("""SELECT c.id conversation_id,m.id source_message_id,t.id turn_id,t.state
        FROM conversation_turns t JOIN conversations c ON c.id=t.conversation_id
        JOIN conversation_messages m ON m.conversation_id=c.id AND m.client_message_id='assistant:' || t.id AND m.role='assistant'
        WHERE c.workflow_type='research' AND t.workflow_type='research' AND t.state='failed'
        ORDER BY t.updated_at DESC LIMIT 1""")
    if sources:
        source = sources[0]
        report["created_own_failed_source"] = False
    else:
        sys.path.insert(0, str(ROOT))
        os.environ["LLMR_DB_PATH"] = str(DATABASE)
        os.environ["LLMR_DATA_ROOT"] = str(ROOT / "data")
        os.environ["LLMR_CODEX_HOME"] = str(AUDIT / "live" / "codex-home")
        from apps.api.app import conversation_store, db
        conversation = conversation_store.create_conversation("report", workflow_type="research")
        message = conversation_store.add_user_message(conversation["id"], "qa-failed-" + uuid4().hex, 0, "仅验证失败回合不能保存观察候选")
        conversation_store.start_turn(conversation["id"], message["turn_id"])
        assert conversation_store.fail_turn(conversation["id"], message["turn_id"], "QA实机失败回合：没有研究结论，也没有模型调用")
        with db.connect() as connection:
            source_id = connection.execute("SELECT id FROM conversation_messages WHERE conversation_id=? AND client_message_id=?", (conversation["id"], "assistant:" + message["turn_id"])).fetchone()[0]
        source = {"conversation_id": conversation["id"], "source_message_id": source_id, "turn_id": message["turn_id"], "state": "failed"}
        report["created_own_failed_source"] = True
    report["source"] = source
    before_candidates = read("SELECT COUNT(*) count FROM research_observation_candidates")[0]["count"]
    rejected = session.post(BASE + "/observation/research-candidates", json={
        "request_id": "qa-failed-candidate-" + uuid4().hex, "conversation_id": source["conversation_id"],
        "source_message_id": source["source_message_id"], "stock_code": "600519.SH"}, timeout=30)
    after_candidates = read("SELECT COUNT(*) count FROM research_observation_candidates")[0]["count"]
    report["candidate_rejection"] = {"status": rejected.status_code, "response": rejected.json(),
                                     "candidate_count_before": before_candidates, "candidate_count_after": after_candidates}
    assert rejected.status_code == 409 and before_candidates == after_candidates
    tasks = session.get(BASE + "/tasks", timeout=30)
    assert tasks.status_code == 200
    report["tasks_after"] = tasks.json()
    report["pending_jobs_after"] = read("SELECT COUNT(*) count FROM jobs WHERE state IN ('queued','running')")[0]["count"]
    assert report["pending_jobs_after"] == 0 and report["tasks_after"]["active_count"] == 0
    report["status"] = "passed"
except Exception:
    report["status"] = "failed"
    report["error"] = traceback.format_exc()
    log(report["error"])
finally:
    report["finished_at"] = datetime.now(timezone(timedelta(hours=8))).isoformat()
    (AUDIT / "live-observation-validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    log("Final live checks: " + report["status"])
sys.exit(0 if report["status"] == "passed" else 1)
