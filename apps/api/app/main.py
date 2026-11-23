from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth, authorization, identity
from .security_context import AccessDenied, LOCAL_ACTOR, actor_scope, auth_mode
from .conversation_api import router as conversation_router
from .research_scan_api import router as research_scan_router
from .screening_api import router as screening_router
from .filter_api import router as filter_router
from .screening_strategy_api import router as screening_strategy_router
from .news_api import router as news_router
from .saved_screening_api import router as saved_screening_router
from .condition_api import router as condition_router
from .condition_builder import router as condition_builder_router
from .dynamic_indicator_api import router as dynamic_indicator_router
from .pattern_language import router as pattern_language_router
from .pattern_research import router as pattern_research_router
from .product_api import router as product_router
from .observation_api import router as observation_router
from .research_project_api import router as research_project_router
from .research_workbench_api import router as research_workbench_router
from .task_api import router as task_router
from .research_assistant_api import router as research_assistant_router
from .intelligence_api import router as intelligence_router
from .research_model_api import router as research_model_router
from .research_attachment_api import router as research_attachment_router
from .research_file_api import router as research_file_router
from .qmt_doc_api import router as qmt_doc_router
from .financial_data_api import router as financial_data_router
from .investment_tracking import router as investment_tracking_router
from .financial_research_api import router as financial_research_router
from .disclosure_api import router as disclosure_router
from .daily_signals_api import router as daily_signals_router
from .client_service_api import router as client_service_router
from .tushare_download_api import router as tushare_download_router
from .tushare_features_api import router as tushare_features_router
from .system_api import router as system_router
from .market_api import router as market_router
from .watchlist_api import router as watchlist_router
from .jobs_api import router as jobs_router
from .pattern_api import router as pattern_router
from .document_api import router as document_router
from .report_evaluation_api import router as report_evaluation_router
from .db import init_db
from .request_security import trusted_write_request
from .settings import PROJECT_ROOT


@asynccontextmanager
async def lifespan(_: FastAPI):
    if auth_mode() == "oidc":
        from dataclasses import replace
        auth.settings()
        identity.initialize()
        with actor_scope(replace(LOCAL_ACTOR, maintenance=True)):
            init_db()
    else:
        init_db()
        from .conversation_store import recover_expired_turns
        recover_expired_turns()
    yield


app = FastAPI(title="LLM 投研工作平台", version="0.1.0", lifespan=lifespan, dependencies=[Depends(authorization.authorize_route)])
app.include_router(auth.router)
app.include_router(condition_router)
app.include_router(condition_builder_router)
app.include_router(dynamic_indicator_router)
app.include_router(conversation_router)
app.include_router(research_scan_router)
app.include_router(screening_router)
app.include_router(filter_router)
app.include_router(screening_strategy_router)
app.include_router(news_router)
app.include_router(saved_screening_router)
app.include_router(pattern_language_router)
app.include_router(pattern_research_router)
app.include_router(product_router)
app.include_router(observation_router)
app.include_router(research_project_router)
app.include_router(research_workbench_router)
app.include_router(task_router)
app.include_router(research_assistant_router)
app.include_router(intelligence_router)
app.include_router(research_model_router)
app.include_router(research_attachment_router)
app.include_router(research_file_router)
app.include_router(qmt_doc_router)
app.include_router(financial_data_router)
app.include_router(investment_tracking_router)
app.include_router(financial_research_router)
app.include_router(disclosure_router)
app.include_router(daily_signals_router)
app.include_router(client_service_router)
app.include_router(tushare_download_router)
app.include_router(tushare_features_router)
app.include_router(system_router)
app.include_router(market_router)
app.include_router(watchlist_router)
app.include_router(jobs_router)
app.include_router(pattern_router)
app.include_router(document_router)
app.include_router(report_evaluation_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://127.0.0.1:{os.environ.get('LLMR_WEB_PORT', '5173')}",
        f"http://localhost:{os.environ.get('LLMR_WEB_PORT', '5173')}",
    ],
    allow_credentials=auth_mode() == "oidc",
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "X-Request-ID", "X-CSRF-Token"],
)


@app.middleware("http")
async def request_id(request: Request, call_next):
    request.state.request_id = request.headers.get("X-Request-ID") or str(uuid4())
    if not trusted_write_request(request):
        response = JSONResponse(status_code=403, content={
            "code": "untrusted_origin",
            "message": "请从当前投研工作台提交操作。" if auth_mode() == "oidc" else "请从本机投研工作台提交操作。",
            "details": None,
            "request_id": request.state.request_id,
        })
    else:
        response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    return response


app.middleware("http")(authorization.authenticate_request)


@app.exception_handler(AccessDenied)
async def access_error(request: Request, exc: AccessDenied):
    return JSONResponse({"code": "access_denied", "message": str(exc)}, status_code=exc.status)


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "code": detail.get("code", "request_error"),
            "message": detail.get("message", "请求失败"),
            "details": detail.get("details"),
            "request_id": getattr(request.state, "request_id", None),
        },
    )


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "code": "validation_error",
            "message": "输入格式或取值不符合要求",
            "details": [f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}" for error in exc.errors()],
            "request_id": getattr(request.state, "request_id", None),
        },
    )


WEB_DIST = PROJECT_ROOT / "apps" / "web" / "dist"
if WEB_DIST.is_dir():
    @app.get("/", include_in_schema=False)
    @app.get("/index.html", include_in_schema=False)
    def web_entry():
        from fastapi.responses import HTMLResponse
        content = (WEB_DIST / "index.html").read_text(encoding="utf-8")
        bootstrap = "<script>window.__LLMR_AUTH_REQUIRED__=" + json.dumps(auth_mode() == "oidc") + ";</script>"
        return HTMLResponse(content.replace("</head>", bootstrap + "</head>"), headers={"Cache-Control": "no-store"})
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
