"""Read-only daily-signal market data and evidence-based client communication drafts."""
from __future__ import annotations

from collections import OrderedDict
from datetime import date, datetime, timedelta, timezone
import math
from threading import Lock
import time
from typing import Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .settings import tushare_settings
from .tushare_client import TushareClient, TushareError
from .tushare_limits import configured_limiter
from .daily_signal_aliases import strategy_identity

router = APIRouter(prefix="/api/v1/daily-signals", tags=["每日信号"])
_market_cache: OrderedDict[str, tuple[float, dict[str, dict]]] = OrderedDict()
_market_lock = Lock()


class MarketRequest(BaseModel):
    date: date
    codes: list[str] = Field(min_length=1, max_length=500)



def _error(status: int, message: str):
    raise HTTPException(status, {"code": "daily_signal_error", "message": message})


def _named_signal_stock(stock: dict) -> dict:
    result = {'code': stock['code'], 'name': stock['name']}
    ratio = stock.get('position_ratio')
    position_date = stock.get('position_date')
    if type(ratio) in (int, float) and 0 <= ratio < math.inf and isinstance(position_date, str):
        result.update(position_ratio=ratio, position_date=position_date)
    return result


def named_signals(payload: dict) -> dict:
    """Project only public fields; upstream identifiers and extra metadata stay here."""
    if payload.get('schema_version') != 1 or not isinstance(payload.get('strategies'), list):
        raise ValueError('Invalid signal schema')
    result = {key: payload[key] for key in ('schema_version', 'date', 'dates', 'n', 'unavailable_count')}
    strategies = []
    fields = ('covers_date', 'win_rate', 'avg_trade_return', 'ann_return', 'sample_count',
              'known_pnl_count', 'win_count', 'sample_start', 'sample_end', 'data_end',
              'ann_return_start', 'ann_return_end', 'ann_return_day_count', 'buy_count', 'sell_count')
    for item in payload['strategies']:
        identity, title = strategy_identity(item['strategy_name'])
        strategy = {key: item[key] for key in fields if key in item}
        strategy.update(strategy_name=identity, strategy_title=title, generation_id='')
        for side in ('buy_signals', 'sell_signals'):
            strategy[side] = [_named_signal_stock(stock) for stock in item[side]]
        strategies.append(strategy)
    result['strategies'] = strategies
    return result


@router.get('/signals')
def signals(n: int = Query(20, ge=1, le=10000), as_of: date | None = Query(None, alias='date')):
    params = {'n': str(n)}
    if as_of is not None:
        params['date'] = as_of.isoformat()
    try:
        response = httpx.get('https://jshs.dwzq.top/api/strategies/signals', params=params, timeout=20)
        response.raise_for_status()
    except httpx.HTTPError:
        _error(503, '信号服务暂不可用，请稍后重试。')
    try:
        return named_signals(response.json())
    except (ValueError, KeyError, TypeError, AttributeError):
        _error(502, '信号数据格式异常，请稍后重试。')



def _number(value: Any) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None


def market_day(day: date) -> dict[str, dict]:
    if day > datetime.now(timezone(timedelta(hours=8))).date():
        _error(422, "不能读取未来日期的成交量。")
    key = day.isoformat()
    with _market_lock:
        cached = _market_cache.get(key)
        if cached and time.monotonic() - cached[0] < 300:
            return cached[1]
        config = tushare_settings()
        try:
            client = TushareClient(str(config['token']), api_url=str(config['api_url']),
                                   timeout=12, retries=0, limiter=configured_limiter())
            snapshot = client.raw_query('daily', trade_date=day.strftime('%Y%m%d'),
                fields='ts_code,trade_date,close,pct_chg,vol,amount')
        except TushareError:
            _error(503, "成交量数据暂不可用，请检查 Tushare 权限或稍后重试。")
        body = snapshot['data']
        rows = {}
        for values in body['items']:
            item = dict(zip(body['fields'], values))
            if item.get('trade_date') != day.strftime('%Y%m%d'):
                continue
            volume = _number(item.get('vol'))
            rows[str(item['ts_code'])] = {
                'code': item['ts_code'], 'date': key, 'close': _number(item.get('close')),
                'pct_chg': _number(item.get('pct_chg')), 'volume': volume if volume is not None and volume >= 0 else None,
                'volume_unit': '手', 'amount': _number(item.get('amount')), 'amount_unit': '千元',
            }
        _market_cache[key] = (time.monotonic(), rows)
        _market_cache.move_to_end(key)
        while len(_market_cache) > 2:
            _market_cache.popitem(last=False)
        return rows


@router.post('/market')
def market_quotes(payload: MarketRequest):
    import re
    if any(not re.fullmatch(r'\d{6}\.(SH|SZ|BJ)', code) for code in payload.codes):
        _error(422, "股票代码格式无效。")
    rows = market_day(payload.date)
    return {'date': payload.date.isoformat(), 'items': [rows[code] for code in dict.fromkeys(payload.codes) if code in rows],
            'source': 'Tushare 日线', 'volume_unit': '手'}


_history_cache: OrderedDict[tuple[str, str], tuple[float, dict]] = OrderedDict()
_history_lock = Lock()


def chart_history(code: str, day: date) -> dict:
    import re
    if not re.fullmatch(r'\d{6}\.(SH|SZ|BJ)', code):
        _error(422, '股票代码格式无效。')
    if day > datetime.now(timezone(timedelta(hours=8))).date():
        _error(422, '不能查询未来行情。')
    key = (code, day.isoformat())
    with _history_lock:
        cached = _history_cache.get(key)
        if cached and time.monotonic() - cached[0] < 300:
            return cached[1]
        config = tushare_settings()
        warning = ''
        try:
            client = TushareClient(str(config['token']), api_url=str(config['api_url']),
                                   timeout=15, retries=0, limiter=configured_limiter())
            payload = client.raw_query('daily', ts_code=code, start_date=(day - timedelta(days=500)).strftime('%Y%m%d'),
                end_date=day.strftime('%Y%m%d'), fields='ts_code,trade_date,open,high,low,close,vol,amount')
            table = payload['data']; bars = []
            for values in table['items']:
                row = dict(zip(table['fields'], values))
                if row.get('ts_code') != code:
                    continue
                try:
                    parsed = datetime.strptime(str(row['trade_date']), '%Y%m%d').date()
                except (ValueError, KeyError):
                    continue
                if parsed > day:
                    continue
                numeric = {key: _number(row.get(key)) for key in ('open', 'high', 'low', 'close', 'vol')}
                if any(numeric[key] is None for key in ('open', 'high', 'low', 'close')):
                    continue
                if min(numeric['open'], numeric['low'], numeric['close']) <= 0 or numeric['high'] < max(numeric['open'], numeric['low'], numeric['close']) or numeric['low'] > min(numeric['open'], numeric['close']):
                    continue
                bars.append({'trade_date': parsed.isoformat(), **{key: numeric[key] for key in ('open','high','low','close')},
                    'volume': numeric['vol'] if numeric['vol'] is not None and numeric['vol'] >= 0 else None,
                    'quality_valid': True})
            bars = sorted({bar['trade_date']: bar for bar in bars}.values(), key=lambda bar: bar['trade_date'])[-180:]
            source, volume_unit = 'Tushare 日线', '手'
        except TushareError:
            from .market import get_bars
            bars = [bar for bar in get_bars(code, day.isoformat(), 180) if bar.get('quality_valid') is not False]
            source, volume_unit = '本地日线', 'unknown'
            warning = '官方行情暂不可用，展示本地可用数据。'
        if not bars:
            _error(404, '该日期之前没有可用行情。')
        result = {'items': bars, 'volume_unit': volume_unit, 'source': source, 'requested_count': 180,
            'data_end': bars[-1]['trade_date'], 'warning': warning, 'price_basis': '未复权'}
        _history_cache[key] = (time.monotonic(), result)
        _history_cache.move_to_end(key)
        while len(_history_cache) > 12:
            _history_cache.popitem(last=False)
        return result


@router.get('/chart/{code}')
def chart(code: str, as_of: date):
    return chart_history(code, as_of)


from .trade_explanations import ExplainRequest, start_explanation, explanation_status, cancel_explanation


@router.post('/reason', status_code=202)
def create_reason(payload: ExplainRequest):
    return start_explanation(payload)


@router.get('/reason/{request_id}')
def reason_status(request_id: str):
    return explanation_status(request_id)


@router.post('/reason/{request_id}/cancel')
def stop_reason(request_id: str):
    return cancel_explanation(request_id)
