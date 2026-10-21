"""Controlled ingestion from the official Tushare Pro API.

Data ingestion is intentionally kept outside request handling. Running the sync
command stages external data, validates it, and only then replaces the market
Parquet file or commits news records to SQLite.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from datetime import date, datetime, time as clock_time, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping
from uuid import uuid4

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from . import news_sources
from .db import utc_now
from .settings import ALLOWED_MARKETS, STOCK_FILE, tushare_settings
from .tushare_client import TushareClient, TushareError


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
MARKET_DAYS_PER_SYNC = 30
SOURCE_DELAY_SECONDS = 0.15
STOCK_CODE_PATTERN = re.compile(r"(?<!\d)(\d{6})\.(SH|SZ|BJ)(?![A-Z])", re.I)
SyncProgress = Callable[[str, dict[str, Any]], None]


def _report_progress(callback: SyncProgress | None, stage: str, **details: Any) -> None:
    if callback:
        callback(stage, details)


def create_client() -> TushareClient:
    """Create a direct official API client using the configured token."""
    config = tushare_settings()
    from .tushare_limits import configured_limiter
    return TushareClient(str(config["token"]), timeout=float(config["timeout"]), retries=int(config["retries"]),
                         limiter=configured_limiter())


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
        raise TushareError(f"{api_name} 返回了无法识别的记录格式")
    if not items:
        return []
    if isinstance(items[0], Mapping):
        return [{str(key): value for key, value in row.items()} for row in items if isinstance(row, Mapping)]
    if not isinstance(fields, list) or not all(isinstance(field, str) for field in fields):
        raise TushareError(f"{api_name} 返回的字段定义无效")
    rows: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, (list, tuple)) or len(item) != len(fields):
            raise TushareError(f"{api_name} 返回了字段数量不匹配的记录")
        rows.append(dict(zip(fields, item, strict=True)))
    return rows


def _query(client: Any, api_name: str, **params: Any) -> list[dict[str, Any]]:
    try:
        payload = client.raw_query(api_name, **params)
    except TushareError:
        raise
    except Exception as exc:
        raise TushareError(f"{api_name} 请求失败：{type(exc).__name__}") from None
    return _payload_rows(payload, api_name)


def _market_bounds() -> tuple[date | None, date | None]:
    if not STOCK_FILE.is_file():
        return None, None
    with duckdb.connect(database=":memory:") as connection:
        row = connection.execute(
            f"SELECT MIN(trade_date)::DATE, MAX(trade_date)::DATE FROM read_parquet({_literal_path(STOCK_FILE)})"
        ).fetchone()
    return (row[0], row[1]) if row else (None, None)


def _market_watermark() -> date | None:
    return _market_bounds()[1]


def _market_signature() -> list[int] | None:
    if not STOCK_FILE.is_file():
        return None
    stat = STOCK_FILE.stat()
    return [stat.st_size, stat.st_mtime_ns]


def _market_completion() -> dict[str, Any]:
    # The ledger is published AFTER the parquet. A crash, restore, or external
    # writer invalidates it and causes safe revalidation, never skipped days.
    try:
        state = json.loads(STOCK_FILE.with_suffix(".sync.json").read_text(encoding="utf-8"))
        if isinstance(state, dict) and state.get("version") == 1 and state.get("signature") == _market_signature():
            date.fromisoformat(state["start"])
            if isinstance(state.get("complete_days"), list):
                return state
    except (OSError, ValueError, TypeError, KeyError):
        pass
    return {}


def _save_market_completion(start: date, complete_days: set[str], retry_days: set[str]) -> None:
    STOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    target = STOCK_FILE.with_suffix(".sync.json")
    staged = target.with_name(f".{target.name}.{uuid4().hex}.tmp")
    try:
        staged.write_text(json.dumps({
            "version": 1, "signature": _market_signature(),
            "start": start.isoformat(), "complete_days": sorted(complete_days),
            "retry_days": sorted(retry_days),
        }), encoding="utf-8")
        os.replace(staged, target)
    finally:
        staged.unlink(missing_ok=True)


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
        if is_open and day is not None and start <= day <= end:
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


def _daily_rows(client: Any, trade_day: date, on_page: Callable[[int, int], None] | None = None) -> list[dict[str, Any]]:
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
        if len(page_rows) > DAILY_PAGE_SIZE:
            raise TushareError(f"daily {trade_day.isoformat()} 返回记录超过分页上限")
        page_keys = {
            (str(item.get("ts_code") or ""), str(item.get("trade_date") or ""))
            for item in page_rows
        }
        if page_keys and page_keys <= seen_page_keys:
            raise TushareError(f"daily {trade_day.isoformat()} 分页重复，已拒绝不完整日线")
        seen_page_keys.update(page_keys)
        rows.extend(page_rows)
        if on_page:
            on_page(page + 1, len(rows))
        if len(page_rows) < DAILY_PAGE_SIZE:
            break
        time.sleep(SOURCE_DELAY_SECONDS)
    else:
        raise TushareError(f"daily {trade_day.isoformat()} 超过最大分页数")
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


def sync_market_data(client: Any, *, as_of: date, initial_days: int = 30, on_progress: SyncProgress | None = None) -> dict[str, Any]:
    """Append missing A-share daily bars without publishing partial days."""

    _report_progress(on_progress, "market", status="running", message="正在核对本地行情与交易日历…")
    earliest, previous_watermark = _market_bounds()
    state = _market_completion()
    # MAX is only a display watermark, not evidence that preceding days are
    # complete. Legacy parquet files have no completion proof and are retried.
    first_requested = date.fromisoformat(state["start"]) if state else (
        earliest or as_of - timedelta(days=max(1, initial_days) - 1)
    )
    if as_of < first_requested:
        first_requested = as_of - timedelta(days=max(1, initial_days) - 1)
    complete_days = set(state.get("complete_days", []))
    retry_days = set(state.get("retry_days", []))
    today = datetime.now(SOURCE_ZONE).date()
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
    pending_days = [day for day in open_days if day.isoformat() not in complete_days or day >= today]
    def priority(day: date) -> tuple[int, date]:
        if day >= today or (previous_watermark is not None and day > previous_watermark):
            return 0, day
        if day.isoformat() in retry_days:
            return 1, day
        return 2, day

    pending_days.sort(key=priority)
    # Revalidate legacy files incrementally rather than making years of daily
    # requests in one run. Unprocessed days remain absent from the ledger and
    # will be resumed on subsequent syncs.
    result["deferred_days"] = [day.isoformat() for day in pending_days[MARKET_DAYS_PER_SYNC:]]
    scheduled_days = pending_days[:MARKET_DAYS_PER_SYNC]
    result.update(completed=0, total=len(scheduled_days), unit="交易日")

    def report_day(message: str, **details: Any) -> None:
        _report_progress(on_progress, "market", **{
            **result, "status": "running", "message": message, **details,
        })

    updates: list[dict[str, Any]] = []
    for index, trade_day in enumerate(scheduled_days):
        report_day(f"正在读取 {trade_day.isoformat()} 行情（{index + 1}/{len(scheduled_days)} 个交易日）", current=trade_day.isoformat())
        try:
            on_page = lambda page, count: report_day(
                f"{trade_day.isoformat()} 已读取 {page} 页、{count:,} 条行情",
                current=trade_day.isoformat(), current_rows=count,
            )
            source_rows = _daily_rows(client, trade_day, on_page) if on_progress else _daily_rows(client, trade_day)
        except TushareError as exc:
            result["missing_or_failed_days"].append({"date": trade_day.isoformat(), "reason": str(exc)})
            result["completed"] = index + 1
            report_day(f"{trade_day.isoformat()} 行情读取失败，继续处理其他交易日")
            continue
        result["rows_received"] += len(source_rows)
        valid_for_day = []
        rejected = 0
        for source_row in source_rows:
            try:
                normalized = _daily_record(source_row)
                if normalized is not None and normalized["trade_date"].date() != trade_day:
                    raise ValueError("返回了其他交易日的行情")
            except ValueError:
                rejected += 1
                continue
            if normalized is not None:
                valid_for_day.append(normalized)
        result["rows_rejected"] += rejected
        if rejected or not valid_for_day:
            result["missing_or_failed_days"].append(
                {"date": trade_day.isoformat(), "reason": "日线含无效记录，整日待重试" if rejected else "未收到可用的 A 股日线"}
            )
            result["completed"] = index + 1
            report_day(f"{trade_day.isoformat()} 行情校验未通过，整日待重试")
            continue
        unique_for_day = {(item["stock_code"], item["trade_date"]): item for item in valid_for_day}
        updates.extend(unique_for_day.values())
        result["updated_days"].append(trade_day.isoformat())
        result["rows_valid"] += len(unique_for_day)
        # Same-day bars can still be incomplete or corrected after close.
        if trade_day < today:
            complete_days.add(trade_day.isoformat())
        result["completed"] = index + 1
        report_day(f"{trade_day.isoformat()} 校验通过，{len(unique_for_day):,} 条行情待写入")
        time.sleep(SOURCE_DELAY_SECONDS)

    report_day("正在合并并保存行情文件…", current=None)
    rows_written, bytes_written = _write_market_update(updates)
    retry_days.difference_update(result["updated_days"])
    retry_days.update(item["date"] for item in result["missing_or_failed_days"])
    _save_market_completion(first_requested, complete_days, retry_days)
    result["rows_written"] = rows_written
    result["bytes_written"] = bytes_written or None
    new_watermark = _market_watermark()
    result["new_watermark"] = new_watermark.isoformat() if new_watermark else None
    result["status"] = "partial" if result["missing_or_failed_days"] or result.get("deferred_days") else ("updated" if rows_written else "no_new_rows")
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


def sync_news(client: Any, *, start: date, as_of: date, on_progress: SyncProgress | None = None) -> dict[str, Any]:
    """Fetch official news while recording whether the requested history was supplied."""

    failures: list[dict[str, str]] = []
    returned_timestamps: list[datetime] = []
    imported = {"created": 0, "duplicates": 0, "requests": 0}
    def report_source(message: str, completed: int, source: str) -> None:
        _report_progress(on_progress, "news", status="running", message=message,
                         completed=completed, total=len(NEWS_ENDPOINT_SOURCES), unit="资讯来源",
                         current=source, **{"import": dict(imported)}, failed_sources=list(failures),
                         requested_start=start.isoformat(), requested_end=as_of.isoformat())

    for index, source in enumerate(NEWS_ENDPOINT_SOURCES):
        report_source(f"正在读取 {source} 资讯（{index + 1}/{len(NEWS_ENDPOINT_SOURCES)} 个来源）", index, source)
        try:
            rows = _query(
                client,
                "news",
                src=source,
                start_date=f"{start.isoformat()} 00:00:00",
                end_date=f"{as_of.isoformat()} 23:59:59",
            )
        except TushareError as exc:
            failures.append({"source": source, "reason": str(exc)})
            report_source(f"{source} 资讯读取失败，继续处理其他来源", index + 1, source)
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
            report_source(f"{source} 正在保存资讯，累计新增 {imported['created']:,} 条、重复 {imported['duplicates']:,} 条", index, source)
        report_source(f"{source} 已处理，返回 {len(rows):,} 条资讯", index + 1, source)
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
        "completed": len(NEWS_ENDPOINT_SOURCES),
        "total": len(NEWS_ENDPOINT_SOURCES),
        "unit": "资讯来源",
        "status": "partial" if failures or not history_complete else "completed",
        "coverage_note": (
            "Tushare 未返回完整的请求时间窗；已导入实际返回的原文，未把缺失日期当作无资讯。"
            if not history_complete
            else "Tushare 返回的最早和最新资讯时间覆盖了请求时间窗。"
        ),
    }


def sync_tushare(
    *,
    as_of: date | str | None = None,
    days: int = 30,
    include_market: bool = True,
    include_news: bool = True,
    client: Any | None = None,
    on_progress: SyncProgress | None = None,
) -> dict[str, Any]:
    """Run the requested official API sync stages and retain useful partial results."""

    if type(days) is not int or not 1 <= days <= 365:
        raise ValueError("同步窗口必须是 1 至 365 个自然日")
    cutoff = _as_date(as_of)
    start = cutoff - timedelta(days=days - 1)
    client = client if client is not None else create_client()
    result: dict[str, Any] = {
        "started_at": utc_now(),
        "as_of": cutoff.isoformat(),
        "window_start": start.isoformat(),
        "window_days": days,
        "stages": {},
    }
    stages: list[tuple[str, Any]] = []
    if include_market:
        stages.append(("market", lambda: sync_market_data(client, as_of=cutoff, initial_days=days, on_progress=on_progress)))
    if include_news:
        stages.append(("news", lambda: sync_news(client, start=start, as_of=cutoff, on_progress=on_progress)))
    for name, action in stages:
        _report_progress(on_progress, name, status="running", message="正在更新行情…" if name == "market" else "正在更新资讯…")
        try:
            result["stages"][name] = action()
        except Exception as exc:
            result["stages"][name] = {"status": "failed", "reason": str(exc)[:240] if isinstance(exc, TushareError) else "更新处理失败，请保存诊断信息交给维护者。"}
        _report_progress(on_progress, name, **result["stages"][name])
    states = [stage.get("status") for stage in result["stages"].values()]
    result["status"] = "completed" if states and all(state in {"completed", "updated", "up_to_date", "no_new_rows"} for state in states) else "partial"
    result["finished_at"] = utc_now()
    return result
