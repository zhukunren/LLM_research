from pathlib import Path

import pytest

from scripts import backup_io


def locked_error():
    error = PermissionError("temporary Windows sharing lock")
    error.winerror = 5
    return error


def test_verified_directory_is_published_after_transient_sharing_errors(tmp_path, monkeypatch):
    staged, target = tmp_path / "backup.tmp", tmp_path / "backup"
    staged.mkdir()
    (staged / "verified.txt").write_text("verified")
    original = Path.rename
    calls, waits = [], []
    def rename(path, destination):
        calls.append(path)
        if len(calls) < 3:
            raise locked_error()
        return original(path, destination)
    monkeypatch.setattr(Path, "rename", rename)
    monkeypatch.setattr(backup_io.time, "sleep", waits.append)
    backup_io.publish_directory(staged, target)
    assert (target / "verified.txt").read_text() == "verified"
    assert waits == [0.05, 0.1]
    assert not staged.exists()


def test_publication_has_a_finite_retry_budget_and_never_replaces_existing_data(tmp_path, monkeypatch):
    staged, target = tmp_path / "restore.tmp", tmp_path / "restore"
    staged.mkdir()
    attempts = []
    def blocked(*_args):
        attempts.append(True)
        raise locked_error()
    monkeypatch.setattr(Path, "rename", blocked)
    monkeypatch.setattr(backup_io.time, "sleep", lambda _seconds: None)
    with pytest.raises(PermissionError):
        backup_io.publish_directory(staged, target)
    assert len(attempts) == 6 and staged.is_dir() and not target.exists()
    target.mkdir()
    (target / "existing.txt").write_text("keep")
    with pytest.raises(FileExistsError):
        backup_io.publish_directory(staged, target)
    assert (target / "existing.txt").read_text() == "keep" and len(attempts) == 6
