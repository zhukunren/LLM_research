"""Opt-in retention for this tool's verified, same-dataset backup siblings.

Unknown, incomplete, modified and pinned directories are never deletion candidates.
The caller holds backup_lock across snapshot creation, publication and rotation.
"""
from __future__ import annotations

from contextlib import ExitStack, closing, contextmanager
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import sqlite3
import stat
import uuid

from scripts.backup_io import pin_windows_parents


MARKER = "retention"
PIN = ".keep"
LOCK = ".llmr-backup.lock"


def unlinked_path(path: Path) -> Path:
    """Check lexical ancestors before resolving: resolve alone hides links."""
    path = Path(os.path.abspath(path))
    for part in [*reversed(path.parents), path]:
        if part.is_symlink() or part.is_junction():
            raise ValueError(f"Linked backup path is not allowed: {part}")
        try:
            attributes = getattr(part.lstat(), "st_file_attributes", 0)
        except FileNotFoundError:
            continue
        if attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise ValueError(f"Reparse backup path is not allowed: {part}")
    return path


def identity(path: Path) -> tuple[int, int]:
    status = path.stat(follow_symlinks=False)
    return status.st_dev, status.st_ino


@contextmanager
def backup_lock(root: Path):
    root = unlinked_path(root)
    root.mkdir(parents=True, exist_ok=True)
    unlinked_path(root)
    lock = root / LOCK
    descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    own = identity(lock)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(json.dumps({"pid": os.getpid(), "purpose": "backup and retention"}))
            stream.flush()
            os.fsync(stream.fileno())
        yield
    finally:
        # Never remove an unknown/stale lock or a lock replaced by another writer.
        if lock.exists() and not lock.is_symlink() and identity(lock) == own:
            lock.unlink()


def dataset_id(locations: list[tuple[Path, Path]], include_source: bool, sources: list[Path]) -> str:
    layout = {"mappings": sorted((str(source.resolve()), relative.as_posix()) for source, relative in locations),
              "include_source": include_source, "sources": sorted(str(path.resolve()) for path in sources)}
    return hashlib.sha256(json.dumps(layout, sort_keys=True).encode()).hexdigest()


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def relative_path(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise ValueError("Invalid backup inventory path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != value or value == ".":
        raise ValueError("Unsafe backup inventory path")
    return path


def absolute_source(value) -> bool:
    return isinstance(value, str) and bool(value) and (Path(value).is_absolute() or PureWindowsPath(value).is_absolute())


def verify_backup(path: Path, dataset: str) -> dict:
    path = unlinked_path(path)
    if not path.is_dir():
        raise ValueError("Backup directory is missing")
    actual = set()
    actual_directories = set()
    for folder, directories, files in os.walk(path, followlinks=False):
        for name in directories + files:
            entry = Path(folder) / name
            unlinked_path(entry)
            if not entry.is_dir() and not entry.is_file():
                raise ValueError("Backup contains a non-regular entry")
        actual_directories.update((Path(folder) / name).relative_to(path).as_posix() for name in directories)
        actual.update((Path(folder) / name).relative_to(path).as_posix() for name in files)
    manifest_path = path / "manifest.json"
    if manifest_path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Backup manifest is too large")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("format_version") != 2 or manifest.get(MARKER) != {"version": 1, "dataset_id": dataset}:
        raise ValueError("Backup is not managed for this dataset")
    if manifest.get("database") != "runtime/app.db" or not isinstance(manifest.get("files"), list):
        raise ValueError("Backup inventory is incomplete")
    created = datetime.fromisoformat(manifest["created_at"])
    if created.tzinfo is None:
        raise ValueError("Backup timestamp must include a timezone")
    mappings = manifest.get("storage_mappings")
    if not isinstance(mappings, list) or not mappings or not all(isinstance(item, dict) for item in mappings):
        raise ValueError("Backup storage mappings are missing or invalid")
    for mapping in mappings:
        relative_path(mapping.get("path"))
        if not absolute_source(mapping.get("original_path")):
            raise ValueError("Backup original storage path is invalid")
    if not any(item["path"] == "runtime/app.db" for item in mappings):
        raise ValueError("Backup database storage mapping is missing")
    copied = manifest.get("source_files_copied")
    entries = list(manifest["files"])
    references = manifest.get("source_references")
    if type(copied) is not bool or not isinstance(references, list) or not all(isinstance(item, dict) for item in entries + references):
        raise ValueError("Backup inventory entries are invalid")
    for reference in references:
        if not absolute_source(reference.get("path")) or type(reference.get("bytes")) is not int or reference["bytes"] < 0 or not isinstance(reference.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", reference["sha256"]):
            raise ValueError("Backup source reference is invalid")
        if copied != bool(reference.get("backup_copy")):
            raise ValueError("Backup source copies do not match the declared mode")
        if copied:
            relative_path(reference["backup_copy"])
            entries.append({**reference, "path": reference["backup_copy"], "database": False})
    expected = {"manifest.json"}
    expected_directories = set()
    has_database = False
    for entry in entries:
        relative = entry["path"]
        parts = relative_path(relative)
        if relative in expected or relative == PIN:
            raise ValueError("Repeated backup inventory path")
        expected.add(relative)
        expected_directories.update(parent.as_posix() for parent in parts.parents if parent != PurePosixPath("."))
        source = path / relative
        if not source.is_file() or type(entry.get("bytes")) is not int or source.stat().st_size != entry["bytes"]:
            raise ValueError(f"Backup file size mismatch: {relative}")
        if not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) or digest(source) != entry["sha256"]:
            raise ValueError(f"Backup checksum mismatch: {relative}")
        if type(entry.get("database")) is not bool:
            raise ValueError("Backup database flag is invalid")
        if relative == "runtime/app.db":
            has_database = entry["database"]
        if entry["database"]:
            with closing(sqlite3.connect(source.as_uri() + "?mode=ro&immutable=1", uri=True)) as database:
                if database.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                    raise ValueError(f"Backup database integrity check failed: {relative}")
    if not has_database or actual - {PIN} != expected or actual_directories != expected_directories:
        raise ValueError("Backup contains missing or untracked files")
    return manifest





def remove_candidate(root: Path, candidate: Path, original: tuple[int, int], dataset: str, expected_root: tuple[int, int]) -> bool:
    with ExitStack() as stack:
        stack.enter_context(pin_windows_parents(root))
        root = unlinked_path(root)
        fd = None
        if shutil.rmtree.avoids_symlink_attacks:
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            stack.callback(os.close, fd)
            info = os.fstat(fd)
            if (info.st_dev, info.st_ino) != expected_root:
                raise ValueError("Backup root changed before retirement")
        elif os.name != "nt":
            raise ValueError("This platform cannot safely delete backups; use --retention-dry-run")

        def unchanged():
            unlinked_path(root)
            if identity(root) != expected_root:
                raise ValueError("Backup root changed during retirement")

        unchanged()
        if candidate.parent != root or identity(candidate) != original:
            raise ValueError("Backup candidate changed before deletion")
        if (candidate / PIN).exists() or (candidate / PIN).is_symlink():
            return False
        verify_backup(candidate, dataset)
        unchanged()
        quarantine = root / (".llmr-retiring-" + uuid.uuid4().hex)
        if fd is not None:
            os.rename(candidate.name, quarantine.name, src_dir_fd=fd, dst_dir_fd=fd)
        else:
            candidate.rename(quarantine)
        try:
            unchanged()
            if identity(quarantine) != original:
                raise ValueError("Backup candidate changed during retirement")
            verify_backup(quarantine, dataset)
            if (quarantine / PIN).exists():
                raise ValueError("Backup was pinned during retirement")
            unchanged()
        except Exception:
            # Nothing deleted yet; restore only in the original, verified parent.
            unchanged()
            if not candidate.exists() and not candidate.is_symlink():
                if fd is not None:
                    os.rename(quarantine.name, candidate.name, src_dir_fd=fd, dst_dir_fd=fd)
                else:
                    quarantine.rename(candidate)
            raise
        # On failure leave this retirement directory for inspection and stop the batch.
        # POSIX removal stays anchored to the checked parent inode; Windows ancestors
        # are pinned against replacement and Python 3.12 does not traverse junctions.
        if fd is not None:
            shutil.rmtree(quarantine.name, dir_fd=fd)
        else:
            shutil.rmtree(quarantine)
        return True


def rotate_backups(published: Path, dataset: str, retain_count: int, *, dry_run: bool = False) -> list[Path]:
    if type(retain_count) is not int or retain_count < 1:
        raise ValueError("Retention count must be an integer of at least 1")
    published = unlinked_path(published)
    root = published.parent
    root_identity = identity(root)
    verify_backup(published, dataset)  # New backup must pass before considering any deletion.
    candidates = []
    for candidate in root.iterdir():
        if candidate == published or candidate.name.startswith(".") or candidate.name.endswith(".tmp"):
            continue
        if (candidate / PIN).exists() or (candidate / PIN).is_symlink():
            continue
        try:
            manifest = verify_backup(candidate, dataset)
            candidates.append((datetime.fromisoformat(manifest["created_at"]), candidate.name, candidate, identity(candidate)))
        except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
            continue  # Unknown/invalid/manual directories are deliberately retained.
    # The new backup always occupies one slot, even if the system clock moved back.
    candidates.sort(reverse=True)
    retiring = candidates[retain_count - 1:]
    removed = []
    for _, _, candidate, original in reversed(retiring):
        unlinked_path(root)
        if identity(root) != root_identity:
            raise ValueError("Backup root changed during retention")
        if dry_run or remove_candidate(root, candidate, original, dataset, root_identity):
            removed.append(candidate)
    return removed
