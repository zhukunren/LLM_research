import json
import io
import urllib.error
import urllib.request

import pytest

from apps.api.app import model_client, settings


@pytest.mark.parametrize("kind", ["json", "tool"])
def test_model_generation_uses_configured_wait_but_preserves_probe_override(monkeypatch, kind):
    monkeypatch.setattr(model_client, "llm_settings", lambda: {
        "configured": True, "api_mode": "responses", "api_path": "/v1/responses",
        "base_url": "https://example.invalid", "api_key": "test-key", "model": "test-model",
    })
    monkeypatch.setattr(model_client, "research_settings", lambda: {"model_request_timeout_seconds": 900})
    waits = []
    def request(_config, _body, timeout_seconds):
        waits.append(timeout_seconds)
        return {"status": "completed", "output_text": '{"ok":true}', "output": [
            {"type": "message", "content": [{"type": "output_text", "text": '{"ok":true}'}]},
        ]}
    monkeypatch.setattr(model_client, "_request_json_body", request)
    if kind == "json":
        model_client.complete_json("Return JSON", "generate")
        model_client.complete_json("Return JSON", "probe", timeout_seconds=20)
    else:
        tools = [model_client.FunctionTool("read_sources", "Read sources", {"type": "object", "properties": {}, "required": [], "additionalProperties": False})]
        model_client.create_tool_turn("Analyze", "generate", tools)
        model_client.create_tool_turn("Analyze", "probe", tools, timeout_seconds=20)
    assert waits == [900, 20]


def test_responses_configuration_is_loaded_from_config_ini(tmp_path, monkeypatch) -> None:
    (tmp_path / "config.ini").write_text(
        "[app]\nmodel_provider=OpenAI\nmodel=gpt-5.5\nreview_model=gpt-5.5\n"
        "[model_providers.OpenAI]\nbase_url=http://127.0.0.1:8081\nwire_api=responses\n"
        "[secrets]\nopenai_api_key=local-test-secret\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(settings, "PROJECT_ROOT", tmp_path)
    result = settings.llm_settings()
    assert result["configured"] is True
    assert result["model"] == "gpt-5.5"
    assert result["api_mode"] == "responses"
    assert result["api_path"] == "/v1/responses"
    assert result["api_key"] == "local-test-secret"


def test_tushare_relay_uses_only_relay_specific_credentials(tmp_path, monkeypatch) -> None:
    (tmp_path / "config.ini").write_text(
        "[tushare]\n"
        "token=legacy-tushare-token\n"
        "relay_api_key=relay-test-key\n"
        "relay_base_url=https://relay.example.test/tushare/pro\n"
        "timeout=45\n"
        "retries=4\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(settings, "PROJECT_ROOT", tmp_path)
    result = settings.tushare_settings()
    assert result["api_key"] == "relay-test-key"
    assert result["base_url"] == "https://relay.example.test/tushare/pro"
    assert result["timeout"] == 45.0
    assert result["retries"] == 4

    (tmp_path / "config.ini").write_text("[tushare]\ntoken=legacy-tushare-token\n", encoding="utf-8")
    fallback = settings.tushare_settings()
    assert fallback["api_key"] == ""
    assert fallback["uses_adapter_default"] is True


def test_responses_request_uses_json_output_store_false_and_extracts_result(monkeypatch) -> None:
    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps({"output_text": '{"status":"ok"}'}).encode("utf-8")

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        captured["body"] = json.loads(request.data)
        captured["authorization"] = request.get_header("Authorization")
        return Response()

    monkeypatch.setattr(model_client, "llm_settings", lambda: {
        "configured": True, "api_mode": "responses", "api_path": "/v1/responses",
        "base_url": "http://127.0.0.1:8081", "api_key": "private-test-key", "model": "gpt-5.5",
    })
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    result = model_client.complete_json("Return JSON.", "health probe", max_output_tokens=80)
    assert result == {"status": "ok"}
    assert captured["url"] == "http://127.0.0.1:8081/v1/responses"
    assert captured["body"]["store"] is False
    assert captured["body"]["model"] == "gpt-5.5"
    assert "JSON" in captured["body"]["input"]
    assert captured["authorization"] == "Bearer private-test-key"


def test_responses_output_items_are_parsed(monkeypatch) -> None:
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps({"output": [{"type": "message", "content": [{"type": "output_text", "text": '{"answer":42}'}]}]}).encode()

    monkeypatch.setattr(model_client, "llm_settings", lambda: {
        "configured": True, "api_mode": "responses", "api_path": "/v1/responses",
        "base_url": "http://127.0.0.1:8081", "api_key": "private-test-key", "model": "gpt-5.5",
    })
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_args, **_kwargs: Response())
    assert model_client.complete_json("Return JSON.", "test") == {"answer": 42}


def test_model_probe_authenticates_without_sending_prompt_content(monkeypatch) -> None:
    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps({"data": [{"id": "gpt-5.5"}]}).encode("utf-8")

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["method"] = request.method
        captured["authorization"] = request.get_header("Authorization")
        captured["data"] = request.data
        return Response()

    monkeypatch.setattr(model_client, "llm_settings", lambda: {
        "configured": True, "api_mode": "responses", "api_path": "/v1/responses",
        "base_url": "http://127.0.0.1:8081", "api_key": "private-test-key", "model": "gpt-5.5",
    })
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    result = model_client.probe_models()
    assert result == {"reachable": True, "authenticated": True, "models": ["gpt-5.5"], "reason": None}
    assert captured["url"] == "http://127.0.0.1:8081/v1/models"
    assert captured["method"] == "GET"
    assert captured["data"] is None
    assert captured["authorization"] == "Bearer private-test-key"


def test_provider_http_error_exposes_code_but_not_raw_response_body(monkeypatch) -> None:
    monkeypatch.setattr(model_client, "llm_settings", lambda: {
        "configured": True, "api_mode": "responses", "api_path": "/v1/responses",
        "base_url": "http://127.0.0.1:8081", "api_key": "private-test-key", "model": "gpt-5.5",
    })
    error_body = json.dumps({"error": {"type": "upstream_error", "code": "backend_unavailable", "message": "private prompt echo"}}).encode()
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_args, **_kwargs: (_ for _ in ()).throw(
        urllib.error.HTTPError("http://127.0.0.1:8081/v1/responses", 502, "Bad Gateway", {}, io.BytesIO(error_body))
    ))
    with pytest.raises(model_client.ModelRequestError) as captured:
        model_client.complete_json("instructions", "content")
    assert "502" in str(captured.value)
    assert "upstream_error" in str(captured.value)
    assert "private prompt echo" not in str(captured.value)
    assert "private-test-key" not in str(captured.value)


def test_chatgpt_account_model_restriction_has_safe_diagnostic(monkeypatch) -> None:
    monkeypatch.setattr(model_client, "llm_settings", lambda: {
        "configured": True, "api_mode": "responses", "api_path": "/v1/responses",
        "base_url": "http://127.0.0.1:8081", "api_key": "private-test-key", "model": "gpt-5.6",
    })
    error_body = json.dumps({"error": {"type": "invalid_request_error", "message": "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}}).encode()
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_args, **_kwargs: (_ for _ in ()).throw(
        urllib.error.HTTPError("http://127.0.0.1:8081/v1/responses", 400, "Bad Request", {}, io.BytesIO(error_body))
    ))
    with pytest.raises(model_client.ModelRequestError) as captured:
        model_client.complete_json("instructions", "content")
    assert "ChatGPT 账户不支持该模型" in str(captured.value)
    assert "gpt-5.6-sol" not in str(captured.value)
