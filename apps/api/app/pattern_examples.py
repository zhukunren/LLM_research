"""Find ranked real windows across the local market, one per security, with source caching."""
from datetime import date
import hashlib
import heapq
from threading import Lock

import numpy as np

from . import market
from .db import connect, json_dump, json_load
from .patterns import _candle_features, _relative_path, _resample, normalize_path, score_window, validate_candles

_scan_lock = Lock()
RECENT_WINDOWS = 120
MAX_EXAMPLES = 24


def _best_candle_window(template: dict, bars: list[dict]) -> dict | None:
    """Rank all OHLC windows together using the candle-window-v2 distances."""
    count = template["target_bars"]
    candles = template.get("candlesticks", [])
    if len(candles) != count:
        return None
    try:
        validate_candles(candles)
        expected_features = _candle_features(candles)
        expected = _relative_path(_resample(np.asarray(template["points"], dtype=float), count))
        raw = np.asarray([[bar.get(key) for key in ("open", "high", "low", "close")] for bar in bars], dtype=float)
    except (ValueError, TypeError, KeyError):
        return None
    windows = [np.lib.stride_tricks.sliding_window_view(raw[:, i], count) for i in range(4)]
    opened, high, low, closed = windows
    valid = np.lib.stride_tricks.sliding_window_view(np.asarray([bar.get("quality_valid", True) for bar in bars]), count).all(axis=1)
    for values in windows:
        valid &= np.isfinite(values).all(axis=1)
    valid &= ((high >= np.maximum(opened, closed)) & (low <= np.minimum(opened, closed))).all(axis=1)
    if not valid.any():
        return None
    with np.errstate(all="ignore"):
        actual = (closed - closed[:, :1]) / np.maximum(np.ptp(closed, axis=1, keepdims=True), 1e-8)
        distances = np.mean((actual - expected) ** 2, axis=1) * .78 + np.mean((np.diff(actual, axis=1) - np.diff(expected)) ** 2, axis=1) * .22
        ranges = high - low
        scale = np.maximum(np.maximum(np.max(ranges, axis=1, keepdims=True), np.max(high, axis=1, keepdims=True) - np.min(low, axis=1, keepdims=True)), 1e-12)
        denominator = np.where(ranges > scale * 1e-9, ranges, 1.)
        body = (closed - opened) / denominator
        wicks = np.stack(((high - np.maximum(opened, closed)) / denominator, (np.minimum(opened, closed) - low) / denominator), axis=2)
        direction = np.where(np.abs(closed - opened) <= scale * 1e-9, 0, np.sign(closed - opened))
        gaps = np.tanh((opened[:, 1:] - closed[:, :-1]) / np.maximum(np.mean(ranges, axis=1, keepdims=True), scale * 1e-9))
        distances += np.mean((body - expected_features[0]) ** 2, axis=1) * .10
        distances += np.mean((wicks - expected_features[1]) ** 2, axis=(1, 2)) * .20
        distances += np.mean(direction != expected_features[2], axis=1) * .15
        distances += np.mean((gaps - expected_features[3]) ** 2, axis=1) * .025
        scores = np.round(100. * np.exp(-distances * 6.2), 2)
    scores[~valid] = -np.inf
    # The original scanner compares rounded scores and keeps the most recent tie.
    start = len(scores) - 1 - int(np.argmax(scores[::-1]))
    window = bars[start:start + count]
    return {**score_window(template, window, match_mode="current"), "bars": window}


def best_window(template: dict, bars: list[dict]) -> dict | None:
    count = template["target_bars"]
    if len(bars) < count:
        return None
    if template.get("representation") == "ohlc_sequence" and template.get("algorithm_version") == "candle-window-v2":
        return _best_candle_window(template, bars)
    if template.get("representation") == "price_path" or template.get("algorithm_version") == "normalized-path-v1":
        closes = np.asarray([bar.get("close") if bar.get("close") is not None else np.nan for bar in bars], dtype=float)
        windows = np.lib.stride_tricks.sliding_window_view(closes, count)
        valid = np.lib.stride_tricks.sliding_window_view(np.asarray([bar.get("quality_valid", True) for bar in bars]), count).all(axis=1) & np.isfinite(windows).all(axis=1)
        if not valid.any():
            return None
        if template.get("algorithm_version") == "path-window-v2":
            expected = _relative_path(_resample(np.asarray(template["points"], dtype=float), count))
            relative = (windows - windows[:, :1]) / np.maximum(np.ptp(windows, axis=1, keepdims=True), 1e-8)
            distances = np.mean((relative - expected) ** 2, axis=1) * .78 + np.mean((np.diff(relative, axis=1) - np.diff(expected)) ** 2, axis=1) * .22
        else:
            expected = _resample(np.asarray(normalize_path(template["points"])), count)
            span = np.ptp(windows, axis=1, keepdims=True)
            relative = (windows - np.min(windows, axis=1, keepdims=True)) / np.maximum(span, 1e-9)
            relative = np.where(span < 1e-9, .5, relative)
            distances = .8 * np.mean(np.abs(relative - expected), axis=1) + .2 * np.minimum(1, np.mean(np.abs(np.diff(relative, axis=1) - np.diff(expected)), axis=1))
        distances[~valid] = np.inf
        # On exact ties prefer the most recent observed window.
        start = len(distances) - 1 - int(np.argmin(distances[::-1]))
        window = bars[start:start + count]
        result = score_window(template, window, match_mode="current")
        return {**result, "bars": window}
    best = None
    for start in range(len(bars) - count, -1, -1):
        window = bars[start:start + count]
        result = score_window(template, window, match_mode="current")
        if result.get("similarity") is not None and (best is None or result["similarity"] > best["similarity"]):
            best = {**result, "bars": window}
    return best


def find_example(template: dict, limit: int = 1) -> dict:
    if type(limit) is not int or not 1 <= limit <= MAX_EXAMPLES:
        raise ValueError(f"样本数量应在1至{MAX_EXAMPLES}之间")
    fingerprint = market.source_fingerprint()
    if fingerprint is None:
        return {"state": "unknown", "reason": "暂无本地真实行情", "bars": [], "items": []}
    cutoff = market.latest_market_date(date.today().isoformat())
    if cutoff is None:
        return {"state": "unknown", "reason": "暂无本地真实行情", "bars": [], "items": []}
    key = hashlib.sha256(json_dump({"template": template, "source": fingerprint, "as_of": cutoff, "windows": RECENT_WINDOWS, "algorithm": "ranked-best-v2", "max_examples": MAX_EXAMPLES}).encode()).hexdigest()
    with _scan_lock:
        with connect() as connection:
            cached = connection.execute("SELECT result_json FROM pattern_examples WHERE cache_key=?", (key,)).fetchone()
        if cached:
            result = json_load(cached[0])
            return {**result, "items": result["items"][:limit]}
        ranked, scanned, valid = [], 0, 0
        source_code = (template.get("market_source") or {}).get("stock_code")
        for code, bars in market.iter_recent_bars(cutoff, template["target_bars"] + RECENT_WINDOWS - 1):
            if code == source_code:
                continue
            scanned += 1
            candidate = best_window(template, bars)
            if candidate is None:
                continue
            valid += 1
            entry = (candidate["similarity"], candidate["end_date"], code, {**candidate, "stock_code": code})
            if len(ranked) < MAX_EXAMPLES:
                heapq.heappush(ranked, entry)
            elif entry[:3] > ranked[0][:3]:
                heapq.heapreplace(ranked, entry)
        if market.source_fingerprint() != fingerprint:
            raise ValueError("行情更新中，请稍后重试")
        items = [entry[3] for entry in sorted(ranked, key=lambda entry: entry[:3], reverse=True)]
        result = {**(items[0] if items else {"state": "unknown", "reason": "本地行情没有足够的有效 K 线窗口", "bars": []}),
                  "items": items,
                  "as_of": cutoff, "scanned_securities": scanned, "valid_securities": valid,
                  "recent_windows": RECENT_WINDOWS, "scope": "本地全部证券，每只最近120个结束窗口；每家公司取最相近区间，按原始相似度排序" + ("；已排除来源股票" if source_code else "")}
        with connect() as connection:
            connection.execute("INSERT OR REPLACE INTO pattern_examples VALUES(?,?)", (key, json_dump(result)))
        return {**result, "items": items[:limit]}
