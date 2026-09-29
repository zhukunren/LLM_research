from __future__ import annotations

import json
import os
import subprocess
import sys

from apps.api.app import conversation_store, db
from apps.api.app.settings import PROJECT_ROOT


def test_codex_mcp_stdio_tools_call_roundtrip(tmp_path, monkeypatch):
    database_path = tmp_path / "mcp-roundtrip.db"
    monkeypatch.setattr(db, "DB_PATH", database_path)
    db.init_db()
    conversation = conversation_store.create_conversation("screening")
    message = conversation_store.add_user_message(
        conversation["id"], "mcp-roundtrip", 0, "读取当前研究状态。"
    )
    conversation_store.start_turn(conversation["id"], message["turn_id"])

    environment = os.environ.copy()
    environment["LLMR_DB_PATH"] = str(database_path)
    environment["LLMR_CODEX_CONVERSATION_ID"] = conversation["id"]
    environment["LLMR_CODEX_TURN_ID"] = message["turn_id"]
    environment["LLMR_CODEX_TASK_REVISION"] = "0"
    environment["PYTHONIOENCODING"] = "utf-8"
    project_root = str(PROJECT_ROOT)
    environment["PYTHONPATH"] = os.pathsep.join(
        item for item in (project_root, environment.get("PYTHONPATH", "")) if item
    )
    process = subprocess.Popen(
        [sys.executable, "-m", "apps.api.app.codex_mcp_server"],
        cwd=str(PROJECT_ROOT),
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    request_lines = "\n".join([
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}, ensure_ascii=False),
        json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}, ensure_ascii=False),
        json.dumps({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "get_research_state", "arguments": {}},
        }, ensure_ascii=False),
    ]) + "\n"
    assert process.stdin is not None
    process.stdin.write(request_lines)
    process.stdin.close()
    stdout = process.stdout.read() if process.stdout is not None else ""
    stderr = process.stderr.read() if process.stderr is not None else ""
    process.wait(timeout=15)
    assert process.returncode == 0, stderr
    responses = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    tool_response = next(item for item in responses if item.get("id") == 2)
    assert tool_response["result"]["isError"] is False
    payload = json.loads(tool_response["result"]["content"][0]["text"])
    assert payload["ok"] is True
    assert payload["result"]["task_revision"] == 0
