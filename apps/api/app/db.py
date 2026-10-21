from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from collections.abc import Iterator

from .settings import DB_PATH, MIGRATIONS_DIR


def database_path():
    from .security_context import current_actor
    from .storage import storage_paths
    import re
    actor = current_actor()
    if actor.workspace is not None:
        from pathlib import Path
        return Path(actor.workspace["database"]).resolve()
    if actor.legacy:
        return DB_PATH
    if any(not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value) for value in (actor.tenant_id, actor.user_id)):
        raise ValueError("Invalid server identity")
    return storage_paths().state_root / "tenants" / actor.tenant_id / "users" / actor.user_id / "app.db"


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    from .security_context import current_actor
    actor = current_actor()
    target = database_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(target, timeout=30, uri=True)
    connection.row_factory = sqlite3.Row
    from .report_search import normalize_search_text
    connection.create_function("llmr_search_text", 1, normalize_search_text, deterministic=True)
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.create_function("llmr_actor_json", 0, lambda: json.dumps({"user_id": actor.user_id, "tenant_id": actor.tenant_id, "permissions_version": actor.permissions_version}))
    try:
        with connection:
            if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_owner'").fetchone():
                owner = connection.execute("SELECT tenant_id,owner_user_id FROM workspace_owner WHERE singleton=1").fetchone()
                if owner and (owner[0], owner[1]) != (actor.tenant_id, actor.user_id):
                    from .security_context import AccessDenied
                    raise AccessDenied("找不到所属工作空间。", 404)
            if not actor.legacy:
                from .security_catalog import expose_public_names
                expose_public_names(connection)
            yield connection
            # Revocation during a request must also stop its final commit.
            current_actor()
    finally:
        connection.close()


def ensure_initialized() -> None:
    """Existing workspaces only need a read; migrations acquire a write lock once."""
    if database_path().is_file():
        with connect() as connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if {"schema_migrations", "workspace_owner"} <= tables:
                applied = {row[0] for row in connection.execute("SELECT version FROM schema_migrations")}
                expected = {path.name for path in MIGRATIONS_DIR.glob("*.sql")}
                if expected <= applied and connection.execute("SELECT 1 FROM workspace_owner WHERE singleton=1").fetchone():
                    return
    init_db()


def init_db() -> None:
    from .storage import application_paths, validate_external_storage
    from .settings import PROJECT_ROOT
    validate_external_storage(PROJECT_ROOT, application_paths())
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
        )
        applied = {row[0] for row in connection.execute("SELECT version FROM schema_migrations")}
        for migration in sorted(MIGRATIONS_DIR.glob("*.sql")):
            version = migration.name
            if version in applied:
                continue
            if version == "044_intelligence_source_publication.sql":
                # The staged intelligence rollout shipped both shapes of this
                # table. SQLite has no ADD COLUMN IF NOT EXISTS; keep both
                # existing workspaces and fresh installations upgradeable.
                columns = {row[1] for row in connection.execute("PRAGMA table_info(intelligence_sources)")}
                if "publisher_date" not in columns:
                    connection.execute("ALTER TABLE intelligence_sources ADD COLUMN publisher_date TEXT")
            statement = ""
            for character in migration.read_text(encoding="utf-8"):
                statement += character
                if character == ";" and sqlite3.complete_statement(statement):
                    connection.execute(statement)
                    statement = ""
            if statement.strip():
                connection.execute(statement)
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, utc_now()),
            )
        from .security_context import current_actor
        actor = current_actor()
        owner_table = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_owner'").fetchone()
        if owner_table:
            bound = connection.execute("SELECT tenant_id,owner_user_id FROM workspace_owner WHERE singleton=1").fetchone()
            if bound and (bound[0], bound[1]) != (actor.tenant_id, actor.user_id):
                raise ValueError("Workspace belongs to another user")
            connection.execute("INSERT OR IGNORE INTO workspace_owner VALUES(1,?,?)", (actor.tenant_id, actor.user_id))
        elif not actor.legacy:
            raise ValueError("The required workspace ownership migration is missing")
        if not actor.legacy:
            # Public stock names are the only legacy records copied to new users.
            # Personal research, conditions and uploads are never inherited.
            from .security_catalog import seed_public_names
            seed_public_names(connection, DB_PATH)
        else:
            from .security_context import auth_mode
            if auth_mode() == "oidc":
                from .security_catalog import _publish_public_names
                rows = connection.execute("SELECT stock_code,name,pinyin,initials,market,updated_at FROM security_catalog").fetchall()
                if rows:
                    _publish_public_names(rows)


def json_dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_load(value: str) -> object:
    return json.loads(value)
