"""Build a Kairos Skill ZIP for the hosted research workbench."""

import argparse
from base64 import b64encode
from hashlib import sha256, sha384
import json
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
from urllib.parse import urljoin
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
NAME = "llm-research-workbench"
ONLINE_NAME = f"{NAME}-online"
SHARED_PANEL_NAME = f"{NAME}-workspace"
PANEL_RUNTIME_FILES = ("workbench-panel.js", "workbench-panel.css")
SOURCE = ROOT / "skills" / "kairos" / NAME
PANEL_CATALOG = ROOT / "apps" / "web" / "src" / "workbench-panels" / "catalog.json"
ARTIFACTS = ROOT / "artifacts" / "kairos-workbench"
MCP_TEMPLATE = "assets/mcp-remote.json"
MCP_NAME = "llm-research-workbench-remote"
BASIC = re.compile(r"Basic [A-Za-z0-9+/]+={0,2}")
OPEN_REQUESTS = {
    "status": ("workbench_status", {}),
    "research-projects": ("workbench_read", {"operation": "GET /api/v1/research-projects"}),
    "saved-screening-tasks": ("workbench_read", {"operation": "GET /api/v1/saved-screening-tasks"}),
    "watchlists": ("workbench_read", {"operation": "GET /api/v1/watchlists"}),
    "observation-panel": ("workbench_read", {
        "operation": "GET /api/v1/observation/entries",
        "query": {"limit": 12, "include_metrics": False},
    }),
}
FILES = (
    "SKILL.md",
    "references/setup.md",
    "references/project-review.md",
    "references/screening.md",
    "references/client-service.md",
    "references/observation-panel.md",
    "assets/observation-panel.html",
    MCP_TEMPLATE,
)


def curl_config(endpoint: str, authorization: str, *headers: str) -> str:
    return (
        f'url = "{endpoint}"\n'
        'proto = "=https"\n'
        'request = "POST"\n'
        'header = "Content-Type: application/json"\n'
        f'header = "Authorization: {authorization}"\n'
        + "".join(f'header = "{header}"\n' for header in headers)
        + 'silent\nshow-error\nfail\nconnect-timeout = 8\nmax-time = 60\n'
    )


def connection_files(connection: Path) -> dict[str, str]:
    template = json.loads((SOURCE / MCP_TEMPLATE).read_text(encoding="utf-8"))
    endpoint = template["mcpServers"][MCP_NAME]["url"]
    try:
        config = json.loads(connection.read_text(encoding="utf-8-sig"))
        server = config["mcpServers"][MCP_NAME]
        authorization = server["headers"]["Authorization"]
        if server["url"] != endpoint or not isinstance(authorization, str):
            raise ValueError
        if BASIC.fullmatch(authorization) is None:
            raise ValueError
    except (OSError, ValueError, TypeError, KeyError):
        raise ValueError(f"请提供 {endpoint} 的有效工作台 MCP 配置。") from None

    files = {
        "assets/hosted-mcp.curl": curl_config(
            endpoint, authorization, "Accept: application/json, text/event-stream",
            "MCP-Protocol-Version: 2025-11-25",
        ),
        "references/packaged-connection.md": (SOURCE / "references/packaged-connection.md").read_text(encoding="utf-8"),
    }
    for example, (tool, arguments) in OPEN_REQUESTS.items():
        files[f"assets/requests/{example}.json"] = json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }, ensure_ascii=False)
    return files


def panel_runtime_path(asset_dir: Path) -> str:
    try:
        fingerprints = b"".join(sha256((asset_dir / name).read_bytes()).digest() for name in PANEL_RUNTIME_FILES)
    except OSError:
        raise ValueError("请先构建共享面板的 JS 和 CSS。") from None
    return "/_workbench/panels/" + sha256(fingerprints).hexdigest()[:16]


def panel_support_files() -> dict[str, str]:
    renderer = "scripts/render-workspace-panel.ps1"
    return {
        "assets/workbench-panels.json": PANEL_CATALOG.read_text(encoding="utf-8"),
        "references/workspace-panels.md": (SOURCE / "references/workspace-panels.md").read_text(encoding="utf-8"),
        renderer: "\ufeff" + (SOURCE / renderer).read_text(encoding="utf-8-sig"),
    }


def shared_panel_files(asset_dir: Path) -> dict[str, str]:
    runtime = panel_runtime_path(asset_dir)
    endpoint = json.loads((SOURCE / MCP_TEMPLATE).read_text(encoding="utf-8"))["mcpServers"][MCP_NAME]["url"]
    assets = {
        name: (urljoin(endpoint, f"{runtime}/{name}"), "sha384-" + b64encode(sha384((asset_dir / name).read_bytes()).digest()).decode("ascii"))
        for name in PANEL_RUNTIME_FILES
    }
    script_url, script_hash = assets["workbench-panel.js"]
    style_url, style_hash = assets["workbench-panel.css"]
    return {
        **panel_support_files(),
        "assets/workspace-panel.html": f'''<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>投研工作台</title>
<link rel="stylesheet" href="{style_url}" crossorigin="anonymous" integrity="{style_hash}">
<div id="workbench-panel">正在加载投研工作台面板…</div>
<script type="application/json" id="workbench-panel-data">__LLMR_PANEL_DATA__</script>
<script defer src="{script_url}" crossorigin="anonymous" integrity="{script_hash}" onerror="document.getElementById('workbench-panel').textContent='面板组件暂未加载，请重新打开面板。'"></script>
</html>
''',
    }


def build(output: Path, *, connection: Path | None = None, panel_assets: Path | None = None) -> None:
    if panel_assets and connection is None:
        raise ValueError("共享面板需要工作台 MCP 配置。")
    files = connection_files(connection) if connection else {}
    if panel_assets:
        files.update(shared_panel_files(panel_assets))
    skill_root = SHARED_PANEL_NAME if panel_assets else ONLINE_NAME if connection else NAME
    if connection:
        entry = (SOURCE / "SKILL.md").read_text(encoding="utf-8")
        files["SKILL.md"] = entry.replace(f"\nname: {NAME}\n", f"\nname: {skill_root}\n", 1)
    output.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=output.parent, suffix=".zip.tmp", delete=False) as temporary:
        pending = Path(temporary.name)
    try:
        with ZipFile(pending, "w", ZIP_DEFLATED) as archive:
            for name, content in files.items():
                archive.writestr(f"{skill_root}/{name}", content)
            for name in FILES:
                if panel_assets and name in ("references/observation-panel.md", "assets/observation-panel.html"):
                    continue
                if name not in files:
                    archive.write(SOURCE / name, f"{skill_root}/{name}")
        pending.replace(output)
    finally:
        pending.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--mcp-config", type=Path, help="工作台维护者发放的 MCP 配置文件")
    parser.add_argument("--panel-assets", type=Path, help="已构建并发布的共享面板运行资源目录")
    args = parser.parse_args()
    default_name = f"{NAME}-kairos.zip" if args.mcp_config else f"{NAME}.zip"
    output = args.output or ARTIFACTS / default_name
    try:
        build(output, connection=args.mcp_config, panel_assets=args.panel_assets)
    except ValueError as exc:
        parser.error(str(exc))
    print(output.resolve())


if __name__ == "__main__":
    main()
