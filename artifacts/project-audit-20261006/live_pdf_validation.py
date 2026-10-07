"""Verify only audit-owned PDF artifacts through the real isolated local API."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys

from pypdf import PdfReader
import requests


AUDIT = Path(__file__).resolve().parent
BASE = "http://127.0.0.1:8066"
CID = "7524a737-283d-4762-b713-ce7569120e64"
PID = "1ee026b1-735f-4c84-9f3e-48e360fcb070"
NID = "bb0a4662-0607-4cc3-b462-d37ffdff5c4a"
ORIGINAL_JOBS = ["ca1c8ce1-2f0d-4f24-818c-7d7482d67b35", "4bf14034-c53b-4426-83fc-d0542791db83", "ebf2066d-e538-4a61-9343-0ddc12ecee54"]


def main():
    session = requests.Session()
    session.trust_env = False
    output = {"base_url": BASE, "conversation_id": CID, "project_id": PID, "note_id": NID, "initial_jobs": [], "pdfs": []}

    def request(method, path, **kwargs):
        return session.request(method, BASE + path, timeout=30, **kwargs)

    for jid in ORIGINAL_JOBS:
        response = request("GET", f"/api/v1/jobs/{jid}")
        response.raise_for_status()
        data = response.json()
        assert data["kind"] == "research_pdf" and data["state"] == "succeeded", data
        output["initial_jobs"].append(data)

    conversation = request("GET", f"/api/v1/conversations/{CID}").json()
    completed = next(turn for turn in conversation["turns"] if turn["state"] == "succeeded")
    report_expected = completed["response_text"]
    project = request("GET", f"/api/v1/research-projects/{PID}").json()
    note = next(note for note in project["notes"] if note["id"] == NID)

    def save_pdf(item, filename, expected):
        response = request("GET", item["url"])
        response.raise_for_status()
        path = AUDIT / filename
        path.write_bytes(response.content)
        reader = PdfReader(path)
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
        compact = "".join(text.split())
        expected_compact = "".join(expected.split())
        # Cover/Markdown headings may insert spaces but accepted text must remain.
        assert expected_compact in compact, (expected, text)
        result = {"name": item["name"], "url": item["url"], "http_status": response.status_code, "local_path": str(path), "bytes": len(response.content), "sha256": hashlib.sha256(response.content).hexdigest(), "pages": len(reader.pages), "expected_text_present": True, "extracted_text": text}
        output["pdfs"].append(result)
        return result

    items = request("GET", f"/api/v1/conversations/{CID}/research-files").json()["items"]
    report = next(item for item in items if item.get("source_kind") == "turn" and item["status"] == "succeeded")
    save_pdf(report, "live-conversation-report.pdf", report_expected)
    save_pdf(note["pdf"], "live-research-note.pdf", note["body"])

    before = request("GET", f"/api/v1/research-projects/{PID}/files")
    assert before.status_code == 200
    renamed = project["name"] + "（PDF 重生成验收）"
    response = request("PATCH", f"/api/v1/research-projects/{PID}", json={"base_revision": project["revision"], "name": renamed, "objective": project["objective"], "status": project["status"]})
    response.raise_for_status()
    replacement = request("POST", f"/api/v1/research-projects/{PID}/notes/{NID}/pdf-jobs", json={})
    replacement.raise_for_status()
    job = replacement.json()
    assert job["status"] == "queued", job
    failing = request("GET", f"/api/v1/research-projects/{PID}/files")
    output["regeneration"] = {"before_http_status": before.status_code, "replacement_job_id": job["job_id"], "queued_http_status": failing.status_code, "queued_response": failing.text, "project_name": renamed}
    assert failing.status_code == 500, failing.text

    executed = subprocess.run([sys.executable, str(AUDIT / "live_server.py"), "--job", job["job_id"]], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert executed.returncode == 0, executed.stderr
    output["regeneration"]["worker_stdout"] = executed.stdout.strip()
    restored = request("GET", f"/api/v1/research-projects/{PID}/files")
    output["regeneration"]["completed_http_status"] = restored.status_code
    assert restored.status_code == 200, restored.text
    latest = request("GET", f"/api/v1/research-projects/{PID}/notes/{NID}/pdf-status").json()["pdf"]
    assert latest["status"] == "succeeded", latest
    save_pdf(latest, "live-research-note-regenerated.pdf", note["body"])
    remaining = request("GET", "/api/v1/tasks?active_only=true").json()
    output["remaining_audit_tasks"] = [item for item in remaining["items"] if item["destination"].get("conversation_id") == CID or item["destination"].get("project_id") == PID]
    assert not output["remaining_audit_tasks"], output["remaining_audit_tasks"]
    destination = AUDIT / "live-pdf-validation.json"
    destination.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"pdfs": [{key: value for key, value in pdf.items() if key != "extracted_text"} for pdf in output["pdfs"]], "regeneration": output["regeneration"], "remaining_audit_tasks": output["remaining_audit_tasks"], "evidence": str(destination)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
