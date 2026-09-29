from apps.api.app import screening_tools
from apps.api.app.model_client import _validate_strict_schema


def test_registered_tools_have_strict_schemas_and_no_process_or_network_tool():
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
    for registration in registry._registrations.values():
        _validate_strict_schema(registration.tool.parameters)


def test_tool_definitions_do_not_accept_extra_arguments():
    market = screening_tools.registry._registrations["read_market_window"]
    schema = market.tool.parameters

    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])


def test_model_only_receives_tools_whose_service_capability_is_available(monkeypatch):
    from apps.api.app import main

    monkeypatch.setattr(
        main,
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
    names = {tool.name for tool in screening_tools.registry.functions_for_model()}

    assert "read_market_window" in names
    assert "inspect_saved_conditions" in names
    assert "read_artifact_chunk" in names
    assert "search_securities" not in names
    assert "search_report_pages" not in names
    assert "exec_host_command" not in names
