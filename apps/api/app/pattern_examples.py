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


def _market_origin(template: dict) -> dict:
    # Derived geometry remains custom, but its known source still constrains
    # source exclusion and historical timing. Never replace the target points.
    derivation = template.get("derivation") or {}
    inherited = derivation.get("market_source") if derivation.get("origin_type") == "market_window" else None
    return template.get("market_source") or inherited or {}


def template_timing(template: dict, as_of: str) -> tuple[str, str]:
    source = _market_origin(template)
    end = source.get("end_date")
    if end and end > as_of:
        return "post_hoc", "事后构造：模板来源区间晚于检索截止日，不能作为该日已知的研究假设。"
    if end:
        return "verified", "仅核验模板来源行情区间不晚于截止日；不能证明当时已提出该研究假设，也不保证不存在其他前视偏差。"
    return "unknown", "模板可用时点未知：手绘、截图或文字无法证明在历史截止日已知，请勿视为无前视偏差的历史验证。"


def find_example(template: dict, limit: int = 1, as_of: str | None = None) -> dict:
    if type(limit) is not int or not 1 <= limit <= MAX_EXAMPLES:
        raise ValueError(f"样本数量应在1至{MAX_EXAMPLES}之间")
    requested = as_of or date.today().isoformat()
    try:
        requested_date = date.fromisoformat(requested)
    except (TypeError, ValueError) as exc:
        raise ValueError("截止日必须为 YYYY-MM-DD") from exc
    if requested_date > date.today():
        raise ValueError("截止日不能晚于今天")
    requested = requested_date.isoformat()
    timing, warning = template_timing(template, requested)
    fingerprint = market.source_fingerprint()
    metadata = {"requested_as_of": requested, "template_timing": timing, "timing_warning": warning,
                "source_fingerprint": hashlib.sha256(json_dump(fingerprint).encode()).hexdigest() if fingerprint else None,
                "price_basis": market.PRICE_BASIS, "frequency": "daily", "scanned_securities": 0, "valid_securities": 0,
                "as_of": None, "recent_windows": RECENT_WINDOWS,
                "scope": "本地全部证券，每只最近120个结束窗口；每家公司取最相近区间，按原始相似度排序"
                         + ("；已排除来源股票" if _market_origin(template).get("stock_code") else "")}
    if fingerprint is None:
        return {**metadata, "state": "unknown", "reason": "暂无本地真实行情", "bars": [], "items": []}
    cutoff = market.latest_market_date(requested)
    if cutoff is None:
        return {**metadata, "state": "unknown", "reason": "暂无本地真实行情", "bars": [], "items": []}
    cutoff = min(cutoff, requested)
    key = hashlib.sha256(json_dump({"template": template, "source": fingerprint, "as_of": cutoff, "windows": RECENT_WINDOWS, "algorithm": "ranked-best-v3-metadata", "max_examples": MAX_EXAMPLES}).encode()).hexdigest()
    with _scan_lock:
        with connect() as connection:
            cached = connection.execute("SELECT result_json FROM pattern_examples WHERE cache_key=?", (key,)).fetchone()
        if cached:
            result = json_load(cached[0])
            return {**result, "requested_as_of": requested, "template_timing": timing, "timing_warning": warning, "items": result["items"][:limit]}
        ranked, scanned, valid = [], 0, 0
        source_code = _market_origin(template).get("stock_code")
        for code, bars in market.iter_recent_bars(cutoff, template["target_bars"] + RECENT_WINDOWS - 1):
            if code == source_code:
                continue
            scanned += 1
            # Defense in depth: never trust a source adapter to honor the cutoff.
            bars = [bar for bar in bars if bar["trade_date"] <= cutoff]
            candidate = best_window(template, bars)
            if candidate is None:
                continue
            valid += 1
            age = sum(bar["trade_date"] > candidate["end_date"] for bar in bars)
            candidate = {**candidate, "match_age_bars": age, "is_current": candidate["end_date"] == cutoff,
                         "end_lag_days": (date.fromisoformat(cutoff) - date.fromisoformat(candidate["end_date"])).days,
                         "age_basis": "距截止日在该证券已载入行情中的观测根数；停牌/缺失不折算为交易日"}
            entry = (candidate["similarity"], candidate["end_date"], code, {**candidate, "stock_code": code})
            if len(ranked) < MAX_EXAMPLES:
                heapq.heappush(ranked, entry)
            elif entry[:3] > ranked[0][:3]:
                heapq.heapreplace(ranked, entry)
        if market.source_fingerprint() != fingerprint:
            raise ValueError("行情更新中，请稍后重试")
        items = [entry[3] for entry in sorted(ranked, key=lambda entry: entry[:3], reverse=True)]
        result = {**metadata, **(items[0] if items else {"state": "unknown", "reason": "本地行情没有足够的有效 K 线窗口", "bars": []}),
                  "items": items,
                  "as_of": cutoff, "scanned_securities": scanned, "valid_securities": valid,
                  "recent_windows": RECENT_WINDOWS, "scope": "本地全部证券，每只最近120个结束窗口；每家公司取最相近区间，按原始相似度排序" + ("；已排除来源股票" if source_code else "")}
        with connect() as connection:
            connection.execute("INSERT OR REPLACE INTO pattern_examples VALUES(?,?)", (key, json_dump(result)))
        return {**result, "items": items[:limit]}
