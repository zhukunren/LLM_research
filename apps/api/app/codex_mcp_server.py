"""Small stdio MCP bridge for the server-owned investment tools.

Codex is the only reasoning runtime. This process only exposes validated
application capabilities and never decides whether a research request is
complete. The parent Codex turn supplies the conversation context through the
database-backed conversation and turn identifiers.
"""

from __future__ import annotations

import json
import os
import sys
from uuid import uuid4
from typing import Any

from . import conversation_store, screening_tools
from .codex_context import task_tool_context
from .tool_protocol import ToolCall
from .screening_contracts import ScreeningTaskRevision


PROTOCOL_VERSION = "2024-11-05"


def _debug(message: str) -> None:
    path = os.environ.get("LLMR_MCP_DEBUG_LOG", "").strip()
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as stream:
            stream.write(message + "\n")
    except OSError:
        pass


def _write(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _error(request_id: Any, code: int, message: str) -> None:
    _write({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def _context() -> screening_tools.ToolContext:
    conversation_id = os.environ.get("LLMR_CODEX_CONVERSATION_ID", "")
    turn_id = os.environ.get("LLMR_CODEX_TURN_ID", "")
    try:
        revision = int(os.environ.get("LLMR_CODEX_TASK_REVISION", "0"))
    except ValueError:
        revision = 0
    task: ScreeningTaskRevision | None = None
    try:
        conversation = conversation_store.get_conversation(conversation_id, message_limit=1)
        revision = conversation["task_revision"]
    except conversation_store.ConversationNotFound:
        pass
    if revision:
        try:
            task = conversation_store.get_task_revision(conversation_id, revision)
        except conversation_store.ConversationNotFound:
            task = None
    source_refs: list[dict[str, Any]] = []
    try:
        app_turn = conversation_store.get_turn(conversation_id, turn_id)
        source_refs = conversation_store.get_user_message(
            conversation_id,
            app_turn["user_message_id"],
        )["source_refs"]
    except conversation_store.ConversationNotFound:
        pass
    return task_tool_context(
        conversation_id,
        turn_id,
        revision,
        task,
        source_refs,
    )


def _tools() -> list[dict[str, Any]]:
    return [tool.as_mcp() for tool in screening_tools.registry.tools_for_codex()]


def _call(arguments: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    name = arguments.get("name")
    if not isinstance(name, str):
        return {"ok": False, "error": {"code": "invalid_tool_call", "message": "缺少工具名称"}}, True
    call_id = arguments.get("call_id")
    if not isinstance(call_id, str) or not call_id:
        call_id = f"codex-{uuid4()}"
    call_arguments = arguments.get("arguments", {})
    if not isinstance(call_arguments, dict):
        return {"ok": False, "error": {"code": "invalid_tool_arguments", "message": "工具参数必须是对象"}}, True
    result = screening_tools.registry.dispatch(
        ToolCall(call_id=call_id, name=name, arguments=call_arguments),
        _context(),
    )
    return result, not bool(result.get("ok"))


def serve() -> None:
    for raw in sys.stdin:
        _debug("recv " + raw.strip()[:1000])
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            _error(None, -32700, "Invalid JSON")
            continue
        if not isinstance(request, dict):
            _error(None, -32600, "Invalid Request")
            continue
        method = request.get("method")
        request_id = request.get("id")
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        if request_id is None:
            continue
        if method == "initialize":
            requested = params.get("protocolVersion")
            version = requested if isinstance(requested, str) and requested else PROTOCOL_VERSION
            _write(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "protocolVersion": version,
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": "llm-research-tools", "version": "1"},
                        "instructions": "Use get_research_state first for screening requests. Save task revisions only with propose_screening_task. Execution authorization requires an explicit current user request.",
                    },
                }
            )
        elif method == "notifications/initialized":
            continue
        elif method == "ping":
            _write({"jsonrpc": "2.0", "id": request_id, "result": {}})
        elif method == "tools/list":
            _write({"jsonrpc": "2.0", "id": request_id, "result": {"tools": _tools()}})
        elif method == "tools/call":
            name = params.get("name")
            call_id = params.get("_call_id") or f"codex-{request_id}"
            _debug(f"call {request_id} {name}")
            result, failed = _call({"name": name, "call_id": call_id, "arguments": params.get("arguments", {})})
            _debug(f"done {request_id} failed={failed}")
            _write(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                        "isError": failed,
                    },
                }
            )
        else:
            _error(request_id, -32601, f"Method not found: {method}")


if __name__ == "__main__":
    serve()
