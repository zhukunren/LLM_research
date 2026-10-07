from apps.api.app import screening_tools
from apps.api.app.research_tools import TushareQueryArgs
import pytest
from pydantic import ValidationError


def test_registered_tools_expose_codex_mcp_schemas():
    registry = screening_tools.registry
    names = registry.registered_tool_names()
    assert {
        "describe_capabilities",
        "get_market_coverage",
        "search_securities",
        "read_market_window",
        "search_report_pages",
        "read_report_page",
        "inspect_saved_conditions",
        "read_artifact_chunk",
    } <= names
    assert "compute_builtin_indicator" not in names
    assert not any(name in {"shell", "sql", "python", "http_get"} for name in names)
    tushare = registry._registrations["query_tushare"].tool.input_schema
    assert tushare["properties"]["params"]["type"] == "object"
    assert TushareQueryArgs.model_validate({"api_name": "daily", "params": {"ts_code": "000001.SZ"}}).limit == 100


def test_tool_definitions_do_not_accept_extra_arguments():
    market = screening_tools.registry._registrations["read_market_window"]
    schema = market.tool.input_schema

    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == {"stock_code", "limit"}
    assert set(schema["properties"]) == {"stock_code", "limit", "as_of"}
    assert schema["properties"]["as_of"]["default"] is None
    assert {item["type"] for item in schema["properties"]["as_of"]["anyOf"]} == {"string", "null"}
    assert screening_tools.ReadMarketWindowArgs.model_validate({"stock_code": "600000.SH", "limit": 1}).as_of is None
    with pytest.raises(ValidationError):
        screening_tools.ReadMarketWindowArgs.model_validate({"stock_code": "600000.SH", "limit": 1, "unknown": True})


def test_codex_mcp_keeps_optional_objects_and_tool_annotations(tmp_path, monkeypatch):
    from apps.api.app.codex_mcp_server import _tools
    from apps.api.app import db, capability_service, market

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tool-metadata.db")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "no-market.parquet")
    for name in ("LLMR_CODEX_CONVERSATION_ID", "LLMR_CODEX_TURN_ID", "LLMR_CODEX_TASK_REVISION"):
        monkeypatch.delenv(name, raising=False)
    # This test concerns schema and annotations, independent of installed data
    # and configuration. Capability availability has a separate test below.
    monkeypatch.setattr(capability_service, "screening_capability_manifest", lambda: {
        "capabilities": [{"id": registration.capability_id, "availability": "available"}
                         for registration in screening_tools.registry._registrations.values() if registration.capability_id]
    })
    db.init_db()

    definitions = {tool["name"]: tool for tool in _tools()}
    tushare = definitions["query_tushare"]
    assert "limit" not in tushare["inputSchema"]["required"]
    assert tushare["inputSchema"]["properties"]["params"]["additionalProperties"]["anyOf"]
    assert tushare["annotations"]["readOnlyHint"]
    assert tushare["annotations"]["openWorldHint"]
    assert not definitions["execute_screening_task"]["annotations"]["readOnlyHint"]


def test_codex_only_receives_tools_whose_service_capability_is_available(monkeypatch):
    from apps.api.app import capability_service

    monkeypatch.setattr(
        capability_service,
        "screening_capability_manifest",
        lambda: {
            "capabilities": [
                {"id": "market.daily_bars", "availability": "available"},
                {"id": "market.security_search", "availability": "unavailable"},
                {"id": "market.builtin_indicators", "availability": "unavailable"},
                {"id": "report.page_search", "availability": "unavailable"},
                {"id": "portfolio.inspect_saved_conditions", "availability": "available"},
                {"id": "runtime.artifact_read", "availability": "available"},
            ]
        },
    )
    names = {tool.name for tool in screening_tools.registry.tools_for_codex()}

    assert "read_market_window" in names
    assert "inspect_saved_conditions" in names
    assert "read_artifact_chunk" in names
    assert "search_securities" not in names
    assert "search_report_pages" not in names
    assert "exec_host_command" not in names
