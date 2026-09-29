from __future__ import annotations

import math
from collections.abc import Sequence


INDICATORS = [
    {"id": "sma", "name": "简单移动平均线", "fields": ["close", "volume"], "min_window": 2, "max_window": 250},
    {"id": "ema", "name": "指数移动平均线", "fields": ["close"], "min_window": 2, "max_window": 250},
    {"id": "rsi", "name": "相对强弱指标", "fields": ["close"], "min_window": 2, "max_window": 100},
    {"id": "bollinger", "name": "布林带", "fields": ["close"], "min_window": 2, "max_window": 250},
    {"id": "macd_dif", "name": "MACD DIF", "fields": ["close"], "signal_window": 9, "fast_window": 12, "slow_window": 26},
    {"id": "macd_dea", "name": "MACD DEA", "fields": ["close"], "signal_window": 9, "fast_window": 12, "slow_window": 26},
    {"id": "macd_hist", "name": "MACD 柱值", "fields": ["close"], "signal_window": 9, "fast_window": 12, "slow_window": 26, "histogram_multiplier": 2},
    {"id": "kdj_k", "name": "KDJ K", "fields": ["high", "low", "close"], "default_window": 9},
    {"id": "kdj_d", "name": "KDJ D", "fields": ["high", "low", "close"], "default_window": 9},
    {"id": "kdj_j", "name": "KDJ J", "fields": ["high", "low", "close"], "default_window": 9},
    {"id": "atr", "name": "平均真實波幅", "fields": ["high", "low", "close"], "min_window": 2, "max_window": 100},
]


def _finite(value: float) -> float | None:
    return value if math.isfinite(value) else None


def _ema_series(series: list[float], window: int) -> list[float | None]:
    output: list[float | None] = [None] * len(series)
    alpha = 2 / (window + 1)
    seed: list[float] = []
    average: float | None = None
    for index, value in enumerate(series):
        if not math.isfinite(value):
            seed = []
            average = None
            continue
        if average is None:
            seed.append(value)
            if len(seed) == window:
                average = sum(seed) / window
                output[index] = _finite(average)
                seed = []
        else:
            average = alpha * value + (1 - alpha) * average
            output[index] = _finite(average)
    return output


def values(bars: Sequence[dict], indicator: str, window: int, field: str = "close") -> list[float | None]:
    if window < 2 or window > 250:
        raise ValueError("指标窗口必须在 2 到 250 之间")
    series = [
        float(bar[field]) if bar.get("quality_valid", True) and bar.get(field) is not None else math.nan
        for bar in bars
    ]
    output: list[float | None] = [None] * len(series)
    if indicator == "sma":
        for index in range(window - 1, len(series)):
            span = series[index - window + 1 : index + 1]
            if all(math.isfinite(value) for value in span):
                output[index] = _finite(sum(span) / window)
        return output
    if indicator == "ema":
        return _ema_series(series, window)
    if indicator == "rsi":
        def rsi(gain: float, loss: float) -> float:
            if gain == 0 and loss == 0:
                return 50.0
            if loss == 0:
                return 100.0
            if gain == 0:
                return 0.0
            return 100 - (100 / (1 + gain / loss))
        seed: list[float] = []
        avg_gain: float | None = None
        avg_loss: float | None = None
        for index in range(1, len(series)):
            delta = series[index] - series[index - 1]
            if not math.isfinite(delta):
                seed = []
                avg_gain = avg_loss = None
                continue
            if avg_gain is None or avg_loss is None:
                seed.append(delta)
                if len(seed) < window:
                    continue
                avg_gain = sum(max(value, 0) for value in seed) / window
                avg_loss = sum(max(-value, 0) for value in seed) / window
                seed = []
                output[index] = rsi(avg_gain, avg_loss)
                continue
            avg_gain = (avg_gain * (window - 1) + max(delta, 0)) / window
            avg_loss = (avg_loss * (window - 1) + max(-delta, 0)) / window
            output[index] = _finite(rsi(avg_gain, avg_loss))
        return output
    if indicator == "bollinger":
        for index in range(window - 1, len(series)):
            span = series[index - window + 1 : index + 1]
            if all(math.isfinite(value) for value in span):
                mean = sum(span) / window
                variance = sum((value - mean) ** 2 for value in span) / window
                output[index] = _finite(mean + 2 * math.sqrt(variance))
        return output
    if indicator in {"macd_dif", "macd_dea", "macd_hist"}:
        fast = values(bars, "ema", 12, field)
        slow = values(bars, "ema", 26, field)
        dif = [a - b if a is not None and b is not None else None for a, b in zip(fast, slow)]
        if indicator == "macd_dif":
            return dif
        dea = _ema_series([value if value is not None else math.nan for value in dif], 9)
        if indicator == "macd_dea":
            return dea
        return [2 * (a - b) if a is not None and b is not None else None for a, b in zip(dif, dea)]
    if indicator in {"kdj_k", "kdj_d", "kdj_j"}:
        if window < 2 or window > 100:
            raise ValueError("KDJ 窗口必须在 2 到 100 之间")
        highs = [float(bar["high"]) if bar.get("quality_valid", True) and bar.get("high") is not None else math.nan for bar in bars]
        lows = [float(bar["low"]) if bar.get("quality_valid", True) and bar.get("low") is not None else math.nan for bar in bars]
        closes = [float(bar["close"]) if bar.get("quality_valid", True) and bar.get("close") is not None else math.nan for bar in bars]
        k_values: list[float | None] = [None] * len(bars)
        d_values: list[float | None] = [None] * len(bars)
        j_values: list[float | None] = [None] * len(bars)
        previous_k: float | None = 50.0
        previous_d: float | None = 50.0
        for index in range(len(bars)):
            start = index - window + 1
            if start < 0:
                continue
            span_high = highs[start : index + 1]
            span_low = lows[start : index + 1]
            if not math.isfinite(closes[index]) or not all(math.isfinite(value) for value in span_high + span_low):
                previous_k = previous_d = None
                continue
            if previous_k is None or previous_d is None:
                previous_k = previous_d = 50.0
            highest, lowest = max(span_high), min(span_low)
            rsv = 50.0 if highest == lowest else (closes[index] - lowest) / (highest - lowest) * 100
            current_k = (2 * previous_k + rsv) / 3
            current_d = (2 * previous_d + current_k) / 3
            current_j = 3 * current_k - 2 * current_d
            k_values[index], d_values[index], j_values[index] = current_k, current_d, current_j
            previous_k, previous_d = current_k, current_d
        return {"kdj_k": k_values, "kdj_d": d_values, "kdj_j": j_values}[indicator]
    if indicator == "atr":
        if window < 2 or window > 100:
            raise ValueError("ATR 窗口必须在 2 到 100 之间")
        true_ranges = [math.nan] * len(bars)
        for index, bar in enumerate(bars):
            if not bar.get("quality_valid", True):
                continue
            high, low = float(bar["high"]), float(bar["low"])
            if index == 0 or not bars[index - 1].get("quality_valid", True):
                true_ranges[index] = high - low
            else:
                previous_close = float(bars[index - 1]["close"])
                true_ranges[index] = max(high - low, abs(high - previous_close), abs(low - previous_close))
        run: list[float] = []
        average: float | None = None
        for index, true_range in enumerate(true_ranges):
            if not math.isfinite(true_range):
                run = []
                average = None
                continue
            if average is None:
                run.append(true_range)
                if len(run) == window:
                    average = sum(run) / window
                    output[index] = _finite(average)
            else:
                average = (average * (window - 1) + true_range) / window
                output[index] = _finite(average)
        return output
    raise ValueError("不支持的指标")


def _line(identifier: str, label: str, series: list[float | None], color: str) -> dict:
    return {"id": identifier, "label": label, "values": series, "color": color}


def _bollinger_lines(bars: Sequence[dict], window: int, field: str) -> list[dict]:
    source = [
        float(bar[field]) if bar.get("quality_valid", True) and bar.get(field) is not None else math.nan
        for bar in bars
    ]
    upper: list[float | None] = [None] * len(source)
    middle: list[float | None] = [None] * len(source)
    lower: list[float | None] = [None] * len(source)
    for index in range(window - 1, len(source)):
        span = source[index - window + 1:index + 1]
        if all(math.isfinite(value) for value in span):
            average = sum(span) / window
            deviation = math.sqrt(sum((value - average) ** 2 for value in span) / window)
            middle[index] = _finite(average)
            upper[index] = _finite(average + 2 * deviation)
            lower[index] = _finite(average - 2 * deviation)
    return [
        _line("bollinger_upper", "上轨", upper, "#b5793b"),
        _line("bollinger_middle", "中轨", middle, "#4c7eb1"),
        _line("bollinger_lower", "下轨", lower, "#b5793b"),
    ]


def chart_display(bars: Sequence[dict], indicator: str, window: int, field: str = "close") -> dict:
    """Return the complete indicator group and whether it belongs on price or a sub-pane."""
    if indicator == "sma":
        return {"placement": "overlay", "lines": [_line("sma", f"SMA {window}", values(bars, indicator, window, field), "#d66755")], "histogram": None, "reference_lines": []}
    if indicator == "ema":
        return {"placement": "overlay", "lines": [_line("ema", f"EMA {window}", values(bars, indicator, window, field), "#4c7eb1")], "histogram": None, "reference_lines": []}
    if indicator == "bollinger":
        return {"placement": "overlay", "lines": _bollinger_lines(bars, window, field), "histogram": None, "reference_lines": []}
    if indicator in {"macd_dif", "macd_dea", "macd_hist"}:
        return {"placement": "pane", "lines": [
            _line("macd_dif", "DIF", values(bars, "macd_dif", 9, field), "#d66755"),
            _line("macd_dea", "DEA", values(bars, "macd_dea", 9, field), "#4c7eb1"),
        ], "histogram": _line("macd_hist", "MACD", values(bars, "macd_hist", 9, field), "#6fa274"), "reference_lines": [0]}
    if indicator in {"kdj_k", "kdj_d", "kdj_j"}:
        return {"placement": "pane", "lines": [
            _line("kdj_k", "K", values(bars, "kdj_k", window, field), "#d66755"),
            _line("kdj_d", "D", values(bars, "kdj_d", window, field), "#4c7eb1"),
            _line("kdj_j", "J", values(bars, "kdj_j", window, field), "#7b62a3"),
        ], "histogram": None, "reference_lines": [20, 80]}
    if indicator == "rsi":
        return {"placement": "pane", "lines": [_line("rsi", f"RSI {window}", values(bars, indicator, window, field), "#7b62a3")], "histogram": None, "reference_lines": [30, 70]}
    if indicator == "atr":
        return {"placement": "pane", "lines": [_line("atr", f"ATR {window}", values(bars, indicator, window, field), "#b5793b")], "histogram": None, "reference_lines": [0]}
    raise ValueError("不支持的指标")


def compare(left: float | None, operator: str, right: float | None) -> str:
    if left is None or right is None:
        return "unknown"
    if operator == "gt":
        return "true" if left > right else "false"
    if operator == "gte":
        return "true" if left >= right else "false"
    if operator == "lt":
        return "true" if left < right else "false"
    if operator == "lte":
        return "true" if left <= right else "false"
    if operator == "eq":
        return "true" if left == right else "false"
    raise ValueError("不支持的比较方式")
