"""Indexed PDF citations retain their exact imported bytes across source edits."""
import hashlib
from pathlib import Path
import sqlite3

from fastapi.testclient import TestClient
import pytest

from apps.api.app import db, documents, main, report_catalog, research_workspace
from apps.api.app.report_parser import ParsedReport


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "reports.db")
    monkeypatch.setattr(report_catalog, "enqueue", lambda: None)
    monkeypatch.setattr(documents, "parse_report", lambda path, **kwargs: ParsedReport(
        [path.read_bytes().decode()], {"backend": "test"},
    ))
    db.init_db()


def legacy(path, original):
    digest = hashlib.sha256(original).hexdigest()
    with db.connect() as connection:
        connection.execute("""INSERT INTO documents
            (id,sha256,filename,title,pages,extracted_chars,parse_status,source_path,imported_at)
            VALUES('legacy',?,'original.pdf','Original',1,8,'indexed',?,?)""",
            (digest, str(path), db.utc_now()))
    return digest


def test_import_freezes_bytes_before_parsing_and_source_replacement(library, tmp_path, monkeypatch):
    path = tmp_path / "report.pdf"
    original = b"%PDF-original"
    path.write_bytes(original)
    parsed_paths = []
    def parse(snapshot, **kwargs):
        parsed_paths.append(snapshot)
        path.write_bytes(b"%PDF-replaced-during-parse")
        return ParsedReport([snapshot.read_bytes().decode()], {"backend": "test"})
    monkeypatch.setattr(documents, "parse_report", parse)
    first = documents.import_local_reports(paths=[path])["results"][0]
    assert first["status"] == "indexed"
    assert parsed_paths[0] != path
    assert parsed_paths[0].name == hashlib.sha256(original).hexdigest() + ".pdf"
    second = documents.import_local_reports(paths=[path])["results"][0]
    assert second["id"] != first["id"]
    with TestClient(main.app) as client:
        assert client.get(f"/api/v1/documents/{first['id']}/pdf").content == original
        assert client.get(f"/api/v1/documents/{second['id']}/pdf").content == b"%PDF-replaced-during-parse"
    with db.connect() as connection:
        assert connection.execute("SELECT text FROM document_pages WHERE document_id=?", (first["id"],)).fetchone()[0] == original.decode()


def test_upload_retains_snapshot_when_upload_file_disappears(library, tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    monkeypatch.setattr(main, "REPORT_UPLOAD_DIR", uploads)
    monkeypatch.setattr(documents, "REPORT_UPLOAD_DIR", uploads)
    original = b"%PDF-uploaded-original"
    with TestClient(main.app) as client:
        response = client.post("/api/v1/documents/upload", files={"file": ("report.pdf", original, "application/pdf")})
        assert response.status_code == 200
        doc_id = response.json()["result"]["id"]
        for path in uploads.glob("*.pdf"):
            path.unlink()
        assert client.get(f"/api/v1/documents/{doc_id}/pdf").content == original


def test_legacy_original_is_frozen_on_first_access(library, tmp_path):
    path = tmp_path / "legacy.pdf"
    original = b"%PDF-legacy-original"
    path.write_bytes(original)
    digest = legacy(path, original)
    with TestClient(main.app) as client:
        assert client.get("/api/v1/documents/legacy/pdf").content == original
        path.write_bytes(b"changed")
        assert client.get("/api/v1/documents/legacy/pdf").content == original
    assert documents.original_snapshot(str(path), digest).read_bytes() == original


@pytest.mark.parametrize("state,status", [("changed", 409), ("missing", 404)])
def test_legacy_changed_or_missing_bytes_fail_closed(library, tmp_path, state, status):
    path = tmp_path / "legacy.pdf"
    legacy(path, b"%PDF-original")
    if state == "changed":
        path.write_bytes(b"%PDF-new-content")
    with TestClient(main.app) as client:
        response = client.get("/api/v1/documents/legacy/pdf")
        assert response.status_code == status
        assert not response.content.startswith(b"%PDF-")
    exported = tmp_path / "research.sqlite"
    research_workspace._snapshot(exported)
    with sqlite3.connect(exported) as connection:
        assert connection.execute("SELECT source_path FROM reports").fetchone()[0] is None


def test_research_export_freezes_valid_legacy_source(library, tmp_path):
    path = tmp_path / "legacy.pdf"
    original = b"%PDF-original"
    path.write_bytes(original)
    legacy(path, original)
    exported = tmp_path / "research.sqlite"
    research_workspace._snapshot(exported)
    with sqlite3.connect(exported) as connection:
        snapshot = Path(connection.execute("SELECT source_path FROM reports").fetchone()[0])
    path.write_bytes(b"replacement")
    assert snapshot != path and snapshot.read_bytes() == original


def test_corrupted_snapshot_is_never_served(library, tmp_path):
    path = tmp_path / "report.pdf"
    path.write_bytes(b"%PDF-original")
    item = documents.import_local_reports(paths=[path])["results"][0]
    snapshot = documents.original_snapshot(str(path), item["sha256"])
    snapshot.chmod(0o644)
    snapshot.write_bytes(b"%PDF-tampered")
    with TestClient(main.app) as client:
        assert client.get(f"/api/v1/documents/{item['id']}/pdf").status_code == 409


def test_original_snapshots_survive_backup_restore_without_source_copies(library, tmp_path, monkeypatch):
    from scripts import backup, restore
    path = tmp_path / "report.pdf"
    original = b"%PDF-backed-up-original"
    path.write_bytes(original)
    item = documents.import_local_reports(paths=[path])["results"][0]
    monkeypatch.setattr(backup, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(backup, "DB_PATH", db.DB_PATH)
    monkeypatch.setattr(backup, "STOCK_FILE", tmp_path / "missing.parquet")
    monkeypatch.setattr(backup, "REPORT_DIR", tmp_path / "local-reports")
    target = tmp_path / "backup"
    monkeypatch.setattr("sys.argv", ["backup.py", str(target)])
    backup.main()
    restored = tmp_path / "restored"
    monkeypatch.setattr("sys.argv", ["restore.py", str(target), str(restored)])
    restore.main()
    monkeypatch.setattr(db, "DB_PATH", restored / "runtime" / "app.db")
    path.unlink()
    with db.connect() as connection:
        row = connection.execute("SELECT source_path,sha256 FROM documents WHERE id=?", (item["id"],)).fetchone()
    assert Path(row["source_path"]).is_relative_to(restored)
    assert documents.original_snapshot(row["source_path"], row["sha256"]).read_bytes() == original
    saved = target / "runtime" / "report-originals" / f"{item['sha256']}.pdf"
    saved.write_bytes(b"tampered")
    broken = tmp_path / "broken-restore"
    monkeypatch.setattr("sys.argv", ["restore.py", str(target), str(broken)])
    with pytest.raises(ValueError, match="checksum mismatch"):
        restore.main()
    assert not broken.exists()


def test_reimport_of_matching_legacy_bytes_relinks_to_snapshot(library, tmp_path):
    path = tmp_path / "legacy.pdf"
    original = b"%PDF-original"
    path.write_bytes(original)
    digest = legacy(path, original)
    result = documents.import_local_reports(paths=[path])["results"][0]
    assert result["id"] == "legacy" and result["status"] == "already_imported"
    with db.connect() as connection:
        saved_path = Path(connection.execute("SELECT source_path FROM documents").fetchone()[0])
    assert saved_path.name == digest + ".pdf" and saved_path != path


def test_concurrent_imports_publish_one_complete_original(library, tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    path = tmp_path / "report.pdf"
    original = b"%PDF-original"
    path.write_bytes(original)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: documents.import_local_reports(paths=[path]), range(2)))
    assert all(result["failed"] == 0 for result in results)
    assert sum(result["imported"] for result in results) == 1
    assert results[0]["results"][0]["id"] == results[1]["results"][0]["id"]
    with db.connect() as connection:
        saved_path = Path(connection.execute("SELECT source_path FROM documents").fetchone()[0])
    assert saved_path.read_bytes() == original
    assert not list(saved_path.parent.glob("*.partial"))


@pytest.mark.parametrize("changed", [False, True])
def test_legacy_research_snapshot_relinks_only_original_path(library, tmp_path, changed):
    path = tmp_path / "legacy.pdf"
    original = b"%PDF-original"
    path.write_bytes(b"replacement" if changed else original)
    frozen_db = tmp_path / "old-research.sqlite"
    digest = hashlib.sha256(original).hexdigest()
    with sqlite3.connect(frozen_db) as connection:
        connection.execute("CREATE TABLE reports(id,source_path,sha256,title)")
        connection.execute("INSERT INTO reports VALUES('old',?,?,'Frozen title')", (str(path), digest))
        connection.execute("CREATE TABLE report_pages(document_id,page_number,text)")
        connection.execute("INSERT INTO report_pages VALUES('old',1,'Frozen indexed text')")
    research_workspace._freeze_snapshot_originals(frozen_db)
    with sqlite3.connect(frozen_db) as connection:
        row = connection.execute("SELECT source_path,sha256,title FROM reports").fetchone()
        assert row[1:] == (digest, "Frozen title")
        assert connection.execute("SELECT text FROM report_pages").fetchone()[0] == "Frozen indexed text"
    if changed:
        assert row[0] is None
    else:
        assert Path(row[0]) != path and Path(row[0]).read_bytes() == original
