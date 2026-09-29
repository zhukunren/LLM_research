import sqlite3

import pytest

from scripts import backup, restore


def test_nested_uploads_are_backed_up_verified_and_relinked_on_restore(tmp_path, monkeypatch):
    project = tmp_path / "project"
    database = project / "runtime" / "app.db"
    upload = project / "runtime" / "uploads" / "reports" / "sample.pdf"
    pattern = project / "runtime" / "uploads" / "patterns" / "image.png"
    for file in (upload, pattern):
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
    with sqlite3.connect(restored / "runtime/app.db") as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute("SELECT source_path FROM documents").fetchone()[0] == str(restored / "runtime/uploads/reports/sample.pdf")

    (target / "runtime/uploads/reports/sample.pdf").write_bytes(b"tampered")
    broken = tmp_path / "must-not-exist"
    monkeypatch.setattr("sys.argv", ["restore.py", str(target), str(broken)])
    with pytest.raises(ValueError, match="checksum mismatch"):
        restore.main()
    assert not broken.exists()
