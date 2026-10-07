"""Real HTTP/PDF/worker regression against the isolated audit database only."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
import traceback
from uuid import uuid4

from pypdf import PdfReader
import requests

AUDIT = Path(__file__).resolve().parent
ROOT = AUDIT.parents[1]
BASE = "http://127.0.0.1:8066"
REPORT = AUDIT / "live-pdf-validation.json"
LOG = AUDIT / "live-pdf-validation.log"
SESSION = requests.Session()
SESSION.trust_env = False
result = {"status": "running", "database": str(AUDIT / "live" / "app.db"), "model_calls": 0,
          "started_at": datetime.now(timezone(timedelta(hours=8))).isoformat(), "http_calls": [], "jobs": []}


def log(message):
    with LOG.open("a", encoding="utf-8") as stream:
        stream.write(message + "\n")
    print(message, flush=True)


def request(method, path, payload=None):
    response = SESSION.request(method, BASE + path, json=payload, timeout=90)
    result["http_calls"].append({"method": method, "path": path, "status": response.status_code,
                                 "request_id": response.headers.get("X-Request-ID")})
    log(f"HTTP {method} {path} -> {response.status_code}")
    assert response.ok, f"HTTP {response.status_code}: {response.text[:2000]}"
    return response


def execute_note_job(task, project_id, note_id):
    assert task["source_kind"] == "note" and task["source_id"] == note_id and task["project_id"] == project_id
    assert task["status"] in {"queued", "succeeded"}, task
    if task["status"] == "succeeded":
        return task
    job = request("GET", "/api/v1/jobs/" + task["job_id"]).json()
    assert job["kind"] == "research_pdf" and job["state"] == "queued"
    log("Execute only selected note PDF job " + task["job_id"])
    worker = subprocess.run(
        [sys.executable, str(AUDIT / "live_server.py"), "--job", task["job_id"]],
        cwd=ROOT, env=os.environ.copy(), capture_output=True, text=True, encoding="utf-8", timeout=180,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    result["jobs"].append({"job_id": task["job_id"], "export_id": task["id"], "exit_code": worker.returncode,
                            "stdout": worker.stdout, "stderr": worker.stderr})
    log(f"Worker exit={worker.returncode}; stdout={worker.stdout.strip()}; stderr={worker.stderr.strip()[:4000]}")
    assert worker.returncode == 0 and worker.stdout.strip() == "True"
    ready = request("GET", f"/api/v1/research-projects/{project_id}/notes/{note_id}/pdf-status?revision={task['source_revision']}").json()["pdf"]
    assert ready["id"] == task["id"] and ready["status"] == "succeeded" and ready["url"], ready
    return ready


def download(task, name, *, title, project_name, marker=None):
    response = request("GET", task["url"])
    assert "application/pdf" in response.headers["Content-Type"]
    assert response.content.startswith(b"%PDF-")
    path = AUDIT / name
    path.write_bytes(response.content)
    reader = PdfReader(BytesIO(response.content))
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert len(reader.pages) >= 1 and title in text and project_name in text
    if marker:
        assert marker in text
    return response.content, {"path": str(path), "pages": len(reader.pages), "bytes": len(response.content), "text": text}


def main(args):
    LOG.write_text("Real PDF replacement validation against isolated audit DB\n", encoding="utf-8")
    assert request("GET", "/api/v1/health").json()["status"] == "ok"
    marker = None
    if args.project_id:
        project = request("GET", "/api/v1/research-projects/" + args.project_id).json()
        history = request("GET", f"/api/v1/research-projects/{args.project_id}/notes/{args.note_id}/history").json()["items"]
        note = history[0]
        assert note["id"] == args.note_id and note["project_id"] == args.project_id
    else:
        token = uuid4().hex[:12]
        marker = "PDF-QA-" + token
        project = request("POST", "/api/v1/research-projects", {
            "name": "PDF实机复测原专题 " + token, "objective": "仅在审查数据库副本中验证报告，不调用模型", "request_id": "pdf-qa-project-" + token}).json()
        note = request("POST", f"/api/v1/research-projects/{project['id']}/notes", {
            "title": "PDF完整正文验收 " + token,
            "body": "# 实机报告回归\n\n" + marker + "\n\n这是独立审查正文。排队期间应能打开上一份报告，完成后应能打开更新后的报告。\n\n|检查|结果|\n|---|---|\n|来源|隔离数据库|\n|模型调用|零|",
            "request_id": "pdf-qa-note-" + token}).json()
    result["project"] = project
    result["note"] = note
    project_id, note_id = project["id"], note["id"]
    note_url = f"/api/v1/research-projects/{project_id}/notes/{note_id}/pdf-jobs"
    first_task = request("POST", note_url, {"revision": note["revision"]}).json()
    first = execute_note_job(first_task, project_id, note_id)
    result["first_export"] = first
    old_bytes, result["first_pdf"] = download(first, "live-pdf-original.pdf", title=note["title"], project_name=project["name"], marker=marker)
    files_url = f"/api/v1/research-projects/{project_id}/files"
    result["before_files"] = request("GET", files_url).json()["items"]
    changed_name = (project["name"][:70] + " 更新专题 " + uuid4().hex[:8])
    renamed = request("PATCH", "/api/v1/research-projects/" + project_id, {
        "base_revision": project["revision"], "name": changed_name,
        "objective": project["objective"], "status": project["status"],
    }).json()
    result["renamed_project"] = renamed
    replacement = request("POST", note_url, {"revision": note["revision"]}).json()
    result["queued_replacement"] = replacement
    assert replacement["id"] != first["id"] and replacement["status"] == "queued" and replacement["url"] is None
    queued_files = request("GET", files_url).json()["items"]
    result["queued_files"] = queued_files
    assert request("GET", files_url).json()["items"] == queued_files
    pending = next(item for item in queued_files if item.get("id") == replacement["id"])
    previous = next(item for item in queued_files if item.get("url") == first["url"])
    assert pending["status"] == "queued" and pending["url"] is None
    assert previous["previous"] and previous["status"] == "succeeded"
    assert "conversation_id" in previous and previous["project_id"] == project_id
    assert request("GET", first["url"]).content == old_bytes
    ready = execute_note_job(replacement, project_id, note_id)
    result["completed_replacement"] = ready
    completed_files = request("GET", files_url).json()["items"]
    result["completed_files"] = completed_files
    assert request("GET", files_url).json()["items"] == completed_files
    assert next(item for item in completed_files if item.get("id") == ready["id"])["status"] == "succeeded"
    assert not any(item.get("url") == first["url"] for item in completed_files)
    new_bytes, result["replacement_pdf"] = download(ready, "live-pdf-replacement.pdf", title=note["title"], project_name=changed_name, marker=marker)
    assert new_bytes != old_bytes and ready["url"] != first["url"]
    assert request("GET", first["url"]).content == old_bytes
    result["status"] = "passed"


parser = argparse.ArgumentParser()
parser.add_argument("--project-id")
parser.add_argument("--note-id")
args = parser.parse_args()
if bool(args.project_id) != bool(args.note_id):
    parser.error("--project-id and --note-id must be provided together, or omit both to create an independent QA note")
try:
    main(args)
except Exception:
    result["status"] = "failed"
    result["error"] = traceback.format_exc()
    log(result["error"])
finally:
    result["finished_at"] = datetime.now(timezone(timedelta(hours=8))).isoformat()
    REPORT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    log("Validation status: " + result["status"])
sys.exit(0 if result["status"] == "passed" else 1)
