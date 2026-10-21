import json
from unittest.mock import Mock

import pytest
import requests

from apps.api.app import settings, tushare_client, tushare_sync
from apps.api.app.tushare_client import TushareClient, TushareError


@pytest.fixture
def config_file(tmp_path, monkeypatch):
    path = tmp_path / "config.ini"
    monkeypatch.setenv("LLMR_CONFIG_FILE", str(path))
    monkeypatch.delenv("TUSHARE_TOKEN", raising=False)
    return path


def response(payload, status=200):
    result = requests.Response()
    result.status_code = status
    result._content = json.dumps(payload).encode()
    result._content_consumed = True
    return result


def success():
    return response({"code": 0, "data": {"fields": ["ts_code", "close"], "items": [["000001.SZ", 10.5]]}})


def test_official_token_from_config_takes_precedence(config_file, monkeypatch):
    config_file.write_text("[tushare]\ntoken= config-token \ntoken_env=TEST_TUSHARE_TOKEN\ntimeout=45\nretries=4\n", encoding="utf-8")
    monkeypatch.setenv("TEST_TUSHARE_TOKEN", "environment-token")
    result = settings.tushare_settings()
    assert result == {"configured": True, "credential_source": "config", "token": "config-token",
                      "token_env": "TEST_TUSHARE_TOKEN", "timeout": 45, "retries": 4}


@pytest.mark.parametrize("env_name", ["TUSHARE_TOKEN", "TEST_TUSHARE_TOKEN"])
def test_official_token_can_be_loaded_from_environment(config_file, monkeypatch, env_name):
    config_file.write_text(f"[tushare]\ntoken= \ntoken_env={env_name}\n", encoding="utf-8")
    monkeypatch.setenv(env_name, " environment-token ")
    result = settings.tushare_settings()
    assert result["configured"] is True
    assert result["token"] == "environment-token"
    assert result["credential_source"] == "environment"


def test_missing_token_does_not_make_a_request(config_file, monkeypatch):
    post = Mock()
    monkeypatch.setattr(tushare_client.requests, "post", post)
    assert settings.tushare_settings()["configured"] is False
    with pytest.raises(TushareError, match="未配置 Tushare 官方 token"):
        tushare_sync.create_client()
    post.assert_not_called()


def test_removed_credentials_and_endpoint_overrides_are_ignored(config_file, monkeypatch):
    config_file.write_text(
        "[tushare]\nrelay_api_key=obsolete-key\napi_key=obsolete-key\n"
        "relay_api_key_env=OBSOLETE_KEY\nrelay_base_url=https://obsolete.invalid\nbase_url=https://obsolete.invalid\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("OBSOLETE_KEY", "obsolete-env-key")
    monkeypatch.setenv("TUSHARE_RELAY_API_KEY", "obsolete-env-key")
    monkeypatch.setenv("TUSHARE_RELAY_BASE_URL", "https://obsolete.invalid")
    assert settings.tushare_settings()["configured"] is False
    with pytest.raises(TushareError, match="未配置"):
        tushare_sync.create_client()
    monkeypatch.setenv("TUSHARE_TOKEN", "official-token")
    post = Mock(return_value=success())
    monkeypatch.setattr(tushare_client.requests, "post", post)
    tushare_sync.create_client().raw_query("daily")
    assert post.call_args.args == ("https://api.tushare.pro",)
    assert post.call_args.kwargs["json"]["token"] == "official-token"


def test_official_json_protocol_and_normalized_rows(config_file, monkeypatch):
    config_file.write_text("[tushare]\ntoken=official-token\ntimeout=45\n", encoding="utf-8")
    post = Mock(return_value=success())
    monkeypatch.setattr(tushare_client.requests, "post", post)
    rows = tushare_sync._query(tushare_sync.create_client(), "daily", ts_code="000001.SZ", fields="ts_code,close", offset=10, limit=20)
    assert rows == [{"ts_code": "000001.SZ", "close": 10.5}]
    post.assert_called_once_with("https://api.tushare.pro", json={
        "api_name": "daily", "token": "official-token", "fields": "ts_code,close",
        "params": {"ts_code": "000001.SZ", "offset": 10, "limit": 20},
    }, timeout=45, allow_redirects=False)


@pytest.mark.parametrize("failure", [requests.Timeout("secret-token"), requests.ConnectionError("secret-token"), response({}, 429), response({}, 503)])
def test_transient_errors_retry_then_succeed(monkeypatch, failure):
    post = Mock(side_effect=[failure, success()])
    sleep = Mock()
    monkeypatch.setattr(tushare_client.requests, "post", post)
    monkeypatch.setattr(tushare_client.time, "sleep", sleep)
    assert TushareClient("secret-token", retries=1).raw_query("daily")["code"] == 0
    assert post.call_count == 2
    sleep.assert_called_once_with(0.6)


def test_retry_budget_and_transport_errors_do_not_expose_token(monkeypatch):
    post = Mock(side_effect=requests.Timeout("secret-token"))
    monkeypatch.setattr(tushare_client.requests, "post", post)
    monkeypatch.setattr(tushare_client.time, "sleep", Mock())
    with pytest.raises(TushareError) as error:
        TushareClient("secret-token", retries=2).raw_query("daily")
    assert post.call_count == 3
    assert "secret-token" not in str(error.value)
    assert error.value.__suppress_context__


def test_permission_denial_redacts_token_and_is_not_retried(monkeypatch):
    post = Mock(return_value=response({"code": 2002, "msg": "secret-token 无权限", "data": None}))
    monkeypatch.setattr(tushare_client.requests, "post", post)
    with pytest.raises(TushareError, match="2002.*无权限") as error:
        TushareClient("secret-token").raw_query("news")
    assert "secret-token" not in str(error.value)
    post.assert_called_once()


@pytest.mark.parametrize("status", [302, 307, 401, 403])
def test_redirects_and_http_denials_are_not_retried(monkeypatch, status):
    post = Mock(return_value=response({"msg": "secret-token"}, status))
    monkeypatch.setattr(tushare_client.requests, "post", post)
    with pytest.raises(TushareError, match=f"HTTP {status}") as error:
        TushareClient("secret-token").raw_query("daily")
    assert "secret-token" not in str(error.value)
    post.assert_called_once()


@pytest.mark.parametrize("payload", [None, [], {}, {"code": 0, "data": None}, {"code": 0, "data": {"fields": [], "items": None}}])
def test_malformed_responses_fail_instead_of_becoming_empty_data(monkeypatch, payload):
    monkeypatch.setattr(tushare_client.requests, "post", Mock(return_value=response(payload)))
    with pytest.raises(TushareError, match="无效"):
        TushareClient("secret-token").raw_query("daily")


def test_non_json_response_is_rejected(monkeypatch):
    invalid = response(None)
    invalid._content = b"not json: secret-token"
    monkeypatch.setattr(tushare_client.requests, "post", Mock(return_value=invalid))
    with pytest.raises(TushareError, match="无效的 JSON") as error:
        TushareClient("secret-token").raw_query("daily")
    assert "secret-token" not in str(error.value)


def test_snapshot_retains_original_bytes_and_decimal_precision(monkeypatch):
    from decimal import Decimal
    raw = b'{"code":0,"data":{"fields":["amount"],"items":[[12345678901234567890.123456789]]}}'
    result = response(None)
    result._content = raw
    monkeypatch.setattr(tushare_client.requests, "post", Mock(return_value=result))
    snapshot = TushareClient("secret-token").query_snapshot("income")
    assert snapshot.body == raw
    assert snapshot.payload["data"]["items"][0][0] == Decimal("12345678901234567890.123456789")


@pytest.mark.parametrize("message,kind", [("每分钟最多访问100次", "rate_limited"), ("没有接口权限", "denied"),
                                        ("服务维护中", "transient_error"), ("参数错误", "unknown")])
def test_provider_failures_have_distinct_categories(monkeypatch, message, kind):
    monkeypatch.setattr(tushare_client.requests, "post", Mock(return_value=response({"code": 2002, "msg": message})))
    with pytest.raises(TushareError) as error:
        TushareClient("secret-token").query_snapshot("income")
    assert error.value.kind == kind


def test_successful_credential_echo_cannot_be_saved(monkeypatch):
    monkeypatch.setattr(tushare_client.requests, "post", Mock(return_value=response(
        {"code": 0, "msg": "secret-token", "data": {"fields": [], "items": []}})))
    with pytest.raises(TushareError) as error:
        TushareClient("secret-token").query_snapshot("income")
    assert error.value.kind == "invalid_response" and "secret-token" not in str(error.value)
