"""Dated reference prices for the editable rebalance card."""
from datetime import datetime, time, timedelta
import logging
import re

import requests

from . import market
from .client_service import TZ, error, now
from .client_service_market import number, tencent_quote_rows
from .db import connect
from .stock_diagnosis import resolve_stock

logger = logging.getLogger(__name__)


def daily_context(code: str, cutoff: datetime) -> dict | None:
    closed_day = cutoff.date() - timedelta(days=cutoff.time() < time(15))
    try:
        bars = market.get_bars(code, closed_day.isoformat(), 2)
    except (OSError, ValueError, market.duckdb.Error):
        logger.warning("Local daily bars temporarily unavailable for the suggestion", exc_info=True)
        return None
    eligible = []
    for row in bars:
        value = number(row.get("close"))
        if row.get("quality_valid", True) and value is not None and value > 0:
            eligible.append((row, value))
    if not eligible:
        return None
    latest, close = eligible[-1]
    previous = eligible[-2][1] if len(eligible) > 1 else None
    return {
        "trade_date": latest["trade_date"], "close": f"{close:.2f}",
        "pct_change": f"{(close / previous - 1) * 100:+.2f}%" if previous is not None else None,
    }


def reference_price(code: str) -> dict:
    code = code.strip().upper()
    if not re.fullmatch(r"\d{6}(?:\.(SH|SZ|BJ))?", code):
        error(422, "请输入六位 A 股代码，可带交易所后缀。")
    with connect() as db:
        stock = resolve_stock(db, code)
    code = stock["stock_code"]
    current = now()
    digits, exchange = code.split(".")
    symbol = exchange.lower() + digits
    remote = None
    try:
        row = tencent_quote_rows([symbol]).get(symbol, [])
        if len(row) > 30 and row[2] == digits:
            price = number(row[3])
            observed = datetime.strptime(row[30], "%Y%m%d%H%M%S").replace(tzinfo=TZ)
            if price is not None and price > 0 and observed <= current + timedelta(seconds=2):
                session = time(9, 30) <= current.time() < time(11, 30) or time(13) <= current.time() < time(15)
                live = session and current.weekday() < 5 and current - timedelta(minutes=2) <= observed
                completed = observed.time() >= time(15)
                remote = {
                    "code": code, "price": f"{price:.2f}", "observed_at": observed.isoformat(),
                    "source": "腾讯行情", "kind": "live" if live else "close" if completed else "latest",
                }
                if observed.date() == current.date() and (current.time() < time(15) or completed):
                    return remote
    except (requests.RequestException, ValueError):
        pass
    daily = daily_context(code, current)
    if daily:
        observed = datetime.fromisoformat(daily["trade_date"]).replace(hour=15, tzinfo=TZ)
        if remote is None or observed > datetime.fromisoformat(remote["observed_at"]):
            return {"code": code, "price": daily["close"], "observed_at": observed.isoformat(),
                    "source": "本地日线", "kind": "close"}
    if remote is not None:
        return remote
    error(503, "暂时没有可核对的行情，可手动填写参考价格。")
