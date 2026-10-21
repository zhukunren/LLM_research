from datetime import date
from decimal import Decimal

import pytest

from apps.api.app.financial_contracts import decimal_text, normalize_record, rows_from_payload, select_version, validate_scope
from apps.api.app.tushare_endpoints import ENDPOINTS, manifest
from apps.api.app.financial_probe import PILOT_COMPANIES, ProbeRequest, samples


def row(**changes):
    return {"ts_code": "600519.SH", "end_date": "20251231", "ann_date": "20260330", "f_ann_date": "20260330",
            "report_type": "1", "comp_type": "1", "revenue": Decimal("12345678901234567890.123456789"), **changes}


def record(**changes):
    return normalize_record("income", row(**changes), observed_at="2026-04-01T09:00:00+08:00")


def test_endpoint_specific_dates_and_no_unproven_pagination():
    assert dict(ENDPOINTS["income"].date_semantics)["end_date"] == "announcement"
    assert dict(ENDPOINTS["fina_indicator"].date_semantics)["end_date"] == "report_period"
    assert dict(ENDPOINTS["disclosure_date"].date_semantics)["pre_date"] == "planned_disclosure"
    with pytest.raises(ValueError, match="不支持参数"):
        ENDPOINTS["anns_d"].validate({"ts_code": "600519.SH", "offset": 2000})
    with pytest.raises(ValueError, match="报告期末"):
        ENDPOINTS["disclosure_date"].validate({"end_date": "20260101"})
    with pytest.raises(ValueError, match="必须限定"):
        ENDPOINTS["income"].validate({"period": "20251231"})
    ENDPOINTS["income_vip"].validate({"period": "20251231"})
    assert all(item["doc_url"].startswith("https://tushare.pro/") for item in manifest()["endpoints"])


def test_bounded_ten_company_plan_has_seven_industrials_and_four_scoped_vip_requests():
    plan = samples(ProbeRequest(request_id="sample", as_of=date(2026, 10, 20)))
    assert len(PILOT_COMPANIES) == 10
    assert sum(c["category"] == "一般工商业" for c in PILOT_COMPANIES) == 7
    assert len(plan) == 74 and len({s["key"] for s in plan}) == 74
    assert len([s for s in plan if s["endpoint"].endswith("_vip")]) == 4
    assert all(s["params"]["ts_code"] for s in plan)
    assert all(s["params"]["period"] == "20251231" for s in plan if s["endpoint"] not in {"anns_d", "disclosure_date"})


def test_precision_null_missing_and_explicit_zero_are_distinct():
    data = record(oper_cost=None, total_profit=0)
    facts = {f["metric_code"]: f for f in data["facts"]}
    assert facts["revenue"]["value"] == "12345678901234567890.123456789"
    assert facts["operating_cost"]["status"] == "null"
    assert facts["profit_before_tax"]["value"] == "0"
    assert facts["parent_net_profit"]["status"] == "absent"
    assert facts["revenue"]["original_verified"] is False
    for value in [True, "NaN", "Infinity", "not-a-number"]:
        with pytest.raises(ValueError):
            decimal_text(value)


def test_normal_vip_identity_is_shared_but_report_types_and_field_contracts_are_not():
    normal = record()
    vip = normalize_record("income_vip", row(), observed_at="2026-05-01T12:00:00+08:00")
    assert normal["id"] == vip["id"]
    assert record(revenue=Decimal("2"))["id"] != normal["id"]
    assert record(report_type="6")["logical_key"] != normal["logical_key"]
    extra = record(rd_exp=None)
    assert extra["schema_hash"] != normal["schema_hash"]
    with pytest.raises(ValueError, match="不能混合"):
        select_version([normal, extra], mode="latest")


def test_latest_date_and_as_of_observation_are_not_interchangeable():
    initial = record(revenue=Decimal("100"))
    revised = normalize_record("income", row(revenue=Decimal("101"), ann_date="20260415", f_ann_date="20260415"),
                               observed_at="2026-04-16T09:00:00+08:00")
    assert select_version([initial, revised], mode="latest")["record"]["id"] == revised["id"]
    assert select_version([initial, revised], mode="as_of", as_of=date(2026, 4, 10))["record"]["id"] == initial["id"]
    assert select_version([initial], mode="as_of", as_of=date(2026, 3, 31))["status"] == "historical_evidence_missing"
    same_date_change = record(revenue=Decimal("102"))
    assert select_version([initial, same_date_change], mode="latest")["status"] == "conflict"
    assert not initial["historical_revision_verified"]


def test_update_flag_only_difference_preserves_both_sources_without_numeric_conflict():
    initial, updated = record(update_flag="0"), record(update_flag="1")
    assert initial["id"] != updated["id"]
    result = select_version([updated, initial], mode="latest")
    assert result["status"] == "selected"
    assert set(result["equivalent_ids"]) == {initial["id"], updated["id"]}
    assert select_version([initial, record(update_flag="1", revenue=99)], mode="latest")["status"] == "conflict"


def test_statement_scope_and_temporal_types_are_explicit():
    assert record(report_type="2")["facts"][0]["temporal"] == "quarter"
    assert record(report_type="6")["scope"] == "parent"
    balance = normalize_record("balancesheet", row(total_assets=123), observed_at="2026-04-01T00:00:00Z")
    assert balance["period_basis"] == "instant"
    with pytest.raises(ValueError, match="报表类型"):
        record(report_type="99")
    with pytest.raises(ValueError, match="时区"):
        normalize_record("income", row(), observed_at="2026-04-01")


def test_forecast_units_are_normalized_and_not_actual_profit():
    data = normalize_record("forecast", {"ts_code": "600519.SH", "end_date": "20261231", "ann_date": "20261001",
                                         "net_profit_min": Decimal("123.4567")}, observed_at="2026-10-20T00:00:00Z")
    fact = data["facts"][0]
    assert fact["value"] == "1234567" and fact["unit"] == "元" and fact["raw_unit"] == "万元"
    assert fact["temporal"] == "forecast"
    validate_scope(data["raw_row"], "forecast", {"ts_code": "600519.SH", "period": "20261231"}, date(2026, 10, 20))


def test_segments_do_not_invent_a_publication_date():
    data = normalize_record("fina_mainbz", {"ts_code": "600519.SH", "end_date": "20251231", "bz_item": "产品",
                                           "bz_sales": 10, "curr_type": "CNY"},
                            observed_at="2026-10-20T00:00:00Z", params={"type": "P"})
    assert data["public_date"] is None
    assert data["dimensions"]["requested_type"] == "P"
    assert select_version([data], mode="as_of", as_of=date(2026, 4, 1))["record"] is None


@pytest.mark.parametrize("change", [{"ts_code": "000333.SZ"}, {"end_date": "20241231"}, {"f_ann_date": "20271001"}])
def test_wrong_security_period_or_future_publication_is_rejected(change):
    with pytest.raises(ValueError):
        validate_scope(row(**change), "income", {"ts_code": "600519.SH", "period": "20251231"}, date(2026, 10, 20))


@pytest.mark.parametrize("payload", [
    {"data": {"fields": ["ts_code", "ts_code"], "items": []}},
    {"data": {"fields": ["ts_code"], "items": [["600519.SH"]]}},
    {"data": {"fields": ["ts_code", "ann_date", "title", "url"], "items": [["600519.SH"]]}},
])
def test_invalid_response_shapes_do_not_become_empty_success(payload):
    with pytest.raises(ValueError):
        rows_from_payload(payload, "anns_d")
