"""Read a cohort in one Parquet query; horizons use market trading dates."""
from functools import lru_cache

from . import market


def reference_prices(codes, as_of):
    return {
        code: {"trade_date": bars[-1]["trade_date"],
               "close": bars[-1]["close"] if bars[-1]["quality_valid"] else None}
        for code, bars in market.iter_recent_bars(as_of, 10, codes) or () if bars
    }


def cohort_prices(codes, signal_date, latest_date):
    fingerprint = market.source_fingerprint()
    result = _cohort_prices(fingerprint, tuple(sorted(codes)), signal_date, latest_date)
    if market.source_fingerprint() != fingerprint:
        raise ValueError("读取期间行情发生更新，请刷新观察池。")
    return result


@lru_cache(maxsize=12)
def _cohort_prices(fingerprint, codes, signal_date, latest_date):
    if not fingerprint or not codes or not latest_date:
        return {"days": 0, "prices": {}}
    source = market._literal_path(market.STOCK_FILE)
    with market._open() as connection:
        # Materialize the market calendar once. Missing individual bars do not shift horizons.
        connection.execute(f"""CREATE TEMP TABLE observation_dates AS
            SELECT day, row_number() OVER (ORDER BY day)-1 AS n FROM (
                SELECT DISTINCT trade_date::DATE AS day FROM read_parquet({source})
                WHERE trade_date > CAST(? AS DATE) AND trade_date<=CAST(? AS DATE)
                UNION SELECT CAST(? AS DATE)
            )""", [signal_date, latest_date, signal_date])
        days = connection.execute("SELECT coalesce(max(n),0) FROM observation_dates").fetchone()[0]
        placeholders = ','.join('?' for _ in codes)
        rows = connection.execute(f"""WITH bars AS (
            SELECT b.stock_code,b.close,b.high,b.low,d.day,d.n,
                coalesce(isfinite(open) AND isfinite(high) AND isfinite(low) AND isfinite(close)
                    AND isfinite(volume) AND isfinite(amount) AND least(open,high,low,close)>0
                    AND high>=greatest(open,low,close) AND low<=least(open,high,close)
                    AND volume>=0 AND amount>=0, false) AS valid
            FROM read_parquet({source}) b JOIN observation_dates d ON b.trade_date::DATE=d.day
            WHERE b.stock_code IN ({placeholders})
              AND b.trade_date BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)
        ) SELECT stock_code,
            max(close) FILTER (WHERE n=0 AND valid) AS base_close,
            arg_max(CASE WHEN valid THEN close ELSE NULL END,day) AS latest_close,
            max(day) FILTER (WHERE valid) AS latest_date,
            max(high) FILTER (WHERE n>0 AND valid) AS peak,
            min(low) FILTER (WHERE n>0 AND valid) AS trough,
            count(*) FILTER (WHERE NOT valid) AS invalid_bars,
            count(*) FILTER (WHERE n>0 AND valid) AS observed_days,
            max(close) FILTER (WHERE n=5 AND valid) AS close_5,
            max(close) FILTER (WHERE n=10 AND valid) AS close_10,
            max(close) FILTER (WHERE n=20 AND valid) AS close_20
        FROM bars GROUP BY stock_code""", [*codes, signal_date, latest_date]).fetchall()
        columns = [item[0] for item in connection.description]
    prices = {}
    for row in rows:
        item = dict(zip(columns, row))
        if item["latest_date"]:
            item["latest_date"] = str(item["latest_date"])
        prices[item.pop("stock_code")] = item
    return {"days": int(days), "prices": prices}


def chart_bars(code, signal_date, cutoff):
    """Keep all bars after the signal, plus 60 before it (no 500-bar truncation)."""
    if not market.source_fingerprint():
        return []
    with market._open() as connection:
        rows = connection.execute(f"""WITH bars AS (
            SELECT trade_date::DATE AS day,open,high,low,close,volume,amount
            FROM read_parquet({market._literal_path(market.STOCK_FILE)})
            WHERE stock_code=? AND trade_date<=CAST(? AS DATE)
        ) SELECT * FROM (
            (SELECT * FROM bars WHERE day<CAST(? AS DATE) ORDER BY day DESC LIMIT 60)
            UNION ALL (SELECT * FROM bars WHERE day>=CAST(? AS DATE))
        ) ORDER BY day""", [code, cutoff, signal_date, signal_date]).fetchall()
    result = []
    for day, op, hi, lo, cl, volume, amount in rows:
        valid, reason = market._bar_quality(op, hi, lo, cl, volume, amount)
        result.append({"trade_date": str(day), "open": op if valid else None,
                       "high": hi if valid else None, "low": lo if valid else None,
                       "close": cl if valid else None, "volume": volume if valid else None,
                       "quality_valid": valid, "quality_reason": reason})
    return result
