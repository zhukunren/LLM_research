"""Dated, single-stock observations for the client-service celebration poster."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
from typing import Literal

from pydantic import Field, field_validator
import requests

from . import tushare_sync
from .client_service import TZ, error, now
from .client_service_contracts import StrictModel
from .client_service_market import number, tencent_quote_rows
from .db import connect
from .stock_diagnosis import resolve_stock
from .tushare_client import TushareError


Mode = Literal['close', 'intraday_high']
Theme = Literal['red_gold', 'blue_gold']
FIRST_MATCH = time(9, 25)
CLOSE = time(15)
HUNDREDTH = Decimal('0.01')


class CelebrationRequest(StrictModel):
    portfolio_name: str = Field(min_length=1, max_length=32)
    code: str = Field(pattern=r'^[0-9]{6}(?:\.(SH|SZ|BJ))?$')
    mode: Mode
    theme: Theme = 'red_gold'

    @field_validator('portfolio_name', mode='before')
    @classmethod
    def clean_name(cls, value):
        return ' '.join(value.split()) if isinstance(value, str) else value

    @field_validator('code', mode='before')
    @classmethod
    def clean_code(cls, value):
        return value.strip().upper() if isinstance(value, str) else value


@dataclass(frozen=True)
class Observation:
    close: Decimal
    high: Decimal
    previous_close: Decimal
    observed_at: datetime
    source: str
    source_url: str


def _observation(close, high, previous_close, volume, observed_at: datetime, source: str, source_url: str) -> Observation | None:
    close, high, previous_close, volume = map(number, (close, high, previous_close, volume))
    if any(value is None or value <= 0 for value in (close, high, previous_close, volume)) or high < close:
        return None
    return Observation(close, high, previous_close, observed_at, source, source_url)


def _tencent_observation(code: str, current: datetime) -> Observation | None:
    digits, exchange = code.split('.')
    symbol = exchange.lower() + digits
    try:
        row = tencent_quote_rows([symbol]).get(symbol, [])
        if len(row) <= 33 or row[2] != digits:
            return None
        observed = datetime.strptime(row[30], '%Y%m%d%H%M%S').replace(tzinfo=TZ)
    except (requests.RequestException, ValueError):
        return None
    if observed.time() < FIRST_MATCH or observed > current + timedelta(seconds=2):
        return None
    return _observation(row[3], row[33], row[4], row[6], observed, '腾讯财经', f'https://gu.qq.com/{symbol}/gp')


def _daily_observation(client, code: str, day: date) -> Observation | None:
    trade_date = day.strftime('%Y%m%d')
    payload = client.raw_query('daily', ts_code=code, trade_date=trade_date,
                               fields='ts_code,trade_date,close,high,pre_close,vol')
    row = next((item for item in tushare_sync._payload_rows(payload, 'daily')
                if item.get('ts_code') == code and str(item.get('trade_date')) == trade_date), None)
    if row is None:
        return None
    return _observation(row.get('close'), row.get('high'), row.get('pre_close'), row.get('vol'),
                        datetime.combine(day, CLOSE, TZ), 'Tushare 日线', 'https://tushare.pro/document/1?doc_id=27')


def _market_observation(code: str, mode: Mode, current: datetime) -> Observation:
    before_close = current.time() < CLOSE
    before_target = before_close if mode == 'close' else current.time() < FIRST_MATCH
    upper_day = current.date() - timedelta(days=int(before_target))
    live = _tencent_observation(code, current)
    if live and live.observed_at.time() < CLOSE and (mode == 'close' or not before_close):
        live = None
    if live and live.observed_at.date() == upper_day:
        return live

    try:
        client = tushare_sync.create_client(timeout=5, retries=0)
        days = tushare_sync._open_days(client, upper_day - timedelta(days=20), upper_day)
        if days:
            day = days[-1]
            if live and live.observed_at.date() == day:
                return live
            if day < current.date() or not before_close:
                daily = _daily_observation(client, code, day)
                if daily:
                    return daily
    except (TushareError, OSError, ValueError):
        pass

    error(503, '最近交易日的收盘行情暂不可核对，请稍后再试。' if mode == 'close'
          else '最近交易日的盘中最高价暂不可核对，请稍后再试。')


def _closing_threshold(rise: Decimal) -> str:
    step = next(step for step in (Decimal('1'), Decimal('0.1'), HUNDREDTH, Decimal('0.001')) if rise > step)
    threshold = rise.quantize(step, rounding=ROUND_CEILING) - step
    return f'{threshold.normalize():f}%'


def collect(payload: CelebrationRequest) -> dict:
    with connect() as connection:
        stock = resolve_stock(connection, payload.code)
    code = stock['stock_code']
    quote = _market_observation(code, payload.mode, now())
    price = quote.close if payload.mode == 'close' else quote.high
    rise = (price - quote.previous_close) * 100 / quote.previous_close
    percentage = rise.quantize(HUNDREDTH, rounding=ROUND_HALF_UP)
    if percentage <= 0:
        error(422, f'该笔行情的涨幅为 {percentage:.2f}%。喜报适用正涨幅。')
    threshold = _closing_threshold(min(rise, percentage)) if payload.mode == 'close' else None
    return {
        'portfolio_name': payload.portfolio_name, 'code': code, 'stock_name': stock['name'], 'mode': payload.mode,
        'theme': payload.theme,
        'mode_label': '收盘涨超' if payload.mode == 'close' else '盘中最高', 'closing_threshold': threshold,
        'change_percent': f'{percentage:.2f}%', 'price': f'{price:f}', 'previous_close': f'{quote.previous_close:f}',
        'trade_date': quote.observed_at.date().isoformat(), 'observed_at': quote.observed_at.isoformat(),
        'source': quote.source, 'source_url': quote.source_url,
    }
