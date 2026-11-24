from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from . import capability_service, codex_runtime
from .api_responses import bad_request
from .db import connect
from .model_client import ModelRequestError, complete_json, probe_function_calling, probe_models
from .model_modes import DEFAULT_MODEL_MODE, MODEL_PRESETS, ModelMode
from .models import AdvisorValidationLevelInput
from .settings import REPORT_DIR, STOCK_FILE, TUSHARE_API_URL, llm_settings, tushare_settings

router = APIRouter(prefix="/api/v1")


@router.get("/health")
def health(request: Request):
    with connect() as connection:
        connection.execute("SELECT 1").fetchone()
    return {"status": "ok", "database": "ready", "version": request.app.version}


def screening_capability_manifest():
    return capability_service.screening_capability_manifest(stock_file=STOCK_FILE, model_configured=bool(llm_settings()["configured"]))


@router.get("/capabilities")
def capabilities():
    settings = llm_settings()
    return {
        "menus": ["watchlist", "news", "patterns", "reports", "screening"],
        "workspace_menus": ["research", "screening", "watchlist", "news", "patterns", "reports"],
        "agent_runtime": "codex",
        "codex_runtime": codex_runtime.availability(),
        "condition_authoring": "natural_language_atomic_conditions_with_confirmation",
        "screening_trace": "all_security_decisions_and_immutable_snapshots",
        "screening_universe": ["all_a_shares", "frozen_watchlist"],
        "chat_drafting": "llm" if settings["configured"] else "local_parser",
        "pattern_screenshot_extraction": "local_color_trace_candidate",
        "report_rubric_evaluation": "configured_llm_async",
        "report_security_binding": "automatic_llm_pdf_catalog",
        "news_data": "local_import_and_tushare_sync",
        "news_external_sync": tushare_settings()["configured"],
        "formal_screening": False,
        "worker": "separate_process_required_for_exploratory_full_scan",
        "screening_capabilities": screening_capability_manifest(),
    }


@router.get("/screening-capabilities")
def screening_capabilities():
    return screening_capability_manifest()


@router.get("/settings/status")
def settings_status():
    llm = llm_settings()
    tushare = tushare_settings()
    return {
        "text_model": {"configured": llm["configured"], "model": llm["model"] if llm["configured"] else None,
                       "api_mode": llm["api_mode"] if llm["configured"] else None,
                       "credential_source": ("local_codex" if llm.get("backend") == "local_codex" else "config.ini")
                       if llm["configured"] else None},
        "codex_runtime": codex_runtime.availability(),
        "tushare": {
            "configured": tushare["configured"],
            "credential_source": tushare["credential_source"] or None,
            "provider": "official" if str(tushare["api_url"]).rstrip("/") == TUSHARE_API_URL else "relay",
        },
        "runtime": {"data_root_configured": STOCK_FILE.exists(), "report_directory_configured": REPORT_DIR.exists()},
        "notice": "Tushare 凭据由服务端读取，数据权限以配置的接口服务为准。行情和资讯结果保存在本地库。",
    }


@router.post("/settings/web-search-test")
async def test_web_search_connection(model_mode: ModelMode = DEFAULT_MODEL_MODE):
    try:
        return await run_in_threadpool(codex_runtime.probe_web_search, model_mode)
    except codex_runtime.CodexRuntimeError as exc:
        raise HTTPException(503, {"code": "web_search_unavailable", "message": str(exc)}) from exc


@router.post("/settings/model-test")
def test_model_connection(model_mode: ModelMode = DEFAULT_MODEL_MODE):
    config = llm_settings()
    if not config["configured"]:
        bad_request("未配置文本模型环境变量", 409, "model_not_configured")
    model = MODEL_PRESETS[model_mode].model_id
    started = time.perf_counter()
    endpoint = probe_models(timeout_seconds=12)
    native = config.get("backend") == "local_codex"
    if not endpoint["reachable"]:
        return {"connected": False, "endpoint_reachable": False, "authenticated": False,
                "message": "本机 Codex 暂时无法读取模型目录。" if native else endpoint["reason"], "api_mode": config["api_mode"]}
    if endpoint["authenticated"] is False:
        return {
            "connected": False,
            "endpoint_reachable": endpoint["reachable"],
            "authenticated": False,
            "message": "本机 Codex 尚未登录 ChatGPT。" if native else "模型端点可达，但凭证未通过认证。",
            "api_mode": config["api_mode"],
        }
    try:
        response = complete_json(
            'Return only this JSON object: {"status":"ok","reply":"ready"}.',
            "Run the connection check.",
            timeout_seconds=60 if native else 20,
            max_output_tokens=256,
            model_mode=model_mode,
        )
    except ModelRequestError as exc:
        return {
            "connected": False,
            "endpoint_reachable": True,
            "authenticated": endpoint["authenticated"],
            "models_endpoint_supported": endpoint["reason"] is None,
            "model_listed": model in endpoint["models"] if endpoint["models"] else None,
            "model": model,
            "message": str(exc),
            "api_mode": config["api_mode"],
            "latency_ms": round((time.perf_counter() - started) * 1000),
        }
    if response.get("status") != "ok":
        bad_request("模型已响应，但没有通过 JSON 连接检查", 502, "model_connection_invalid_response")
    return {
        "connected": True,
        "endpoint_reachable": True,
        "authenticated": endpoint["authenticated"],
        "models_endpoint_supported": endpoint["reason"] is None,
        "model_listed": model in endpoint["models"] if endpoint["models"] else None,
        "model": model,
        "api_mode": config["api_mode"],
        "latency_ms": round((time.perf_counter() - started) * 1000),
    }


@router.post("/settings/model-tool-test")
def test_model_tool_connection():
    return probe_function_calling()


@router.get("/settings/advisor-validation")
def get_advisor_validation_level():
    """Get current advisor report validation strictness level."""
    from .settings import advisor_validation_level, AVAILABLE_VALIDATION_LEVELS
    level = advisor_validation_level()
    descriptions = {
        "basic": "基础级别 - 拦截事实和证据错误，表达问题只提示",
        "strict": "严格级别 - 增加分析维度、客户稿口径与时间标注完整性要求",
        "off": "兼容级别 - 保留事实和证据校验，关闭可选表达建议"
    }
    return {
        "level": level,
        "description": descriptions.get(level, "未知级别"),
        "available_levels": AVAILABLE_VALIDATION_LEVELS
    }


@router.post("/settings/advisor-validation")
def update_advisor_validation_level(input_data: AdvisorValidationLevelInput):
    """Set advisor report validation strictness level."""
    from .settings import set_advisor_validation_level

    try:
        set_advisor_validation_level(input_data.level)
        return {"success": True, "level": input_data.level, "message": f"验证级别已设置为 {input_data.level}"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
