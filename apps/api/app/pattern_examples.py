"""Find the highest raw similarity window across the local market, with source caching."""
from datetime import date
import hashlib
from threading import Lock

import numpy as np

from . import market
from .db import connect, json_dump, json_load
from .patterns import _relative_path, _resample, normalize_path, score_window

_scan_lock = Lock()
RECENT_WINDOWS = 120


def best_window(template: dict, bars: list[dict]) -> dict | None:
    count = template["target_bars"]
    if len(bars) < count:
        return None
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


def find_example(template: dict) -> dict:
    fingerprint = market.source_fingerprint()
    if fingerprint is None:
        return {"state": "unknown", "reason": "暂无本地真实行情", "bars": []}
    key = hashlib.sha256(json_dump({"template": template, "source": fingerprint, "windows": RECENT_WINDOWS, "algorithm": "raw-best-v1"}).encode()).hexdigest()
    with _scan_lock:
        with connect() as connection:
            cached = connection.execute("SELECT result_json FROM pattern_examples WHERE cache_key=?", (key,)).fetchone()
        if cached:
            return json_load(cached[0])
        cutoff = market.latest_market_date(date.today().isoformat())
        if cutoff is None:
            return {"state": "unknown", "reason": "暂无本地真实行情", "bars": []}
        best, scanned, valid = None, 0, 0
        for code, bars in market.iter_recent_bars(cutoff, template["target_bars"] + RECENT_WINDOWS - 1):
            scanned += 1
            candidate = best_window(template, bars)
            if candidate is None:
                continue
            valid += 1
            if best is None or candidate["similarity"] > best["similarity"]:
                best = {**candidate, "stock_code": code}
        if market.source_fingerprint() != fingerprint:
            raise ValueError("行情更新中，请稍后重试")
        result = {**(best or {"state": "unknown", "reason": "本地行情没有足够的有效 K 线窗口", "bars": []}),
                  "as_of": cutoff, "scanned_securities": scanned, "valid_securities": valid,
                  "recent_windows": RECENT_WINDOWS, "scope": "本地全部证券，每只最近120个结束窗口，按原始相似度选择"}
        with connect() as connection:
            connection.execute("INSERT OR REPLACE INTO pattern_examples VALUES(?,?)", (key, json_dump(result)))
        return result
