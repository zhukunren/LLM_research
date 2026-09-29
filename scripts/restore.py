from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path


def verified_path(root: Path, relative: str, expected_hash: str) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError(f"Backup file is missing or outside the backup directory: {relative}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected_hash:
        raise ValueError(f"Backup checksum mismatch: {relative}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description="Restore a local backup into a new directory.")
    parser.add_argument("backup", type=Path)
    parser.add_argument("destination", type=Path, help="New directory; existing paths are never overwritten")
    args = parser.parse_args()
    backup = args.backup.resolve()
    destination = args.destination.resolve()
    manifest_path = backup / "manifest.json"
    source_db = backup / "runtime" / "app.db"
    if not manifest_path.is_file() or not source_db.is_file():
        raise SystemExit("Backup manifest or database is missing.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    relocated: dict[str, str] = {}
    for item in manifest.get("upload_files", []):
        relative = str(Path("runtime") / "uploads" / item["name"])
        path = verified_path(backup, relative, item["sha256"])
        if item.get("original_path"):
            relocated[item["original_path"]] = str(destination / path.relative_to(backup))
    for item in manifest.get("source_references", []):
        if item.get("backup_copy"):
            path = verified_path(backup, item["backup_copy"], item["sha256"])
            relocated[item["path"]] = str(destination / path.relative_to(backup))
    with closing(sqlite3.connect(source_db)) as connection:
        result = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok":
        raise SystemExit(f"Backup database failed integrity_check: {result}")
    if destination.exists():
        raise SystemExit("Restore destination already exists; choose a new directory.")
    temporary = destination.with_name(destination.name + ".tmp")
    if temporary.exists():
        raise SystemExit(f"Temporary restore path already exists: {temporary}")
    temporary.mkdir(parents=True)
    try:
        shutil.copytree(backup / "runtime", temporary / "runtime")
        if (backup / "source").is_dir():
            shutil.copytree(backup / "source", temporary / "source")
        with closing(sqlite3.connect(temporary / "runtime" / "app.db")) as connection, connection:
            if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'").fetchone():
                connection.executemany("UPDATE documents SET source_path=? WHERE source_path=?", [(new, old) for old, new in relocated.items()])
        (temporary / "restore-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.rename(destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    print(f"Restore verified at: {destination}")
    print("Point LLMR_DB_PATH at the restored runtime/app.db and preserve the source references in restore-manifest.json.")


if __name__ == "__main__":
    main()

