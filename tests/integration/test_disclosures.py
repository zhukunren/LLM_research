from dataclasses import replace
import hashlib
import io
import json
import sqlite3

from fastapi.testclient import TestClient
import pytest
from reportlab.pdfgen.canvas import Canvas
from pypdf import PdfWriter

from apps.api.app import db, disclosures, disclosure_sources, documents, jobs, main, worker
from apps.api.app.security_context import LOCAL_ACTOR, actor_scope, AccessDenied
from apps.api.app.report_parser import ReportParserError


def pdf_bytes(label="ORIGINAL SYNTHETIC"):
    stream = io.BytesIO()
    canvas = Canvas(stream)
    canvas.drawString(40, 750, label + " 600519.SH Revenue 100")
    canvas.showPage()
    canvas.showPage()  # blank physical page must remain page 2
    canvas.drawString(40, 750, "Physical page three")
    canvas.save()
    return stream.getvalue()


def metadata(**changes):
    return {"title": "合成年度报告", "stock_code": "600519.SH", "report_period": "2025-12-31",
            "document_type": "annual", "document_form": "full", "publication_date": "2026-04-01", "confirmed": True, **changes}


@pytest.fixture
def archive(tmp_path, monkeypatch):
    monkeypatch.setenv("LLMR_AUTH_MODE", "local")
    monkeypatch.setenv("LLMR_CONFIG_FILE", str(tmp_path / "absent.ini"))
    monkeypatch.setenv("LLMR_STATE_ROOT", str(tmp_path / "state"))
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    with TestClient(main.app) as client:
        with db.connect() as connection:
            connection.execute("INSERT OR IGNORE INTO security_catalog(stock_code,name,pinyin,initials,market,updated_at) VALUES('600519.SH','贵州茅台','','','SH',?)", (db.utc_now(),))
        yield client


def upload(client, key, data=None, meta=None, **options):
    payload = {"request_id": key, "metadata": meta if meta is not None else metadata(), **options}
    response = client.post("/api/v1/disclosures/upload", data={"payload": json.dumps(payload)},
                           files={"file": ("600519.SH-2025年度报告.pdf", data or pdf_bytes(), "application/pdf")})
    assert response.status_code == 202, response.text
    result = response.json()
    worker.execute_job(result["job_id"])
    return client.get("/api/v1/disclosure-imports/" + result["id"]).json()


def detail(client, item):
    return client.get("/api/v1/disclosures/versions/" + item["version_id"]).json()


def test_upload_pages_search_pending_and_original_integrity(archive):
    data = pdf_bytes()
    item = upload(archive, "upload", data=data, meta={"title": "待核对"})
    assert item["state"] == "succeeded", item
    version = detail(archive, item)
    assert version["pages"] == 3 and version["classification_status"] == "pending"
    assert version["metadata"]["suggestions"]["report_period"] == "2025-12-31"
    assert version["metadata"]["suggestions"]["stock_code"] == "600519.SH"
    assert archive.get(version["pdf_url"]).content == data
    assert archive.get(f"/api/v1/disclosures/versions/{version['id']}/pages/2").json()["text"] == ""
    third = archive.get(f"/api/v1/disclosures/versions/{version['id']}/pages/3").json()
    assert "Physical page three" in third["text"] and third["page_number"] == 3
    found = archive.get(f"/api/v1/disclosures/versions/{version['id']}/search?q=Revenue").json()
    assert found["items"][0]["page_number"] == 1
    assert archive.get("/api/v1/disclosures?as_of=2026-04-02").json()["total"] == 0
    assert documents.list_documents() == []  # disclosures do not masquerade as research reports
    original = documents._snapshot_path(hashlib.sha256(data).hexdigest())
    original.write_bytes(b"tampered")
    assert archive.get(version["pdf_url"]).status_code == 409
    assert archive.get(f"/api/v1/disclosures/versions/{version['id']}/pages/1").status_code == 409


def test_classification_correction_history_and_optimistic_lock(archive):
    item = upload(archive, "pending", meta={})
    url = "/api/v1/disclosures/versions/" + item["version_id"] + "/metadata"
    saved = archive.patch(url, json={"base_revision": 1, "metadata": metadata()})
    assert saved.status_code == 200, saved.text
    assert len(saved.json()["metadata_history"]) == 2
    assert archive.patch(url, json={"base_revision": 1, "metadata": metadata()}).status_code == 409
    assert archive.get("/api/v1/disclosures?stock_code=600519.SH&report_period=2025-12-31").json()["total"] == 1
    assert archive.get("/api/v1/disclosures?as_of=2026-04-02").json()["total"] == 1


def test_revision_keeps_old_pdf_and_cutoff_does_not_leak_future_version(archive):
    old_bytes, new_bytes = pdf_bytes("OLD"), pdf_bytes("REVISED")
    first = upload(archive, "first", old_bytes)
    second = upload(archive, "second", new_bytes, meta=metadata(publication_date="2026-05-01"),
                    relation="revision", target_version_id=first["version_id"])
    assert second["state"] == "succeeded", second
    current = detail(archive, second)
    assert current["version"] == 2 and len(current["versions"]) == 2
    assert archive.get("/api/v1/disclosures").json()["total"] == 1
    earlier = archive.get("/api/v1/disclosures?as_of=2026-04-15").json()["items"][0]
    assert earlier["id"] == first["version_id"]
    assert len(archive.get(f"/api/v1/disclosures/versions/{earlier['id']}?as_of=2026-04-15").json()["versions"]) == 1
    assert archive.get(current["pdf_url"] + "?as_of=2026-04-15").status_code == 404
    assert archive.get(detail(archive, first)["pdf_url"]).content == old_bytes
    with db.connect() as connection, pytest.raises(sqlite3.IntegrityError, match="immutable"):
        connection.execute("UPDATE disclosure_versions SET sha256='changed' WHERE id=?", (first["version_id"],))


def test_summary_cannot_replace_full_report_but_correction_can_be_related(archive):
    first = upload(archive, "first")
    response = archive.post("/api/v1/disclosures/upload", data={"payload": json.dumps({
        "request_id": "wrong", "metadata": metadata(document_form="summary"),
        "relation": "revision", "target_version_id": first["version_id"]})},
        files={"file": ("summary.pdf", pdf_bytes("SUMMARY"), "application/pdf")})
    assert response.status_code == 422
    note = upload(archive, "correction", pdf_bytes("CORRECTION NOTICE"),
                  meta=metadata(document_type="correction", document_form="notice"),
                  relation="supplement", target_version_id=first["version_id"])
    assert note["state"] == "succeeded"
    assert detail(archive, first)["version"] == 1
    assert detail(archive, first)["related"][0]["id"] == note["version_id"]


def test_duplicate_bytes_reuse_index_without_parser_and_cannot_reclassify(archive, monkeypatch):
    data = pdf_bytes()
    first = upload(archive, "first", data)
    monkeypatch.setattr(documents, "parse_report", lambda *_args, **_kwargs: pytest.fail("duplicate parsed again"))
    second = upload(archive, "again", data)
    assert second["outcome"] == "duplicate" and second["version_id"] == first["version_id"]
    wrong = upload(archive, "wrong", data, meta=metadata(stock_code="000333.SZ"))
    assert wrong["state"] == "failed" and "其他分类" in wrong["message"]
    assert detail(archive, first)["metadata"]["stock_code"] == "600519.SH"


def test_official_link_new_content_creates_revision_and_parse_retry_reuses_download(archive, monkeypatch):
    contents, calls = [pdf_bytes("FIRST")], []
    url = "https://static.cninfo.com.cn/report.pdf"
    def download(address, **kwargs):
        calls.append(address)
        return contents[0], address
    monkeypatch.setattr(disclosure_sources, "download", download)
    def submit(key, publication):
        response = archive.post("/api/v1/disclosures/import-url", json={"request_id": key, "url": url,
                                                                      "metadata": metadata(publication_date=publication)})
        assert response.status_code == 202, response.text
        worker.execute_job(response.json()["job_id"])
        return archive.get("/api/v1/disclosure-imports/" + response.json()["id"]).json()
    first = submit("url1", "2026-04-01")
    original_parser = documents.parse_report
    contents[0] = pdf_bytes("CHANGED")
    monkeypatch.setattr(documents, "parse_report", lambda *_args, **_kwargs: (_ for _ in ()).throw(ReportParserError("解析失败")))
    failed = submit("url2", "2026-05-01")
    assert failed["state"] == "failed" and failed["sha256"]
    monkeypatch.setattr(documents, "parse_report", original_parser)
    retry = archive.post("/api/v1/disclosure-imports/" + failed["id"] + "/retry").json()
    worker.execute_job(retry["job_id"])
    final = archive.get("/api/v1/disclosure-imports/" + failed["id"]).json()
    assert len(calls) == 2 and final["state"] == "succeeded"
    assert detail(archive, final)["previous_version_id"] == first["version_id"]


def test_scanned_pdf_still_has_readable_physical_pages(archive):
    stream = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=300)
    writer.write(stream)
    item = upload(archive, "scan", stream.getvalue())
    version = detail(archive, item)
    assert version["parse_status"] == "no_text" and version["pages"] == 1
    assert archive.get(version["pdf_url"]).status_code == 200


def test_cancellation_prevents_archive_publication_and_restart_uses_same_source(archive, monkeypatch):
    original_parser = documents.parse_report
    response = archive.post("/api/v1/disclosures/upload", data={"payload": json.dumps({"request_id": "cancel", "metadata": metadata()})},
                            files={"file": ("data.pdf", pdf_bytes(), "application/pdf")}).json()
    def parse(*args, **kwargs):
        result = original_parser(*args, **kwargs)
        jobs.cancel(response["job_id"])
        return result
    monkeypatch.setattr(documents, "parse_report", parse)
    worker.execute_job(response["job_id"])
    assert archive.get("/api/v1/disclosures").json()["total"] == 0
    monkeypatch.setattr(documents, "parse_report", lambda *_args, **_kwargs: pytest.fail("indexed file reparsed"))
    retried = archive.post("/api/v1/disclosure-imports/" + response["id"] + "/retry").json()
    worker.execute_job(retried["job_id"])
    assert archive.get("/api/v1/disclosures").json()["total"] == 1


def test_series_reclassification_preserves_metadata_history(archive):
    first = upload(archive, "first")
    second = upload(archive, "next", pdf_bytes("NEXT"), relation="revision", target_version_id=first["version_id"])
    url = "/api/v1/disclosures/versions/" + second["version_id"] + "/metadata"
    changed = {"base_revision": 1, "metadata": metadata(stock_code="000333.SZ")}
    assert archive.patch(url, json=changed).status_code == 409
    assert archive.patch(url, json={**changed, "propagate_identity": True}).status_code == 200
    old = detail(archive, first)
    assert old["metadata"]["stock_code"] == "000333.SZ" and not old["metadata"]["confirmed"]
    assert old["metadata_history"][-1]["metadata"]["stock_code"] == "600519.SH"


def test_private_workspaces_and_read_only_role(archive):
    item = upload(archive, "private")
    with actor_scope(replace(LOCAL_ACTOR, user_id="other", tenant_id="team", legacy=False, maintenance=True)):
        db.init_db()
        with pytest.raises(disclosures.DisclosureError):
            disclosures.detail(item["version_id"])
        with pytest.raises(disclosures.DisclosureError):
            disclosures.read_import(item["id"])
    with actor_scope(replace(LOCAL_ACTOR, role="viewer")):
        with pytest.raises(AccessDenied):
            disclosures.enqueue(disclosures.ImportRequest(request_id="no"), data=pdf_bytes())


def test_archive_and_classification_survive_backup_restore(archive, tmp_path, monkeypatch):
    from scripts import backup, restore
    data = pdf_bytes("BACKUP")
    item = upload(archive, "backup", data)
    monkeypatch.setattr(backup, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(backup, "DB_PATH", db.database_path())
    monkeypatch.setattr(backup, "STOCK_FILE", tmp_path / "absent.parquet")
    monkeypatch.setattr(backup, "REPORT_DIR", tmp_path / "absent-reports")
    target, restored = tmp_path / "backup", tmp_path / "restored"
    monkeypatch.setattr("sys.argv", ["backup.py", str(target)])
    backup.main()
    monkeypatch.setattr("sys.argv", ["restore.py", str(target), str(restored)])
    restore.main()
    for key, value in json.loads((restored / "storage-environment.json").read_text()).items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(db, "DB_PATH", restored / "runtime/app.db")
    path, saved = disclosures.pdf_path(item["version_id"])
    assert path.is_relative_to(restored) and path.read_bytes() == data
    assert saved["metadata"]["stock_code"] == "600519.SH"
    assert disclosures.read_page(item["version_id"], 3)["page_number"] == 3
