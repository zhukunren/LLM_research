# -*- coding: utf-8 -*-
"""Project example: previous completed daily bar breaks prior highs on volume.
Signal only; no account queries or orders. Requires matching daily main chart.
Local mock verification does not replace validation in the broker's QMT.
"""
import math

SYMBOL = '000001.SZ'
LOOKBACK = 20
VOLUME_WINDOW = 5
VOLUME_MULTIPLIER = 1.5


class State:
    pass


g = State()


def init(C):
    if C.stockcode + '.' + C.market != SYMBOL or C.period != '1d':
        raise ValueError('Select the configured symbol and daily main chart')
    if LOOKBACK < 1 or VOLUME_WINDOW < 1 or VOLUME_MULTIPLIER <= 0:
        raise ValueError('Invalid lookback or volume parameters')
    C.set_universe([SYMBOL])
    g.emitted = set()


def handlebar(C):
    tag = int(C.get_bar_timetag(C.barpos))
    end = timetag_to_datetime(tag, '%Y%m%d%H%M%S')
    try:
        count = max(LOOKBACK, VOLUME_WINDOW) + 2
        data = C.get_market_data_ex(
            ['time', 'high', 'close', 'volume'], [SYMBOL], period='1d',
            end_time=end, count=count, dividend_type='none', fill_data=False, subscribe=False)
        rows = sorted((r for r in data[SYMBOL].to_dict('records') if int(r['time']) <= tag),
                      key=lambda r: int(r['time']))
        if len(rows) < count or len(set(int(r['time']) for r in rows)) != len(rows):
            print('skip: insufficient or duplicate history', end)
            return
        if int(rows[-1]['time']) != tag:
            print('skip: main-chart bar missing', end)
            return
        closed = rows[:-1]
        if any(not math.isfinite(float(r[field])) or float(r[field]) <= 0
               for r in closed for field in ('high', 'close', 'volume')):
            print('skip: missing/nonfinite/zero data', end)
            return
        signal = closed[-1]
        # Both comparison windows exclude the signal bar itself.
        prior_high = max(float(r['high']) for r in closed[-LOOKBACK - 1:-1])
        prior_volume = sum(float(r['volume']) for r in closed[-VOLUME_WINDOW - 1:-1]) / VOLUME_WINDOW
        key = (SYMBOL, int(signal['time']))
        if (float(signal['close']) > prior_high
                and float(signal['volume']) > prior_volume * VOLUME_MULTIPLIER
                and key not in g.emitted):
            g.emitted.add(key)
            print('BREAKOUT_SIGNAL', SYMBOL, 'decision_time', key[1], 'observed_at', tag,
                  'prior_high', prior_high, 'volume_ratio', float(signal['volume']) / prior_volume)
    except (KeyError, TypeError, ValueError, OverflowError, AttributeError) as error:
        print('data error; no signal emitted:', type(error).__name__, str(error))
