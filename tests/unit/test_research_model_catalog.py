import json
import urllib.error

import pytest

from apps.api.app import research_models, settings


def test_provider_discovery_is_bounded_cached_and_credentials_stay_out_of_result(monkeypatch):
    research_models._cache.clear()
    calls = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self, count):
            assert count <= 1_000_001
            return json.dumps({"data": [{"id": "gpt-6-luna"}, {"id": "untrusted\ninvalid"}, {"id": 1}]}).encode()
    def open_request(request, timeout):
        assert request.full_url == "https://provider.invalid/v1/models"
        assert timeout <= 3
        calls.append(request)
        return Response()
    monkeypatch.setattr(research_models.urllib.request, "urlopen", open_request)
    provider = {"configured": True, "base_url": "https://provider.invalid/v1", "api_key": "private-discovery-key"}
    assert research_models._discover(provider) == ({"gpt-6-luna"}, "verified")
    assert research_models._discover(provider) == ({"gpt-6-luna"}, "verified")
    assert len(calls) == 1
    assert "private-discovery-key" not in str(research_models._cache)


def test_authentication_failure_does_not_enable_the_configured_model(monkeypatch):
    research_models._cache.clear()
    provider = {"configured": True, "model": "gpt-6-luna", "reasoning_effort": "high",
                "base_url": "https://provider.invalid", "api_key": "private-invalid-key"}
    monkeypatch.setattr(research_models, "llm_settings", lambda: provider)
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {"account_tier": "free", "allowed_models": [], "reasoning_efforts": {}})
    def denied(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 401, "private error detail", {}, None)
    monkeypatch.setattr(research_models.urllib.request, "urlopen", denied)
    catalog = research_models.catalog()
    assert all(not item["available"] for item in catalog["models"])
    assert "private" not in str(catalog)
    with pytest.raises(research_models.ResearchModelError, match="认证失败"):
        research_models.resolve_selection()


def test_invalid_operator_effort_config_fails_with_safe_configuration_error(monkeypatch):
    monkeypatch.setenv("LLMR_RESEARCH_MODEL_EFFORTS_JSON", '{"gpt-6-luna":[{}]}')
    with pytest.raises(ValueError, match="reasoning_efforts_json"):
        settings.research_model_settings()


def test_discovery_rotated_credentials_do_not_reuse_old_account_catalog_and_expired_error_recovers(monkeypatch):
    research_models._cache.clear()
    clock = [100.0]
    monkeypatch.setattr(research_models.time, "monotonic", lambda: clock[0])
    calls = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self, count): return b'{"data":[{"id":"gpt-6-luna"}]}'
    def request(request, timeout):
        calls.append(request.get_header("Authorization"))
        if len(calls) == 2:
            raise urllib.error.HTTPError(request.full_url, 403, "account changed", {}, None)
        return Response()
    monkeypatch.setattr(research_models.urllib.request, "urlopen", request)
    provider = {"configured": True, "base_url": "https://provider.invalid/v1", "api_key": "first-test-account"}
    assert research_models._discover(provider) == ({"gpt-6-luna"}, "verified")
    rotated = {**provider, "api_key": "second-test-account"}
    assert research_models._discover(rotated) == (set(), "authentication_failed")
    assert research_models._discover(rotated) == (set(), "authentication_failed")
    assert len(calls) == 2
    clock[0] += 31
    assert research_models._discover(rotated) == ({"gpt-6-luna"}, "verified")
    assert len(calls) == 3


@pytest.mark.parametrize("payload", [b'not-json', b'null', b'[]', b'{"data":null}'])
def test_invalid_discovery_payload_does_not_enable_unconfirmed_alternate_models(monkeypatch, payload):
    research_models._cache.clear()
    class Response:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self, count): return payload
    monkeypatch.setattr(research_models.urllib.request, "urlopen", lambda *_args, **_kwargs: Response())
    monkeypatch.setattr(research_models, "llm_settings", lambda: {"configured": True, "model": "gpt-6-luna", "reasoning_effort": "high", "base_url": "https://provider.invalid", "api_key": "test-key"})
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {"account_tier": "free", "allowed_models": [], "reasoning_efforts": {}})
    catalog = research_models.catalog()
    assert not next(item for item in catalog["models"] if item["id"] == "gpt-5.6-luna")["available"]
    assert catalog["discovery_status"] != "verified"
