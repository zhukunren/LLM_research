from datetime import date
from decimal import Decimal
import pytest

from apps.api.app.financial_contracts import normalize_record, digest
from apps.api.app.financial_facts import NORMALIZATION_VERSION
from apps.api.app.financial_metrics import Calculator, FinancialQuery


def source(period, values, *, family="income", report_type="1", company_type="1", announced=None, observed="2026-10-20T08:00:00Z"):
    row = {"ts_code": "600519.SH", "end_date": period.replace("-", ""), "ann_date": announced or str(int(period[:4]) + 1) + "0331",
           "report_type": report_type, "comp_type": company_type, **values}
    if family == "fina_indicator":
        row.pop("report_type"); row.pop("comp_type")
    return normalize_record(family, row, observed_at=observed)


def calculator(records, basis="quarter", mode="latest", cutoff="2026-10-20"):
    facts = {}
    for r in records:
        for f in r["facts"]:
            fid = digest([r["id"], f["metric_code"], NORMALIZATION_VERSION])
            facts[fid] = {**f, "id": fid}
    query = FinancialQuery(stock_code="600519.SH", as_of=cutoff, start_year=2021, basis=basis, mode=mode)
    return Calculator(query, records, facts)


def test_single_quarters_are_same_year_differences_and_preserve_exact_input_ids():
    records = [source("2025-" + period, {"revenue": Decimal(value)}) for period, value in
               [("03-31", "100.12"), ("06-30", "250.35"), ("09-30", "401.77"), ("12-31", "700.01")]]
    calc = calculator(records)
    expected = ["100.12", "150.23", "151.42", "298.24"]
    assert [calc.point("revenue", r["report_period"])["value"] for r in records] == expected
    point = calc.point("revenue", "2025-09-30")
    assert len(point["input_fact_ids"]) == 2 and point["formula"] == "current_ytd - previous_same_year_ytd"


def test_ttm_uses_previous_fiscal_year_and_matching_ytd_but_december_needs_only_current_year():
    calc = calculator([source("2024-12-31", {"revenue": 600}), source("2024-06-30", {"revenue": 240}),
                       source("2025-06-30", {"revenue": 300}), source("2025-12-31", {"revenue": 750})], basis="ttm")
    assert calc.point("revenue", "2025-06-30")["value"] == "660"
    assert len(calc.point("revenue", "2025-06-30")["input_fact_ids"]) == 3
    single = calculator([source("2025-12-31", {"revenue": 750})], basis="ttm")
    assert single.point("revenue", "2025-12-31")["value"] == "750"


def test_missing_quarter_null_and_absent_are_not_zero_and_ttms_are_not_partial_sums():
    calc = calculator([source("2025-06-30", {"revenue": 200, "oper_cost": None, "n_income": 0})])
    assert calc.point("revenue", "2025-06-30")["status"] == "dependency_missing"
    assert calc.raw("operating_cost", "2025-06-30")["status"] == "source_null"
    assert calc.raw("parent_net_profit", "2025-06-30")["status"] == "field_absent"
    assert calc.raw("net_profit", "2025-06-30")["value"] == "0"
    ttm = calculator([source("2025-06-30", {"revenue": 200})], basis="ttm")
    assert ttm.point("revenue", "2025-06-30")["value"] is None


def test_balance_sheet_and_opening_cash_are_point_values_in_all_views():
    records = [source("2025-06-30", {"total_assets": 1100, "total_liab": 440}, family="balancesheet"),
               source("2025-06-30", {"c_cash_equ_beg_period": 500}, family="cashflow")]
    for basis in ("quarter", "ttm", "cumulative"):
        calc = calculator(records, basis=basis)
        assert calc.point("assets", "2025-06-30")["value"] == "1100"
        assert calc.point("assets", "2025-06-30")["actual_basis"] == "period_end"
        assert calc.point("beginning_cash_equivalents", "2025-06-30")["actual_basis"] == "period_start"
        assert calc.point("debt_ratio", "2025-06-30")["value"] == "40"


def test_ratios_use_matching_quarter_flows_and_do_not_subtract_reported_roe():
    records = [source("2025-03-31", {"revenue": 100, "oper_cost": 70, "n_income": 10}),
               source("2025-06-30", {"revenue": 300, "oper_cost": 190, "n_income": 50}),
               source("2025-06-30", {"roe": 15}, family="fina_indicator")]
    calc = calculator(records)
    assert calc.point("gross_margin", "2025-06-30")["value"] == "40"
    assert calc.point("net_margin", "2025-06-30")["value"] == "20"
    assert calc.point("provider_roe", "2025-06-30")["status"] == "unsupported_basis"


def test_nonpositive_denominators_and_negative_base_yoy_are_explicit():
    records = [source("2024-12-31", {"revenue": 0, "n_income_attr_p": -50}),
               source("2025-12-31", {"revenue": 0, "oper_cost": 1, "n_income_attr_p": 20, "n_income": -10}),
               source("2025-12-31", {"n_cashflow_act": 15}, family="cashflow")]
    calc = calculator(records, basis="annual")
    assert calc.point("gross_margin", "2025-12-31")["status"] == "zero_denominator"
    assert calc.point("cash_conversion", "2025-12-31")["status"] == "nonpositive_denominator"
    yoy = calc.point("parent_net_profit_yoy", "2025-12-31")
    assert yoy["value"] is None and yoy["absolute_change"] == "70" and yoy["change_classification"] == "turnaround"
    assert calc.point("revenue_yoy", "2025-12-31")["status"] == "nonpositive_base"


def test_historical_cutoff_requires_observed_version_and_announcement_not_report_period():
    original = source("2025-12-31", {"revenue": 100}, observed="2026-04-01T00:00:00Z")
    revision = source("2025-12-31", {"revenue": 120}, announced="20260501", observed="2026-05-02T00:00:00Z")
    early = calculator([original, revision], mode="as_of", cutoff="2026-03-31")
    assert early.raw("revenue", "2025-12-31")["status"] == "historical_evidence_missing"
    middle = calculator([original, revision], mode="as_of", cutoff="2026-04-15")
    assert middle.raw("revenue", "2025-12-31")["value"] == "100"
    latest = calculator([original, revision])
    assert latest.raw("revenue", "2025-12-31")["value"] == "120"


def test_equal_update_flags_are_equivalent_but_unknown_same_date_revision_is_a_conflict():
    records = [source("2025-03-31", {"revenue": 100, "update_flag": flag}) for flag in ("0", "1")]
    result = calculator(records).point("revenue", "2025-03-31")
    assert result["value"] == "100" and len(result["input_fact_ids"]) == 2
    records.append(source("2025-03-31", {"revenue": 101, "update_flag": "1"}))
    assert calculator(records).point("revenue", "2025-03-31")["status"] == "conflict"


def test_adjusted_comparatives_cannot_silently_change_difference_basis():
    records = [source("2025-03-31", {"revenue": 100}), source("2025-06-30", {"revenue": 300}),
               source("2025-03-31", {"revenue": 110}, report_type="4", announced="20260701")]
    calc = calculator(records)
    assert calc.raw("revenue", "2025-03-31")["value"] == "100"
    assert calc.point("revenue", "2025-06-30")["status"] == "comparability_unverified"


def test_financial_company_template_and_company_type_changes_are_not_silently_mixed():
    bank = calculator([source("2025-12-31", {"revenue": 100, "oper_cost": 20}, company_type="2")], basis="annual")
    assert bank.point("gross_margin", "2025-12-31")["status"] == "not_applicable"
    changed = calculator([source("2025-03-31", {"revenue": 100}), source("2025-06-30", {"revenue": 300}, company_type="7")])
    assert changed.point("revenue", "2025-06-30")["status"] == "incompatible_unit_or_scope"


def test_foreign_currency_is_not_presented_as_cny_or_converted_with_an_invented_rate():
    record = source("2025-12-31", {"revenue": 100, "curr_type": "USD"})
    assert calculator([record], basis="annual").point("revenue", "2025-12-31")["status"] == "currency_conversion_required"


def test_reconciliation_exposes_mismatch_without_repairing_source():
    records = [source("2025-12-31", {"total_assets": 100, "total_liab": 30, "total_hldr_eqy_inc_min_int": 70}, family="balancesheet"),
               source("2025-12-31", {"n_income": 20, "n_income_attr_p": 15, "minority_gain": 3})]
    checks = {item["check"]: item for item in calculator(records).checks("2025-12-31")}
    assert checks["balance_equation"]["status"] == "pass"
    assert checks["profit_attribution"]["status"] == "mismatch" and checks["profit_attribution"]["difference"] == "2"
    assert checks["cash_movement"]["status"] == "missing"
