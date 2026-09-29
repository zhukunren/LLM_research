from __future__ import annotations

import base64
import binascii
import math
import os
import re
import tempfile
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .settings import PATTERN_UPLOAD_DIR


MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000


def _decode_image(payload: str, mime_type: str) -> np.ndarray:
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("图片编码无效") from exc
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("图片超过 10 MB 限制")
    signatures = {
        "image/png": raw.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": raw.startswith(b"\xff\xd8\xff"),
        "image/webp": len(raw) > 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP",
    }
    if not signatures.get(mime_type, False):
        raise ValueError("图片实际格式与声明类型不一致")
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("图片无法解码")
    height, width = image.shape[:2]
    if width < 100 or height < 80 or width * height > MAX_IMAGE_PIXELS:
        raise ValueError("图片尺寸不在支持范围内")
    return image


def store_source_image(payload: str, mime_type: str, filename: str | None) -> dict[str, str]:
    image = _decode_image(payload, mime_type)
    raw = base64.b64decode(payload, validate=True)
    digest = __import__("hashlib").sha256(raw).hexdigest()
    extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[mime_type]
    PATTERN_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    target = PATTERN_UPLOAD_DIR / f"{digest}{extension}"
    if not target.exists():
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=PATTERN_UPLOAD_DIR, delete=False, suffix=".tmp") as stream:
                temporary = Path(stream.name)
                stream.write(raw)
            os.replace(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    safe_name = re.sub(r"[^\w .()（）_-]", "_", Path((filename or "pattern.png").replace("\\", "/")).name).strip(" .")[:160]
    return {
        "sha256": digest,
        "mime_type": mime_type,
        "filename": safe_name or f"pattern{extension}",
        "extension": extension,
        "width": str(image.shape[1]),
        "height": str(image.shape[0]),
    }


def extract_path(payload: str, mime_type: str, crop: dict[str, float]) -> dict[str, Any]:
    image = _decode_image(payload, mime_type)
    x, y = crop.get("x", 0), crop.get("y", 0)
    width, height = crop.get("width", 1), crop.get("height", 1)
    if not all(math.isfinite(value) for value in (x, y, width, height)) or width <= 0 or height <= 0:
        raise ValueError("裁剪区域无效")
    x0 = max(0, min(image.shape[1] - 1, int(x * image.shape[1])))
    y0 = max(0, min(image.shape[0] - 1, int(y * image.shape[0])))
    x1 = max(x0 + 1, min(image.shape[1], int((x + width) * image.shape[1])))
    y1 = max(y0 + 1, min(image.shape[0], int((y + height) * image.shape[0])))
    roi = image[y0:y1, x0:x1]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]
    value = hsv[:, :, 2]
    mask = (saturation > 45) & (value > 35) & (value < 250)
    counts = mask.sum(axis=0)
    active = counts > 0
    coverage = float(active.mean())
    if coverage < 0.15:
        raise ValueError("裁剪区域内没有足够的彩色图表轨迹，请收紧裁剪框或改用手绘")
    ys = np.full(mask.shape[1], np.nan, dtype=np.float64)
    for column in np.flatnonzero(active):
        ys[column] = float(np.median(np.flatnonzero(mask[:, column])))
    known = np.flatnonzero(np.isfinite(ys))
    xs = np.arange(mask.shape[1])
    ys = np.interp(xs, known, ys[known])
    normalized = 1 - ys / max(1, mask.shape[0] - 1)
    points = np.interp(np.linspace(0, len(normalized) - 1, 60), xs, normalized).tolist()
    smooth = cv2.GaussianBlur(np.asarray(points, dtype=np.float32).reshape(1, -1), (1, 0), 0.8).flatten().tolist()
    confidence = round(max(0.0, min(1.0, coverage * min(1.0, 0.5 + known.size / 120))), 3)
    return {
        "representation": "price_path",
        "points": [round(float(point), 5) for point in smooth],
        "target_bars": 60,
        "quality": {
            "confidence": confidence,
            "horizontal_coverage": round(coverage, 3),
            "identified": "colored_trace_candidate",
            "requires_manual_review": confidence < 0.9,
            "limitations": ["仅提取彩色走势候选线", "不恢复真实价格、时间轴或证券代码", "不提取 OHLC 蜡烛数据"],
            "algorithm_version": "screenshot-path-1",
        },
    }


def validate_candles(candles: list[dict[str, float]]) -> None:
    for index, candle in enumerate(candles):
        if not all(key in candle and math.isfinite(candle[key]) for key in ("open", "high", "low", "close")):
            raise ValueError(f"第 {index + 1} 根蜡烛缺少有效 OHLC")
        if candle["high"] < max(candle["open"], candle["close"]) or candle["low"] > min(candle["open"], candle["close"]):
            raise ValueError(f"第 {index + 1} 根蜡烛不满足 OHLC 高低关系")


def normalize_path(points: list[float]) -> list[float]:
    if len(points) < 2:
        raise ValueError("形态至少需要两个点")
    low, high = min(points), max(points)
    if high - low < 1e-9:
        return [0.5] * len(points)
    return [(point - low) / (high - low) for point in points]


def _resample(values: np.ndarray, count: int) -> np.ndarray:
    if len(values) == count:
        return values.astype(float, copy=False)
    positions = np.linspace(0, len(values) - 1, count)
    left = np.floor(positions).astype(int)
    right = np.minimum(left + 1, len(values) - 1)
    weight = positions - left
    return values[left] * (1.0 - weight) + values[right] * weight


def _relative_path(values: np.ndarray) -> np.ndarray:
    """Reference K-line project normalization: first price is the zero point."""
    values = np.asarray(values, dtype=float)
    return (values - values[0]) / max(float(np.ptp(values)), 1e-8)


def _display_pair(left: np.ndarray, right: np.ndarray) -> tuple[list[float], list[float]]:
    low = min(float(np.min(left)), float(np.min(right)))
    span = max(float(np.max(left)), float(np.max(right))) - low
    span = max(span, 1e-8)
    return ((left - low) / span).round(5).tolist(), ((right - low) / span).round(5).tolist()


def _base_result(
    *, window: list[dict[str, Any]], actual: np.ndarray, expected: np.ndarray,
    score: float, path_distance: float, velocity_distance: float,
    algorithm: str, match_mode: str, match_age_bars: int, priority_score: float,
    components: dict[str, float] | None = None,
) -> dict[str, Any]:
    display_actual, display_expected = _display_pair(actual, expected)
    result = {
        "state": "true", "similarity": round(float(score), 2),
        "path_error": round(float(path_distance), 6),
        "start_date": window[0]["trade_date"], "end_date": window[-1]["trade_date"],
        "candidate_points": display_actual, "template_points": display_expected,
        "algorithm_version": algorithm, "match_mode": match_mode,
        "match_age_bars": match_age_bars, "is_current": match_age_bars == 0,
        "priority_score": round(float(priority_score), 2),
        "distance_components": {"path": round(float(path_distance), 6), "velocity": round(float(velocity_distance), 6), **(components or {})},
        "normalization": "first_price_relative_v2",
        "interpretation": "形态相似度仅描述价格路径和K线结构接近程度，不代表上涨概率或收益预测",
    }
    return result


def _score_window_v1(template: dict[str, Any], bars: list[dict[str, Any]]) -> dict[str, Any]:
    count = int(template["target_bars"])
    if len(bars) < count:
        return {"state": "unknown", "reason": "可用行情不足以覆盖形态窗口"}
    window = bars[-count:]
    if any(not bar.get("quality_valid", True) for bar in window):
        return {"state": "unknown", "reason": "形态窗口包含行情质量异常 bar"}
    closes = [float(bar["close"]) for bar in window]
    if any(not math.isfinite(value) for value in closes):
        return {"state": "unknown", "reason": "形态窗口存在缺失收盘价"}
    actual = normalize_path(closes)
    expected = normalize_path([float(value) for value in template["points"]])
    expected_x = np.linspace(0, 1, len(expected))
    actual_x = np.linspace(0, 1, len(actual))
    expected_resampled = np.interp(actual_x, expected_x, expected)
    path_error = float(np.mean(np.abs(np.asarray(expected_resampled) - np.asarray(actual))))
    expected_delta = np.diff(expected_resampled)
    actual_delta = np.diff(actual)
    slope_error = float(np.mean(np.abs(expected_delta - actual_delta))) if len(expected_delta) else 0.0
    error = 0.8 * path_error + 0.2 * min(1.0, slope_error)
    components = {"path": round(error, 5)}
    algorithm = "normalized-path-v1"
    if template.get("representation") == "ohlc_sequence" and template.get("algorithm_version") != "normalized-path-v1":
        expected_candles = template.get("candlesticks", [])
        if len(expected_candles) != count:
            return {"state": "unknown", "reason": "蜡烛模板数量与匹配窗口不一致"}
        try:
            validate_candles(expected_candles)
            validate_candles(window)
            expected_features = _candle_features(expected_candles)
            actual_features = _candle_features(window)
        except (ValueError, TypeError, KeyError):
            return {"state": "unknown", "reason": "蜡烛模板或行情缺少有效 OHLC"}
        body = float(np.mean(np.abs(expected_features[0] - actual_features[0]))) / 2
        wicks = float(np.mean(np.abs(expected_features[1] - actual_features[1])))
        direction = float(np.mean(expected_features[2] != actual_features[2]))
        gap = float(np.mean(np.abs(expected_features[3] - actual_features[3]))) / 2
        components.update(body=round(body, 5), wicks=round(wicks, 5), direction=round(direction, 5), gap=round(gap, 5))
        error = 0.40 * error + 0.20 * body + 0.20 * wicks + 0.15 * direction + 0.05 * gap
        algorithm = "normalized-candles-v1"
    return {
        "state": "true",
        "similarity": round(100 * max(0.0, 1.0 - error), 2),
        "path_error": round(path_error, 5),
        "start_date": window[0]["trade_date"],
        "end_date": window[-1]["trade_date"],
        "candidate_points": [round(value, 5) for value in actual],
        "template_points": [round(float(value), 5) for value in expected_resampled],
        "algorithm_version": algorithm,
        "distance_components": components,
        "candidate_candlesticks": [{key: bar[key] for key in ("open", "high", "low", "close")} for bar in window] if algorithm == "normalized-candles-v1" else [],
        "interpretation": "形态相似度仅描述归一化路径接近程度，不代表上涨概率或收益预测",
    }


def _score_window_v2(
    template: dict[str, Any], bars: list[dict[str, Any]], *, match_mode: str, recent_bars: int,
) -> dict[str, Any]:
    count = int(template["target_bars"])
    if len(bars) < count:
        return {"state": "unknown", "reason": "可用行情不足以覆盖形态窗口"}
    if match_mode == "recent" and len(bars) < count + recent_bars - 1:
        return {"state": "unknown", "reason": "可用行情不足以覆盖近期形态回看范围"}
    expected_raw = np.asarray([float(value) for value in template["points"]], dtype=float)
    if not np.all(np.isfinite(expected_raw)) or len(expected_raw) < 2:
        return {"state": "unknown", "reason": "形态模板缺少有效走势点"}
    expected = _relative_path(_resample(expected_raw, count))
    final_start = len(bars) - count
    if match_mode == "current":
        starts = [final_start]
    else:
        first_start = max(0, final_start - recent_bars + 1)
        starts = range(first_start, final_start + 1)
    best: tuple[float, int, np.ndarray, float, float, dict[str, float]] | None = None
    for start in starts:
        window = bars[start:start + count]
        if len(window) != count or any(not item.get("quality_valid", True) for item in window):
            continue
        try:
            closes = np.asarray([float(item["close"]) for item in window], dtype=float)
        except (TypeError, ValueError, KeyError):
            continue
        if not np.all(np.isfinite(closes)):
            continue
        actual = _relative_path(closes)
        path_distance = float(np.mean((actual - expected) ** 2))
        velocity_distance = float(np.mean((np.diff(actual) - np.diff(expected)) ** 2)) if count > 1 else 0.0
        distance = path_distance * 0.78 + velocity_distance * 0.22
        components: dict[str, float] = {}
        if template.get("representation") == "ohlc_sequence" and template.get("candlesticks"):
            try:
                validate_candles(template["candlesticks"])
                validate_candles(window)
                expected_features = _candle_features(template["candlesticks"])
                actual_features = _candle_features(window)
            except (ValueError, TypeError, KeyError):
                continue
            body = float(np.mean((expected_features[0] - actual_features[0]) ** 2)) / 2
            wicks = float(np.mean((expected_features[1] - actual_features[1]) ** 2))
            direction = float(np.mean(expected_features[2] != actual_features[2]))
            gap = float(np.mean((expected_features[3] - actual_features[3]) ** 2)) / 2
            components = {"body": body, "wicks": wicks, "direction": direction, "gap": gap}
            distance += body * 0.20 + wicks * 0.20 + direction * 0.15 + gap * 0.05
        score = 100.0 * math.exp(-distance * 6.2)
        age = final_start - start
        priority = score if match_mode == "current" else score * (0.65 + 0.35 * math.exp(-age / max(1.0, recent_bars * 0.45)))
        if best is None or priority > best[0]:
            best = (priority, start, actual, path_distance, velocity_distance, components)
    if best is None:
        return {"state": "unknown", "reason": "候选形态窗口包含缺失或质量异常行情"}
    priority, start, actual, path_distance, velocity_distance, components = best
    window = bars[start:start + count]
    age = final_start - start
    result = _base_result(
        window=window, actual=actual, expected=expected,
        score=100.0 * math.exp(-(
            path_distance * 0.78 + velocity_distance * 0.22
            + components.get("body", 0) * 0.20 + components.get("wicks", 0) * 0.20
            + components.get("direction", 0) * 0.15 + components.get("gap", 0) * 0.05
        ) * 6.2),
        path_distance=path_distance, velocity_distance=velocity_distance,
        algorithm="candle-window-v2" if template.get("representation") == "ohlc_sequence" else "path-window-v2",
        match_mode=match_mode, match_age_bars=age, priority_score=priority, components=components,
    )
    if template.get("representation") == "ohlc_sequence":
        result["candidate_candlesticks"] = [{key: item[key] for key in ("open", "high", "low", "close")} for item in window]
    else:
        result["candidate_candlesticks"] = []
    return result


def score_window(
    template: dict[str, Any], bars: list[dict[str, Any]], *,
    match_mode: str | None = None, recent_bars: int | None = None,
) -> dict[str, Any]:
    """Compare the current or most-recent window without looking beyond the screening cutoff."""
    params = template.get("params") if isinstance(template.get("params"), dict) else {}
    mode = match_mode or params.get("match_mode", "current")
    mode = mode if mode in {"current", "recent"} else "current"
    requested_recent = recent_bars if recent_bars is not None else params.get("recent_bars", 20)
    try:
        lookback = int(requested_recent)
    except (TypeError, ValueError):
        lookback = 20
    lookback = max(1, min(120, lookback))
    if template.get("algorithm_version") in {"path-window-v2", "candle-window-v2"}:
        return _score_window_v2(template, bars, match_mode=mode, recent_bars=lookback)
    return _score_window_v1(template, bars)


def _candle_features(candles: list[dict[str, float]]) -> tuple[np.ndarray, ...]:
    opened = np.asarray([item["open"] for item in candles], dtype=float)
    high = np.asarray([item["high"] for item in candles], dtype=float)
    low = np.asarray([item["low"] for item in candles], dtype=float)
    closed = np.asarray([item["close"] for item in candles], dtype=float)
    ranges = high - low
    scale = max(float(np.max(ranges)), float(np.max(high) - np.min(low)), 1e-12)
    denominator = np.where(ranges > scale * 1e-9, ranges, 1.0)
    body = (closed - opened) / denominator
    wicks = np.column_stack(((high - np.maximum(opened, closed)) / denominator, (np.minimum(opened, closed) - low) / denominator))
    direction = np.where(np.abs(closed - opened) <= scale * 1e-9, 0, np.sign(closed - opened))
    gaps = np.tanh((opened[1:] - closed[:-1]) / max(float(np.mean(ranges)), scale * 1e-9))
    return body, wicks, direction, gaps
