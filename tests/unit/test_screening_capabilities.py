import json

from apps.api.app.screening_capabilities import build_manifest, market_coverage
from apps.api.app.indicators import INDICATORS


def manifest(**overrides):
    settings = {
        "market_available": True,
        "indexed_reports": 2,
        "saved_patterns": 1,
        "builtin_indicators": INDICATORS,
        "model_configured": True,
        "runtime_ready": False,
    }
    settings.update(overrides)
    return build_manifest(**settings)


def test_manifest_matches_existing_capabilities_and_never_claims_unavailable_data():
    result = manifest()
    items = {item["id"]: item for item in result["capabilities"]}

    assert result["version"] == "screening-capabilities-v1"
    assert all(not item["agent_tool_registered"] for item in result["capabilities"])
    assert items["market.daily_bars"]["availability"] == "available"
    assert items["market.daily_bars"]["coverage"]["max_bars_per_security"] == 500
    assert items["market.daily_bars"]["coverage"]["price_basis"] == "unknown"
    assert "market.builtin_indicators" not in items
    assert items["report.page_search"]["availability"] == "available"
    assert items["report.evidence_evaluation"]["availability"] == "available"
    assert items["news.local_search"]["availability"] == "unavailable"
    assert items["runtime.generated_python"]["availability"] == "unavailable"
    assert items["fundamentals.market_cap"]["availability"] == "unavailable"
    assert items["securities.historical_classification"]["availability"] == "unavailable"
    assert items["market.minute_bars"]["availability"] == "unavailable"
    assert items["portfolio.combine_saved_conditions"]["availability"] == "available"


def test_manifest_reports_partial_sources_and_missing_runtime_prerequisites():
    result = manifest(indexed_reports=0, saved_patterns=0, model_configured=False, runtime_ready=False)
    items = {item["id"]: item for item in result["capabilities"]}

    assert items["report.page_search"]["availability"] == "unavailable"
    assert items["report.evidence_evaluation"]["availability"] == "unavailable"
    assert items["pattern.match_saved"]["availability"] == "unavailable"
    assert items["runtime.generated_python"]["coverage"]["execution_backend"] == "local_python"
    assert items["runtime.generated_python"]["resource_policy"]["os_security_sandbox"] is False

    partial = manifest(model_configured=False)["capabilities"]
    report_eval = next(item for item in partial if item["id"] == "report.evidence_evaluation")
    assert report_eval["availability"] == "partial"
    assert report_eval["reason"] == "尚未配置评估所需的文本模型"


def test_market_coverage_strips_host_paths_and_unrelated_secrets():
    profile = {
        "available": True,
        "path": "D:/private/example/stock_daily.parquet",
        "sha256": "a" * 64,
        "first_date": "2020-01-01",
        "last_date": "2026-09-14",
        "markets": {"SH": 2},
        "rows": 100,
        "securities": 2,
        "columns": [{"name": "close", "type": "DOUBLE"}, {"hidden": "value"}],
        "quality_status": "issues_found",
        "price_basis": "unknown",
        "volume_unit": "unknown",
        "amount_unit": "unknown",
        "formal_execution_ready": False,
        "formal_blockers": ["复权口径未确认"],
        "openai_api_key": "must-not-be-returned",
    }

    result = market_coverage(profile)
    output = json.dumps(result, ensure_ascii=False)
    assert result["source_id"] == "a" * 64
    assert result["columns"] == [{"name": "close", "type": "DOUBLE"}]
    assert "path" not in result
    assert "private" not in output
    assert "must-not-be-returned" not in output
    assert "openai_api_key" not in output
