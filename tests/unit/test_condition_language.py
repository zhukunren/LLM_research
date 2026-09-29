import pytest

from apps.api.app import condition_language as language
from apps.api.app.rules import evaluate_filter, validate_filter


def test_compound_request_keeps_all_atoms_and_boolean_precedence():
    plan = language.compile_plan("收盘价高于20日均线，且近5个交易日涨幅大于3%，或者RSI14小于30")
    assert plan["status"] == "ready"
    assert len(plan["conditions"]) == 3
    assert plan["tree"] == {"op": "any", "children": [
        {"op": "all", "children": [{"op": "condition", "key": "c1"}, {"op": "condition", "key": "c2"}]},
        {"op": "condition", "key": "c3"},
    ]}
    assert plan["conditions"][0]["expression"]["operator"] == "lt"
    assert plan["conditions"][1]["expression"]["value"] == 3


def test_grouping_and_not_preserve_the_entire_group():
    plan = language.compile_plan("收盘价高于20日均线且排除（RSI14大于70或近5个交易日涨幅大于10%）")
    assert plan["status"] == "ready"
    assert plan["tree"]["children"][1]["op"] == "not"
    assert plan["tree"]["children"][1]["children"][0]["op"] == "any"


@pytest.mark.parametrize("prompt", ["市值小于100亿", "连续3天收盘价高于20日均线", "RSI14大于70且市值小于100亿", "最近涨得不错", "收盘价高于20日均线但不能是ST", "最近5天涨幅大于3%", "收盘价刚突破20日均线", "当日成交量大于此前0日均量的2倍", "收盘价高于20日均线且", "排除()"])
def test_local_parser_never_substitutes_or_silently_ignores_unknown_requirements(prompt, monkeypatch):
    monkeypatch.setattr(language, "llm_settings", lambda: {"configured": False})
    plan = language.compile_plan(prompt)
    assert plan["status"] == "needs_clarification"
    assert plan["conditions"] == []
    assert plan["issues"]


def test_model_failure_is_distinct_from_successful_local_interpretation(monkeypatch):
    monkeypatch.setattr(language, "llm_settings", lambda: {"configured": True, "model": "fixture"})
    def broken(*args, **kwargs):
        raise language.ModelRequestError("模拟网络超时")
    monkeypatch.setattr(language, "complete_json", broken)
    plan = language.compile_plan("帮我找强势股")
    assert plan["status"] == "service_error"
    assert plan["conditions"] == []


@pytest.mark.parametrize("mutation", ["unknown_reference", "missing_reference", "extra_field", "fabricated_quote", "duplicate_key", "invalid_expression"])
def test_invalid_model_plans_cannot_be_confirmed(mutation, monkeypatch):
    prompt = "收盘价高于20日均线"
    candidate = language.local_plan(prompt)
    if mutation == "unknown_reference":
        candidate["tree"]["key"] = "c9"
    elif mutation == "missing_reference":
        candidate["tree"] = None
    elif mutation == "extra_field":
        candidate["tree"]["code"] = "print('execute')"
    elif mutation == "fabricated_quote":
        candidate["conditions"][0]["source_quote"] = "市值小于100亿"
    elif mutation == "duplicate_key":
        candidate["conditions"].append(candidate["conditions"][0])
    else:
        candidate["conditions"][0]["expression"]["lookback"] = 100
    monkeypatch.setattr(language, "local_plan", lambda _: None)
    monkeypatch.setattr(language, "llm_settings", lambda: {"configured": True, "model": "fixture"})
    monkeypatch.setattr(language, "complete_json", lambda *a, **k: candidate)
    assert language.compile_plan(prompt)["status"] == "needs_clarification"


def test_partial_model_plan_keeps_unsupported_intent_visible(monkeypatch):
    candidate = language.local_plan("收盘价高于20日均线")
    candidate["issues"] = [{"kind": "unsupported", "text": "没有市值数据", "suggestion": "接入市值来源后才能判断"}]
    monkeypatch.setattr(language, "llm_settings", lambda: {"configured": True, "model": "fixture"})
    monkeypatch.setattr(language, "complete_json", lambda *a, **k: candidate)
    plan = language.compile_plan("收盘价高于20日均线且市值小于100亿")
    assert len(plan["conditions"]) == 1
    assert plan["status"] == "needs_clarification"


@pytest.mark.parametrize("extra", ["而且市值小于100亿", "并排除ST股", "并连续满足三天"])
def test_server_guards_missing_capabilities_even_if_model_omits_issue(extra, monkeypatch):
    candidate = language.local_plan("收盘价高于20日均线")
    monkeypatch.setattr(language, "llm_settings", lambda: {"configured": True, "model": "fixture"})
    monkeypatch.setattr(language, "complete_json", lambda *a, **k: candidate)
    plan = language.compile_plan("收盘价高于20日均线" + extra)
    assert plan["status"] == "needs_clarification"
    assert plan["issues"][0]["kind"] == "unsupported"


def test_return_percentage_uses_n_plus_one_bars_and_volume_excludes_today():
    bars = [{"close": close, "volume": volume, "quality_valid": True} for close, volume in [(10., 100.), (11., 200.), (12., 600.)]]
    result = evaluate_filter({"op": "metric_compare", "metric": "return_pct", "window": 2, "operator": "gt", "value": 15}, bars)
    assert result["state"] == "true"
    assert result["actual"] == pytest.approx(20)
    ratio = evaluate_filter({"op": "metric_compare", "metric": "volume_ratio", "window": 2, "operator": "gt", "value": 3}, bars)
    assert ratio["actual"] == 4
    assert ratio["baseline"] == 150
    assert ratio["state"] == "true"
    assert evaluate_filter({"op": "metric_compare", "metric": "return_pct", "window": 3, "operator": "gt", "value": 0}, bars)["state"] == "unknown"


def test_three_consecutive_volume_days_each_compare_with_their_own_prior_twenty_day_average():
    bars = [{"close": 10., "volume": 100., "quality_valid": True, "trade_date": f"bar-{i:02}"} for i in range(23)]
    bars[-3]["volume"], bars[-2]["volume"], bars[-1]["volume"] = 110., 120., 99.
    expression = {"op": "metric_compare", "metric": "volume_ratio", "window": 20, "operator": "gt", "value": 1, "consecutive_days": 3}
    result = evaluate_filter(expression, bars)
    assert result["state"] == "false"
    assert [item["state"] for item in result["daily_values"]] == ["true", "true", "false"]
    assert [item["baseline"] for item in result["daily_values"]] == pytest.approx([100., 100.5, 101.5])
    assert result["start_date"] == "bar-20" and result["end_date"] == "bar-22"


def test_consecutive_return_windows_shift_once_for_each_completed_trading_day():
    bars = [{"close": 10., "volume": 100., "quality_valid": True, "trade_date": f"bar-{i:02}"} for i in range(8)]
    bars[5]["close"], bars[6]["close"], bars[7]["close"] = 11., 12., 10.
    result = evaluate_filter({"op": "metric_compare", "metric": "return_pct", "window": 5, "operator": "gt", "value": 0, "consecutive_days": 3}, bars)
    assert [item["state"] for item in result["daily_values"]] == ["true", "true", "false"]
    assert result["state"] == "false"


@pytest.mark.parametrize("prompt", ["连续3日成交量>20日均量", "连续3个交易日的成交量大于20日均量", "持续3日成交量大于此前20日均量"])
def test_consecutive_volume_condition_preserves_repeat_count_and_one_times_threshold(prompt):
    plan = language.local_plan(prompt)
    assert plan is not None
    assert plan["conditions"][0]["expression"] == {"op": "metric_compare", "metric": "volume_ratio", "window": 20, "operator": "gt", "value": 1.0, "consecutive_days": 3}
    assert "连续 3 个交易日" in __import__("apps.api.app.condition_contract", fromlist=["describe_filter"]).describe_filter("technical", plan["conditions"][0]["expression"])["summary"]


@pytest.mark.parametrize("problem", ["zero_volume", "bad_bar", "nan", "missing"])
def test_metric_missing_and_bad_data_are_unknown(problem):
    bars = [{"close": 10., "volume": 0., "quality_valid": True}, {"close": 11., "volume": 100., "quality_valid": True}]
    if problem == "bad_bar":
        bars[0]["quality_valid"] = False
    elif problem == "nan":
        bars[0]["volume"] = float("nan")
    elif problem == "missing":
        del bars[0]["volume"]
    result = evaluate_filter({"op": "metric_compare", "metric": "volume_ratio", "window": 1, "operator": "gt", "value": 1}, bars)
    assert result["state"] == "unknown"


@pytest.mark.parametrize("change", [{"window": True}, {"window": 251}, {"metric": []}, {"operator": {}}, {"value": float("inf")}, {"value": True}, {"exec": "bad"}])
def test_metric_validation_rejects_malformed_fields(change):
    assert validate_filter("technical", {"op": "metric_compare", "metric": "return_pct", "window": 5, "operator": "gt", "value": 5, **change})
