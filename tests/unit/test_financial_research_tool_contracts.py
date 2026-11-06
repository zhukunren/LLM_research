"""Model-facing financial arguments expose usable metric names and repairable errors."""
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from apps.api.app import financial_metrics, financial_research_tools as tools
from apps.api.app.screening_tools import ToolDispatchError


@pytest.mark.parametrize("argument_type", [tools.FinancialArgs, tools.CompareArgs])
def test_model_schema_lists_the_verified_financial_metric_codes(argument_type):
    schema = argument_type.model_json_schema()
    assert set(schema["properties"]["metrics"]["items"]["enum"]) == {item["code"] for item in financial_metrics.catalog()}


@pytest.mark.parametrize("metric", ["net_profit_parent", "operating_cash_flow", "made_up_metric"])
def test_unsupported_metric_names_are_argument_errors_before_tool_execution(metric):
    with pytest.raises(ValidationError) as failure:
        tools.FinancialArgs(stock_code="000333.SZ", as_of="2026-10-20", metrics=[metric])
    assert failure.value.errors()[0]["loc"] == ("metrics", 0)
    assert failure.value.errors()[0]["type"] == "literal_error"


def test_observed_company_query_uses_the_supported_names():
    request = tools.FinancialArgs(stock_code="000333.SZ", as_of="2026-10-20", basis="cumulative", start_year=2026,
                                  metrics=["revenue", "parent_net_profit", "operating_cashflow"])
    assert financial_metrics.FinancialQuery(**request.model_dump(exclude={"offset", "limit"})).metrics == request.metrics


def test_invalid_year_range_has_an_actionable_error_instead_of_generic_execution_failure():
    request = tools.FinancialArgs(stock_code="000333.SZ", as_of="2026-10-20", start_year=2027)
    context = SimpleNamespace(as_of="2026-10-20", stock_codes=None)
    with pytest.raises(ToolDispatchError, match="查询年度") as failure:
        tools.get_financials(request, context)
    assert failure.value.code == "invalid_financial_query"


def test_duplicate_comparison_companies_have_an_actionable_error():
    request = tools.CompareArgs(stock_codes=["000333.SZ", "600519.SH", "000333.SZ"], as_of="2026-10-20")
    context = SimpleNamespace(as_of="2026-10-20", stock_codes=None)
    with pytest.raises(ToolDispatchError, match="比较公司不能重复") as failure:
        tools.compare(request, context)
    assert failure.value.code == "invalid_financial_query"
