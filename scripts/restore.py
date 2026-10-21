from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path

if __package__:
    from .backup_io import publish_directory
else:
    from backup_io import publish_directory


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


def restore_complete(manifest: dict, backup: Path, destination: Path, temporary: Path) -> None:
    """Verify the complete inventory before restoring any user workspace."""
    entries = [(item, verified_path(backup, item["path"], item["sha256"])) for item in manifest["files"]]
    mappings = []
    for item in manifest["storage_mappings"]:
        target = (destination / item["path"]).resolve()
        if not target.is_relative_to(destination):
            raise ValueError("Restored storage path is outside the destination")
        mappings.append((item["original_path"], str(target)))
    for item in manifest.get("source_references", []):
        if item.get("backup_copy"):
            source = verified_path(backup, item["backup_copy"], item["sha256"])
            entries.append(({"database": False}, source))
            mappings.append((item["path"], str(destination / source.relative_to(backup))))
    mappings.sort(key=lambda item: len(item[0]), reverse=True)

    def relocate(value):
        if isinstance(value, dict):
            return {key: relocate(item) for key, item in value.items()}
        if isinstance(value, list):
            return [relocate(item) for item in value]
        if isinstance(value, str):
            normalized = value.replace("\\", "/")
            for old, new in mappings:
                prefix = old.replace("\\", "/").rstrip("/")
                if normalized == prefix or normalized.startswith(prefix + "/"):
                    return str(Path(new) / normalized[len(prefix):].lstrip("/"))
        return value

    temporary.mkdir(parents=True)
    for item, source in entries:
        target = temporary / source.relative_to(backup)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        if item["database"]:
            with closing(sqlite3.connect(target)) as connection, connection:
                if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise ValueError(f"Backup database failed integrity_check: {source.name}")
                tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                for table in ("documents", "reports"):
                    if table in tables and "source_path" in {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}:
                        for (old,) in connection.execute(f"SELECT DISTINCT source_path FROM {table}").fetchall():
                            new = relocate(old)
                            if new != old:
                                connection.execute(f"UPDATE {table} SET source_path=? WHERE source_path=?", (new, old))
                if {"external_identities", "tenant_memberships", "service_sessions"} <= tables:
                    # Recovered accounts keep their identity, not old login/task credentials.
                    for table in ("sessions", "service_sessions", "oidc_requests"):
                        connection.execute(f"DELETE FROM {table}")
        elif target.name == "research-inputs.json":
            target.write_text(json.dumps(relocate(json.loads(target.read_text(encoding="utf-8"))), ensure_ascii=False, indent=2), encoding="utf-8")
    runtime = destination / "runtime"
    environment = {"LLMR_STATE_ROOT": str(runtime), "LLMR_UPLOAD_ROOT": str(runtime / "uploads"),
                   "LLMR_ARTIFACT_ROOT": str(runtime), "LLMR_SANDBOX_STATE_ROOT": str(runtime),
                   "LLMR_CODEX_HOME": str(runtime / "codex-home"), "LLMR_DB_PATH": str(runtime / "app.db"),
                   "LLMR_IDENTITY_DB_PATH": str(runtime / "identity.db")}
    if manifest.get("source_files_copied"):
        environment["LLMR_DATA_ROOT"] = str(destination / "source")
    (temporary / "storage-environment.json").write_text(json.dumps(environment, indent=2), encoding="utf-8")


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
    if manifest.get("format_version") == 2:
        if destination.exists():
            raise SystemExit("Restore destination already exists; choose a new directory.")
        temporary = destination.with_name(destination.name + ".tmp")
        if temporary.exists():
            raise SystemExit(f"Temporary restore path already exists: {temporary}")
        try:
            restore_complete(manifest, backup, destination, temporary)
            (temporary / "restore-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            publish_directory(temporary, destination)
        except Exception:
            if temporary.is_dir():
                shutil.rmtree(temporary)
            raise
        print(f"Restore verified at: {destination}")
        print("Use storage-environment.json for all restored storage roots. Sign in again after restart.")
        return
    relocated: dict[str, str] = {}
    for item in manifest.get("upload_files", []):
        relative = str(Path("runtime") / "uploads" / item["name"])
        path = verified_path(backup, relative, item["sha256"])
        if item.get("original_path"):
            relocated[item["original_path"]] = str(destination / path.relative_to(backup))
    for item in manifest.get("report_originals", []):
        relative = str(Path("runtime") / "report-originals" / item["name"])
        path = verified_path(backup, relative, item["sha256"])
        if path.stem != item["sha256"]:
            raise ValueError(f"Report original filename does not match checksum: {item['name']}")
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
        publish_directory(temporary, destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    print(f"Restore verified at: {destination}")
    print("Point LLMR_DB_PATH at the restored runtime/app.db and preserve the source references in restore-manifest.json.")


if __name__ == "__main__":
    main()

