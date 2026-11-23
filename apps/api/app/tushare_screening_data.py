"""Validated Tushare inputs for the industry valuation rule."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
from typing import Any
from uuid import uuid4

from . import tushare_sync
from .tushare_client import TushareError


A_SHARE = re.compile(r"^\d{6}\.(SH|SZ|BJ)$")
INDUSTRY_CODE = r"^\d{6}\.SI$"
MEMBER_FIELDS = (
    "l1_code", "l1_name", "l2_code", "l2_name", "l3_code", "l3_name",
    "ts_code", "in_date", "out_date",
)
PAGE_SIZE = 2000


@dataclass(frozen=True)
class SourceRows:
    rows: list[dict[str, Any]]
    manifest: str
    observed_at: str | None = None


def _invalid(api_name: str, reason: str) -> TushareError:
    return TushareError(f"{api_name}：{reason}", kind="invalid_response")


def _source_day(value: Any) -> date | None:
    text = str(value or "").strip()
    if re.fullmatch(r"\d{8}|\d{4}-\d{2}-\d{2}", text):
        try:
            return date.fromisoformat(text)
        except ValueError:
            pass
    return None


def _pages(client, api_name: str, fields: tuple[str, ...], identity: tuple[str, ...], **params):
    seen = set()
    for offset in range(0, 40_000, PAGE_SIZE):
        rows = tushare_sync._query(client, api_name, fields=",".join(fields), limit=PAGE_SIZE, offset=offset, **params)
        if len(rows) > PAGE_SIZE or any(not set(fields) <= row.keys() for row in rows):
            raise _invalid(api_name, "返回字段或分页范围无效")
        for row in rows:
            key = tuple(str(row[field]) for field in identity)
            if key in seen:
                raise _invalid(api_name, "返回了重复记录，无法确认分页完整")
            seen.add(key)
            yield row
        if len(rows) < PAGE_SIZE:
            return
    raise _invalid(api_name, "超过最大分页范围")


def _cache(key: str, fetch, *, max_age: timedelta, root: Path | None = None) -> SourceRows:
    directory = root or tushare_sync.STOCK_FILE.parent / "tushare-screening-v1"
    path = directory / f"{key}.json"
    now = datetime.now(timezone.utc)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        observed = datetime.fromisoformat(payload["observed_at"])
        if observed <= now < observed + max_age and isinstance(payload["rows"], list):
            rows = payload["rows"]
        else:
            rows = None
    except (OSError, KeyError, TypeError, ValueError):
        rows = None
    if rows is None:
        rows = fetch()
        observed = datetime.now(timezone.utc)
        payload = {"observed_at": observed.isoformat(), "rows": rows}
        path.parent.mkdir(parents=True, exist_ok=True)
        pending = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            pending.write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False), encoding="utf-8")
            os.replace(pending, path)
        finally:
            pending.unlink(missing_ok=True)
    digest = hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()).hexdigest()
    return SourceRows(rows, f"tushare:{key}:sha256:{digest}", observed.isoformat())


def _member_rows(client) -> list[dict[str, Any]]:
    api_name = "index_member_all"
    rows = {}
    for current in ("Y", "N"):
        for raw in _pages(client, api_name, MEMBER_FIELDS, ("ts_code", "l3_code", "in_date", "out_date"), is_new=current):
            code = str(raw["ts_code"]).upper().strip()
            if not A_SHARE.fullmatch(code):
                continue
            path = [
                [str(raw[f"l{level}_code"]).strip(), str(raw[f"l{level}_name"] or "").strip()]
                for level in (1, 2, 3)
            ]
            start = _source_day(raw["in_date"])
            end = _source_day(raw["out_date"])
            if (not start or (raw["out_date"] and not end) or (end and end < start)
                    or (current == "N" and end is None)
                    or any(not re.fullmatch(INDUSTRY_CODE, item[0]) or not item[1] for item in path)):
                raise _invalid(api_name, "行业代码、名称或成分生效日期无效")
            start_text, end_text = start.isoformat(), end.isoformat() if end else None
            rows[(code, path[-1][0], start_text, end_text)] = {
                "stock_code": code, "path": path, "in_date": start_text, "out_date": end_text,
            }
    if not rows:
        raise TushareError("index_member_all 没有返回有效的申万行业成分", kind="no_data")
    return list(rows.values())


def industry_memberships(client) -> SourceRows:
    return _cache("index_member_all", lambda: _member_rows(client), max_age=timedelta(days=1))


def industry_catalog(memberships: SourceRows) -> list[dict[str, Any]]:
    catalog = {}
    for row in memberships.rows:
        for level, (code, name) in enumerate(row["path"], start=1):
            catalog[code] = {"code": code, "name": name, "level": level}
    return sorted(catalog.values(), key=lambda item: (item["level"], item["code"]))


def list_industries() -> list[dict[str, Any]]:
    return industry_catalog(industry_memberships(tushare_sync.create_client()))


def _quote_rows(client, api_name: str, field: str, trade_day: date) -> list[dict[str, Any]]:
    fields = ("ts_code", "trade_date", field)
    rows = []
    for raw in _pages(client, api_name, fields, ("ts_code", "trade_date"), trade_date=trade_day.strftime("%Y%m%d")):
        code = str(raw["ts_code"]).upper().strip()
        if not A_SHARE.fullmatch(code):
            continue
        if _source_day(raw["trade_date"]) != trade_day:
            raise _invalid(api_name, "返回了其他交易日的数据")
        try:
            value = tushare_sync._number(raw[field], field)
        except ValueError:
            value = None
        if isinstance(raw[field], bool) or (field == "amount" and value is not None and value < 0):
            value = None
        rows.append({"stock_code": code, field: value})
    if not rows:
        raise TushareError(f"{api_name} 暂无 {trade_day.isoformat()} 的 A 股数据", kind="no_data")
    return rows


def daily_valuation(client, trade_day: date) -> SourceRows:
    return _cache(
        f"daily_basic-{trade_day.isoformat()}",
        lambda: _quote_rows(client, "daily_basic", "pe_ttm", trade_day),
        max_age=timedelta(hours=1),
    )


def daily_amount(client, trade_day: date) -> SourceRows:
    return _cache(
        f"daily-amount-{trade_day.isoformat()}",
        lambda: _quote_rows(client, "daily", "amount", trade_day),
        max_age=timedelta(days=1),
    )


def verified_amount(value: Any) -> float | None:
    if type(value) in {int, float} and math.isfinite(value) and value >= 0:
        return float(value)
    return None
