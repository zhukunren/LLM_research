from apps.api.app import settings, codex_runtime


def test_default_research_and_deep_turns_have_longer_budgets(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "PROJECT_ROOT", tmp_path)
    for key in ("TURN_TIMEOUT_SECONDS", "MODEL_REQUEST_TIMEOUT_SECONDS", "TOOL_TIMEOUT_SECONDS"):
        monkeypatch.delenv("LLMR_RESEARCH_" + key, raising=False)
    standard = settings.research_mode_settings("research", "standard")
    deep = settings.research_mode_settings("research", "deep")
    assert standard["turn_timeout_seconds"] == 3600
    assert deep["turn_timeout_seconds"] == 7200
    assert standard["reasoning_effort"] == "high"
    assert deep["reasoning_effort"] == "max"
    assert settings.research_mode_settings("advanced")["reasoning_effort"] == "max"
    assert settings.research_mode_settings("advanced", "standard")["reasoning_effort"] == "high"
    assert standard["model_request_timeout_seconds"] == 600
    assert standard["tool_timeout_seconds"] == 1800


def test_timeout_configuration_and_environment_reach_model_tools(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "PROJECT_ROOT", tmp_path)
    for key in ("TURN_TIMEOUT_SECONDS", "MODEL_REQUEST_TIMEOUT_SECONDS", "TOOL_TIMEOUT_SECONDS"):
        monkeypatch.delenv("LLMR_RESEARCH_" + key, raising=False)
    (tmp_path / "config.ini").write_text(
        "[research]\nturn_timeout_seconds=5400\nmodel_request_timeout_seconds=900\ntool_timeout_seconds=2400\n",
        encoding="utf-8",
    )
    assert settings.research_settings()["turn_timeout_seconds"] == 5400
    assert settings.research_settings()["model_request_timeout_seconds"] == 900
    provider = codex_runtime._provider_overrides({"base_url": "https://example.invalid", "model": "test-model"})
    assert "model_providers.llmr.stream_idle_timeout_ms=900000" in provider
    assert "mcp_servers.llm_research.tool_timeout_sec=2400" in codex_runtime._mcp_overrides()
    monkeypatch.setenv("LLMR_RESEARCH_MODEL_REQUEST_TIMEOUT_SECONDS", "1200")
    assert settings.research_settings()["model_request_timeout_seconds"] == 1200
    overrides = codex_runtime._mcp_overrides({"LLMR_RESEARCH_MODEL_REQUEST_TIMEOUT_SECONDS": "1200"})
    assert 'mcp_servers.llm_research.env.LLMR_RESEARCH_MODEL_REQUEST_TIMEOUT_SECONDS="1200"' in overrides
