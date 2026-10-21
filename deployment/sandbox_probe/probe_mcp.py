"""Non-business stdio MCP server for the offline SDK compatibility probe."""
import json
import sys
from pathlib import Path

for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    method = message.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "probe", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "echo", "description": "Return the probe text.", "annotations": {"readOnlyHint": True, "destructiveHint": False}, "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False}}]}
    elif method == "tools/call":
        Path("mcp-proof.json").write_text(json.dumps(message["params"]["arguments"]), encoding="utf-8")
        result = {"content": [{"type": "text", "text": message["params"]["arguments"]["text"]}], "isError": False}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
