from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from apps.api.app.settings import DB_PATH, PROJECT_ROOT, REPORT_DIR, REPORT_UPLOAD_DIR, STOCK_FILE


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_database(source: Path, destination: Path) -> None:
    src = sqlite3.connect(source)
    dest = sqlite3.connect(destination)
    try:
        src.backup(dest)
        result = dest.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise RuntimeError(f"SQLite backup integrity check failed: {result}")
    finally:
        dest.close()
        src.close()


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
    upload_root = PROJECT_ROOT / "runtime" / "uploads"
    upload_files = [path for path in upload_root.rglob("*") if path.is_file()] if upload_root.is_dir() else []
    total_copy = DB_PATH.stat().st_size + sum(path.stat().st_size for path in upload_files)
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
        runtime_dir = temporary / "runtime"
        runtime_dir.mkdir()
        copy_database(DB_PATH, runtime_dir / "app.db")
        uploads_dir = runtime_dir / "uploads"
        uploads_dir.mkdir(parents=True)
        for path in upload_files:
            target = uploads_dir / path.relative_to(upload_root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
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
        manifest = {
            "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "format_version": 1,
            "database": "runtime/app.db",
            "upload_files": [{"name": str(path.relative_to(upload_root)), "original_path": str(path), "bytes": path.stat().st_size, "sha256": sha256(path)} for path in upload_files],
            "source_references": refs,
            "source_files_copied": bool(args.include_source),
        }
        (temporary / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.rename(destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    print(f"Backup created: {destination}")
    print(f"Database: {DB_PATH.stat().st_size:,} bytes; source files copied: {args.include_source}")


if __name__ == "__main__":
    main()
