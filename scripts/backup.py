from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path
from contextlib import ExitStack, closing

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from apps.api.app.settings import DB_PATH, PROJECT_ROOT, REPORT_DIR, STOCK_FILE
from apps.api.app.storage import storage_paths
from scripts.backup_io import publish_directory


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def persistent_locations(paths) -> list[tuple[Path, Path]]:
    """Map private assets into the canonical layout used by restore."""
    runtime = Path("runtime")
    return [
        (DB_PATH, runtime / "app.db"),
        (Path(os.environ.get("LLMR_IDENTITY_DB_PATH") or paths.state_root / "identity.db"), runtime / "identity.db"),
        (Path(os.environ.get("LLMR_IDENTITY_DB_PATH") or paths.state_root / "identity.db").with_name("public-security-catalog.db"), runtime / "public-security-catalog.db"),
        (paths.state_root / "tenants", runtime / "tenants"),
        (paths.upload_root, runtime / "uploads"),
        (paths.report_originals, runtime / "report-originals"),
        (paths.evidence_root / "financial-sources", runtime / "financial-sources"),
        (paths.artifact_root / "financial-pilots", runtime / "financial-pilots"),
        (paths.artifact_root / "financial-series", runtime / "financial-series"),
        (paths.attachments_root, runtime / "uploads/research-attachments"),
        (paths.research_root, runtime / "research"),
        (paths.execution_artifacts, runtime / "artifacts"),
        (paths.artifact_root / "research-project-pdfs", runtime / "research-project-pdfs"),
        (paths.artifact_root / "tenants", runtime / "tenants"),
        (paths.sandbox_state_root / "generated-conditions", runtime / "generated-conditions"),
        (paths.sandbox_state_root / "tenants", runtime / "tenants"),
        (paths.codex_state, runtime / "codex-home"),
    ]


def inventory(locations: list[tuple[Path, Path]]) -> dict[Path, Path]:
    files: dict[Path, Path] = {}
    for source, relative in locations:
        if source.is_symlink() or source.is_junction():
            raise ValueError(f"Cannot back up a linked storage path: {source}")
        if not source.exists():
            continue
        entries = [(source, relative)] if source.is_file() else []
        if source.is_dir():
            for folder, directories, names in os.walk(source, followlinks=False):
                directories[:] = [name for name in directories if name not in {"__pycache__", "program-runs"}]
                for name in directories + names:
                    path = Path(folder) / name
                    if path.is_symlink() or path.is_junction():
                        raise ValueError(f"Cannot back up a linked storage path: {path}")
                entries.extend((Path(folder) / name, relative / (Path(folder) / name).relative_to(source)) for name in names)
        for path, target in entries:
            # SQLite's backup API incorporates committed WAL content.
            suffix = next((value for value in ("-wal", "-shm", "-journal") if path.name.endswith(value)), None)
            if suffix:
                database = path.with_name(path.name[:-len(suffix)])
                if database.is_file():
                    with database.open("rb") as stream:
                        if stream.read(16) == b"SQLite format 3\x00":
                            continue
            path = path.resolve()
            previous = files.get(target)
            if previous is not None and previous != path:
                raise ValueError(f"Conflicting storage files at backup destination: {target}")
            files[target] = path
    return files


def write_snapshot(temporary: Path, locations: list[tuple[Path, Path]]) -> list[dict]:
    files = inventory(locations)
    records = []
    hashes = {}
    with ExitStack() as stack:
        databases = {}
        signatures = {}
        for relative, source in files.items():
            with source.open("rb") as stream:
                is_database = stream.read(16) == b"SQLite format 3\x00"
            if not is_database and relative.name in {"app.db", "identity.db", "public-security-catalog.db"}:
                raise ValueError(f"Invalid application database: {source}")
            if is_database:
                connection = stack.enter_context(closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)))
                databases[relative] = (connection, connection.execute("PRAGMA data_version").fetchone()[0])
            else:
                stat = source.stat()
                signatures[relative] = (stat.st_size, stat.st_mtime_ns)
        # Snapshot every DB before collecting immutable originals and uploads.
        for relative in sorted(files, key=lambda path: path not in databases):
            source, target = files[relative], temporary / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if relative in databases:
                with closing(sqlite3.connect(target)) as destination:
                    databases[relative][0].backup(destination)
                    if destination.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        raise ValueError(f"Database backup integrity check failed: {relative}")
            else:
                shutil.copy2(source, target)
            digest = sha256(target)
            hashes[relative] = digest
            if source.parent.name == "report-originals" and source.suffix.lower() == ".pdf" and digest != source.stem:
                raise ValueError(f"Report original checksum mismatch: {source.name}")
            records.append({"path": relative.as_posix(), "original_path": str(source), "bytes": target.stat().st_size,
                            "sha256": digest, "database": relative in databases})
        if inventory(locations) != files:
            raise ValueError("Storage changed during backup; retry while the application is idle.")
        for relative, (connection, version) in databases.items():
            if connection.execute("PRAGMA data_version").fetchone()[0] != version:
                raise ValueError("Database changed during backup; retry while the application is idle.")
        for relative, signature in signatures.items():
            stat = files[relative].stat()
            if (stat.st_size, stat.st_mtime_ns) != signature or sha256(files[relative]) != hashes[relative]:
                raise ValueError("File changed during backup; retry while the application is idle.")
    return records


def main() -> None:
    parser = argparse.ArgumentParser(description="Back up local research assets and source references.")
    parser.add_argument("destination", type=Path, help="New backup directory; it must not already exist")
    parser.add_argument("--include-source", action="store_true", help="Copy the read-only Parquet and local PDF sources")
    args = parser.parse_args()
    destination = args.destination.resolve()
    if destination.exists():
        raise SystemExit("Backup destination already exists; choose a new directory.")
    if not DB_PATH.is_file():
        raise SystemExit("Application database is missing; start the platform once before backing it up.")

    source_files = [path for path in [STOCK_FILE, *REPORT_DIR.glob("*.pdf")] if path.is_file()]
    paths = storage_paths(project_root=PROJECT_ROOT, database_path=DB_PATH)
    locations = persistent_locations(paths)
    for source, relative in locations:
        if relative.suffix != ".db" and destination.is_relative_to(source.resolve()):
            raise SystemExit("Backup destination must be outside the storage being backed up.")
    total_copy = sum(path.stat().st_size for path in inventory(locations).values())
    if args.include_source:
        total_copy += sum(path.stat().st_size for path in source_files)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(destination.parent).free < total_copy + 20 * 1024 * 1024:
        raise SystemExit("Insufficient free space for the requested backup.")

    temporary = destination.with_name(destination.name + ".tmp")
    if temporary.exists():
        raise SystemExit(f"Temporary backup path already exists: {temporary}")
    temporary.mkdir()
    try:
        records = write_snapshot(temporary, locations)
        refs = [{"path": str(path), "bytes": path.stat().st_size, "sha256": sha256(path)} for path in source_files]
        if args.include_source:
            source_copy = temporary / "source"
            if STOCK_FILE.is_file():
                target = source_copy / "stock_data" / STOCK_FILE.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(STOCK_FILE, target)
            for path in (REPORT_DIR.glob("*.pdf") if REPORT_DIR.is_dir() else []):
                target = source_copy / "research_report" / path.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
            refs = [
                {**item, "backup_copy": f"source/stock_data/{STOCK_FILE.name}" if item["path"] == str(STOCK_FILE) else f"source/research_report/{Path(item['path']).name}"}
                for item in refs
            ]
            for item in refs:
                if sha256(temporary / item["backup_copy"]) != item["sha256"]:
                    raise ValueError("Source changed during backup; retry while data synchronization is idle.")
        manifest = {
            "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "format_version": 2,
            "database": "runtime/app.db",
            "files": records,
            "storage_mappings": [{"original_path": str(source.resolve()), "path": relative.as_posix()} for source, relative in locations],
            "source_references": refs,
            "source_files_copied": bool(args.include_source),
        }
        (temporary / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        publish_directory(temporary, destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    print(f"Backup created: {destination}")
    print(f"Database: {DB_PATH.stat().st_size:,} bytes; source files copied: {args.include_source}")


if __name__ == "__main__":
    main()
