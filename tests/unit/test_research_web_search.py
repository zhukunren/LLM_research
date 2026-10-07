import pytest

from apps.api.app import codex_runtime, settings


@pytest.fixture
def config_root(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "PROJECT_ROOT", tmp_path)
    monkeypatch.delenv("LLMR_RESEARCH_WEB_SEARCH", raising=False)
    monkeypatch.delenv("LLMR_LLM_SUPPORTS_STANDALONE_WEB_SEARCH", raising=False)
    return tmp_path


def test_search_defaults_to_live_but_requires_provider_opt_in(config_root):
    assert settings.research_web_search_mode() == "live"
    config = settings.llm_settings()
    assert config["supports_standalone_web_search"] is False
    config.update(base_url="https://example.invalid", model="test")
    overrides = codex_runtime._provider_overrides(config)
    assert 'web_search="live"' in overrides
    assert "features.standalone_web_search=false" in overrides


@pytest.mark.parametrize("mode", ["live", "cached", "disabled"])
def test_search_mode_and_provider_capability_reach_codex(config_root, mode):
    (config_root / "config.ini").write_text(
        f"[research]\nweb_search={mode}\n"
        "[app]\nmodel=test\n"
        "[model_providers.OpenAI]\nbase_url=https://example.invalid\n"
        "supports_standalone_web_search=true\n",
        encoding="utf-8",
    )
    overrides = codex_runtime._provider_overrides(settings.llm_settings())
    assert f'web_search="{mode}"' in overrides
    assert "model_providers.llmr.supports_standalone_web_search=true" in overrides
    assert f"features.standalone_web_search={'false' if mode == 'disabled' else 'true'}" in overrides


def test_environment_overrides_both_search_controls(config_root, monkeypatch):
    (config_root / "config.ini").write_text(
        "[research]\nweb_search=cached\n"
        "[model_providers.OpenAI]\nsupports_standalone_web_search=false\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("LLMR_RESEARCH_WEB_SEARCH", "live")
    monkeypatch.setenv("LLMR_LLM_SUPPORTS_STANDALONE_WEB_SEARCH", "true")
    assert settings.research_web_search_mode() == "live"
    assert settings.llm_settings()["supports_standalone_web_search"] is True


@pytest.mark.parametrize("mode", ["off", "indexed", "unknown"])
def test_invalid_search_mode_is_rejected(config_root, monkeypatch, mode):
    monkeypatch.setenv("LLMR_RESEARCH_WEB_SEARCH", mode)
    with pytest.raises(ValueError, match="research.web_search"):
        settings.research_web_search_mode()


def test_invalid_provider_capability_is_rejected(config_root, monkeypatch):
    monkeypatch.setenv("LLMR_LLM_SUPPORTS_STANDALONE_WEB_SEARCH", "probably")
    with pytest.raises(ValueError, match="supports_standalone_web_search"):
        settings.llm_settings()
