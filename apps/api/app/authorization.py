"""Central HTTP policy, applied to every API route including legacy routes."""
import hmac
import json

from fastapi import Request
from starlette.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .security_context import AccessDenied, LOCAL_ACTOR, actor_scope, auth_mode, can_write, current_actor

PUBLIC_PATHS = {"/api/v1/health", "/api/v1/auth/status", "/auth/login", "/auth/callback"}
ADMIN_PATHS = {"/api/v1/documents/import-local", "/api/v1/documents/catalog", "/api/v1/settings/model-test", "/api/v1/settings/model-tool-test"}
# Search uses a JSON POST but does not persist data or execute user code.
READ_ONLY_POSTS = {"/api/v1/documents/search"}
RESOURCE_PARAMETERS = {
    "conversation_id": (("conversations", "id"),), "turn_id": (("conversation_turns", "id"),),
    "project_id": (("research_projects", "id"),), "note_id": (("research_notes", "id"),),
    "filter_id": (("filters", "id"),), "strategy_id": (("strategies", "id"),), "pattern_id": (("patterns", "id"),),
    "document_id": (("documents", "id"),), "watchlist_id": (("watchlists", "id"),),
    "job_id": (("jobs", "id"),), "scan_id": (("research_scans", "id"),),
    "run_id": (("screening_runs", "id"), ("screening_task_runs", "id"), ("report_evaluation_runs", "id")),
    "asset_id": (("saved_screening_tasks", "id"),), "attachment_id": (("research_attachments", "id"),),
    "message_id": (("conversation_messages", "id"),), "share_id": (("research_conversation_shares", "id"),),
    "export_id": (("research_pdf_exports", "id"),), "trial_id": (("dynamic_indicator_trials", "id"),),
    "indicator_id": (("dynamic_indicator_versions", "indicator_id"),),
    "matrix_id": (("research_matrices", "id"),), "matrix_run_id": (("research_matrix_runs", "id"),),
    "check_id": (("research_tracking_checks", "id"),),
    "brief_id": (("intelligence_runs", "id"),),
}


def _exists(parameter: str, value: str):
    from .db import connect
    with connect() as connection:
        for table, column in RESOURCE_PARAMETERS[parameter]:
            if connection.execute(f"SELECT 1 FROM {table} WHERE {column}=? LIMIT 1", (value,)).fetchone():
                return
    raise AccessDenied("找不到此资源。", 404)


def authorize_route(request: Request):
    if not request.url.path.startswith("/api/") or request.url.path in PUBLIC_PATHS or auth_mode() == "local":
        return
    current_actor()
    for parameter, value in request.path_params.items():
        if parameter in RESOURCE_PARAMETERS:
            _exists(parameter, str(value))


async def authenticate_request(request: Request, call_next):
    path = request.url.path
    if not (path.startswith("/api/") or path.startswith("/auth/")) or path in PUBLIC_PATHS or request.method == "OPTIONS":
        return await call_next(request)
    try:
        from . import auth, db, identity
        if auth_mode() == "local":
            actor, csrf = LOCAL_ACTOR, ""
        else:
            token = request.cookies.get(auth.COOKIE, "")
            if not token:
                raise AccessDenied("请先登录。", 401)
            actor, csrf = await run_in_threadpool(identity.session_actor, token)
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                supplied = request.headers.get("X-CSRF-Token", "")
                if not supplied or not hmac.compare_digest(supplied.encode(), csrf.encode()):
                    raise AccessDenied("请求校验失败，请刷新页面。", 403)
                if path != "/auth/logout" and path not in READ_ONLY_POSTS and not can_write(actor):
                    raise AccessDenied("当前账户只有查看权限。", 403)
            if (path in ADMIN_PATHS or "/maintenance/" in path) and not actor.platform_admin:
                raise AccessDenied("此操作仅限平台维护者。", 403)
        with actor_scope(actor):
            if auth_mode() == "oidc":
                # Schema initialization is a server operation; never take a
                # workspace path or owner from a client request.
                await run_in_threadpool(db.ensure_initialized)
            request.state.csrf_token = csrf
            if auth_mode() == "oidc" and request.headers.get("content-type", "").startswith("application/json"):
                raw = await request.body()
                try:
                    body = json.loads(raw) if raw else {}
                except ValueError:
                    body = {}
                if isinstance(body, dict):
                    if any(key in body for key in ("user_id", "tenant_id", "owner_user_id", "platform_admin", "role")):
                        raise AccessDenied("身份和权限只能由服务端确定。", 422)
                    for key in ("project_id", "asset_id", "conversation_id", "trial_id"):
                        if body.get(key):
                            await run_in_threadpool(_exists, key, str(body[key]))
                    attachment_ids = body.get("attachment_ids", [])
                    if not isinstance(attachment_ids, list):
                        raise AccessDenied("附件列表格式无效。", 422)
                    for value in attachment_ids:
                        await run_in_threadpool(_exists, "attachment_id", str(value))
            response = await call_next(request)
            if auth_mode() == "oidc":
                response.headers["Cache-Control"] = "no-store"
                response.headers["Vary"] = "Cookie" + (", " + response.headers["Vary"] if "Vary" in response.headers else "")
            return response
    except AccessDenied as exc:
        return JSONResponse({"code": "access_denied", "message": str(exc)}, status_code=exc.status)
