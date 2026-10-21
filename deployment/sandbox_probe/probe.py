"""Exercise the real pinned SDK/runtime against a deterministic offline provider.

No application imports, model account, or service credentials are used.
"""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
import os
from pathlib import Path
import sys
from threading import Thread

from openai_codex import ApprovalMode, Codex, CodexConfig, LocalImageInput, Sandbox, TextInput, TurnHandle
from openai_codex.generated.v2_all import CommandExecResponse, TurnStartParams


class Provider(BaseHTTPRequestHandler):
    requests: list[dict] = []
    tool_requested = False

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(body)
        functions = [tool for tool in body.get("tools", []) if "echo" in tool.get("name", "")]
        namespaces = [namespace for item in body.get("input", []) if item.get("type") == "additional_tools" for namespace in item.get("tools", [])]
        executor = next((tool for namespace in namespaces if namespace.get("name") == "functions" for tool in namespace.get("tools", []) if tool.get("name") == "exec"), None)
        if not self.tool_requested and (functions or executor):
            type(self).tool_requested = True
            if functions:
                item = {"id": "fc_probe", "type": "function_call", "call_id": "probe_echo", "name": functions[0]["name"], "arguments": json.dumps({"text": "sdk-probe-mcp"})}
            else:
                item = {"id": "fc_probe", "type": "custom_tool_call", "call_id": "probe_echo", "namespace": "functions", "name": "exec", "input": "const t = ALL_TOOLS.find(x => /mcp.*probe.*echo/.test(x.name)); if (!t) throw new Error('Probe MCP tool missing'); text(await tools[t.name]({text: 'sdk-probe-mcp'}));"}
        else:
            item = {"id": "msg_probe", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "sdk-probe-ok", "annotations": []}]}
        response = {"id": "resp_probe", "object": "response", "status": "completed", "output": [item], "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        events = [
            {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
            {"type": "response.output_item.added", "output_index": 0, "item": item},
        ]
        if item["type"] == "message":
            events.append({"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": "sdk-probe-ok"})
        events.extend([
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": response},
        ])
        for event in events:
            self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
        self.wfile.flush()


def run(work: Path, *, container: bool, external_sandbox: bool = False) -> dict:
    work.mkdir(parents=True, exist_ok=True)
    (work / "mcp-proof.json").unlink(missing_ok=True)
    scratch = work / "tmp"
    scratch.mkdir(exist_ok=True)
    state = Path(os.environ.get("CODEX_HOME") or work / "codex-state")
    state.mkdir(parents=True, exist_ok=True)
    report: dict = {"sdk_version": importlib.metadata.version("openai-codex"), "platform": sys.platform,
                    "mode": "container" if container else "native_protocol_only", "external_sandbox": external_sandbox, "checks": {}}
    if report["sdk_version"] != "0.159.0":
        raise RuntimeError("Probe must use the project's pinned openai-codex==0.159.0")
    if external_sandbox:
        if not container:
            raise RuntimeError("External sandbox mode is only allowed in the explicit container probe")
        sentinel = Path("/opt/research-runtime/immutable-code.txt")
        if Path("/opt/app").exists() or not sentinel.is_file():
            raise RuntimeError("Minimal immutable runtime is required")
        try:
            sentinel.write_text("modified")
        except OSError:
            report["checks"]["runtime_code_read_only"] = sentinel.read_text().strip() == "immutable-code-sentinel"
        else:
            raise RuntimeError("Refusing external sandbox mode in a writable runtime")
    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    server = Thread(target=provider.serve_forever, daemon=True)
    server.start()
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
        "PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "PLAYWRIGHT_BROWSERS_PATH", "LANG", "TEMP", "TMP",
    }}
    env.update(CODEX_HOME=str(state), CODEX_SQLITE_HOME=str(state), LLMR_PROBE_KEY="offline-no-secret", PYTHONIOENCODING="utf-8",
               TEMP=str(scratch), TMP=str(scratch), TMPDIR=str(scratch))
    overrides = (
        'model_provider="probe"', 'model="gpt-6-luna"', 'model_providers.probe.name="Offline compatibility probe"',
        f'model_providers.probe.base_url="http://127.0.0.1:{provider.server_port}/v1"',
        'model_providers.probe.wire_api="responses"', 'model_providers.probe.env_key="LLMR_PROBE_KEY"',
        'model_providers.probe.requires_openai_auth=false', 'model_providers.probe.supports_websockets=false',
        'model_providers.probe.request_max_retries=0', 'web_search="disabled"',
        'approval_policy="never"', 'sandbox_mode="workspace-write"',
        'sandbox_workspace_write.network_access=true',
        f'mcp_servers.probe.command={json.dumps(sys.executable)}',
        f'mcp_servers.probe.args=[{json.dumps(str(Path(__file__).with_name("probe_mcp.py")))}]',
        f'mcp_servers.probe.cwd={json.dumps(str(work))}',
        'mcp_servers.probe.required=true',
        'mcp_servers.probe.default_tools_approval_mode="auto"',
    ) + (('windows.sandbox="unelevated"',) if os.name == "nt" else ())
    try:
        with Codex(config=CodexConfig(cwd=str(work), env=env, config_overrides=overrides)) as codex:
            report["runtime_version"] = codex.metadata.serverInfo.version
            report["checks"]["sdk_initialize"] = True

            def command(code: str) -> CommandExecResponse:
                # Isolate this version-specific low-level access in the probe.
                return codex._client.request("command/exec", {
                    "command": [sys.executable, "-c", code], "cwd": str(work), "timeoutMs": 60000,
                    "sandboxPolicy": {"type": "externalSandbox", "networkAccess": "enabled"} if external_sandbox else {"type": "workspaceWrite", "writableRoots": [str(work)], "networkAccess": True},
                }, response_model=CommandExecResponse)

            def turn(thread, inputs):
                if not external_sandbox:
                    return thread.turn(inputs)
                # The public preset enum has no externalSandbox member in
                # 0.159.0. Use its typed app-server client only in this probe.
                wire = [{"type": "text", "text": item.text} if isinstance(item, TextInput)
                        else {"type": "localImage", "path": item.path} for item in inputs]
                params = TurnStartParams.model_validate({"threadId": thread.id, "input": wire,
                    "approvalPolicy": "never", "cwd": str(work),
                    "sandboxPolicy": {"type": "externalSandbox", "networkAccess": "enabled"}})
                response, subscription = codex._client._start_turn(thread.id, wire, params=params, for_handle=True)
                return TurnHandle(codex._client, thread.id, response.turn.id, _subscription=subscription)

            code = """from pathlib import Path
from PIL import Image
from openpyxl import Workbook, load_workbook
from docx import Document
from pptx import Presentation
from reportlab.pdfgen.canvas import Canvas
from pypdf import PdfReader
Path('outputs').mkdir(exist_ok=True)
Image.new('RGB',(80,80),'white').save('outputs/chart.png')
w=Workbook(); w.active['A1']='probe'; w.save('outputs/result.xlsx')
d=Document(); d.add_paragraph('probe'); d.save('outputs/result.docx')
p=Presentation(); p.slides.add_slide(p.slide_layouts[6]); p.save('outputs/result.pptx')
c=Canvas('outputs/result.pdf'); c.drawString(50,700,'probe'); c.save()
assert load_workbook('outputs/result.xlsx').active['A1'].value=='probe'
assert Document('outputs/result.docx').paragraphs[0].text=='probe'
assert len(Presentation('outputs/result.pptx').slides)==1
assert len(PdfReader('outputs/result.pdf').pages)==1
print('artifacts-ok')
"""
            result = command(code)
            report["checks"]["shell_python_artifacts"] = result.exit_code == 0 and "artifacts-ok" in result.stdout
            if result.exit_code:
                report["command_error"] = result.stderr[-2000:]
                return report
            browser = command("""import os
from pathlib import Path
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    options={'headless':True}
    if os.name=='nt':
        edge=Path(os.environ.get('PROGRAMFILES(X86)','C:/Program Files (x86)'))/'Microsoft/Edge/Application/msedge.exe'
        if edge.is_file(): options['executable_path']=str(edge)
    b=p.chromium.launch(**options); page=b.new_page(); page.goto('data:text/html,<h1>probe-browser</h1>')
    assert page.locator('h1').inner_text()=='probe-browser'
    page.screenshot(path='outputs/browser.png'); b.close()
print('browser-ok')
""")
            report["checks"]["headless_browser"] = browser.exit_code == 0 and "browser-ok" in browser.stdout
            if browser.exit_code:
                report["browser_error"] = browser.stderr[-2000:]
            thread = codex.thread_start(model="gpt-6-luna", model_provider="probe", cwd=str(work), sandbox=Sandbox.workspace_write, approval_mode=ApprovalMode.deny_all)
            handle = turn(thread, [TextInput(text="Call the echo probe, then acknowledge."), LocalImageInput(path=str(work / "outputs/chart.png"))])
            events = list(handle.stream())
            terminal = next((event for event in reversed(events) if event.method == "turn/completed"), None)
            report["checks"]["turn_stream_completed"] = bool(terminal and str(terminal.payload.turn.status).split('.')[-1].lower() == "completed")
            proof = work / "mcp-proof.json"
            report["checks"]["mcp_tool_call"] = proof.is_file() and json.loads(proof.read_text()) == {"text": "sdk-probe-mcp"}
            report["checks"]["image_input"] = any("data:image" in json.dumps(body) for body in Provider.requests)
            resumed = codex.thread_resume(thread.id, cwd=str(work), sandbox=Sandbox.workspace_write, approval_mode=ApprovalMode.deny_all)
            reply = turn(resumed, [TextInput(text="Acknowledge the resumed thread.")]).run()
            report["checks"]["thread_resume"] = reply.final_response == "sdk-probe-ok"
            if container:
                immutable = command("""from pathlib import Path
p=Path('/opt/research-runtime/immutable-code.txt')
assert not Path('/opt/app').exists()
assert p.read_text().strip()=='immutable-code-sentinel'
try:
    p.write_text('modified')
except OSError:
    print('immutable-ok')
else:
    raise RuntimeError('Runtime code is writable')
""")
                report["checks"]["runtime_code_read_only"] = immutable.exit_code == 0 and "immutable-ok" in immutable.stdout
    finally:
        provider.shutdown()
        provider.server_close()
    (work / "provider-requests.json").write_text(json.dumps(Provider.requests, ensure_ascii=True), encoding="utf-8")
    report["provider_called_echo"] = Provider.tool_requested
    report["event_methods"] = sorted({event.method for event in events})
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, default=Path("/workspace"))
    args = parser.parse_args()
    report = run(args.work.resolve(), container=os.environ.get("LLMR_PROBE_MODE") == "container",
                 external_sandbox=os.environ.get("LLMR_PROBE_EXTERNAL_SANDBOX") == "1")
    report["status"] = "passed" if all(report["checks"].values()) else "failed"
    print(json.dumps(report, ensure_ascii=True), flush=True)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
