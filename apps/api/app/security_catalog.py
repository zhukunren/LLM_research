"""Display names are independent of immutable screening prices and decisions."""
from __future__ import annotations

import re
import sqlite3
from contextlib import closing
from .db import connect, utc_now


def public_catalog_path():
    from .identity import identity_path
    return identity_path().with_name("public-security-catalog.db")


def expose_public_names(connection) -> None:
    """Overlay only public names; never attach another user's business DB."""
    path = public_catalog_path()
    if not path.is_file() or not connection.execute("SELECT 1 FROM main.sqlite_master WHERE name='security_catalog'").fetchone():
        return
    connection.execute("ATTACH DATABASE ? AS public_names", (path.resolve().as_uri() + "?mode=ro",))
    if connection.execute("SELECT 1 FROM public_names.sqlite_master WHERE name='security_catalog'").fetchone():
        connection.execute("CREATE TEMP VIEW security_catalog AS SELECT * FROM public_names.security_catalog")


def _publish_public_names(rows) -> None:
    path = public_catalog_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=30)) as connection, connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE IF NOT EXISTS security_catalog (stock_code TEXT PRIMARY KEY,name TEXT NOT NULL,pinyin TEXT NOT NULL,initials TEXT NOT NULL,market TEXT NOT NULL,updated_at TEXT NOT NULL)")
        connection.executemany("INSERT INTO security_catalog VALUES(?,?,?,?,?,?) ON CONFLICT(stock_code) DO UPDATE SET name=excluded.name,pinyin=excluded.pinyin,initials=excluded.initials,market=excluded.market,updated_at=excluded.updated_at", rows)


def seed_public_names(connection, source_path) -> None:
    if connection.execute("SELECT 1 FROM security_catalog LIMIT 1").fetchone() or not source_path.is_file():
        return
    with sqlite3.connect(source_path.resolve().as_uri() + "?mode=ro", uri=True) as source:
        if not source.execute("SELECT 1 FROM sqlite_master WHERE name='security_catalog'").fetchone():
            return
        rows = source.execute("SELECT stock_code,name,pinyin,initials,market,updated_at FROM security_catalog").fetchall()
    connection.executemany("INSERT OR IGNORE INTO security_catalog VALUES(?,?,?,?,?,?)", rows)


def entries() -> list[dict]:
    with connect() as connection:
        return [dict(row) for row in connection.execute("SELECT * FROM security_catalog ORDER BY stock_code")]


def names() -> dict[str, str]:
    return {item["stock_code"]: item["name"] for item in entries()}


def refresh(client=None) -> int:
    from .tushare_sync import create_client, _query
    from pypinyin import lazy_pinyin
    from dataclasses import replace
    from .security_context import AccessDenied, LOCAL_ACTOR, actor_scope, auth_mode, current_actor
    shared = auth_mode() == "oidc"
    if shared and not current_actor().platform_admin:
        raise AccessDenied("股票目录更新仅限平台维护者。", 403)
    owned = client is None
    client = client or create_client()
    try:
        records = _query(client, "stock_basic", list_status="L", fields="ts_code,name,cnspell")
        rows = []
        for item in records:
            code, name = str(item.get("ts_code", "")).upper(), str(item.get("name", "")).strip()
            if not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", code) or not name:
                continue
            syllables = lazy_pinyin(name)
            rows.append((code, name, "".join(syllables).lower(), "".join(p[0] for p in syllables if p).lower(), code[-2:], utc_now()))
        if not rows:
            raise ValueError("股票名称服务暂未返回有效资料，已保留原有名称。")
        # Maintenance may be initiated by any platform admin's personal workspace.
        # Publish the same shared directory regardless of who initiated it.
        with actor_scope(replace(LOCAL_ACTOR, maintenance=True)):
            with connect() as connection:
                connection.executemany("""INSERT INTO security_catalog VALUES(?,?,?,?,?,?)
                    ON CONFLICT(stock_code) DO UPDATE SET name=excluded.name,pinyin=excluded.pinyin,
                    initials=excluded.initials,market=excluded.market,updated_at=excluded.updated_at""", rows)
                published = connection.execute("SELECT stock_code,name,pinyin,initials,market,updated_at FROM security_catalog").fetchall()
        if shared:
            _publish_public_names(published)
        return len(rows)
    finally:
        if owned and getattr(client, "_session", None):
            client._session.close()


def query_clause(code_column: str = "stock_code") -> str:
    # code_column is supplied only by application code, never by a request.
    return f"""({code_column} LIKE ? OR {code_column} IN (
        SELECT stock_code FROM security_catalog WHERE name LIKE ? OR pinyin LIKE ? OR initials LIKE ?))"""


def query_params(query: str) -> tuple[str, str, str, str]:
    value = "%" + query.strip()[:64] + "%"
    return (value,) * 4
