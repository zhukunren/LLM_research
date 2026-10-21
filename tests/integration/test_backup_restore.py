import hashlib
import io
import json
import sqlite3
from pathlib import Path

import pytest

from scripts import backup, restore


def test_nested_uploads_are_backed_up_verified_and_relinked_on_restore(tmp_path, monkeypatch):
    project = tmp_path / "project"
    database = project / "runtime" / "app.db"
    upload = project / "runtime" / "uploads" / "reports" / "sample.pdf"
    pattern = project / "runtime" / "uploads" / "patterns" / "image.png"
    financial_response = project / "runtime" / "financial-sources" / "responses" / "sample.json"
    financial_result = project / "runtime" / "financial-pilots" / "sample" / "result.json"
    for file in (upload, pattern, financial_response, financial_result):
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b"test uploaded content")
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE documents(id TEXT PRIMARY KEY,source_path TEXT)")
        connection.execute("INSERT INTO documents VALUES('report',?)", (str(upload),))
    monkeypatch.setattr(backup, "PROJECT_ROOT", project)
    monkeypatch.setattr(backup, "DB_PATH", database)
    monkeypatch.setattr(backup, "STOCK_FILE", project / "missing.parquet")
    monkeypatch.setattr(backup, "REPORT_DIR", project / "data" / "reports")
    target = tmp_path / "backup"
    monkeypatch.setattr("sys.argv", ["backup.py", str(target)])
    backup.main()
    assert (target / "runtime/uploads/patterns/image.png").read_bytes() == pattern.read_bytes()

    restored = tmp_path / "restored"
    monkeypatch.setattr("sys.argv", ["restore.py", str(target), str(restored)])
    restore.main()
    assert (restored / "runtime/financial-sources/responses/sample.json").read_bytes() == financial_response.read_bytes()
    assert (restored / "runtime/financial-pilots/sample/result.json").read_bytes() == financial_result.read_bytes()
    with sqlite3.connect(restored / "runtime/app.db") as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute("SELECT source_path FROM documents").fetchone()[0] == str(restored / "runtime/uploads/reports/sample.pdf")

    (target / "runtime/uploads/reports/sample.pdf").write_bytes(b"tampered")
    broken = tmp_path / "must-not-exist"
    monkeypatch.setattr("sys.argv", ["restore.py", str(target), str(broken)])
    with pytest.raises(ValueError, match="checksum mismatch"):
        restore.main()
    assert not broken.exists()


@pytest.fixture
def private_backup(tmp_path, monkeypatch):
    from apps.api.app import conversation_store, db, identity, research_attachments
    from apps.api.app.security_context import actor_scope
    from apps.api.app.storage import application_paths
    original = tmp_path / "original"
    for name in ("STATE", "UPLOAD", "ARTIFACT", "SANDBOX_STATE"):
        monkeypatch.setenv(f"LLMR_{name}_ROOT", str(original / name.lower()))
    monkeypatch.setenv("LLMR_AUTH_MODE", "oidc")
    monkeypatch.setenv("LLMR_CONFIG_FILE", str(original / "absent.ini"))
    monkeypatch.setenv("LLMR_IDENTITY_DB_PATH", str(original / "identity/accounts.db"))
    monkeypatch.delenv("LLMR_CODEX_HOME", raising=False)
    database = original / "legacy.db"
    monkeypatch.setattr(db, "DB_PATH", database)
    monkeypatch.setattr(backup, "DB_PATH", database)
    monkeypatch.setattr(backup, "PROJECT_ROOT", original)
    monkeypatch.setattr(backup, "STOCK_FILE", original / "missing.parquet")
    monkeypatch.setattr(backup, "REPORT_DIR", original / "missing-reports")
    identity.initialize()
    with actor_scope(identity.actor_for_user("local-admin", "local")):
        db.init_db()
    users = []
    for name in ("Alice", "Bob"):
        actor = identity.user_from_oidc("https://fixture.invalid", name, name)
        with actor_scope(actor):
            db.init_db()
            cid = conversation_store.create_conversation("screening")["id"]
            attached = research_attachments.upload(cid, "upload", "source.txt", io.BytesIO(name.encode()))
            paths = application_paths()
            original_bytes = ("%PDF-" + name).encode()
            digest = hashlib.sha256(original_bytes).hexdigest()
            pdf = paths.report_originals / (digest + ".pdf")
            pdf.parent.mkdir(parents=True)
            pdf.write_bytes(original_bytes)
            with db.connect() as connection:
                connection.execute("INSERT INTO documents(id,sha256,filename,title,pages,extracted_chars,parse_status,source_path,imported_at) VALUES('doc',?,'source.pdf',?,1,5,'indexed',?,?)", (digest, name, str(pdf), db.utc_now()))
            work = paths.research_root / cid / "work"
            (work / "outputs").mkdir(parents=True)
            (work / "outputs/result.txt").write_text(name, encoding="utf-8")
            snapshot = work / "sources.sqlite"
            with sqlite3.connect(snapshot) as connection:
                connection.execute("CREATE TABLE reports(id TEXT,source_path TEXT)")
                connection.execute("INSERT INTO reports VALUES('doc',?)", (str(pdf),))
            (work / "research-inputs.json").write_text(json.dumps({"workspace": str(work), "sources": {"sqlite": str(snapshot)}}), encoding="utf-8")
            paths.codex_home.mkdir(parents=True)
            (paths.codex_home / "thread.jsonl").write_text(name, encoding="utf-8")
            users.append((actor, cid, attached["id"], name))
    target = tmp_path / "backup"
    monkeypatch.setattr("sys.argv", ["backup.py", str(target)])
    backup.main()
    return target, users


def test_all_private_workspaces_and_identity_survive_verified_restore(private_backup, tmp_path, monkeypatch):
    from apps.api.app import db, identity, research_attachments, research_files
    from apps.api.app.security_context import actor_scope
    from apps.api.app.storage import application_paths
    target, users = private_backup
    manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["format_version"] == 2
    assert sum(item["database"] for item in manifest["files"]) == 6  # global, identity, 2 users, 2 evidence snapshots
    restored = tmp_path / "restored"
    monkeypatch.setattr("sys.argv", ["restore.py", str(target), str(restored)])
    restore.main()
    for key, value in json.loads((restored / "storage-environment.json").read_text()).items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(db, "DB_PATH", restored / "runtime/app.db")
    for actor, cid, attachment_id, name in users:
        recovered = identity.actor_for_user(actor.user_id, actor.tenant_id)
        with actor_scope(recovered):
            paths = application_paths()
            assert paths.database.is_relative_to(restored)
            assert research_attachments.download(cid, attachment_id)[0].read_bytes() == name.encode()
            assert research_files.generated_file_path(cid, "result.txt").read_text(encoding="utf-8") == name
            assert (paths.codex_home / "thread.jsonl").read_text(encoding="utf-8") == name
            with db.connect() as connection:
                pdf = Path(connection.execute("SELECT source_path FROM documents WHERE id='doc'").fetchone()[0])
            assert pdf.is_relative_to(restored) and pdf.read_bytes() == ("%PDF-" + name).encode()
            work = paths.research_root / cid / "work"
            inputs = json.loads((work / "research-inputs.json").read_text(encoding="utf-8"))
            assert Path(inputs["sources"]["sqlite"]) == work / "sources.sqlite"
            with sqlite3.connect(work / "sources.sqlite") as connection:
                assert connection.execute("SELECT source_path FROM reports").fetchone()[0] == str(pdf)


@pytest.mark.parametrize("asset", ["identity", "user_database", "output"])
def test_complete_restore_rejects_corrupted_private_assets(private_backup, tmp_path, monkeypatch, asset):
    target, _ = private_backup
    manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
    record = next(item for item in manifest["files"] if (
        item["path"] == "runtime/identity.db" if asset == "identity" else
        item["path"].endswith("/app.db") and "/tenants/" in item["path"] if asset == "user_database" else
        item["path"].endswith("/outputs/result.txt")))
    (target / record["path"]).write_bytes(b"corrupted")
    restored = tmp_path / "must-not-exist"
    monkeypatch.setattr("sys.argv", ["restore.py", str(target), str(restored)])
    with pytest.raises(ValueError, match="checksum mismatch"):
        restore.main()
    assert not restored.exists()


def test_backup_detects_commits_during_asset_copy(tmp_path, monkeypatch):
    database, asset = tmp_path / "app.db", tmp_path / "result.txt"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE records(value TEXT)")
    asset.write_text("fixture")
    original_copy = backup.shutil.copy2
    def concurrent_copy(source, target):
        with sqlite3.connect(database) as connection:
            connection.execute("INSERT INTO records VALUES('concurrent write')")
        return original_copy(source, target)
    monkeypatch.setattr(backup.shutil, "copy2", concurrent_copy)
    destination = tmp_path / "snapshot"
    with pytest.raises(ValueError, match="Database changed during backup"):
        backup.write_snapshot(destination, [(database, Path("runtime/app.db")), (asset, Path("runtime/result.txt"))])
