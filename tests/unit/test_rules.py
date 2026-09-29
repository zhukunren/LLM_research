from apps.api.app.rules import combine, evaluate_filter, local_draft, validate_filter


def test_three_value_logic() -> None:
    assert combine("all", ["true", "unknown"]) == "unknown"
    assert combine("all", ["false", "unknown"]) == "false"
    assert combine("any", ["false", "unknown"]) == "unknown"
    assert combine("any", ["true", "unknown"]) == "true"
    assert combine("not", ["unknown"]) == "unknown"


def test_unsupported_code_is_rejected() -> None:
    errors = validate_filter("technical", {"op": "sql", "text": "select 1"})
    assert errors


def test_rule_compares_closing_price_above_sma_with_correct_direction() -> None:
    name, expression, _ = local_draft("technical", "收盘价在 2 日均线上方")
    assert name
    assert expression["operator"] == "lt"
    bars = [{"close": value} for value in [1.0, 2.0, 3.0]]
    result = evaluate_filter(expression, bars)
    assert result["state"] == "true"
    assert result["actual"] == 2.5
    assert result["threshold"] == 3.0


def test_local_ma_cross_draft_is_structured() -> None:
    _, expression, _ = local_draft("technical", "MA5 上穿 MA20")
    assert expression == {"op": "ma_cross", "fast_window": 5, "slow_window": 20, "direction": "up"}


def test_downward_cross_preserves_direction_from_draft_to_execution() -> None:
    _, expression, _ = local_draft("technical", "MA2 下穿 MA4")
    assert expression["direction"] == "down"
    bars = [{"close": float(value)} for value in [2, 3, 4, 5, 1]]
    assert evaluate_filter(expression, bars)["state"] == "true"
    assert evaluate_filter({**expression, "direction": "up"}, bars)["state"] == "false"


def test_macd_natural_language_draft_is_structured() -> None:
    _, expression, _ = local_draft("technical", "MACD 柱大于 0")
    assert expression["indicator"] == "macd_hist"
    assert expression["window"] == 9
    assert expression["operator"] == "gt"


def test_qualitative_report_request_becomes_editable_rubric() -> None:
    _, expression, explanation = local_draft("report", "基本面改善，行业景气度提升，尤其关注订单和毛利率")
    assert expression["evaluation_mode"] == "rubric"
    assert expression["combine"] == "all"
    assert {item["id"] for item in expression["criteria"]} == {"fundamental_improvement", "industry_improvement"}
    assert any("毛利率" in signal or "订单" in signal for item in expression["criteria"] for signal in item["signals"])
    assert "本地通用" in explanation
    assert validate_filter("report", expression) == []
