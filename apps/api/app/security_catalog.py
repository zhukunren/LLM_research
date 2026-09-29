"""Display names are independent of immutable screening prices and decisions."""
from __future__ import annotations

import re
from .db import connect, utc_now


def entries() -> list[dict]:
    with connect() as connection:
        return [dict(row) for row in connection.execute("SELECT * FROM security_catalog ORDER BY stock_code")]


def names() -> dict[str, str]:
    return {item["stock_code"]: item["name"] for item in entries()}


def refresh(client=None) -> int:
    from .tushare_sync import create_client, _query
    from pypinyin import lazy_pinyin
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
        with connect() as connection:
            connection.executemany("""INSERT INTO security_catalog VALUES(?,?,?,?,?,?)
                ON CONFLICT(stock_code) DO UPDATE SET name=excluded.name,pinyin=excluded.pinyin,
                initials=excluded.initials,market=excluded.market,updated_at=excluded.updated_at""", rows)
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
