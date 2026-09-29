from apps.api.app.indicators import chart_display, values


def test_sma_requires_complete_window() -> None:
    result = values([{"close": value} for value in [1, 2, 3, 4]], "sma", 3)
    assert result == [None, None, 2.0, 3.0]


def test_ema_uses_sma_seed_and_alpha() -> None:
    result = values([{"close": value} for value in [1, 2, 3, 4]], "ema", 3)
    assert result[:2] == [None, None]
    assert result[2:] == [2.0, 3.0]


def test_rsi_flat_series_is_fifty() -> None:
    result = values([{"close": 10.0} for _ in range(5)], "rsi", 2)
    assert result[2:] == [50.0, 50.0, 50.0]


def test_rsi_reseeds_after_an_invalid_bar_window() -> None:
    bars = [{"close": value} for value in [10.0, 11.0, 12.0, 13.0, 9.0, 8.0, 7.0, 6.0]]
    bars[3]["quality_valid"] = False
    result = values(bars, "rsi", 2)
    assert result[2] == 100
    assert result[-1] == 0


def test_bollinger_uses_population_standard_deviation() -> None:
    result = values([{"close": value} for value in [1, 2, 3]], "bollinger", 3)
    assert result[-1] == 2 + 2 * (2 / 3) ** 0.5


def test_invalid_bar_makes_indicator_window_unknown() -> None:
    bars = [
        {"close": 1.0},
        {"close": 2.0, "quality_valid": False},
        {"close": 3.0},
        {"close": 4.0},
    ]
    result = values(bars, "sma", 3)
    assert result[-1] is None


def test_macd_histogram_uses_standard_initialization() -> None:
    bars = [{"close": float(index + 1)} for index in range(40)]
    result = values(bars, "macd_hist", 9)
    assert all(value is None for value in result[:33])
    assert result[33] is not None


def test_kdj_flat_window_uses_fifty_seed_and_atr_uses_full_window() -> None:
    flat = [{"open": 10.0, "high": 10.0, "low": 10.0, "close": 10.0} for _ in range(9)]
    assert values(flat, "kdj_k", 9)[-1] == 50
    assert values(flat, "kdj_d", 9)[-1] == 50
    assert values(flat, "kdj_j", 9)[-1] == 50
    bars = [
        {"high": 2.0, "low": 1.0, "close": 1.5},
        {"high": 3.0, "low": 2.0, "close": 2.5},
    ]
    assert values(bars, "atr", 2)[-1] == 1.25


def test_chart_display_uses_price_overlay_and_complete_sub_indicator_groups() -> None:
    bars = [
        {"open": float(index), "high": float(index + 2), "low": float(index - 1), "close": float(index + 1)}
        for index in range(1, 45)
    ]
    overlay = chart_display(bars, "sma", 5)
    bollinger = chart_display(bars, "bollinger", 5)
    macd = chart_display(bars, "macd_hist", 9)
    kdj = chart_display(bars, "kdj_k", 9)
    assert overlay["placement"] == "overlay"
    assert [line["id"] for line in bollinger["lines"]] == ["bollinger_upper", "bollinger_middle", "bollinger_lower"]
    assert macd["placement"] == "pane"
    assert [line["id"] for line in macd["lines"]] == ["macd_dif", "macd_dea"]
    assert macd["histogram"]["id"] == "macd_hist"
    assert kdj["reference_lines"] == [20, 80]
