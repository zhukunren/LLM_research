from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Sequence
from typing import Any

from .settings import llm_settings


class ModelRequestError(RuntimeError):
    pass


@dataclass(frozen=True)
class FunctionTool:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class FunctionCall:
    call_id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ToolTurn:
    api_mode: str
    model: str
    response_id: str | None
    text: str | None
    calls: tuple[FunctionCall, ...]
    continuation_items: tuple[dict[str, Any], ...]
    refusal: str | None = None


MAX_TOOL_CALLS_PER_RESPONSE = 12
MAX_TOOL_OUTPUT_CHARS = 1_000_000
TOOL_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _validate_strict_schema(schema: Any, path: str = "$", depth: int = 0) -> None:
    if depth > 32 or not isinstance(schema, dict):
        raise ValueError(f"严格工具 schema 在 {path} 无效或嵌套过深")

    if schema.get("type") == "object":
        properties = schema.get("properties")
        required = schema.get("required")
        if not isinstance(properties, dict) or schema.get("additionalProperties") is not False:
            raise ValueError(f"严格工具 schema 的对象 {path} 必须声明 properties 与 additionalProperties=false")
        if not isinstance(required, list) or set(required) != set(properties) or len(required) != len(properties):
            raise ValueError(f"严格工具 schema 的对象 {path} 必须将每个字段列为 required")
        for key, child in properties.items():
            if not isinstance(key, str):
                raise ValueError(f"严格工具 schema 的字段名在 {path} 无效")
            _validate_strict_schema(child, f"{path}.{key}", depth + 1)

    for key in ("items", "additionalProperties"):
        child = schema.get(key)
        if isinstance(child, dict):
            _validate_strict_schema(child, f"{path}.{key}", depth + 1)
    for key in ("anyOf", "oneOf", "allOf"):
        variants = schema.get(key)
        if variants is not None:
            if not isinstance(variants, list):
                raise ValueError(f"严格工具 schema 的 {key} 在 {path} 必须是数组")
            for index, child in enumerate(variants):
                _validate_strict_schema(child, f"{path}.{key}[{index}]", depth + 1)
    for key in ("$defs", "definitions"):
        definitions = schema.get(key)
        if definitions is not None:
            if not isinstance(definitions, dict):
                raise ValueError(f"严格工具 schema 的 {key} 在 {path} 必须是对象")
            for name, child in definitions.items():
                _validate_strict_schema(child, f"{path}.{key}.{name}", depth + 1)


def _tool_definitions(tools: Sequence[FunctionTool], mode: str) -> list[dict[str, Any]]:
    if not tools or len(tools) > 64:
        raise ValueError("每次工具调用必须提供1到64个函数定义")
    names = [tool.name for tool in tools]
    if len(names) != len(set(names)) or any(not TOOL_NAME.fullmatch(name) for name in names):
        raise ValueError("函数工具名称无效或重复")

    definitions = []
    for tool in tools:
        _validate_strict_schema(tool.parameters)
        function = {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
            "strict": True,
        }
        definitions.append(
            {"type": "function", **function}
            if mode == "responses"
            else {"type": "function", "function": function}
        )
    return definitions


def _parse_arguments(value: Any, name: str) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            raise ModelRequestError(f"模型工具 {name} 返回了无效JSON参数") from None
    if not isinstance(value, dict):
        raise ModelRequestError(f"模型工具 {name} 的参数必须是JSON对象")
    return value


def _unique_calls(calls: list[FunctionCall]) -> tuple[FunctionCall, ...]:
    ids = [call.call_id for call in calls]
    if len(calls) > MAX_TOOL_CALLS_PER_RESPONSE:
        raise ModelRequestError("模型单次响应的工具调用数量超过上限")
    if len(ids) != len(set(ids)) or any(not call_id for call_id in ids):
        raise ModelRequestError("模型工具调用ID为空或重复")
    return tuple(calls)


def tool_output_items(turn: ToolTurn, outputs: dict[str, Any]) -> list[dict[str, Any]]:
    """Create provider-specific outputs only for the exact calls in a tool turn."""
    expected_ids = {call.call_id for call in turn.calls}
    if not expected_ids or set(outputs) != expected_ids:
        raise ValueError("工具输出必须与本回合的工具调用ID完全一致")
    result = []
    for call in turn.calls:
        try:
            output = json.dumps(outputs[call.call_id], ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        except (TypeError, ValueError):
            raise ValueError(f"工具 {call.name} 的返回值不是合法JSON") from None
        if len(output) > MAX_TOOL_OUTPUT_CHARS:
            raise ValueError(f"工具 {call.name} 的返回值超过大小上限")
        if turn.api_mode == "responses":
            result.append({"type": "function_call_output", "call_id": call.call_id, "output": output})
        elif turn.api_mode == "chat_completions":
            result.append({"role": "tool", "tool_call_id": call.call_id, "content": output})
        else:
            raise ValueError("工具回合使用了未知的模型接口模式")
    return result


def probe_models(timeout_seconds: int = 12) -> dict[str, Any]:
    config = llm_settings()
    if not config["configured"]:
        return {"reachable": False, "authenticated": False, "models": [], "reason": "model_not_configured"}
    request = urllib.request.Request(
        f"{config['base_url']}/v1/models",
        headers={"Authorization": f"Bearer {config['api_key']}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read())
        entries = payload.get("data", []) if isinstance(payload, dict) else []
        models = [entry["id"] for entry in entries if isinstance(entry, dict) and isinstance(entry.get("id"), str)]
        return {"reachable": True, "authenticated": True, "models": models, "reason": None}
    except urllib.error.HTTPError as exc:
        if exc.code in {401, 403}:
            return {"reachable": True, "authenticated": False, "models": [], "reason": f"authentication_http_{exc.code}"}
        return {"reachable": True, "authenticated": True, "models": [], "reason": f"models_http_{exc.code}"}
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", "connection_failed")
        return {"reachable": False, "authenticated": False, "models": [], "reason": f"network_error: {str(reason)[:120]}"}
    except (TimeoutError, ValueError, TypeError):
        return {"reachable": True, "authenticated": None, "models": [], "reason": "invalid_models_response"}


def _extract_json_text(payload: dict[str, Any], mode: str) -> str:
    if mode == "chat_completions":
        content = payload["choices"][0]["message"]["content"]
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(item.get("text", "") for item in content if isinstance(item, dict))
        raise ValueError("Chat Completions 返回了不支持的消息格式")
    output_text = payload.get("output_text")
    if isinstance(output_text, str):
        return output_text
    pieces: list[str] = []
    for output in payload.get("output", []):
        if not isinstance(output, dict) or output.get("type") != "message":
            continue
        for item in output.get("content", []):
            if isinstance(item, dict) and item.get("type") == "output_text" and isinstance(item.get("text"), str):
                pieces.append(item["text"])
    if not pieces:
        raise ValueError("Responses API 响应中没有文本输出")
    return "".join(pieces)


def _request_json_body(config: dict[str, Any], body: dict[str, Any], timeout_seconds: int) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{config['base_url']}{config['api_path']}",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {config['api_key']}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        error_type = None
        error_code = None
        provider_message = ""
        try:
            error_body = json.loads(exc.read(64 * 1024))
            error_detail = error_body.get("error", {}) if isinstance(error_body, dict) else {}
            if isinstance(error_detail, dict):
                error_type = error_detail.get("type")
                error_code = error_detail.get("code")
                provider_message = error_detail.get("message", "")
        except (ValueError, OSError):
            pass
        safe_details = [value for value in (error_type, error_code) if isinstance(value, str) and len(value) <= 80]
        suffix = f" ({', '.join(safe_details)})" if safe_details else ""
        if isinstance(provider_message, str) and "not supported when using Codex with a ChatGPT account" in provider_message:
            suffix += "；当前代理使用的 ChatGPT 账户不支持该模型"
        raise ModelRequestError(f"模型端点返回 HTTP {exc.code}{suffix}") from None
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", "连接失败")
        raise ModelRequestError(f"无法连接模型端点：{str(reason)[:140]}") from None
    except (TimeoutError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise ModelRequestError(f"模型响应格式或 JSON 无效：{str(exc)[:160]}") from None
    if not isinstance(payload, dict):
        raise ModelRequestError("模型端点返回的 JSON 根节点不是对象")
    return payload


def complete_json(
    instructions: str,
    user_content: str,
    *,
    timeout_seconds: int = 60,
    max_output_tokens: int = 4000,
) -> dict[str, Any]:
    config = llm_settings()
    if not config["configured"]:
        raise ModelRequestError("文本模型未配置")
    mode = str(config["api_mode"])
    if mode == "responses":
        body = {
            "model": config["model"],
            "instructions": instructions,
            "input": f"{user_content}\n\nReturn the response as JSON only.",
            "text": {"format": {"type": "json_object"}},
            "max_output_tokens": max_output_tokens,
            "store": False,
        }
    elif mode == "chat_completions":
        body = {
            "model": config["model"],
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": instructions},
                {"role": "user", "content": user_content},
            ],
        }
    else:
        raise ModelRequestError(f"不支持的模型接口模式：{mode}")
    payload = _request_json_body(config, body, timeout_seconds)
    try:
        result = json.loads(_extract_json_text(payload, mode))
    except (TimeoutError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ModelRequestError(f"模型响应格式或 JSON 无效：{str(exc)[:160]}") from None
    if not isinstance(result, dict):
        raise ModelRequestError("模型输出的 JSON 根节点不是对象")
    return result


def _chat_message_text(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        pieces = [
            item["text"]
            for item in value
            if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)
        ]
        return "".join(pieces) if pieces else None
    return None


def _parse_responses_calls(payload: dict[str, Any]) -> tuple[FunctionCall, ...]:
    output = payload.get("output", [])
    if not isinstance(output, list):
        raise ModelRequestError("Responses API 工具输出不是数组")
    calls: list[FunctionCall] = []
    for item in output:
        if not isinstance(item, dict) or item.get("type") != "function_call":
            continue
        if item.get("status") not in (None, "completed"):
            raise ModelRequestError("Responses API 返回了未完成的工具调用")
        call_id, name = item.get("call_id"), item.get("name")
        if not isinstance(call_id, str) or not isinstance(name, str):
            raise ModelRequestError("Responses API 工具调用缺少ID或名称")
        calls.append(FunctionCall(call_id, name, _parse_arguments(item.get("arguments"), name)))
    return _unique_calls(calls)


def _parse_chat_call_items(message: dict[str, Any]) -> tuple[FunctionCall, ...]:
    raw_calls = message.get("tool_calls", [])
    if not isinstance(raw_calls, list):
        raise ModelRequestError("Chat Completions 工具调用不是数组")
    calls: list[FunctionCall] = []
    for item in raw_calls:
        if not isinstance(item, dict) or item.get("type") != "function":
            raise ModelRequestError("Chat Completions 返回了不支持的工具调用类型")
        function = item.get("function")
        if not isinstance(function, dict):
            raise ModelRequestError("Chat Completions 工具调用缺少函数定义")
        call_id, name = item.get("id"), function.get("name")
        if not isinstance(call_id, str) or not isinstance(name, str):
            raise ModelRequestError("Chat Completions 工具调用缺少ID或名称")
        calls.append(FunctionCall(call_id, name, _parse_arguments(function.get("arguments"), name)))
    return _unique_calls(calls)


def _responses_text(payload: dict[str, Any]) -> str | None:
    output_text = payload.get("output_text")
    if isinstance(output_text, str):
        return output_text
    pieces = []
    for item in payload.get("output", []):
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if isinstance(content, dict) and content.get("type") == "output_text":
                text = content.get("text")
                if isinstance(text, str):
                    pieces.append(text)
    return "".join(pieces) if pieces else None


def _chat_messages(instructions: str, conversation: str | list[dict[str, Any]]) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [{"role": "system", "content": instructions}]
    if isinstance(conversation, str):
        messages.append({"role": "user", "content": conversation})
    elif isinstance(conversation, list) and all(
        isinstance(item, dict) and item.get("role") in {"developer", "user", "assistant", "tool"}
        for item in conversation
    ):
        messages.extend(conversation)
    else:
        raise ValueError("对话历史必须是文本或带有效role的消息数组")
    return messages


def _responses_input(conversation: str | list[dict[str, Any]]) -> str | list[dict[str, Any]]:
    if isinstance(conversation, str):
        return conversation
    if isinstance(conversation, list) and all(
        isinstance(item, dict) and isinstance(item.get("type"), str) or
        isinstance(item, dict) and isinstance(item.get("role"), str)
        for item in conversation
    ):
        return conversation
    raise ValueError("Responses API 对话输入必须是文本或有效输入项数组")


def create_tool_turn(
    instructions: str,
    conversation: str | list[dict[str, Any]],
    tools: Sequence[FunctionTool],
    *,
    timeout_seconds: int = 45,
    max_output_tokens: int = 4000,
) -> ToolTurn:
    """Request one model turn; tool calls remain inert until a server dispatcher validates them."""
    config = llm_settings()
    if not config["configured"]:
        raise ModelRequestError("文本模型未配置")
    mode = str(config["api_mode"])
    definitions = _tool_definitions(tools, mode)
    if mode == "responses":
        body = {
            "model": config["model"],
            "instructions": instructions,
            "input": _responses_input(conversation),
            "tools": definitions,
            "tool_choice": "auto",
            "parallel_tool_calls": False,
            "max_output_tokens": max_output_tokens,
            "store": False,
        }
    elif mode == "chat_completions":
        body = {
            "model": config["model"],
            "messages": _chat_messages(instructions, conversation),
            "tools": definitions,
            "tool_choice": "auto",
            "parallel_tool_calls": False,
            "max_completion_tokens": max_output_tokens,
        }
    else:
        raise ModelRequestError(f"不支持工具调用的模型接口模式：{mode}")

    payload = _request_json_body(config, body, timeout_seconds)
    refusal = None
    if mode == "responses":
        if payload.get("status") not in (None, "completed"):
            raise ModelRequestError("Responses API 工具回合未正常完成")
        calls = _parse_responses_calls(payload)
        items = payload.get("output", [])
        for output in items if isinstance(items, list) else []:
            if not isinstance(output, dict) or output.get("type") != "message":
                continue
            for item in output.get("content", []):
                if isinstance(item, dict) and item.get("type") == "refusal" and isinstance(item.get("refusal"), str):
                    refusal = item["refusal"]
        text = _responses_text(payload)
        continuation = tuple(items) if calls and isinstance(items, list) else ()
    else:
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise ModelRequestError("Chat Completions 没有返回有效选择")
        choice = choices[0]
        message = choice.get("message")
        if not isinstance(message, dict):
            raise ModelRequestError("Chat Completions 没有返回assistant消息")
        calls = _parse_chat_call_items(message)
        finish_reason = choice.get("finish_reason")
        if calls and finish_reason not in (None, "tool_calls"):
            raise ModelRequestError("Chat Completions 工具回合结束状态无效")
        if finish_reason == "length":
            raise ModelRequestError("Chat Completions 工具回合输出超过模型限制")
        raw_refusal = message.get("refusal")
        refusal = raw_refusal if isinstance(raw_refusal, str) else None
        text = _chat_message_text(message.get("content"))
        continuation = (message,) if calls else ()

    if calls and refusal:
        raise ModelRequestError("模型响应同时包含拒绝与工具调用，已阻止执行")
    if not calls and not text and not refusal:
        raise ModelRequestError("模型工具回合没有可用的文本、工具调用或拒绝结果")
    return ToolTurn(
        api_mode=mode,
        model=str(config["model"]),
        response_id=payload.get("id") if isinstance(payload.get("id"), str) else None,
        text=text,
        calls=calls,
        continuation_items=continuation,
        refusal=refusal,
    )


def probe_function_calling(timeout_seconds: int = 30) -> dict[str, Any]:
    """Verify one synthetic function call and its result without user or market data."""
    config = llm_settings()
    if not config["configured"]:
        return {
            "connected": False,
            "tool_calling_supported": False,
            "round_trip_completed": False,
            "reason": "model_not_configured",
        }

    tool = FunctionTool(
        name="screening_connection_probe",
        description="Return the provided synthetic integer unchanged. This function has no external side effects.",
        parameters={
            "type": "object",
            "properties": {"value": {"type": "integer"}},
            "required": ["value"],
            "additionalProperties": False,
        },
    )
    instructions = (
        "This is a synthetic function-calling health check. Call screening_connection_probe exactly once "
        "with value 731, then state the returned value. Do not call any other function."
    )
    prompt = "Run the synthetic function-calling health check."
    started = time.perf_counter()
    try:
        first = create_tool_turn(
            instructions, prompt, [tool], timeout_seconds=timeout_seconds, max_output_tokens=300
        )
        if first.refusal or len(first.calls) != 1:
            return {
                "connected": True,
                "tool_calling_supported": False,
                "round_trip_completed": False,
                "model": str(config["model"]),
                "api_mode": str(config["api_mode"]),
                "reason": "synthetic_function_call_not_returned",
                "latency_ms": round((time.perf_counter() - started) * 1000),
            }
        call = first.calls[0]
        if call.name != tool.name or call.arguments != {"value": 731}:
            return {
                "connected": True,
                "tool_calling_supported": True,
                "round_trip_completed": False,
                "model": str(config["model"]),
                "api_mode": str(config["api_mode"]),
                "reason": "synthetic_function_arguments_invalid",
                "latency_ms": round((time.perf_counter() - started) * 1000),
            }

        if first.api_mode == "responses":
            continuation: list[dict[str, Any]] = [
                {"role": "user", "content": [{"type": "input_text", "text": prompt}]}
            ]
        else:
            continuation = [{"role": "user", "content": prompt}]
        continuation.extend(first.continuation_items)
        continuation.extend(tool_output_items(first, {call.call_id: {"status": "ok", "value": 731}}))
        final = create_tool_turn(
            instructions,
            continuation,
            [tool],
            timeout_seconds=timeout_seconds,
            max_output_tokens=300,
        )
        round_trip = not final.calls and not final.refusal and bool(final.text)
        return {
            "connected": True,
            "tool_calling_supported": True,
            "round_trip_completed": round_trip,
            "echo_confirmed": bool(round_trip and "731" in final.text),
            "model": str(config["model"]),
            "api_mode": str(config["api_mode"]),
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "reason": None if round_trip else "synthetic_tool_output_not_consumed",
        }
    except (ModelRequestError, ValueError) as exc:
        return {
            "connected": True,
            "tool_calling_supported": False,
            "round_trip_completed": False,
            "model": str(config["model"]),
            "api_mode": str(config["api_mode"]),
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "reason": str(exc)[:200],
        }
