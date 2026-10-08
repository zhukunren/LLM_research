"""Separate cache for benchmark indices; indices never enter the stock universe."""
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
import json
import os
import time
import requests

from .market import _bar_quality
from .settings import DATA_ROOT
from .tushare_sync import create_client, _payload_rows, _source_date

INDEX_FILE = DATA_ROOT / "market_index" / "000001.SH.json"
_lock = Lock()
# No weekday heuristic can prove an exchange holiday or a fully published
# session. Cache an observation briefly, never a promise of range completeness.
CACHE_TTL_SECONDS = 300
SOURCE_ZONE = timezone(timedelta(hours=8))


def _read_cache() -> dict:
    try:
        cached = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
        if isinstance(cached, dict) and isinstance(cached.get("bars"), list):
            return cached
    except (OSError, ValueError, TypeError):
        pass
    return {}


def _cache_fresh(cached: dict, start: date, cutoff: date) -> bool:
    try:
        age = time.time() - float(cached["fetched_at"])
        return (0 <= age < CACHE_TTL_SECONDS
                and cached.get("requested_start", "9999") <= start.isoformat()
                and cached.get("requested_end", "") >= cutoff.isoformat())
    except (KeyError, TypeError, ValueError):
        return False



def _fetch(start: date, cutoff: date) -> tuple[list[dict], str]:
    try:
        response = create_client().raw_query("index_daily", ts_code="000001.SH", start_date=start.strftime("%Y%m%d"), end_date=cutoff.strftime("%Y%m%d"))
        rows = _payload_rows(response, "index_daily")
        if rows:
            return rows, "Tushare index_daily"
    except Exception:
        pass
    response = requests.get("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get", params={"param": f"sh000001,day,{start.isoformat()},{cutoff.isoformat()},1000,qfq"}, timeout=20)
    response.raise_for_status()
    series = response.json().get("data", {}).get("sh000001", {}).get("day", [])
    return [{"ts_code": "000001.SH", "trade_date": row[0], "open": row[1], "close": row[2], "high": row[3], "low": row[4], "vol": row[5], "amount": None} for row in series], "腾讯行情 / 上证指数"


def get_bars(as_of: str | None = None, limit: int = 500) -> list[dict]:
    cutoff = date.fromisoformat(as_of) if as_of else datetime.now(SOURCE_ZONE).date()
    with _lock:
        cached = _read_cache()
        start = cutoff - timedelta(days=1100)
        if not _cache_fresh(cached, start, cutoff):
            try:
                rows, source = _fetch(start, cutoff)
                bars = []
                for row in rows:
                    day = _source_date(row.get("trade_date"))
                    if not day or not start <= day <= cutoff or row.get("ts_code") != "000001.SH":
                        continue
                    values = [float(row[key]) for key in ("open", "high", "low", "close", "vol")]
                    amount = float(row["amount"]) if row.get("amount") is not None else None
                    valid, reason = _bar_quality(*values, amount if amount is not None else 0)
                    if not valid:
                        raise ValueError("上证指数返回了无效行情")
                    bars.append(dict(zip(("open", "high", "low", "close", "volume"), values), amount=amount, trade_date=day.isoformat(), quality_valid=True, quality_reason=reason, source=source))
                if not bars:
                    raise ValueError("数据源尚未返回上证指数行情")
                unique = {bar["trade_date"]: bar for bar in cached.get("bars", [])}
                unique.update({bar["trade_date"]: bar for bar in bars})
                cached = {
                    # Bounds describe this fetch, not inferred completeness or
                    # the union of potentially disjoint historical requests.
                    "requested_start": start.isoformat(),
                    "requested_end": cutoff.isoformat(),
                    "fetched_at": time.time(),
                    "observed_start": min(bar["trade_date"] for bar in bars),
                    "observed_end": max(bar["trade_date"] for bar in bars),
                    "bars": sorted(unique.values(), key=lambda bar: bar["trade_date"]),
                }
                INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
                staged = INDEX_FILE.with_suffix(".tmp")
                staged.write_text(json.dumps(cached), encoding="utf-8")
                os.replace(staged, INDEX_FILE)
            except Exception as exc:
                if not cached.get("bars"):
                    raise ValueError("上证指数行情暂时无法读取，请稍后重试") from exc
        return [bar for bar in cached.get("bars", []) if bar["trade_date"] <= cutoff.isoformat()][-max(1, min(limit, 500)):]
