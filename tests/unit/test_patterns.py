import base64
from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from apps.api.app.patterns import extract_path, score_window, validate_candles


def candle_template():
    candles = [{"open": float(i + 10), "high": float(i + 13), "low": float(i + 9), "close": float(i + 12)} for i in range(10)]
    return {"target_bars": 10, "representation": "ohlc_sequence", "points": [item["close"] for item in candles], "candlesticks": candles}


def test_candle_match_is_invariant_to_positive_price_scale_and_translation():
    template = candle_template()
    bars = [{**{key: value * 3 + 100 for key, value in candle.items()}, "trade_date": str(index)} for index, candle in enumerate(template["candlesticks"])]
    assert score_window(template, bars)["similarity"] == 100


def test_candle_match_distinguishes_body_direction_and_wicks_with_identical_closes():
    template = candle_template()
    same = [{**candle, "trade_date": str(index)} for index, candle in enumerate(template["candlesticks"])]
    changed = [{**candle, "open": candle["close"] + 1, "high": candle["high"] + 5} for candle in same]
    matching = score_window(template, same)
    opposite = score_window(template, changed)
    assert matching["similarity"] == 100
    assert opposite["similarity"] < 80
    assert opposite["distance_components"]["path"] == 0
    assert opposite["distance_components"]["direction"] == 1
    assert score_window({**template, "algorithm_version": "normalized-path-v1"}, changed)["similarity"] == 100


def test_ohlc_validation_rejects_inconsistent_bar() -> None:
    with pytest.raises(ValueError, match="高低关系"):
        validate_candles([{"open": 10, "high": 9, "low": 8, "close": 9}])


def test_path_match_returns_date_anchored_explanation() -> None:
    bars = [{"trade_date": f"2026-01-{index + 1:02d}", "close": float(index + 1)} for index in range(10)]
    template = {"target_bars": 10, "points": [index / 9 for index in range(10)]}
    result = score_window(template, bars)
    assert result["state"] == "true"
    assert result["similarity"] == 100
    assert result["end_date"] == "2026-01-10"


def test_invalid_bar_in_pattern_window_is_unknown() -> None:
    bars = [{"trade_date": str(index), "close": float(index + 1)} for index in range(10)]
    bars[5]["quality_valid"] = False
    result = score_window({"target_bars": 10, "points": [index / 9 for index in range(10)]}, bars)
    assert result["state"] == "unknown"


def test_v2_path_score_matches_reference_relative_normalization_and_velocity():
    template = {"target_bars": 4, "points": [10, 11, 12, 13], "algorithm_version": "path-window-v2"}
    bars = [{"trade_date": str(index), "close": value} for index, value in enumerate([100, 110, 120, 130])]
    result = score_window(template, bars)
    assert result["similarity"] == 100
    assert result["normalization"] == "first_price_relative_v2"
    assert result["distance_components"]["velocity"] == 0


def test_v2_recent_mode_finds_best_recent_window_without_using_future_data():
    template = {"target_bars": 4, "points": [10, 11, 12, 13], "algorithm_version": "path-window-v2",
                "params": {"match_mode": "recent", "recent_bars": 5}}
    bars = [{"trade_date": str(index), "close": value} for index, value in enumerate([10, 11, 12, 13, 10, 9, 8, 7])]
    current = score_window(template, bars, match_mode="current")
    recent = score_window(template, bars)
    assert current["similarity"] < 50
    assert recent["similarity"] == 100
    assert recent["match_mode"] == "recent"
    assert recent["match_age_bars"] == 4
    assert recent["end_date"] == "3"


def test_v2_recent_mode_keeps_insufficient_history_unknown():
    template = {"target_bars": 4, "points": [1, 2, 3, 4], "algorithm_version": "path-window-v2"}
    bars = [{"trade_date": str(index), "close": float(index)} for index in range(6)]
    result = score_window(template, bars, match_mode="recent", recent_bars=5)
    assert result["state"] == "unknown"
    assert "近期形态回看范围" in result["reason"]


def test_screenshot_extraction_returns_candidate_path() -> None:
    image = Image.new("RGB", (300, 180), "white")
    draw = ImageDraw.Draw(image)
    draw.line([(x, 140 - x // 3) for x in range(10, 290)], fill=(220, 30, 30), width=4)
    stream = BytesIO()
    image.save(stream, format="PNG")
    result = extract_path(base64.b64encode(stream.getvalue()).decode("ascii"), "image/png", {"x": 0, "y": 0, "width": 1, "height": 1})
    assert len(result["points"]) == 60
    assert result["quality"]["horizontal_coverage"] > 0.9
    assert "不提取 OHLC" in result["quality"]["limitations"][2]
