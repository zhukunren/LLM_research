# -*- coding: utf-8 -*-
"""Project example: daily MA cross signals; no account access or order calls.
Copy into QMT's built-in editor; select 000001.SZ daily main chart and download
history first. This file has mock logic tests, not broker-client certification.
"""
import math

SYMBOL = '000001.SZ'
FAST = 5
SLOW = 20


class State:
    pass


g = State()


def init(C):
    if C.stockcode + '.' + C.market != SYMBOL or C.period != '1d':
        raise ValueError('Select the configured symbol and daily main chart')
    if not 0 < FAST < SLOW:
        raise ValueError('Require 0 < FAST < SLOW')
    C.set_universe([SYMBOL])
    g.emitted = set()


def handlebar(C):
    tag = int(C.get_bar_timetag(C.barpos))
    end = timetag_to_datetime(tag, '%Y%m%d%H%M%S')
    try:
        data = C.get_market_data_ex(
            ['time', 'close', 'volume'], [SYMBOL], period='1d', end_time=end,
            count=SLOW + 2, dividend_type='none', fill_data=False, subscribe=False)
        records = data[SYMBOL].to_dict('records')
        rows = sorted((r for r in records if int(r['time']) <= tag),
                      key=lambda r: int(r['time']))
        if len(rows) < SLOW + 2 or len(set(int(r['time']) for r in rows)) != len(rows):
            print('skip: insufficient or duplicate history', end)
            return
        if int(rows[-1]['time']) != tag:
            print('skip: main-chart bar is missing from local data', end)
            return
        # The latest row may still be forming. Decide on the previous bar only.
        closed = rows[:-1]
        prices = [float(r['close']) for r in closed]
        if any(not math.isfinite(p) or p <= 0 for p in prices):
            print('skip: invalid close', end)
            return
        if not math.isfinite(float(closed[-1]['volume'])) or float(closed[-1]['volume']) <= 0:
            print('skip: no volume at decision bar', end)
            return
        now_fast = sum(prices[-FAST:]) / FAST
        now_slow = sum(prices[-SLOW:]) / SLOW
        prev_fast = sum(prices[-FAST - 1:-1]) / FAST
        prev_slow = sum(prices[-SLOW - 1:-1]) / SLOW
        side = 'BUY_SIGNAL' if prev_fast <= prev_slow and now_fast > now_slow else (
            'SELL_SIGNAL' if prev_fast >= prev_slow and now_fast < now_slow else '')
        key = (SYMBOL, int(closed[-1]['time']), side)
        if side and key not in g.emitted:
            g.emitted.add(key)
            print(side, SYMBOL, 'decision_time', key[1], 'observed_at', tag,
                  'fast', now_fast, 'slow', now_slow)
    except (KeyError, TypeError, ValueError, OverflowError, AttributeError) as error:
        print('data error; no signal emitted:', type(error).__name__, str(error))
