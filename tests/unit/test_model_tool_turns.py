import json
import urllib.request

import pytest

from apps.api.app import model_client


def market_tool():
    return model_client.FunctionTool(
        name="query_market",
        description="Read one fixed market data window.",
        parameters={
            "type": "object",
            "properties": {
                "stock_code": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 500},
            },
            "required": ["stock_code", "limit"],
            "additionalProperties": False,
        },
    )


def configure(monkeypatch, mode="responses"):
    monkeypatch.setattr(
        model_client,
        "llm_settings",
        lambda: {
            "configured": True,
            "api_mode": mode,
            "api_path": "/v1/responses" if mode == "responses" else "/v1/chat/completions",
            "base_url": "http://127.0.0.1:8081",
            "api_key": "private-test-key",
            "model": "gpt-6-luna",
        },
    )


class Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


def test_responses_tool_call_is_strict_and_preserves_continuation_items(monkeypatch):
    configure(monkeypatch)
    captured = {}
    response_items = [
        {"type": "reasoning", "id": "rs_1", "summary": []},
        {
            "type": "function_call",
            "id": "fc_1",
            "call_id": "call_1",
            "name": "query_market",
            "arguments": '{"stock_code":"600000.SH","limit":20}',
            "status": "completed",
        },
    ]

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        captured["body"] = json.loads(request.data)
        captured["authorization"] = request.get_header("Authorization")
        return Response({"id": "resp_1", "status": "completed", "output": response_items})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    turn = model_client.create_tool_turn(
        "Use only the supplied read tool.",
        "查看600000.SH最近20根日线",
        [market_tool()],
        timeout_seconds=17,
        max_output_tokens=900,
    )

    assert captured["url"] == "http://127.0.0.1:8081/v1/responses"
    assert captured["timeout"] == 17
    assert captured["authorization"] == "Bearer private-test-key"
    assert captured["body"]["store"] is False
    assert captured["body"]["parallel_tool_calls"] is False
    assert captured["body"]["tools"][0]["strict"] is True
    assert captured["body"]["tools"][0]["parameters"]["additionalProperties"] is False
    assert turn.response_id == "resp_1"
    assert turn.calls[0].call_id == "call_1"
    assert turn.calls[0].arguments == {"stock_code": "600000.SH", "limit": 20}
    assert list(turn.continuation_items) == response_items

    outputs = model_client.tool_output_items(turn, {"call_1": {"rows": 20}})
    assert outputs == [
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": '{"rows":20}',
        }
    ]


def test_chat_completions_tool_schema_and_assistant_message_are_preserved(monkeypatch):
    configure(monkeypatch, "chat_completions")
    captured = {}
    assistant_message = {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "query_market", "arguments": '{"stock_code":"600000.SH","limit":5}'},
            }
        ],
    }

    def fake_urlopen(request, timeout):
        captured["body"] = json.loads(request.data)
        return Response({"choices": [{"message": assistant_message, "finish_reason": "tool_calls"}]})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    turn = model_client.create_tool_turn("Read the market.", "筛选浦发银行", [market_tool()])
    assert captured["body"]["tool_choice"] == "auto"
    assert captured["body"]["parallel_tool_calls"] is False
    assert captured["body"]["tools"][0]["function"]["strict"] is True
    assert list(turn.continuation_items) == [assistant_message]
    assert model_client.tool_output_items(turn, {"call_1": {"rows": 5}}) == [
        {"role": "tool", "tool_call_id": "call_1", "content": '{"rows":5}'}
    ]


def test_final_text_response_has_no_continuation_items(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: Response(
            {
                "id": "resp_final",
                "status": "completed",
                "output_text": "没有符合条件的股票。",
                "output": [{"type": "message", "content": [{"type": "output_text", "text": "没有符合条件的股票。"}]}],
            }
        ),
    )
    turn = model_client.create_tool_turn("Read results.", "解释本次筛选", [market_tool()])
    assert turn.text == "没有符合条件的股票。"
    assert turn.calls == ()
    assert turn.continuation_items == ()


def test_function_output_ids_and_values_are_checked_before_serialization(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: Response(
            {
                "output": [
                    {
                        "type": "function_call",
                        "call_id": "call_1",
                        "name": "query_market",
                        "arguments": '{"stock_code":"600000.SH","limit":1}',
                        "status": "completed",
                    }
                ]
            }
        ),
    )
    turn = model_client.create_tool_turn("Use tools.", "查询行情", [market_tool()])
    with pytest.raises(ValueError, match="调用ID完全一致"):
        model_client.tool_output_items(turn, {"wrong_call": {"rows": 1}})
    with pytest.raises(ValueError, match="合法JSON"):
        model_client.tool_output_items(turn, {"call_1": {"value": float("nan")}})


def test_invalid_strict_schema_is_rejected_before_network_call(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_args, **_kwargs: pytest.fail("network called"))
    invalid = model_client.FunctionTool(
        name="query_market",
        description="Read market data.",
        parameters={"type": "object", "properties": {"stock_code": {"type": "string"}}, "additionalProperties": True},
    )
    with pytest.raises(ValueError, match="additionalProperties=false"):
        model_client.create_tool_turn("Use tools.", "查行情", [invalid])


def test_synthetic_tool_connection_probe_completes_one_safe_round_trip(monkeypatch):
    configure(monkeypatch)
    call = model_client.FunctionCall(
        "call_probe",
        "screening_connection_probe",
        {"value": 731},
    )
    first = model_client.ToolTurn(
        "responses",
        "gpt-6-luna",
        "response-1",
        None,
        (call,),
        (
            {
                "type": "function_call",
                "id": "function-1",
                "call_id": "call_probe",
                "name": "screening_connection_probe",
                "arguments": '{"value":731}',
            },
        ),
    )
    final = model_client.ToolTurn(
        "responses", "gpt-6-luna", "response-2", "The returned value is 731.", (), ()
    )
    requests = []

    def fake_turn(instructions, conversation, tools, **kwargs):
        requests.append((instructions, conversation, tools, kwargs))
        return first if len(requests) == 1 else final

    monkeypatch.setattr(model_client, "create_tool_turn", fake_turn)
    result = model_client.probe_function_calling()

    assert result["connected"] is True
    assert result["tool_calling_supported"] is True
    assert result["round_trip_completed"] is True
    assert result["echo_confirmed"] is True
    assert requests[1][1][0]["role"] == "user"
    assert requests[1][1][-1] == {
        "type": "function_call_output",
        "call_id": "call_probe",
        "output": '{"status":"ok","value":731}',
    }
    assert "private-test-key" not in json.dumps(result)


def test_synthetic_tool_probe_never_runs_after_the_model_omits_a_call(monkeypatch):
    configure(monkeypatch)
    requests = []

    def return_text(*args, **kwargs):
        requests.append((args, kwargs))
        return model_client.ToolTurn(
            "responses", "gpt-6-luna", "response-1", "I cannot call the tool.", (), ()
        )

    monkeypatch.setattr(model_client, "create_tool_turn", return_text)
    result = model_client.probe_function_calling()

    assert result["connected"] is True
    assert result["tool_calling_supported"] is False
    assert result["round_trip_completed"] is False
    assert len(requests) == 1


def test_unconfigured_model_does_not_attempt_a_tool_request(monkeypatch):
    monkeypatch.setattr(model_client, "llm_settings", lambda: {"configured": False})
    monkeypatch.setattr(
        model_client,
        "create_tool_turn",
        lambda *_args, **_kwargs: pytest.fail("model is not configured"),
    )
    assert model_client.probe_function_calling()["reason"] == "model_not_configured"
