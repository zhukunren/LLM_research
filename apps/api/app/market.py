from __future__ import annotations

import hashlib
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

import duckdb
import pyarrow.parquet as pq

from .settings import ALLOWED_MARKETS, STOCK_FILE


def _literal_path(path: Path) -> str:
    return "'" + str(path).replace("'", "''") + "'"


def _open() -> duckdb.DuckDBPyConnection:
    connection = duckdb.connect(database=":memory:")
    connection.execute("SET threads=4")
    connection.execute("SET preserve_insertion_order=false")
    return connection


def profile() -> dict[str, Any]:
    if not STOCK_FILE.is_file():
        return {"available": False, "path": str(STOCK_FILE), "reason": "行情文件不存在"}
    metadata = pq.ParquetFile(STOCK_FILE).metadata
    source = _literal_path(STOCK_FILE)
    with _open() as connection:
        row = connection.execute(
            f"""
            SELECT COUNT(*) AS rows,
                   COUNT(DISTINCT stock_code) AS securities,
                   MIN(trade_date)::DATE AS first_date,
                   MAX(trade_date)::DATE AS last_date,
                   COUNT(*) - COUNT(DISTINCT (stock_code, trade_date)) AS duplicate_keys,
                   COUNT(*) FILTER (WHERE open IS NULL OR high IS NULL OR low IS NULL OR close IS NULL) AS null_ohlc,
                   COUNT(*) FILTER (WHERE high < greatest(open, close, low) OR low > least(open, close, high)) AS invalid_ohlc,
                   COUNT(*) FILTER (WHERE volume < 0) AS negative_volume,
                   COUNT(*) FILTER (WHERE amount < 0) AS negative_amount,
                   COUNT(*) FILTER (WHERE high < greatest(open, close)) AS high_below_body,
                   COUNT(*) FILTER (WHERE low > least(open, close)) AS low_above_body,
                   COUNT(*) FILTER (WHERE open <= 0 OR high <= 0 OR low <= 0 OR close <= 0) AS nonpositive_prices,
                   COUNT(*) FILTER (WHERE stock_code IS NULL OR trade_date IS NULL) AS null_keys,
                   COUNT(*) FILTER (WHERE NOT isfinite(open) OR NOT isfinite(high) OR NOT isfinite(low) OR NOT isfinite(close)) AS nonfinite_prices
            FROM read_parquet({source})
            """
        ).fetchone()
        markets = connection.execute(
            f"""
            SELECT regexp_extract(stock_code, '\\.([A-Z]+)$', 1) AS market,
                   COUNT(DISTINCT stock_code) AS securities
            FROM read_parquet({source})
            GROUP BY 1 ORDER BY 1
            """
        ).fetchall()
        latest = connection.execute(
            f"""
            SELECT COUNT(*) FROM read_parquet({source})
            WHERE trade_date=(SELECT MAX(trade_date) FROM read_parquet({source}))
            """
        ).fetchone()[0]
    counts = {market: count for market, count in markets}
    fields = pq.ParquetFile(STOCK_FILE).schema_arrow
    actual_markets = set(counts)
    quality_ok = (
        row[4] == 0
        and row[5] == 0
        and row[6] == 0
        and row[7] == 0
        and row[8] == 0
        and row[9] == 0
        and row[10] == 0
        and row[11] == 0
        and row[12] == 0
        and row[13] == 0
        and actual_markets <= ALLOWED_MARKETS
    )
    digest = hashlib.sha256()
    with STOCK_FILE.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return {
        "available": True,
        "path": str(STOCK_FILE),
        "bytes": STOCK_FILE.stat().st_size,
        "parquet_rows": metadata.num_rows,
        "rows": row[0],
        "securities": row[1],
        "first_date": str(row[2]),
        "last_date": str(row[3]),
        "latest_day_rows": latest,
        "markets": counts,
        "duplicate_keys": row[4],
        "null_ohlc": row[5],
        "invalid_ohlc": row[6],
        "negative_volume": row[7],
        "negative_amount": row[8],
        "high_below_body": row[9],
        "low_above_body": row[10],
        "nonpositive_prices": row[11],
        "null_keys": row[12],
        "nonfinite_prices": row[13],
        "sha256": digest.hexdigest(),
        "columns": [{"name": field.name, "type": str(field.type)} for field in fields],
        "quality_status": "basic_checks_passed" if quality_ok else "issues_found",
        "price_basis": "unknown",
        "volume_unit": "unknown",
        "amount_unit": "unknown",
        "formal_execution_ready": False,
        "formal_blockers": ["复权口径未确认", "成交量与成交额单位未确认", "证券主数据和历史交易日历未接入"],
    }


def source_fingerprint() -> tuple[str, int, int] | None:
    try:
        stat = STOCK_FILE.stat()
        return str(STOCK_FILE.resolve()), stat.st_size, stat.st_mtime_ns
    except FileNotFoundError:
        return None


def daily_bar_source_available(path: Path | None = None) -> bool:
    """Check Parquet metadata only; do not scan or hash the market data."""
    source_path = path or STOCK_FILE
    if not source_path.is_file():
        return False
    try:
        columns = set(pq.ParquetFile(source_path).schema_arrow.names)
    except Exception:
        return False
    required = {"stock_code", "trade_date", "open", "high", "low", "close", "volume", "amount"}
    return required <= columns


@lru_cache(maxsize=1)
def _profile_for_source(fingerprint: tuple[str, int, int] | None) -> dict[str, Any]:
    return profile()


def cached_profile() -> dict[str, Any]:
    # Replacing or extending the sample data must invalidate the process cache.
    return _profile_for_source(source_fingerprint())


def _date_predicate(as_of: str | None) -> tuple[str, list[str]]:
    if as_of:
        return "trade_date <= CAST(? AS TIMESTAMP)", [as_of]
    return "TRUE", []


def _bar_quality(open_: Any, high: Any, low: Any, close: Any, volume: Any, amount: Any) -> tuple[bool, str | None]:
    values = (open_, high, low, close, volume, amount)
    if any(value is None or not math.isfinite(float(value)) for value in values):
        return False, "行情字段为空或非有限数值"
    if min(open_, high, low, close) <= 0:
        return False, "存在非正价格"
    if high < max(open_, close, low) or low > min(open_, close, high):
        return False, "OHLC 高低关系异常"
    if volume < 0 or amount < 0:
        return False, "成交量或成交额为负"
    return True, None


def search_securities(
    query: str = "",
    market: str = "",
    limit: int = 100,
    as_of: str | None = None,
) -> list[dict[str, Any]]:
    if not STOCK_FILE.is_file():
        return []
    source = _literal_path(STOCK_FILE)
    market = market.upper()
    if market and market not in ALLOWED_MARKETS:
        return []
    filters = []
    params: list[Any] = []
    if query:
        filters.append("s.stock_code ILIKE ?")
        params.append(f"%{query.strip()}%")
    if market:
        filters.append("ends_with(s.stock_code, ?)")
        params.append(f".{market}")
    where = " AND ".join(filters) or "TRUE"
    with _open() as connection:
        rows = connection.execute(
            f"""
            WITH selected AS (
                SELECT stock_code, MAX(trade_date) AS last_date
                FROM read_parquet({source})
                WHERE (? IS NULL OR trade_date <= CAST(? AS TIMESTAMP))
                GROUP BY stock_code
            )
            SELECT s.stock_code, s.last_date::DATE AS last_date, b.close, b.amount
            FROM selected s
            JOIN read_parquet({source}) b
              ON b.stock_code=s.stock_code AND b.trade_date=s.last_date
            WHERE {where}
            ORDER BY s.stock_code LIMIT ?
            """,
            [as_of, as_of, *params, max(1, min(limit, 500))],
        ).fetchall()
    return [
        {"stock_code": code, "market": code.rsplit(".", 1)[-1], "last_date": str(date), "close": close, "amount": amount}
        for code, date, close, amount in rows
    ]


def security_codes(as_of: str) -> list[str]:
    """Freeze securities with local A-share bars available by the requested date."""
    if not STOCK_FILE.is_file():
        return []
    source = _literal_path(STOCK_FILE)
    with _open() as connection:
        rows = connection.execute(
            f"""SELECT DISTINCT stock_code
                FROM read_parquet({source})
                WHERE trade_date <= CAST(? AS TIMESTAMP)
                  AND regexp_extract(stock_code, '\\.([A-Z]+)$', 1) IN ('SH','SZ','BJ')
                ORDER BY stock_code""",
            [as_of],
        ).fetchall()
    return [row[0] for row in rows]


def get_bars(stock_code: str, as_of: str | None = None, limit: int = 250) -> list[dict[str, Any]]:
    if not STOCK_FILE.is_file() or "." not in stock_code:
        return []
    if stock_code.rsplit(".", 1)[-1] not in ALLOWED_MARKETS:
        return []
    source = _literal_path(STOCK_FILE)
    predicate, params = _date_predicate(as_of)
    with _open() as connection:
        rows = connection.execute(
            f"""
            SELECT trade_date::DATE, open, high, low, close, volume, amount
            FROM read_parquet({source})
            WHERE stock_code=? AND {predicate}
            ORDER BY trade_date DESC LIMIT ?
            """,
            [stock_code, *params, max(1, min(limit, 500))],
        ).fetchall()
    rows.reverse()
    bars = []
    for date, op, hi, lo, cl, vol, amt in rows:
        valid, reason = _bar_quality(op, hi, lo, cl, vol, amt)
        bars.append({
            "trade_date": str(date), "open": op, "high": hi, "low": lo, "close": cl,
            "volume": vol, "amount": amt, "quality_valid": valid, "quality_reason": reason,
        })
    return bars


def latest_market_date(as_of: str) -> str | None:
    if not STOCK_FILE.is_file():
        return None
    with _open() as connection:
        row = connection.execute(f"SELECT MAX(trade_date)::DATE FROM read_parquet({_literal_path(STOCK_FILE)}) WHERE trade_date<=CAST(? AS TIMESTAMP)", [as_of]).fetchone()
    return str(row[0]) if row and row[0] else None


def iter_recent_bars(as_of: str, per_stock: int = 250, stock_codes: list[str] | None = None):
    if not STOCK_FILE.is_file():
        return
    source = _literal_path(STOCK_FILE)
    if stock_codes is not None and not stock_codes:
        return
    code_predicate = " AND stock_code IN (" + ",".join("?" for _ in stock_codes) + ")" if stock_codes is not None else ""
    connection = _open()
    try:
        reader = connection.execute(
            f"""
            SELECT stock_code, trade_date::DATE AS trade_date, open, high, low, close, volume, amount
            FROM read_parquet({source})
            WHERE trade_date <= CAST(? AS TIMESTAMP) AND regexp_extract(stock_code, '\\.([A-Z]+)$', 1) IN ('SH','SZ','BJ'){code_predicate}
            QUALIFY row_number() OVER (PARTITION BY stock_code ORDER BY trade_date DESC) <= ?
            ORDER BY stock_code, trade_date
            """,
            [as_of, *(stock_codes or []), max(10, min(per_stock, 500))],
        ).fetch_record_batch(rows_per_batch=65_536)
        current_code: str | None = None
        bars: list[dict[str, Any]] = []
        for batch in reader:
            for row in batch.to_pylist():
                code = row["stock_code"]
                if current_code is not None and code != current_code:
                    yield current_code, bars
                    bars = []
                current_code = code
                valid, reason = _bar_quality(row["open"], row["high"], row["low"], row["close"], row["volume"], row["amount"])
                bars.append({
                    "trade_date": str(row["trade_date"]), "open": row["open"], "high": row["high"],
                    "low": row["low"], "close": row["close"], "volume": row["volume"], "amount": row["amount"],
                    "quality_valid": valid, "quality_reason": reason,
                })
        if current_code is not None:
            yield current_code, bars
    finally:
        connection.close()
