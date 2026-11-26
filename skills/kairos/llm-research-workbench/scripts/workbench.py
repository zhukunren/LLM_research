"""MCP and command line adapter for the local LLM Research workbench."""

from __future__ import annotations

import argparse
import base64
import binascii
from dataclasses import dataclass
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path, PureWindowsPath
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import uuid4


TITLE = "LLM 投研工作平台"
VERSION = "1.4.1"
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_HOSTED_REQUEST_BYTES = 8 * 1024 * 1024
METHODS = {"GET", "POST", "PATCH", "PUT", "DELETE"}
PATH_FIELD = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
FILE_PATH_ROUTES = {
    "/api/v1/conversations/{conversation_id}/generated-files/{path}",
    "/api/v1/conversations/{conversation_id}/research-assets/{path}",
    "/api/v1/conversations/{conversation_id}/research-files/{path}",
}
ATTACHMENT_OPERATION = "POST /api/v1/conversations/{conversation_id}/attachments"
SERVICE_CARD_PNG_PATH = "/api/v1/client-service/cards/{card_id}/image.png"
SERVICE_PREVIEW_PATHS = {
    "/api/v1/client-service/preview", "/api/v1/client-service/opening-plans/preview",
    "/api/v1/client-service/rebalance-suggestions/preview", "/api/v1/client-service/celebrations",
}
PNG_DATA_URL = "data:image/png;base64,"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
HOSTED_WEB_ONLY = (
    "/api/v1/auth", "/api/v1/settings", "/api/v1/maintenance", "/api/v1/documents/import-local",
    "/api/v1/client-service/robots",
)
FILE_EXTENSIONS = {
    "application/json": ".json", "application/pdf": ".pdf", "text/csv": ".csv",
    "text/plain": ".txt", "text/markdown": ".md", "application/zip": ".zip",
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
}
GROUPS = {
    "projects": ("研究项目、证据和投资跟踪", "research-projects research-evidence investment-tracking observation watchlists"),
    "research": ("研究对话、研究方法、文件与交付", "conversations research-assistants research-models tasks"),
    "library": ("研报、资料和原始披露", "documents report-evaluations disclosures disclosure-imports"),
    "financial": ("财务数据与证据", "companies financial-data financial-facts"),
    "market": ("市场和情报", "news intelligence daily-signals securities security-catalog indicators"),
    "screening": ("选股、条件、指标、形态与策略", "screening-runs screening-capabilities screening-history screening-industries screening-templates saved-screening-tasks condition-builder condition-drafts dynamic-indicators filters patterns strategies qmt-docs"),
    "service": ("对客服务", "client-service"),
    "settings": ("任务、数据服务和系统设置", "health me auth jobs settings capabilities data maintenance tushare-download tushare-features"),
}
RESOURCE_GROUPS = {resource: group for group, (_, names) in GROUPS.items() for resource in names.split()}
OPERATION_LABELS = {
    "GET /api/v1/research-projects": "查找研究项目",
    "GET /api/v1/research-projects/{project_id}": "打开已有项目",
    "POST /api/v1/research-projects/{project_id}/companies/{stock_code}/changes": "检查项目的资料变化",
    "POST /api/v1/research-projects/{project_id}/change-checks/{check_id}/review": "保存资料变化复核意见",
    "PATCH /api/v1/research-projects/{project_id}/notes/{note_id}": "保存研究笔记新版本",
    "GET /api/v1/research-projects/{project_id}/notes/{note_id}/history": "查看研究笔记历史版本",
    "POST /api/v1/disclosures/upload": "上传用户提供的披露 PDF",
    "POST /api/v1/disclosures/import-url": "归档官方披露链接",
    "GET /api/v1/disclosure-imports/{import_id}": "查询披露导入进度",
    ATTACHMENT_OPERATION: "为研究对话上传用户附件",
    "GET /api/v1/jobs/{job_id}": "查询后台任务进度",
    "POST /api/v1/jobs/{job_id}/cancel": "取消指定后台任务",
    "POST /api/v1/jobs/{job_id}/retry": "重试可重试的后台任务",
    "GET /api/v1/screening-templates": "查找可直接试算的固定选股规则",
    "POST /api/v1/screening-templates/{template_id}/preview": "用一只股票试算规则",
    "GET /api/v1/strategies": "查找现有选股组合及其版本",
    "POST /api/v1/strategies/validate": "检查组合中条件和形态的版本引用",
    "POST /api/v1/strategies": "保存选股组合新版本",
    "POST /api/v1/screening-runs": "按选定组合版本提交正式或探索筛选",
    "GET /api/v1/screening-runs/{run_id}/decisions": "读取固定批次结果、明细和依据",
    "GET /api/v1/screening-runs/{run_id}/export": "下载该次筛选的 CSV",
    "GET /api/v1/saved-screening-tasks": "查找已保存的对话选股方案",
    "GET /api/v1/disclosures/versions/{version_id}/pages/{page}": "读取原始披露的物理页",
    "GET /api/v1/disclosures/versions/{version_id}/pdf": "下载已归档的原始披露 PDF",
}


class BridgeError(Exception):
    def __init__(self, message, *, status=None, detail=None):
        super().__init__(message)
        self.status = status
        self.detail = detail

    def payload(self):
        value = {"ok": False, "error": str(self)}
        if self.status is not None:
            value["status"] = self.status
        if self.detail is not None:
            value["detail"] = self.detail
        return value


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = build_opener(ProxyHandler({}), NoRedirect())


def load_object(path, *, optional=False):
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        if optional:
            return {}
        raise
    if not isinstance(value, dict):
        raise BridgeError("配置或请求文件必须是 JSON 对象。")
    return value


def project_root(explicit=None):
    def is_workbench(path):
        return (path / "scripts" / "start.ps1").is_file() and (path / "apps" / "api" / "app" / "main.py").is_file()

    if explicit:
        path = Path(explicit).expanduser().resolve()
        if not is_workbench(path):
            raise BridgeError("指定目录不是投研工作台项目根目录。")
        return path
    source = Path(__file__).resolve()
    bundled = source.parents[1] / "assets" / "workbench"
    for candidate in (bundled, *source.parents, Path.cwd(), *Path.cwd().parents):
        if is_workbench(candidate):
            return candidate
    return None


def origin(value):
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError:
        port = None
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}
            or parsed.username is not None or parsed.password is not None or not port
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise BridgeError("适配器只连接明确指定端口的本机投研工作台。")
    return f"http://127.0.0.1:{port}"


def hosted_origin():
    value = os.environ.get("LLMR_WORKBENCH_PUBLIC_ORIGIN", "").rstrip("/")
    if not value:
        return None
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment or any(ord(char) <= 32 for char in value)):
        raise BridgeError("远程工作台地址必须是 HTTPS 站点根地址。")
    return value


def service_image(png):
    if not png.startswith(PNG_SIGNATURE) or len(png) > MAX_JSON_BYTES:
        raise BridgeError("工作台返回的服务图片格式或大小无效。")
    return {"type": "image", "mimeType": "image/png", "data": base64.b64encode(png).decode("ascii")}


def request(base, path, *, method="GET", data=None, content_type=None, timeout=30, allow_link=False,
            inline_png=False):
    headers = {"Accept": "application/json"}
    if content_type:
        headers["Content-Type"] = content_type
    req = Request(base + path, method=method, data=data, headers=headers)
    try:
        with OPENER.open(req, timeout=timeout) as response:
            media_type = response.headers.get_content_type()
            if media_type == "text/event-stream":
                raise BridgeError("此接口使用持续事件流，请用任务或会话查询接口获取进度。")
            if inline_png and media_type == "image/png":
                png = response.read(MAX_JSON_BYTES + 1)
                expected = response.headers.get("Content-Length", "")
                if expected.isdecimal() and int(expected) != len(png):
                    raise BridgeError("服务图片下载不完整，请重试。")
                return response.status, {
                    "url": base + path, "media_type": media_type, "bytes": len(png), "sha256": sha256(png).hexdigest(),
                    "_mcp_image": service_image(png),
                }
            if allow_link and (response.headers.get("Content-Disposition") or media_type in {
                "application/pdf", "application/octet-stream", "text/html", "text/csv", "application/zip"
            } or media_type.startswith(("image/", "application/vnd."))):
                return response.status, {"url": base + path, "media_type": media_type}
            blob = response.read(MAX_JSON_BYTES + 1)
            if len(blob) > MAX_JSON_BYTES:
                raise BridgeError("响应过大，请使用接口的筛选或分页参数。")
            if not blob:
                return response.status, None
            if media_type != "application/json" and not media_type.endswith("+json"):
                if allow_link:
                    return response.status, {"url": base + path, "media_type": media_type}
                raise BridgeError("该地址没有返回工作台 JSON。")
            return response.status, json.loads(blob)
    except HTTPError as exc:
        with exc:
            body = exc.read(24000)
        try:
            detail = json.loads(body)
        except (ValueError, UnicodeError):
            detail = None
        message = "工作台拒绝了该操作。"
        if exc.code == 409:
            message = "当前状态或版本有冲突，请重新读取后再决定。"
        raise BridgeError(message, status=exc.code, detail=detail) from exc
    except (URLError, TimeoutError, ConnectionError) as exc:
        raise BridgeError("连接本机工作台失败或请求超时。请确认工作台和后台进程正在运行。") from exc


def download(base, path, exports):
    req = Request(base + path, headers={"Accept": "*/*"})
    try:
        with OPENER.open(req, timeout=60) as response:
            media_type = response.headers.get_content_type()
            if media_type in {"text/event-stream", "text/html"}:
                raise BridgeError("此操作返回网页或事件流，请选择原件、文件下载或结果查询接口。")
            extension = FILE_EXTENSIONS.get(media_type) or mimetypes.guess_extension(media_type) or ".bin"
            name = response.headers.get_filename() or ("工作台结果" + extension)
            name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")[:140]
            if not name:
                name = "工作台结果" + extension
            elif not Path(name).suffix:
                name += extension
            if PureWindowsPath(name).is_reserved():
                name = "_" + name
            expected = response.headers.get("Content-Length", "")
            if expected.isdecimal() and int(expected) > MAX_FILE_BYTES:
                raise BridgeError("文件超过 50 MB，请缩小范围或按批次导出。")
            folder = exports / uuid4().hex
            folder.mkdir(parents=True, exist_ok=False)
            file = folder / name
            size, digest = 0, sha256()
            try:
                with file.open("xb") as destination:
                    while chunk := response.read(128 * 1024):
                        size += len(chunk)
                        if size > MAX_FILE_BYTES:
                            raise BridgeError("文件超过 50 MB，请缩小范围或按批次导出。")
                        digest.update(chunk)
                        destination.write(chunk)
                if not size or (expected.isdecimal() and size != int(expected)):
                    raise BridgeError("文件为空或下载不完整，请检查任务状态后重试。")
            except Exception:
                file.unlink(missing_ok=True)
                folder.rmdir()
                raise
            return {"local_path": str(file), "filename": name, "media_type": media_type,
                    "bytes": size, "sha256": digest.hexdigest()}
    except HTTPError as exc:
        exc.close()
        raise BridgeError("工作台无法交付该文件。请检查文件或任务状态。", status=exc.code) from exc
    except (URLError, TimeoutError, ConnectionError) as exc:
        raise BridgeError("下载中断。请在本机工作台恢复后重试。") from exc


def compact(value, *, chars=1600, items=12, depth=0):
    if isinstance(value, str):
        return value if len(value) <= chars else value[:chars] + "…"
    if isinstance(value, list):
        result = [compact(item, chars=chars, items=items, depth=depth + 1) for item in value[:items]]
        if len(value) > items:
            result.append({"more_items": len(value) - items})
        return result
    if isinstance(value, dict):
        if depth >= 10:
            return {"more_fields": len(value)}
        return {key: compact(item, chars=chars, items=items, depth=depth + 1) for key, item in value.items()}
    return value


def response_data(value):
    text = json.dumps(value, ensure_ascii=False)
    if len(text) <= 28000:
        return {"data": value, "summary": False}
    shorter = compact(value)
    if len(json.dumps(shorter, ensure_ascii=False)) > 38000:
        shorter = compact(value, chars=400, items=4)
    if len(json.dumps(shorter, ensure_ascii=False)) > 45000:
        if isinstance(value, dict):
            shorter = {"available_fields": list(value)}
        else:
            shorter = {"total_items": len(value)} if isinstance(value, list) else None
    return {"data": shorter, "summary": True, "hint": "用 select 取所需字段，或用接口的分页参数继续读取。"}


def choose_fields(data, selectors):
    result = {}
    for selector in selectors:
        value = data
        try:
            for part in selector.split("."):
                value = value[int(part)] if isinstance(value, list) else value[part]
        except (ValueError, IndexError, KeyError, TypeError):
            raise BridgeError(f"找不到结果字段 {selector}。") from None
        result[selector] = value
    return result


def multipart(form, files, *, hosted=False):
    boundary = uuid4().hex
    chunks = []
    total = 0

    def add(name, value, *, filename=None, media_type=None):
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise BridgeError("上传表单字段名无效。")
        header = f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"'
        if filename is not None:
            if any(c in filename for c in '"\r\n'):
                raise BridgeError("上传文件名含无效字符。")
            header += f'; filename="{filename}"\r\nContent-Type: {media_type}'
        chunks.extend((header.encode("utf-8"), b"\r\n\r\n", value, b"\r\n"))

    for name, value in form.items():
        encoded = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        add(name, encoded.encode("utf-8"))
    for name, values in files.items():
        for value in values if isinstance(values, list) else [values]:
            if hosted:
                if not isinstance(value, dict) or set(value) != {"filename", "content_base64"}:
                    raise BridgeError("远程附件请传入 filename 和 content_base64，也可从工作台网页上传。")
                filename, encoded = value["filename"], value["content_base64"]
                if (not isinstance(filename, str) or not 0 < len(filename) <= 240 or filename in {".", ".."}
                        or any(c in '/\\:<>"|?*' or ord(c) < 32 for c in filename)):
                    raise BridgeError("远程附件请使用简单文件名。")
                if not isinstance(encoded, str) or len(encoded) > MAX_HOSTED_REQUEST_BYTES:
                    raise BridgeError("远程附件内容超过 8 MiB 请求限额，请从工作台网页上传。")
                try:
                    data = base64.b64decode(encoded, validate=True)
                except (ValueError, binascii.Error) as exc:
                    raise BridgeError("远程附件的 Base64 格式无效。") from exc
            else:
                if not isinstance(value, str):
                    raise BridgeError("上传文件必须使用用户提供的本机绝对路径。")
                path = Path(value)
                if value.startswith(("\\\\", "//")) or not path.is_absolute() or not path.is_file():
                    raise BridgeError("上传文件必须是可读取的本机文件，不能使用共享网络路径。")
                filename = path.name
                with path.open("rb") as handle:
                    data = handle.read(MAX_FILE_BYTES - total + 1)
            total += len(data)
            if total > MAX_FILE_BYTES:
                raise BridgeError("本次上传文件总量超过 50 MB。")
            add(name, data, filename=filename, media_type=mimetypes.guess_type(filename)[0] or "application/octet-stream")
    chunks.append(f"--{boundary}--\r\n".encode("ascii"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def binary_field(schema):
    return (schema.get("format") == "binary" or schema.get("contentMediaType") == "application/octet-stream"
            or (isinstance(schema.get("items"), dict) and binary_field(schema["items"])))


@dataclass(frozen=True)
class Operation:
    method: str
    path: str
    metadata: dict
    group: str

    @property
    def key(self):
        return f"{self.method} {self.path}"

    @property
    def label(self):
        return OPERATION_LABELS.get(self.key, self.metadata.get("summary", self.key))

    @property
    def needs_confirmation(self):
        return self.method == "DELETE" or (
            self.method != "GET"
            and (
                self.path == "/api/v1/screening-runs" or self.path.endswith("/execute")
                or self.path in {
                    "/api/v1/conversations/{conversation_id}/scope",
                    "/api/v1/conversations/{conversation_id}/composition",
                    "/api/v1/conversations/{conversation_id}/screening-templates/{template_id}",
                    "/api/v1/conversations/{conversation_id}/saved-screening-tasks/{asset_id}/reuse",
                }
                or any(word in self.path.split("/") for word in ("share", "shares", "send", "publish"))
            )
        )

    def confirmation_for(self, body):
        return self.needs_confirmation or (
            self.method == "POST" and self.path == "/api/v1/conversations/{conversation_id}/messages"
            and (body or {}).get("execute_plan") is True
        )

    def brief(self):
        return {"operation": self.key, "label": self.label, "group": self.group, "tags": self.metadata.get("tags", [])}


class Workbench:
    def __init__(self, *, root=None):
        local = load_object(Path(__file__).with_name("connection.local.json"), optional=True)
        origin_override = os.environ.get("LLMR_WORKBENCH_ORIGIN") or os.environ.get("LLMR_KAIROS_WORKBENCH_ORIGIN")
        checkout = project_root(root or os.environ.get("LLMR_WORKBENCH_PROJECT_ROOT"))
        state = os.environ.get("LLMR_STATE_ROOT")
        if state:
            processes = Path(state) / "processes.json"
        elif not root and isinstance(local.get("processes_file"), str):
            processes = Path(local["processes_file"])
        else:
            processes = checkout / "runtime" / "processes.json" if checkout else None
        runtime = load_object(processes, optional=True) if processes else {}
        api_port, web_port = runtime.get("api_port"), runtime.get("web_port")
        self.web = self.public_origin = hosted_origin()
        if origin_override:
            self.base = origin(origin_override)
        elif type(api_port) is int and 1 <= api_port <= 65535:
            self.base = origin(f"http://127.0.0.1:{api_port}")
            if self.web is None and runtime.get("web_mode") in {"bundled", "development"} and type(web_port) is int and 1 <= web_port <= 65535:
                self.web = origin(f"http://127.0.0.1:{web_port}")
        else:
            raise BridgeError("找不到本机工作台运行记录。请先在项目目录启动 start-agent.cmd 或 start.cmd，再从该项目目录运行技能。")
        self.launcher = local.get("launcher")
        if checkout:
            agent_launcher = checkout / "start-agent.cmd"
            self.launcher = str(agent_launcher if agent_launcher.is_file() else checkout / "start.cmd")
        export_root = (processes.parent if processes else Path.cwd()) / "agent-exports"
        self.exports = export_root.resolve()
        self.schema = None

    def verify(self):
        if self.schema is None:
            _, schema = request(self.base, "/openapi.json", timeout=5)
            if not isinstance(schema, dict) or schema.get("info", {}).get("title") != TITLE:
                raise BridgeError("当前端口未运行 LLM 投研工作平台。")
            self.schema = schema
        return self.schema

    def status(self):
        self.verify()
        _, result = request(self.base, "/api/v1/health", timeout=5)
        _, auth = request(self.base, "/api/v1/auth/status", timeout=5)
        info = {"ok": True, "api": self.public_origin or self.base, "workbench": self.web, "health": result, "auth": auth}
        if self.public_origin:
            return {**info, "connection": "remote", "mcp": self.public_origin + "/mcp"}
        return {**info, "launcher": self.launcher}

    def operations(self):
        result = {}
        for path, actions in self.verify().get("paths", {}).items():
            if not path.startswith("/api/v1/") or not isinstance(actions, dict):
                continue
            if self.public_origin and any(path == blocked or path.startswith(blocked + "/") for blocked in HOSTED_WEB_ONLY):
                continue
            resource = path.split("/")[3]
            for method, metadata in actions.items():
                if method.upper() in METHODS and isinstance(metadata, dict):
                    item = Operation(method.upper(), path, metadata, RESOURCE_GROUPS.get(resource, "other"))
                    result[item.key] = item
        return result

    def operation(self, key):
        selected = self.operations().get(key)
        if selected is None:
            raise BridgeError("找不到这个操作。请先用工作台目录搜索，使用目录返回的完整 operation。")
        return selected

    def catalog(self, query="", group="", offset=0, limit=20):
        operations = list(self.operations().values())
        groups = {key: {"label": label, "operations": sum(op.group == key for op in operations)}
                  for key, (label, _) in GROUPS.items()}
        other = sum(op.group == "other" for op in operations)
        if other:
            groups["other"] = {"label": "其他工作台操作", "operations": other}
        filtered = [op for op in operations if (not group or group == op.group)
                    and all(word.casefold() in json.dumps(op.brief(), ensure_ascii=False).casefold() for word in query.split())]
        page = filtered[offset:offset + limit] if group or query else []
        return {"ok": True, "workbench": self.web, "groups": groups, "total": len(operations),
                "matches": len(filtered), "operations": [item.brief() for item in page],
                "next_offset": offset + limit if page and offset + limit < len(filtered) else None}

    def expand(self, value, ref_seen=()):
        if isinstance(value, list):
            return [self.expand(entry, ref_seen) for entry in value]
        if not isinstance(value, dict):
            return value
        reference = value.get("$ref", "")
        prefix = "#/components/schemas/"
        if reference.startswith(prefix) and reference not in ref_seen:
            found = self.schema.get("components", {}).get("schemas", {}).get(reference.removeprefix(prefix))
            if found is not None:
                return self.expand(found, (*ref_seen, reference))
        return {key: self.expand(entry, ref_seen) for key, entry in value.items()}

    def describe(self, operation):
        selected = self.operation(operation)
        upload = {"file": "binary", "request_id": "string"} if selected.key == ATTACHMENT_OPERATION else None
        body = self.expand(selected.metadata.get("requestBody"))
        result = {"ok": True, **selected.brief(), "parameters": self.expand(selected.metadata.get("parameters", [])),
                  "request_body": body, "attachment_fields": upload, "requires_user_confirmation": selected.needs_confirmation}
        return {**result, "request_body": compact(body, chars=900, items=30)} if body else result

    def endpoint(self, selected, path, query):
        keys = set(PATH_FIELD.findall(selected.path))
        if keys != set(path or {}):
            raise BridgeError(f"路径参数应为 {', '.join(sorted(keys)) or '无'}。")

        def encode_param(match):
            field = match.group(1)
            value = path[field]
            if type(value) not in {str, int}:
                raise BridgeError(f"路径参数 {field} 需要文字或整数。")
            value = str(value)
            if "/" in value and (field != "path" or selected.path not in FILE_PATH_ROUTES):
                raise BridgeError(f"路径参数 {field} 不能包含路径分隔符。")
            parts = value.split("/")
            if any(part in {"", ".", ".."} or "\\" in part or any(ord(c) < 32 for c in part) for part in parts):
                raise BridgeError("路径参数包含无效片段。")
            return "/".join(quote(part, safe="") for part in parts)

        url = PATH_FIELD.sub(encode_param, selected.path)
        if query:
            pairs = [(key, str(item).lower() if isinstance(item, bool) else item)
                     for key, value in query.items() for item in (value if isinstance(value, list) else [value])
                     if item is not None]
            url += "?" + urlencode(pairs)
        return url

    def require_local(self):
        _, auth = request(self.base, "/api/v1/auth/status", timeout=5)
        if not isinstance(auth, dict) or auth.get("mode") != "local":
            raise BridgeError("此 Agent 连接只接受本机 local 工作台。当前实例使用 OIDC 登录。")

    def download(self, operation, *, path=None, query=None):
        selected = self.operation(operation)
        if selected.method != "GET":
            raise BridgeError("文件交付仅接受目录中的 GET 操作。")
        self.require_local()
        url = self.endpoint(selected, path, query)
        if self.public_origin:
            code, result = request(self.base, url, allow_link=True, timeout=60,
                                   inline_png=selected.path == SERVICE_CARD_PNG_PATH)
            if not isinstance(result, dict) or result.get("url") != self.base + url or result.get("media_type") == "text/html":
                raise BridgeError("请选择返回下载文件的操作。")
            return {"ok": True, "operation": selected.key, "status": code, **self.public_links(result)}
        return {"ok": True, "operation": selected.key, **download(self.base, url, self.exports)}

    def public_links(self, value):
        if isinstance(value, dict):
            return {key: self.public_links(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.public_links(item) for item in value]
        if isinstance(value, str):
            url = value.removeprefix(self.base)
            if url.startswith(("/api/v1/", "/#/")):
                return self.public_origin + url
        return value

    def execute(self, operation, *, write, path=None, query=None, body=None, form=None, files=None, select=None,
                user_confirmed=False):
        selected = self.operation(operation)
        if (selected.method != "GET") != write:
            raise BridgeError("读取用 workbench_read，提交或修改用 workbench_write。")
        if selected.confirmation_for(body) and not user_confirmed:
            raise BridgeError("此操作需要用户明确确认。请先展示动作、对象、版本或收件目标。")
        url = self.endpoint(selected, path, query)
        self.require_local()
        data, content_type = None, None
        content = selected.metadata.get("requestBody", {}).get("content", {})
        if form is not None or files is not None:
            if body is not None or (selected.key != ATTACHMENT_OPERATION and "multipart/form-data" not in content):
                raise BridgeError("该操作不接受这个上传表单。请查看操作说明。")
            schema = self.expand(content.get("multipart/form-data", {}).get("schema", {}))
            file_fields = {"file"} if selected.key == ATTACHMENT_OPERATION else {
                name for name, field in schema.get("properties", {}).items()
                if binary_field(field)
            }
            if not set(files or {}).issubset(file_fields):
                raise BridgeError("上传文件字段与接口要求不符。")
            data, content_type = multipart(form or {}, files or {}, hosted=bool(self.public_origin))
        elif body is not None:
            if not write or "application/json" not in content:
                raise BridgeError("此操作不接受 JSON 请求体。")
            data, content_type = json.dumps(body, ensure_ascii=False).encode("utf-8"), "application/json"
        code, result = request(self.base, url, method=selected.method, data=data, content_type=content_type, allow_link=True)
        if select:
            result = choose_fields(result, select)
        if self.public_origin:
            result = self.public_links(result)
        output = {"ok": True, "status": code, "operation": selected.key}
        if self.public_origin and selected.path in SERVICE_PREVIEW_PATHS and isinstance(result, dict) and "image" in result:
            encoded = result.pop("image")
            if not isinstance(encoded, str) or not encoded.startswith(PNG_DATA_URL):
                raise BridgeError("工作台返回的服务预览格式无效。")
            try:
                output["_mcp_image"] = service_image(base64.b64decode(encoded[len(PNG_DATA_URL):], validate=True))
            except (ValueError, binascii.Error) as exc:
                raise BridgeError("工作台返回的服务预览无法解码。") from exc
        return {**output, **response_data(result)}


PROPERTY_OPERATION = {"type": "string", "description": "工作台目录返回的完整 METHOD /api/v1/... 操作名"}
PROPERTY_MAP = {"type": "object"}
PROPERTY_SELECT = {"type": "array", "items": {"type": "string"}, "maxItems": 24}
READ_PROPERTIES = {"operation": PROPERTY_OPERATION, "path": PROPERTY_MAP, "query": PROPERTY_MAP, "select": PROPERTY_SELECT}
WRITE_PROPERTIES = {**READ_PROPERTIES, "body": PROPERTY_MAP, "form": PROPERTY_MAP, "files": PROPERTY_MAP,
                    "user_confirmed": {"type": "boolean"}}


def tool(name, description, properties=None, required=(), *, read_only=True, destructive=False, open_world=False):
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "additionalProperties": False, "properties": properties or {},
                            "required": list(required)},
            "annotations": {"readOnlyHint": read_only, "destructiveHint": destructive, "openWorldHint": open_world}}


TOOLS = [
    tool("workbench_status", "检查投研工作台以及 Agent 连接的服务实例。"),
    tool("workbench_catalog", "按业务领域、关键词或 API 路径搜索完整工作台操作。无参数时列出领域与操作数量。",
         {"query": {"type": "string"}, "group": {"type": "string"}, "offset": {"type": "integer", "minimum": 0},
          "limit": {"type": "integer", "minimum": 1, "maximum": 50}}),
    tool("workbench_describe", "读取指定工作台操作的参数、请求体和确认要求。", {"operation": PROPERTY_OPERATION}, ("operation",)),
    tool("workbench_read", "读取后台任务、原文、项目、数据或成果，并可挑选字段以缩小输出。", READ_PROPERTIES, ("operation",)),
    tool("workbench_download", "领取原件、图表或导出结果。远程时点卡片返回完整 PNG 和下载地址。",
         {"operation": PROPERTY_OPERATION, "path": PROPERTY_MAP, "query": PROPERTY_MAP}, ("operation",), read_only=False),
    tool("workbench_write", "提交用户要求的工作台操作。正式执行、外发、共享和删除须先取得用户确认。",
         WRITE_PROPERTIES, ("operation",), read_only=False, destructive=True, open_world=True),
]


def call(name, arguments, *, root=None, human_confirm=None):
    if not isinstance(arguments, dict):
        raise BridgeError("工具参数必须是 JSON 对象。")
    definitions = {entry["name"]: entry["inputSchema"] for entry in TOOLS}
    if name not in definitions:
        raise BridgeError(f"找不到工具 {name}。")
    schema = definitions[name]
    if set(arguments) - schema["properties"].keys() or set(schema["required"]) - arguments.keys():
        raise BridgeError("工具参数名不符合调用说明。")
    types = {"string": str, "integer": int, "object": dict, "array": list, "boolean": bool}
    for key, value in arguments.items():
        property_schema = schema["properties"][key]
        if type(value) is not types[property_schema["type"]]:
            raise BridgeError(f"工具参数 {key} 的格式不正确。")
        if isinstance(value, int) and not isinstance(value, bool) and (
            value < property_schema.get("minimum", value) or value > property_schema.get("maximum", value)
        ):
            raise BridgeError(f"工具参数 {key} 超出范围。")
        if isinstance(value, list) and (len(value) > 24 or not all(isinstance(item, str) and item for item in value)):
            raise BridgeError(f"工具参数 {key} 应是最多 24 个字段名。")
    client = Workbench(root=root)
    if name == "workbench_status":
        return client.status()
    if name == "workbench_catalog":
        return client.catalog(**arguments)
    if name == "workbench_describe":
        return client.describe(**arguments)
    if name == "workbench_download":
        return client.download(**arguments)
    if name == "workbench_write" and human_confirm is not None:
        selected = client.operation(arguments["operation"])
        if selected.confirmation_for(arguments.get("body")):
            client.endpoint(selected, arguments.get("path"), arguments.get("query"))
            client.require_local()
            if not human_confirm(selected, arguments):
                raise BridgeError("这次操作没有收到用户批准。")
        arguments = {**arguments, "user_confirmed": True}
    return client.execute(write=name == "workbench_write", **arguments)


def run_tool(name, arguments, **options):
    try:
        return call(name, arguments, **options)
    except BridgeError as exc:
        return exc.payload()
    except (OSError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}


def rpc_error(rpc_id, code, message):
    return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}}


def rpc(raw, *, root=None, human_confirm=None):
    rpc_id = None
    try:
        message = json.loads(raw)
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            raise ValueError
        rpc_id = message.get("id")
        if "id" not in message:
            return None
        method = message.get("method")
        params = message.get("params") or {}
        if method == "initialize":
            versions = {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}
            preferred = params.get("protocolVersion")
            result = {"protocolVersion": preferred if preferred in versions else "2025-06-18",
                      "capabilities": {"tools": {}}, "serverInfo": {"name": "llm-research-workbench", "version": VERSION}}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            approve = (lambda operation, arguments: human_confirm(rpc_id, operation, arguments)) if human_confirm else None
            value = run_tool(params.get("name"), params.get("arguments", {}), root=root, human_confirm=approve)
            attached = value.pop("_mcp_image", None)
            content = [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}]
            if attached:
                content.append(attached)
            result = {"content": content, "isError": not value.get("ok", False)}
        elif method == "ping":
            result = {}
        else:
            return rpc_error(rpc_id, -32601, "Method not found")
        return {"jsonrpc": "2.0", "id": rpc_id, "result": result}
    except (ValueError, AttributeError, TypeError):
        return rpc_error(rpc_id, -32600, "Invalid request")


def approval_message(operation, args):
    target = {key: args[key] for key in ("path", "query", "body") if key in args}
    def redact(value):
        if isinstance(value, list):
            return [redact(item) for item in value]
        if isinstance(value, dict):
            return {key: "已隐藏" if re.search(r"token|secret|password|authorization|webhook|credential", key, re.I)
                    else redact(item) for key, item in value.items()}
        return value

    summary = json.dumps(compact(redact(target), chars=150, items=8), ensure_ascii=False)[:1400]
    return f"{operation.label}\n{operation.key}\n本次提交 {summary}"


def serve(root=None, require_approval=False):
    supports_forms = False

    def emit(value):
        print(json.dumps(value, ensure_ascii=False), flush=True)

    def approve(tool_id, operation, arguments):
        if not supports_forms:
            raise BridgeError("当前 MCP 客户端未提供原生确认表单。请在支持确认的客户端提交，或由用户在终端确认。")
        approval_id = f"approval-{uuid4()}"
        emit({"jsonrpc": "2.0", "id": approval_id, "method": "elicitation/create",
              "params": {"message": approval_message(operation, arguments), "requestedSchema": {
                  "type": "object", "properties": {"confirm": {"type": "boolean", "title": "批准本次操作", "default": False}},
                  "required": ["confirm"],
              }}})
        for response in sys.stdin:
            try:
                message = json.loads(response)
            except ValueError:
                continue
            if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                continue
            method = message.get("method")
            if message.get("id") == approval_id and method is None:
                answer = message.get("result")
                content = answer.get("content") if isinstance(answer, dict) else None
                return (isinstance(content, dict) and answer.get("action") == "accept"
                        and content.get("confirm") is True)
            params = message.get("params")
            if method == "notifications/cancelled" and isinstance(params, dict) and params.get("requestId") == tool_id:
                return False
            if method == "ping":
                result = rpc(response)
                if result is not None:
                    emit(result)
            elif method and "id" in message:
                emit(rpc_error(message["id"], -32000, "工作台正在等另一项操作的用户确认。"))
        return False

    for line in sys.stdin:
        if require_approval:
            try:
                message = json.loads(line)
                if message.get("method") == "initialize":
                    elicitation = message["params"]["capabilities"].get("elicitation")
                    supports_forms = isinstance(elicitation, dict) and ("form" in elicitation or not elicitation)
            except (ValueError, AttributeError, KeyError, TypeError):
                pass
        result = rpc(line, root=root, human_confirm=approve if require_approval else None)
        if result is not None:
            emit(result)


def serve_http(port, root=None):
    source = Path(__file__).resolve()
    health = {"ok": True, "name": "llm-research-workbench", "pid": os.getpid(),
              "source": str(source), "sha256": sha256(source.read_bytes()).hexdigest()}
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    origins = {f"http://{host}" for host in hosts}
    public = hosted_origin()
    request_limit = MAX_HOSTED_REQUEST_BYTES if public else 1024 * 1024
    if public:
        origins.add(public)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return

        def respond(self, status, value=None):
            body = b"" if value is None else json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            if status == 405:
                self.send_header("Allow", "POST")
            if body:
                self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if body:
                self.wfile.write(body)

        def allowed(self):
            origin_header = self.headers.get("Origin")
            return (self.headers.get("Host") in hosts and (origin_header is None or origin_header in origins)
                    and self.headers.get("Sec-Fetch-Site") != "cross-site")

        def do_GET(self):
            if not self.allowed():
                return self.respond(403)
            if self.path == "/health":
                return self.respond(200, health)
            return self.respond(405 if self.path == "/mcp" else 404)

        def do_DELETE(self):
            return self.respond(405 if self.allowed() and self.path == "/mcp" else 403)

        def do_POST(self):
            if not self.allowed():
                return self.respond(403)
            if self.path != "/mcp":
                return self.respond(404)
            if self.headers.get_content_type() != "application/json":
                return self.respond(415)
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return self.respond(400)
            if not 0 < size <= request_limit:
                return self.respond(413)
            self.connection.settimeout(10)
            try:
                result = rpc(self.rfile.read(size), root=root)
            except TimeoutError:
                return self.respond(408)
            return self.respond(202 if result is None else 200, result)

    with ThreadingHTTPServer(("127.0.0.1", port), Handler) as server:
        server.serve_forever()


def main():
    sys.stdin.reconfigure(encoding="utf-8-sig")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", nargs="?", choices=("serve", "http", "call"), default="serve")
    parser.add_argument("tool", nargs="?")
    parser.add_argument("--input", type=Path, help="UTF-8 JSON object for a CLI call")
    parser.add_argument("--port", type=int, default=18861)
    parser.add_argument("--project-root", type=Path, help="本机投研项目根目录")
    parser.add_argument("--require-user-approval", action="store_true", help="使用 MCP 原生确认或本人人工终端确认")
    options = parser.parse_args()
    if options.mode == "serve":
        serve(options.project_root, options.require_user_approval)
        return 0
    if options.mode == "http":
        if not 1 <= options.port <= 65535:
            parser.error("--port must be between 1 and 65535")
        if options.require_user_approval:
            parser.error("HTTP 桥接使用 Kairos Agent 对话确认。需要 MCP 原生确认时请使用 serve。")
        serve_http(options.port, options.project_root)
        return 0
    if not options.tool:
        parser.error("call requires a tool name")
    arguments = load_object(options.input) if options.input else {}
    def approve_in_terminal(operation, request_args):
        if not sys.stdin.isatty():
            raise BridgeError("请在自己的终端核对并确认该操作。")
        print(approval_message(operation, request_args), file=sys.stderr)
        return input("输入 确认 后提交：").strip() == "确认"

    result = run_tool(options.tool, arguments, root=options.project_root,
                      human_confirm=approve_in_terminal if options.require_user_approval else None)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
