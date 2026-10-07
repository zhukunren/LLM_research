"""Read-only project audit reproductions; all application state is temporary.

Run from repository root with Python 3.12 and runtime/python-deps on PYTHONPATH.
No production database writes or external/model calls are made.
"""
from __future__ import annotations

import json
import socket
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from pypdf import PdfWriter

from apps.api.app import conversation_store as store, db, main
from apps.api.app import research_external as external
from apps.api.app import research_pdf as pdf, research_projects as projects
from apps.api.app import research_observations as candidates
from apps.api.app import worker
from apps.api.app import news_library


def run() -> dict:
    evidence = {}
    with tempfile.TemporaryDirectory(prefix="llmr-audit-") as tmp:
        with patch.object(db, "DB_PATH", Path(tmp) / "audit.db"):
            db.init_db()
            with TestClient(main.app, raise_server_exceptions=False) as client:
                # A rejected CORS origin still creates a maintenance task.
                response = client.post("/api/v1/maintenance/refresh", headers={"Origin": "http://untrusted.example", "Content-Type": "application/x-www-form-urlencoded"})
                with db.connect() as connection:
                    created = connection.execute("SELECT count(*) FROM jobs WHERE kind='data_sync'").fetchone()[0]
                evidence["cross_origin_mutation"] = {"status": response.status_code, "queued_jobs": created, "cors_allow_origin": response.headers.get("Access-Control-Allow-Origin")}

                # Reconstruct a note with an existing PDF from before job migration.
                project = projects.create_project(projects.CreateProject(name="Audit", request_id="project"))
                note = projects.create_note(project["id"], projects.CreateNote(title="Legacy", body="Legacy research note", request_id="note"))
                blob = BytesIO()
                writer = PdfWriter()
                writer.add_blank_page(width=595, height=842)
                writer.write(blob)
                cached = pdf._cached(project["id"], f"研究笔记-{note['id'][:8]}-v1.pdf", b"audit-legacy", lambda path: path.write_bytes(blob.getvalue()), project=True)
                with db.connect() as connection:
                    connection.execute("DELETE FROM research_pdf_exports WHERE id=?", (note["pdf"]["id"],))
                    connection.execute("DELETE FROM jobs WHERE id=?", (note["pdf"]["job_id"],))
                response = client.get(f"/api/v1/research-projects/{project['id']}/files")
                try:
                    projects.project_files(project["id"])
                except Exception as exc:
                    cause = f"{type(exc).__name__}: {exc}"
                else:
                    cause = None
                evidence["legacy_project_pdf"] = {"status": response.status_code, "cause": cause, "pdf_download_status": client.get(cached["url"]).status_code}

                # Also occurs in a normal current-version workflow: an earlier
                # PDF exists while a replacement of the same note is queued.
                project2 = projects.create_project(projects.CreateProject(name="Original name", request_id="project2"))
                note2 = projects.create_note(project2["id"], projects.CreateNote(title="Current", body="A saved current-version note", request_id="note2"))
                worker.execute_job(note2["pdf"]["job_id"])
                before = client.get(f"/api/v1/research-projects/{project2['id']}/files")
                projects.update_project(project2["id"], projects.UpdateProject(base_revision=1, name="Renamed project"))
                replacement = client.post(f"/api/v1/research-projects/{project2['id']}/notes/{note2['id']}/pdf-jobs", json={}).json()
                after = client.get(f"/api/v1/research-projects/{project2['id']}/files")
                evidence["replacement_project_pdf"] = {"before_status": before.status_code, "replacement_status": replacement.get("status"), "after_status": after.status_code}

                # Failed-turn system text is accepted as a research source.
                cid = store.create_conversation("report", workflow_type="research")["id"]
                message = store.add_user_message(cid, "first", 0, "研究公司")
                store.start_turn(cid, message["turn_id"])
                store.fail_turn(cid, message["turn_id"], "连接失败，没有研究结果")
                with db.connect() as connection:
                    source_id = connection.execute("SELECT id FROM conversation_messages WHERE conversation_id=? AND role='assistant'", (cid,)).fetchone()[0]
                    connection.execute("INSERT INTO security_catalog VALUES('600519.SH','贵州茅台','','','SH','2026-10-06')")
                response = client.post("/api/v1/observation/research-candidates", json={"request_id": "failed-source", "conversation_id": cid, "source_message_id": source_id, "stock_code": "600519.SH"})
                evidence["failed_source_candidate"] = {"status": response.status_code, "source_text": response.json().get("source_text"), "source_scope_status": response.json().get("source_scope_status")}

        # Simulate a DNS change between guard resolution and the HTTP connection.
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                internal = self.path.startswith("/internal")
                body = (b"<html><title>Isolated internal service</title><body>" + b"audit-private-data-only " * 20 + b"</body></html>") if internal else b"loopback-source-reached"
                self.send_response(200)
                self.send_header("Content-Type", "text/html" if internal else "text/csv")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        real_resolve = socket.getaddrinfo
        calls = []

        def rebind(host, port, *args, **kwargs):
            if host == "audit-rebind.example":
                address = "93.184.216.34" if not calls else "127.0.0.1"
                calls.append(address)
                return real_resolve(address, port, *args, **kwargs)
            return real_resolve(host, port, *args, **kwargs)

        try:
            page = news_library.extract_web_text(f"http://127.0.0.1:{server.server_port}/internal")
            evidence["news_private_source"] = {"url": page["url"], "title": page["title"], "text_prefix": page["text"][:100], "text_length": len(page["text"])}
            captured = []

            def fake_model(_instructions, content, **_kwargs):
                captured.append(content)
                return {"title": "Isolated internal source", "body": "Audit source", "source": "Audit", "published_at": None, "stock_codes": [], "event_key": None}

            with patch.object(db, "DB_PATH", Path(tmp) / "audit.db"), patch.object(news_library, "complete_json", side_effect=fake_model):
                with TestClient(main.app, raise_server_exceptions=False) as client:
                    response = client.post("/api/v1/news/import-url", json={"url": page["url"], "request_id": "internal-news"})
            evidence["news_private_source"].update({"api_status": response.status_code, "private_text_sent_to_model_function": bool(captured and "audit-private-data-only" in captured[0])})
            target = Path(tmp) / "source.csv"
            with patch.object(socket, "getaddrinfo", side_effect=rebind), patch.object(external, "_network_proxies", return_value={}):
                final_url, media = external._download(f"http://audit-rebind.example:{server.server_port}/source.csv", target, 1024)
            evidence["dns_rebinding"] = {"resolutions": calls, "saved_body": target.read_text(), "final_url": final_url, "content_type": media}
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
    return evidence


if __name__ == "__main__":
    result = run()
    destination = Path(__file__).with_name("backend_repro_results.json")
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
