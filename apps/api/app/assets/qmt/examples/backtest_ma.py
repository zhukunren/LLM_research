# -*- coding: utf-8 -*-
"""Project teaching example: ordinary A-share MA orders in BACKTEST ONLY.
Not a production/live strategy. Orders are disabled initially. Requires the
configured daily main chart, local history, configured fees and sufficient cash.
Only mock logic tests have run; no broker QMT execution has been verified.
"""
import math

SYMBOL = '000001.SZ'
FAST = 5
SLOW = 20
ACCOUNT_ID = 'qmt_demo_backtest'
ENABLE_BACKTEST_ORDERS = False
LOT_SIZE = 100  # Ordinary A-share example only, not a universal trading unit.
FEE_RESERVE = 0.003


class State:
    pass


g = State()


def init(C):
    if getattr(C, 'do_back_test', None) is not True:
        raise RuntimeError('This example is restricted to verified QMT backtest mode')
    if C.stockcode + '.' + C.market != SYMBOL or C.period != '1d':
        raise ValueError('Select the configured symbol and daily main chart')
    if not 0 < FAST < SLOW or LOT_SIZE <= 0 or FEE_RESERVE < 0:
        raise ValueError('Invalid parameters')
    C.set_universe([SYMBOL])
    g.submitted = set()


def handlebar(C):
    # Recheck every callback; do not infer mode from is_last_bar or a user flag.
    if getattr(C, 'do_back_test', None) is not True:
        raise RuntimeError('Backtest mode is required; no order was submitted')
    tag = int(C.get_bar_timetag(C.barpos))
    end = timetag_to_datetime(tag, '%Y%m%d%H%M%S')
    try:
        data = C.get_market_data_ex(
            ['time', 'open', 'close', 'volume'], [SYMBOL], period='1d', end_time=end,
            count=SLOW + 2, dividend_type='none', fill_data=False, subscribe=False)
        rows = sorted((r for r in data[SYMBOL].to_dict('records') if int(r['time']) <= tag),
                      key=lambda r: int(r['time']))
        if len(rows) < SLOW + 2 or len(set(int(r['time']) for r in rows)) != len(rows):
            print('skip: insufficient or duplicate history', end)
            return
        if int(rows[-1]['time']) != tag:
            print('skip: current main-chart bar missing', end)
            return
        prices = [float(r['close']) for r in rows[:-1]]
        price = float(rows[-1]['open'])  # Known at current bar opening; no current close signal.
        volume = float(rows[-2]['volume'])
        if (not math.isfinite(price) or price <= 0 or not math.isfinite(volume) or volume <= 0
                or any(not math.isfinite(p) or p <= 0 for p in prices)):
            print('skip: invalid price/volume', end)
            return
        cross_up = (sum(prices[-FAST - 1:-1]) / FAST <= sum(prices[-SLOW - 1:-1]) / SLOW
                    and sum(prices[-FAST:]) / FAST > sum(prices[-SLOW:]) / SLOW)
        cross_down = (sum(prices[-FAST - 1:-1]) / FAST >= sum(prices[-SLOW - 1:-1]) / SLOW
                      and sum(prices[-FAST:]) / FAST < sum(prices[-SLOW:]) / SLOW)
        side = 23 if cross_up else (24 if cross_down else None)
        key = (SYMBOL, int(rows[-2]['time']), side)
        if side is None or key in g.submitted:
            return
        if not ENABLE_BACKTEST_ORDERS:
            g.submitted.add(key)
            print('backtest orders disabled; signal only', key)
            return
        positions = get_trade_detail_data(ACCOUNT_ID, 'STOCK', 'POSITION')
        holding = next((p for p in positions
                        if p.m_strInstrumentID + '.' + p.m_strExchangeID == SYMBOL), None)
        quantity = 0
        if side == 23 and (holding is None or holding.m_nVolume == 0):
            accounts = get_trade_detail_data(ACCOUNT_ID, 'STOCK', 'ACCOUNT')
            if not accounts:
                raise ValueError('No account data; cannot assume available cash')
            cash = float(accounts[0].m_dAvailable)
            if math.isfinite(cash) and cash >= LOT_SIZE * price * (1 + FEE_RESERVE):
                quantity = LOT_SIZE
        elif side == 24 and holding is not None:
            quantity = max(0, int(holding.m_nCanUseVolume)) // LOT_SIZE * LOT_SIZE
        if quantity <= 0:
            print('skip: holdings, cash or sellable quantity does not permit order', key)
            return
        # 23/24 buy/sell; 1101 share quantity; 11 limit; 0 normal bar mechanism.
        # Simulator matching, fees and fills still depend on QMT backtest settings.
        g.submitted.add(key)
        passorder(side, 1101, ACCOUNT_ID, SYMBOL, 11, price, quantity,
                  'qmt_ma_backtest_example', 0, str(key[1]), C)
        print('backtest order requested; fill is not confirmed', key, quantity)
    except (KeyError, TypeError, ValueError, OverflowError, AttributeError) as error:
        print('backtest data/order error; no automatic retry:', type(error).__name__, str(error))
