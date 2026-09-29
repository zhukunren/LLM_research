"""Controlled ingestion from the project's Tushare relay adapter.

The relay is intentionally kept outside request handling.  Running the sync
command stages external data, validates it, and only then replaces the market
Parquet file or commits news records to SQLite.
"""
from __future__ import annotations

import hashlib
import math
import os
import re
import time
from datetime import date, datetime, time as clock_time, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping
from uuid import uuid4

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from . import news_sources
from .db import utc_now
from .settings import ALLOWED_MARKETS, STOCK_FILE, tushare_settings


NEWS_ENDPOINT_SOURCES = (
    "eastmoney",
    "sina",
    "wallstreetcn",
    "10jqka",
    "yuncaijing",
    "fenghuang",
    "jinrongjie",
)
SOURCE_ZONE = timezone(timedelta(hours=8))
DAILY_PAGE_SIZE = 1_000
DAILY_MAX_PAGES = 20
SOURCE_DELAY_SECONDS = 0.15
STOCK_CODE_PATTERN = re.compile(r"(?<!\d)(\d{6})\.(SH|SZ|BJ)(?![A-Z])", re.I)


class RelaySyncError(RuntimeError):
    """A relay failure that can be reported without revealing credentials."""


def create_client() -> Any:
    """Create the bundled relay client using explicit settings when provided."""

    try:
        import tushare_relay
    except ImportError as exc:  # pragma: no cover - deployment configuration failure
        raise RelaySyncError("找不到项目根目录中的 tushare_relay.py") from exc

    config = tushare_settings()
    options: dict[str, Any] = {
        "timeout": config["timeout"],
        "retries": config["retries"],
        "retry_backoff": 0.6,
    }
    if config["base_url"]:
        options["base_url"] = config["base_url"]
    # An empty token deliberately lets the adapter use its own configured
    # default.  The key itself never enters a result payload or log message.
    return tushare_relay.pro_api(str(config["api_key"]), **options)


def _as_date(value: date | str | None) -> date:
    if value is None:
        return date.today()
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("截止日必须是有效的 YYYY-MM-DD 日期") from exc


def _date_text(value: date) -> str:
    return value.strftime("%Y%m%d")


def _source_date(value: Any) -> date | None:
    text = str(value or "").strip()
    for pattern, parser in ((r"20\d{6}", "%Y%m%d"), (r"20\d{2}-\d{2}-\d{2}", "%Y-%m-%d")):
        if re.fullmatch(pattern, text):
            return datetime.strptime(text, parser).date()
    return None


def _payload_rows(payload: Any, api_name: str) -> list[dict[str, Any]]:
    """Normalize Tushare's fields/items response without requiring pandas."""

    data = payload.get("data", payload) if isinstance(payload, Mapping) else payload
    if isinstance(data, Mapping):
        fields = data.get("fields")
        items = data.get("items", data.get("records"))
    else:
        fields, items = None, data
    if items is None:
        return []
    if not isinstance(items, list):
        raise RelaySyncError(f"{api_name} 返回了无法识别的记录格式")
    if not items:
        return []
    if isinstance(items[0], Mapping):
        return [{str(key): value for key, value in row.items()} for row in items if isinstance(row, Mapping)]
    if not isinstance(fields, list) or not all(isinstance(field, str) for field in fields):
        raise RelaySyncError(f"{api_name} 返回的字段定义无效")
    rows: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, (list, tuple)) or len(item) != len(fields):
            raise RelaySyncError(f"{api_name} 返回了字段数量不匹配的记录")
        rows.append(dict(zip(fields, item, strict=True)))
    return rows


def _query(client: Any, api_name: str, **params: Any) -> list[dict[str, Any]]:
    try:
        payload = client.raw_query(api_name, **params)
    except Exception as exc:
        message = str(exc).replace("\n", " ").strip()
        raise RelaySyncError(f"{api_name} 请求失败：{message or type(exc).__name__}") from exc
    return _payload_rows(payload, api_name)


def _market_watermark() -> date | None:
    if not STOCK_FILE.is_file():
        return None
    literal = "'" + str(STOCK_FILE).replace("'", "''") + "'"
    with duckdb.connect(database=":memory:") as connection:
        row = connection.execute(f"SELECT MAX(trade_date)::DATE FROM read_parquet({literal})").fetchone()
    return row[0] if row and row[0] else None


def _open_days(client: Any, start: date, end: date) -> list[date]:
    rows = _query(
        client,
        "trade_cal",
        exchange="SSE",
        start_date=_date_text(start),
        end_date=_date_text(end),
    )
    output = []
    for row in rows:
        is_open = str(row.get("is_open", "")).strip().lower() in {"1", "1.0", "true"}
        day = _source_date(row.get("cal_date"))
        if is_open and day is not None:
            output.append(day)
    return sorted(set(output))


def _number(value: Any, field: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} 不是数值") from exc
    if not math.isfinite(result):
        raise ValueError(f"{field} 不是有限数值")
    return result


def _daily_record(row: dict[str, Any]) -> dict[str, Any] | None:
    stock_code = str(row.get("ts_code") or "").upper().strip()
    if "." not in stock_code or stock_code.rsplit(".", 1)[-1] not in ALLOWED_MARKETS:
        return None
    trade_date = _source_date(row.get("trade_date"))
    if trade_date is None:
        raise ValueError("trade_date 无效")
    values = {
        "open": _number(row.get("open"), "open"),
        "high": _number(row.get("high"), "high"),
        "low": _number(row.get("low"), "low"),
        "close": _number(row.get("close"), "close"),
        "volume": _number(row.get("vol"), "vol"),
        "amount": _number(row.get("amount"), "amount"),
    }
    if min(values["open"], values["high"], values["low"], values["close"]) <= 0:
        raise ValueError("价格必须为正数")
    if values["high"] < max(values["open"], values["low"], values["close"]) or values["low"] > min(
        values["open"], values["close"]
    ):
        raise ValueError("OHLC 高低关系无效")
    if values["volume"] < 0 or values["amount"] < 0:
        raise ValueError("成交量或成交额为负")
    return {
        "trade_date": datetime.combine(trade_date, clock_time.min),
        "stock_code": stock_code,
        **values,
    }


def _daily_rows(client: Any, trade_day: date) -> list[dict[str, Any]]:
    """Read every paged daily row for one exchange day or fail as a whole."""

    rows: list[dict[str, Any]] = []
    seen_page_keys: set[tuple[str, str]] = set()
    for page in range(DAILY_MAX_PAGES):
        page_rows = _query(
            client,
            "daily",
            trade_date=_date_text(trade_day),
            limit=DAILY_PAGE_SIZE,
            offset=page * DAILY_PAGE_SIZE,
        )
        if not page_rows:
            break
        # Some relay cache paths ignore a high offset and return the entire
        # requested day.  That response is complete, but it overlaps earlier
        # pages; accept it and let the per-day key de-duplication below choose
        # one bar per security/date instead of issuing another duplicate page.
        if len(page_rows) > DAILY_PAGE_SIZE:
            rows.extend(page_rows)
            break
        page_keys = {
            (str(item.get("ts_code") or ""), str(item.get("trade_date") or ""))
            for item in page_rows
        }
        if page_keys and page_keys <= seen_page_keys:
            raise RelaySyncError(f"daily {trade_day.isoformat()} 分页重复，已拒绝不完整日线")
        seen_page_keys.update(page_keys)
        rows.extend(page_rows)
        if len(page_rows) < DAILY_PAGE_SIZE:
            break
        time.sleep(SOURCE_DELAY_SECONDS)
    else:
        raise RelaySyncError(f"daily {trade_day.isoformat()} 超过最大分页数")
    return rows


def _literal_path(path: Path) -> str:
    return "'" + str(path).replace("'", "''") + "'"


def _write_market_update(rows: list[dict[str, Any]]) -> tuple[int, int]:
    """Merge validated bars then atomically replace the active Parquet file."""

    if not rows:
        return 0, 0
    STOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    unique = {(row["stock_code"], row["trade_date"]): row for row in rows}
    staged_rows = list(unique.values())
    schema = pa.schema(
        [
            pa.field("trade_date", pa.timestamp("ns")),
            pa.field("stock_code", pa.string()),
            pa.field("open", pa.float64()),
            pa.field("high", pa.float64()),
            pa.field("low", pa.float64()),
            pa.field("close", pa.float64()),
            pa.field("volume", pa.float64()),
            pa.field("amount", pa.float64()),
        ]
    )
    token = uuid4().hex
    staged = STOCK_FILE.parent / f".stock_daily.tushare-{token}.parquet"
    replacement = STOCK_FILE.parent / f".stock_daily.replacement-{token}.parquet"
    try:
        pq.write_table(pa.Table.from_pylist(staged_rows, schema=schema), staged, compression="zstd")
        if STOCK_FILE.is_file():
            with duckdb.connect(database=":memory:") as connection:
                connection.execute("SET preserve_insertion_order=false")
                connection.execute(
                    f"""COPY (
                        SELECT stock_code, trade_date, open, high, low, close, volume, amount
                        FROM (
                            SELECT stock_code, trade_date, open, high, low, close, volume, amount,
                                   row_number() OVER (
                                       PARTITION BY stock_code, trade_date ORDER BY source_priority DESC
                                   ) AS row_priority
                            FROM (
                                SELECT stock_code, trade_date, open, high, low, close, volume, amount, 0 AS source_priority
                                FROM read_parquet({_literal_path(STOCK_FILE)})
                                UNION ALL
                                SELECT stock_code, trade_date, open, high, low, close, volume, amount, 1 AS source_priority
                                FROM read_parquet({_literal_path(staged)})
                            )
                        )
                        WHERE row_priority=1
                        ORDER BY trade_date, stock_code
                    ) TO {_literal_path(replacement)} (FORMAT PARQUET, COMPRESSION ZSTD)"""
                )
        else:
            os.replace(staged, replacement)
        os.replace(replacement, STOCK_FILE)
    finally:
        staged.unlink(missing_ok=True)
        replacement.unlink(missing_ok=True)
    return len(staged_rows), STOCK_FILE.stat().st_size


def sync_market_data(client: Any, *, as_of: date, initial_days: int = 30) -> dict[str, Any]:
    """Append missing A-share daily bars without publishing partial days."""

    previous_watermark = _market_watermark()
    first_requested = (
        previous_watermark + timedelta(days=1)
        if previous_watermark is not None
        else as_of - timedelta(days=max(1, initial_days) - 1)
    )
    result: dict[str, Any] = {
        "source": "tushare.daily",
        "previous_watermark": previous_watermark.isoformat() if previous_watermark else None,
        "requested_start": first_requested.isoformat(),
        "requested_end": as_of.isoformat(),
        "open_days": [],
        "updated_days": [],
        "missing_or_failed_days": [],
        "rows_received": 0,
        "rows_valid": 0,
        "rows_rejected": 0,
        "rows_written": 0,
        "bytes_written": None,
    }
    if first_requested > as_of:
        result.update(status="up_to_date", new_watermark=previous_watermark.isoformat() if previous_watermark else None)
        return result

    open_days = _open_days(client, first_requested, as_of)
    result["open_days"] = [item.isoformat() for item in open_days]
    updates: list[dict[str, Any]] = []
    for trade_day in open_days:
        try:
            source_rows = _daily_rows(client, trade_day)
        except RelaySyncError as exc:
            result["missing_or_failed_days"].append({"date": trade_day.isoformat(), "reason": str(exc)})
            continue
        result["rows_received"] += len(source_rows)
        valid_for_day = []
        rejected = 0
        for source_row in source_rows:
            try:
                normalized = _daily_record(source_row)
            except ValueError:
                rejected += 1
                continue
            if normalized is not None:
                valid_for_day.append(normalized)
        result["rows_rejected"] += rejected
        if not valid_for_day:
            result["missing_or_failed_days"].append(
                {"date": trade_day.isoformat(), "reason": "未收到可用的 A 股日线"}
            )
            continue
        unique_for_day = {(item["stock_code"], item["trade_date"]): item for item in valid_for_day}
        updates.extend(unique_for_day.values())
        result["updated_days"].append(trade_day.isoformat())
        result["rows_valid"] += len(unique_for_day)
        time.sleep(SOURCE_DELAY_SECONDS)

    rows_written, bytes_written = _write_market_update(updates)
    result["rows_written"] = rows_written
    result["bytes_written"] = bytes_written or None
    new_watermark = _market_watermark()
    result["new_watermark"] = new_watermark.isoformat() if new_watermark else None
    result["status"] = "partial" if result["missing_or_failed_days"] else ("updated" if rows_written else "no_new_rows")
    return result


def _news_timestamp(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.strptime(text, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=SOURCE_ZONE)
    return parsed.isoformat()


def _news_codes(*parts: Any) -> list[str]:
    joined = "\n".join(str(part or "") for part in parts).upper()
    return sorted({f"{code}.{market}" for code, market in STOCK_CODE_PATTERN.findall(joined)})


def _news_item(row: dict[str, Any], source_hint: str) -> news_sources.NewsItemInput | None:
    title = str(row.get("title") or "").strip()
    body = str(row.get("content") or "").strip()
    if not body:
        return None
    if not title:
        title = body.replace("\n", " ")[:120]
    timestamp = _news_timestamp(row.get("datetime"))
    channel = str(row.get("channels") or source_hint).strip() or source_hint
    event_payload = f"{timestamp or ''}\n{title}\n{body}".encode("utf-8")
    return news_sources.NewsItemInput(
        title=title,
        body=body,
        source=f"Tushare news/{channel}",
        stock_codes=_news_codes(title, body),
        published_at=timestamp,
        available_at=timestamp,
        event_key=f"tushare-news:{hashlib.sha256(event_payload).hexdigest()[:24]}",
    )


def _chunks(values: list[Any], size: int) -> list[list[Any]]:
    return [values[index : index + size] for index in range(0, len(values), size)]


def sync_news(client: Any, *, start: date, as_of: date) -> dict[str, Any]:
    """Fetch relay news while recording whether the requested history was supplied."""

    failures: list[dict[str, str]] = []
    returned_timestamps: list[datetime] = []
    imported = {"created": 0, "duplicates": 0, "requests": 0}
    for source in NEWS_ENDPOINT_SOURCES:
        try:
            rows = _query(
                client,
                "news",
                src=source,
                start_date=f"{start.isoformat()} 00:00:00",
                end_date=f"{as_of.isoformat()} 23:59:59",
            )
        except RelaySyncError as exc:
            failures.append({"source": source, "reason": str(exc)})
            continue
        items = [item for row in rows if (item := _news_item(row, source)) is not None]
        for item in items:
            if item.published_at:
                returned_timestamps.append(item.published_at)
        for batch in _chunks(items, 100):
            fingerprint = hashlib.sha256(
                "\n".join(item.model_dump_json() for item in batch).encode("utf-8")
            ).hexdigest()[:24]
            response = news_sources.import_items(
                news_sources.NewsImport(
                    request_id=f"tushare-news-{source}-{start:%Y%m%d}-{as_of:%Y%m%d}-{fingerprint}",
                    items=batch,
                )
            )
            imported["created"] += response["created"]
            imported["duplicates"] += response["duplicates"]
            imported["requests"] += 1
        time.sleep(SOURCE_DELAY_SECONDS)
    earliest = min(returned_timestamps) if returned_timestamps else None
    latest = max(returned_timestamps) if returned_timestamps else None
    history_complete = bool(earliest and earliest.date() <= start and latest and latest.date() >= as_of)
    return {
        "source": "tushare.news",
        "requested_start": start.isoformat(),
        "requested_end": as_of.isoformat(),
        "configured_sources": list(NEWS_ENDPOINT_SOURCES),
        "failed_sources": failures,
        "earliest_returned_at": earliest.isoformat() if earliest else None,
        "latest_returned_at": latest.isoformat() if latest else None,
        "history_complete": history_complete,
        "import": imported,
        "status": "partial" if failures or not history_complete else "completed",
        "coverage_note": (
            "中转站未返回完整的请求时间窗；已导入实际返回的原文，未把缺失日期当作无资讯。"
            if not history_complete
            else "中转站返回的最早和最新资讯时间覆盖了请求时间窗。"
        ),
    }


def sync_tushare(
    *,
    as_of: date | str | None = None,
    days: int = 30,
    include_market: bool = True,
    include_news: bool = True,
    client: Any | None = None,
) -> dict[str, Any]:
    """Run the requested relay sync stages and retain useful partial results."""

    if type(days) is not int or not 1 <= days <= 365:
        raise ValueError("同步窗口必须是 1 至 365 个自然日")
    cutoff = _as_date(as_of)
    start = cutoff - timedelta(days=days - 1)
    relay = client or create_client()
    result: dict[str, Any] = {
        "started_at": utc_now(),
        "as_of": cutoff.isoformat(),
        "window_start": start.isoformat(),
        "window_days": days,
        "stages": {},
    }
    stages: list[tuple[str, Any]] = []
    if include_market:
        stages.append(("market", lambda: sync_market_data(relay, as_of=cutoff, initial_days=days)))
    if include_news:
        stages.append(("news", lambda: sync_news(relay, start=start, as_of=cutoff)))
    for name, action in stages:
        try:
            result["stages"][name] = action()
        except Exception as exc:
            result["stages"][name] = {"status": "failed", "reason": f"{type(exc).__name__}: {str(exc)[:240]}"}
    states = [stage.get("status") for stage in result["stages"].values()]
    result["status"] = "completed" if states and all(state in {"completed", "updated", "up_to_date", "no_new_rows"} for state in states) else "partial"
    result["finished_at"] = utc_now()
    session = getattr(relay, "_session", None)
    if session is not None:
        try:
            session.close()
        except Exception:
            pass
    return result
