from copy import deepcopy
from datetime import datetime

import pytest
from pydantic import ValidationError

from apps.api.app import closing_review
from apps.api.app.advisor_contracts import AdvisorReport
from apps.api.app.closing_review import ClosingEvent, ClosingTurnover


EVENT_COPY = "活动安排在北京时间10月21日17:00，为A股收盘后，具体发布内容需届时核对。"
CLIENT_COPY = "盘面回顾：沪深两市成交额约1.46万亿元，较前一交易日增加约186亿元，上涨个股超过3700只。\n热点板块：科技方向较活跃，具体表现仍有分化。\n明日观察：先看成交与上涨股票数量是否继续增加。" + EVENT_COPY + "市场有风险，投资需谨慎。"


def report_data():
    return {"stock_code": None, "verdict": "review", "conclusion": "指数与个股表现不完全一致，需要继续观察成交。", "effective_date": "2026-10-20", "session_status": "closed",
            "supporting_points": [], "contrary_points": [], "risks": ["板块可能快速轮动"], "invalidation_conditions": ["成交与上涨家数同时回落"],
            "action_conditions": ["观察成交与多数股票能否同步改善"], "suitability": "用于普通客户市场资讯交流", "client_copy": CLIENT_COPY,
            "full_copy": CLIENT_COPY + "统计范围与来源差异保留在内部记录中。",
            "closing_review": {"turnover": {"market_scope": "SH_SZ", "amount_yi": 14561.12, "evidence_keys": ["market-close"],
                "comparison": {"market_scope": "SH_SZ", "change_yi": 185.95, "evidence_keys": ["market-close"]}},
                "events": [{"title": "产业活动主题演讲", "evidence_keys": ["industry-event"], "local_start": "2026-10-21T11:00:00+02:00",
                            "source_timezone": "Europe/Berlin", "client_copy_excerpt": EVENT_COPY}], "scope_notes": "上涨家数采用公开收盘报道样本；客户稿使用约数。"}}


def evidence_items():
    return [{"event_key": "market-close", "event_date": "2026-10-20", "analysis_dimension": "market",
             "evidence": [{"quote": "沪深两市成交额14561.12亿元，较上一交易日增加185.95亿元。"}]},
            {"event_key": "industry-event", "event_date": "2026-10-21", "analysis_dimension": "catalyst",
             "evidence": [{"quote": "Wednesday, October 21, 11 a.m.–1 p.m. CEST. Keynote at the Berlin conference."}]}]


def review_result(data=None, items=None, level="basic"):
    report = AdvisorReport.model_validate(data or report_data())
    result = closing_review.validate(report, items if items is not None else evidence_items(), closing_review.policy_snapshot(), "client", level=level)
    return report, result


def validate(data=None, items=None, level="basic"):
    report, result = review_result(data, items, level)
    if result.errors:
        raise ValueError("\n".join(result.errors))
    return report


def test_turnover_rounding_and_beijing_time_are_consistent():
    report = validate()
    event = report.closing_review.events[0]
    assert event.beijing_start.isoformat() == "2026-10-21T17:00:00+08:00"
    assert event.session_relation == "after_close"


def test_comparison_cannot_mix_two_and_three_exchange_universes():
    data = report_data()["closing_review"]["turnover"]
    data["comparison"]["market_scope"] = "SH_SZ_BJ"
    with pytest.raises(ValidationError, match="同一行情统计口径"):
        ClosingTurnover.model_validate(data)


def test_delta_direction_is_checked_against_the_source_and_unchanged_is_allowed():
    data = report_data()
    data["closing_review"]["turnover"]["comparison"]["change_yi"] = -185.95
    data["client_copy"] = CLIENT_COPY.replace("增加约186亿元", "减少约186亿元")
    with pytest.raises(ValueError, match="变化方向"):
        validate(data)
    data["closing_review"]["turnover"]["comparison"]["change_yi"] = 0
    data["client_copy"] = CLIENT_COPY.replace("增加约186亿元", "持平")
    items = evidence_items()
    items[0]["evidence"][0]["quote"] = "沪深两市成交额14561.12亿元，较上一交易日持平。"
    validate(data, items)


@pytest.mark.parametrize("level", ["basic", "strict", "off"])
@pytest.mark.parametrize(("old", "new", "message"), [
    ("1.46万亿元", "1.47万亿元", "金额不一致"),
    ("1.46万亿元", "1.46亿元", "金额不一致"),
    ("增加约186亿元", "增加约227亿元", "比较不一致"),
    ("沪深两市成交额", "沪深京三市成交额", "标注沪深两市"),
])
def test_client_copy_blocks_factual_errors_in_every_mode(old, new, message, level):
    data = report_data()
    data["client_copy"] = data["client_copy"].replace(old, new)
    with pytest.raises(ValueError, match=message):
        validate(data, level=level)


@pytest.mark.parametrize("quote", [
    "全市场成交额14561.12亿元，较上一交易日增加185.95亿元。",
    "沪深京三市成交额14561.12亿元，较上一交易日增加185.95亿元。",
    "沪深两市成交额14715亿元，较上一交易日增加227亿元。",
])
def test_turnover_must_be_supported_by_a_quote_with_the_declared_universe(quote):
    items = evidence_items()
    items[0]["evidence"][0]["quote"] = quote
    with pytest.raises(ValueError, match="统计范围|未支持"):
        validate(items=items)


def test_explicit_three_exchange_fallback_is_valid():
    data, items = report_data(), evidence_items()
    turnover = data["closing_review"]["turnover"]
    turnover.update(market_scope="SH_SZ_BJ", amount_yi=14715)
    turnover["comparison"].update(market_scope="SH_SZ_BJ", change_yi=227)
    data["client_copy"] = CLIENT_COPY.replace("沪深两市", "沪深京三市").replace("1.46万亿元", "1.47万亿元").replace("186亿元", "227亿元")
    items[0]["evidence"][0]["quote"] = "沪深京三市成交额14715亿元，较上一交易日增加227亿元。"
    validate(data, items)


def test_a_reported_threshold_cannot_be_used_as_a_precise_turnover_total():
    data, items = report_data(), evidence_items()
    data["closing_review"]["turnover"].update(amount_yi=14000, comparison=None)
    data["client_copy"] = CLIENT_COPY.replace("1.46万亿元", "1.4万亿元").replace("，较前一交易日增加约186亿元", "")
    items[0]["evidence"][0]["quote"] = "沪深两市成交额超过1.4万亿元，上涨个股超过3700只。"
    with pytest.raises(ValueError, match="未支持所记录"):
        validate(data, items)


def test_unbound_or_old_market_references_cannot_support_turnover():
    for change in ({"event_key": "another-run"}, {"event_date": "2026-10-19"}, {"analysis_dimension": "catalyst"}):
        items = evidence_items()
        items[0].update(change)
        with pytest.raises(ValueError, match="不属于|所选交易日"):
            validate(items=items)


@pytest.mark.parametrize(("local", "zone", "beijing", "slot"), [
    ("2026-10-21T11:00:00+02:00", "Europe/Berlin", "2026-10-21T17:00:00+08:00", "after_close"),
    ("2026-11-20T11:00:00+01:00", "Europe/Berlin", "2026-11-20T18:00:00+08:00", "after_close"),
    ("2026-10-21T17:00:00-04:00", "America/New_York", "2026-10-22T05:00:00+08:00", "before_open"),
    ("2026-10-21T03:30:00+00:00", "UTC", "2026-10-21T11:30:00+08:00", "midday_break"),
    ("2026-10-21T07:00:00+00:00", "UTC", "2026-10-21T15:00:00+08:00", "after_close"),
])
def test_event_conversion_uses_date_offset_and_trading_clock(local, zone, beijing, slot):
    event = ClosingEvent(title="已公布产业活动", evidence_keys=["event"], local_start=local, source_timezone=zone)
    assert event.beijing_start.isoformat() == beijing and event.session_relation == slot


@pytest.mark.parametrize("changes", [
    {"local_start": "2026-11-20T11:00:00+02:00"},  # Wrong winter offset.
    {"local_start": "2026-03-29T02:30:00+01:00"},  # Nonexistent local wall time.
    {"local_start": "2026-10-21T11:00:00"},
    {"source_timezone": "CST"},
    {"beijing_start": "2026-10-21T15:00:00+08:00"},
    {"session_relation": "during_session"},
])
def test_wrong_timezone_or_unsupported_converted_fields_are_rejected(changes):
    event = report_data()["closing_review"]["events"][0]
    event.update(changes)
    with pytest.raises(ValidationError):
        ClosingEvent.model_validate(event)


def test_date_only_source_cannot_be_turned_into_a_confirmed_time():
    items = evidence_items()
    items[1]["evidence"][0]["quote"] = "The keynote is on October 21. More information will be announced."
    with pytest.raises(ValueError, match="原始日程时刻与时区"):
        validate(items=items)


def test_after_close_event_requires_the_correct_day_clock_and_session_in_client_copy():
    for wrong in (EVENT_COPY.replace("17:00", "15:00"), EVENT_COPY.replace("10月21日", "10月20日"), EVENT_COPY.replace("收盘后", "盘中")):
        data = report_data()
        data["client_copy"] = CLIENT_COPY.replace(EVENT_COPY, wrong)
        data["closing_review"]["events"][0]["client_copy_excerpt"] = wrong
        with pytest.raises(ValueError, match="北京时间|盘后关系"):
            validate(data)


def test_unconfirmed_time_stays_explicit_and_legacy_runs_keep_their_contract():
    data = report_data()
    event = data["closing_review"]["events"][0]
    event.update(local_start=None, source_timezone=None, client_copy_excerpt="产业活动的时间待确认，后续以正式安排为准。")
    data["client_copy"] = CLIENT_COPY.replace(EVENT_COPY, event["client_copy_excerpt"])
    assert validate(data).closing_review.events[0].session_relation == "time_unconfirmed"
    data["closing_review"] = None
    legacy = AdvisorReport.model_validate(data)
    closing_review.validate(legacy, evidence_items(), None, "client")
    result = closing_review.validate(legacy, evidence_items(), closing_review.policy_snapshot(), "client")
    assert any("closing_review" in error for error in result.errors)


@pytest.mark.parametrize("risk", [
    "市场波动仍可能较大，以上仅作公开信息交流，投资需结合自身情况审慎判断。",
    "风险提示：市场波动较大，投资需审慎。",
    "股市有风险，投资需谨慎。",
])
def test_natural_risk_language_does_not_require_a_canned_sentence(risk):
    data = report_data()
    data["client_copy"] = CLIENT_COPY.replace("市场有风险，投资需谨慎。", risk)
    validate(data)


def test_policy_snapshot_is_independent_of_later_default_changes():
    first = closing_review.policy_snapshot()
    saved = deepcopy(first)
    first["plain_language"].clear()
    assert closing_review.policy_snapshot() == saved


@pytest.mark.parametrize("level", ["basic", "strict"])
@pytest.mark.parametrize(("old", "new", "message"), [
    ("超过3700只", "3734只", "家数使用约数"),
    ("上涨股票数量", "个股宽度", "易懂表达"),
    ("明日观察", "接下来", "三段"),
])
def test_editorial_suggestions_never_block(old, new, message, level):
    data = report_data()
    data["client_copy"] = data["client_copy"].replace(old, new)
    _, result = review_result(data, level=level)
    assert not result.errors and not result.warnings
    assert any(message in suggestion for suggestion in result.suggestions)


@pytest.mark.parametrize("level", ["basic", "strict", "off"])
def test_missing_client_risk_sentence_is_a_nonblocking_review_warning(level):
    data = report_data()
    data["client_copy"] = CLIENT_COPY.replace("市场有风险，投资需谨慎。", "")
    _, result = review_result(data, level=level)
    assert not result.errors
    assert any("简短风险提示" in warning for warning in result.warnings)


@pytest.mark.parametrize("level", ["basic", "strict"])
def test_long_copy_is_an_editorial_suggestion(level):
    data = report_data()
    data["client_copy"] += "后续仍需核对正式资料。" * 90
    _, result = review_result(data, level=level)
    assert not result.errors
    assert any("建议精简" in suggestion for suggestion in result.suggestions)


def test_legacy_off_suppresses_only_optional_editorial_suggestions():
    data = report_data()
    data["client_copy"] = CLIENT_COPY.replace("明日观察", "后续关注").replace("上涨股票数量", "个股宽度")
    _, result = review_result(data, level="off")
    assert not result.errors and not result.suggestions


@pytest.mark.parametrize("level", ["basic", "strict", "off"])
@pytest.mark.parametrize("change", ["missing_turnover", "missing_comparison", "wrong_date", "wrong_chinese_clock", "invented_clock"])
def test_missing_provenance_or_conflicting_event_facts_block_every_mode(level, change):
    data = report_data()
    if change == "missing_turnover":
        data["closing_review"]["turnover"] = None
    elif change == "missing_comparison":
        data["closing_review"]["turnover"]["comparison"] = None
    else:
        event = data["closing_review"]["events"][0]
        if change == "wrong_date":
            excerpt = EVENT_COPY.replace("10月21日", "2025年10月21日")
        elif change == "wrong_chinese_clock":
            excerpt = EVENT_COPY.replace("17:00", "下午3点")
        else:
            event.update(local_start=None, source_timezone=None)
            excerpt = EVENT_COPY
        event["client_copy_excerpt"] = excerpt
        data["client_copy"] = CLIENT_COPY.replace(EVENT_COPY, excerpt)
    _, result = review_result(data, level=level)
    assert result.errors


@pytest.mark.parametrize("level", ["basic", "strict"])
def test_omitted_time_label_is_a_warning_in_basic_and_required_in_strict(level):
    data = report_data()
    excerpt = EVENT_COPY.replace("北京时间", "")
    data["closing_review"]["events"][0]["client_copy_excerpt"] = excerpt
    data["client_copy"] = CLIENT_COPY.replace(EVENT_COPY, excerpt)
    _, result = review_result(data, level=level)
    assert bool(result.errors) == (level == "strict")
    assert bool(result.warnings) == (level == "basic")


@pytest.mark.parametrize("phrase", ["时间待确认", "具体时刻待确认", "具体时间尚未确认"])
def test_equivalent_unconfirmed_time_wording_does_not_trigger_editorial_repair(phrase):
    data = report_data()
    excerpt = "产业活动的" + phrase + "，后续以正式安排为准。"
    data["closing_review"]["events"][0].update(local_start=None, source_timezone=None, client_copy_excerpt=excerpt)
    data["client_copy"] = CLIENT_COPY.replace(EVENT_COPY, excerpt)
    _, result = review_result(data)
    assert not result.errors and not result.warnings
