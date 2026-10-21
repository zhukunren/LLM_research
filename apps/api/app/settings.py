from __future__ import annotations

import os
import configparser
import json
from pathlib import Path

from .storage import storage_paths


PROJECT_ROOT = Path(__file__).resolve().parents[3]
_STORAGE = storage_paths(project_root=PROJECT_ROOT)
STATE_ROOT = _STORAGE.state_root
UPLOAD_ROOT = _STORAGE.upload_root
ARTIFACT_ROOT = _STORAGE.artifact_root
SANDBOX_STATE_ROOT = _STORAGE.sandbox_state_root
PYTHON_DEPS = _STORAGE.python_deps
DATA_ROOT = _STORAGE.data_root
DB_PATH = _STORAGE.database
STOCK_FILE = DATA_ROOT / "stock_data" / "stock_daily.parquet"
REPORT_DIR = DATA_ROOT / "research_report"
REPORT_UPLOAD_DIR = UPLOAD_ROOT / "reports"
PATTERN_UPLOAD_DIR = UPLOAD_ROOT / "patterns"
MIGRATIONS_DIR = PROJECT_ROOT / "apps" / "api" / "migrations"
MAX_RECENT_BARS = 500
ALLOWED_MARKETS = {"SH", "SZ", "BJ"}


def config_path() -> Path:
    return Path(os.environ.get("LLMR_CONFIG_FILE") or PROJECT_ROOT / "config.ini").expanduser().resolve()


def _read_config() -> configparser.ConfigParser:
    config = configparser.ConfigParser(interpolation=None)
    target = config_path()
    if target.is_file():
        try:
            with target.open("r", encoding="utf-8-sig") as stream:
                config.read_file(stream)
        except (OSError, configparser.Error):
            config = configparser.ConfigParser(interpolation=None)
    return config


def llm_settings() -> dict[str, str | bool]:
    config = _read_config()
    app = config["app"] if config.has_section("app") else {}
    provider_name = app.get("model_provider", "OpenAI")
    provider_section = f"model_providers.{provider_name}"
    provider = config[provider_section] if config.has_section(provider_section) else {}
    secrets = config["secrets"] if config.has_section("secrets") else {}
    key = secrets.get("openai_api_key", "")
    if not key:
        key_env = secrets.get("openai_api_key_env", "OPENAI_API_KEY")
        key = os.environ.get(key_env, "")
    base_url = provider.get("base_url", "").rstrip("/")
    model = app.get("model", "")
    reasoning_effort = app.get("reasoning_effort", "").strip() or os.environ.get("LLMR_REASONING_EFFORT", "high")
    if reasoning_effort not in {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}:
        raise ValueError("reasoning_effort 配置无效")
    api_mode = provider.get("wire_api", "chat_completions").strip().lower()
    api_path = provider.get("api_path", "/v1/responses" if api_mode == "responses" else "/v1/chat/completions")
    if not base_url:
        base_url = os.environ.get("LLMR_LLM_BASE_URL", "").rstrip("/")
    if not key:
        key = os.environ.get("LLMR_LLM_API_KEY", "")
    if not model:
        model = os.environ.get("LLMR_LLM_MODEL", "")
    if not config.has_section(provider_section) or not config_path().is_file():
        api_mode = os.environ.get("LLMR_LLM_API_MODE", api_mode).strip().lower()
        api_path = os.environ.get("LLMR_LLM_API_PATH", os.environ.get("LLMR_LLM_CHAT_PATH", api_path))
    search_capability = os.environ.get(
        "LLMR_LLM_SUPPORTS_STANDALONE_WEB_SEARCH",
        provider.get("supports_standalone_web_search", "false"),
    ).strip().lower()
    if search_capability not in configparser.ConfigParser.BOOLEAN_STATES:
        raise ValueError("supports_standalone_web_search 应为 true 或 false")
    return {
        "configured": bool(base_url and key and model),
        "base_url": base_url,
        "api_key": key,
        "model": model,
        "reasoning_effort": reasoning_effort,
        "api_mode": api_mode,
        "api_path": api_path,
        "supports_standalone_web_search": configparser.ConfigParser.BOOLEAN_STATES[search_capability],
    }


def research_web_search_mode() -> str:
    config = _read_config()
    section = config["research"] if config.has_section("research") else {}
    mode = os.environ.get("LLMR_RESEARCH_WEB_SEARCH", section.get("web_search", "live")).strip().lower()
    if mode not in {"live", "cached", "disabled"}:
        raise ValueError("research.web_search 应为 live、cached 或 disabled")
    return mode


def research_model_settings() -> dict:
    """Server-owned entitlements; clients cannot upgrade their account tier."""
    config = _read_config()
    section = config["research_models"] if config.has_section("research_models") else {}
    tier = os.environ.get("LLMR_RESEARCH_ACCOUNT_TIER", section.get("account_tier", "free")).strip().lower()
    if tier not in {"free", "paid", "enterprise"}:
        raise ValueError("research_models.account_tier 应为 free、paid 或 enterprise")
    allowed = os.environ.get("LLMR_RESEARCH_ALLOWED_MODELS", section.get("allowed_models", "")).strip()
    efforts = json.loads(os.environ.get("LLMR_RESEARCH_MODEL_EFFORTS_JSON", section.get("reasoning_efforts_json", "{}")))
    valid = {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
    if not isinstance(efforts, dict) or any(not isinstance(key, str) or not isinstance(value, list)
            or not value or any(not isinstance(item, str) or item not in valid for item in value) for key, value in efforts.items()):
        raise ValueError("research_models.reasoning_efforts_json 应将模型映射到支持的推理档位数组")
    return {"account_tier": tier, "allowed_models": [item.strip() for item in allowed.split(",") if item.strip()],
            "reasoning_efforts": efforts}


def research_settings() -> dict[str, int]:
    config = _read_config()
    section = config["research"] if config.has_section("research") else {}
    values = {}
    for name, default, minimum, maximum in (
        ("turn_timeout_seconds", 3600, 30, 7200),
        ("model_request_timeout_seconds", 600, 1, 3600),
        ("tool_timeout_seconds", 1800, 1, 7200),
        ("max_tool_calls", 0, 0, 10000),
        ("max_output_file_bytes", 50 * 1024 * 1024, 1024, 200 * 1024 * 1024),
    ):
        value = int(os.environ.get("LLMR_RESEARCH_" + name.upper(), section.get(name, str(default))))
        if not minimum <= value <= maximum:
            raise ValueError(f"research.{name} 应在 {minimum} 到 {maximum} 之间")
        values[name] = value
    return values


def report_parser_settings() -> dict[str, str | None]:
    config = _read_config()
    section = config["reports"] if config.has_section("reports") else {}
    backend = os.environ.get("LLMR_REPORT_PARSER", section.get("parser", "pypdf")).strip().lower()
    if backend not in {"pypdf", "docling"}:
        raise ValueError("reports.parser 仅支持 pypdf 或 docling")
    artifacts = os.environ.get("LLMR_DOCLING_ARTIFACTS_PATH", section.get("docling_artifacts_path", "")).strip() or None
    return {"backend": backend, "docling_artifacts_path": artifacts}


def research_mode_settings(mode: str | None, depth: str | None = None) -> dict[str, int | str]:
    """Return user-facing research budgets without widening business write access."""
    normalized = (mode or "research").strip().lower()
    if normalized not in {"research", "screening", "advanced"}:
        normalized = "research"
    deep = depth == "deep" or (depth is None and normalized == "advanced")
    values: dict[str, int | str] = {
        **research_settings(), "mode": normalized,
        "reasoning_effort": "max" if deep else "high",
    }
    if deep:
        values["turn_timeout_seconds"] = max(int(values["turn_timeout_seconds"]), 7200)
        values["max_output_file_bytes"] = max(int(values["max_output_file_bytes"]), 200 * 1024 * 1024)
    return values


AVAILABLE_VALIDATION_LEVELS = [
    {
        "value": "basic",
        "label": "基础级别",
        "description": "只检查必填字段和基本格式，适合人工审核后交付的场景。"
    },
    {
        "value": "strict",
        "label": "严格级别",
        "description": "自动检查成交额口径、时区格式、术语规范等所有细节，确保输出质量。"
    }
]


def advisor_validation_level() -> str:
    """
    Get advisor report validation strictness level.

    Returns:
        "off" (no validation), "basic" (default, completeness only), "strict" (all checks)
    """
    config = _read_config()
    section = config["advisor"] if config.has_section("advisor") else {}
    level = os.environ.get("LLMR_ADVISOR_VALIDATION_LEVEL", section.get("validation_level", "basic")).strip().lower()
    if level not in {"off", "basic", "strict"}:
        raise ValueError("advisor.validation_level 应为 off、basic 或 strict")
    return level


def set_advisor_validation_level(level: str) -> None:
    """
    Set advisor report validation strictness level.

    Args:
        level: "basic" or "strict"
    """
    if level not in {"basic", "strict"}:
        raise ValueError("validation_level must be 'basic' or 'strict'")

    config = _read_config()
    if not config.has_section("advisor"):
        config.add_section("advisor")
    config.set("advisor", "validation_level", level)

    target = config_path()
    with target.open("w", encoding="utf-8") as f:
        config.write(f)


def default_research_mode() -> str:
    config = _read_config()
    section = config["research"] if config.has_section("research") else {}
    value = os.environ.get("LLMR_RESEARCH_MODE", section.get("mode", "research")).strip().lower()
    return value if value in {"research", "screening", "advanced"} else "research"


def tushare_settings() -> dict[str, str | float | int | bool]:
    """Read the official Tushare token for server-side requests."""

    config = _read_config()
    section = config["tushare"] if config.has_section("tushare") else {}
    token_env = section.get("token_env", "").strip() or "TUSHARE_TOKEN"
    configured_token = section.get("token", "").strip()
    token = configured_token or os.environ.get(token_env, "").strip()
    try:
        timeout = float(section.get("timeout", "30"))
    except ValueError:
        timeout = 30.0
    try:
        retries = int(section.get("retries", "3"))
    except ValueError:
        retries = 3
    return {
        "configured": bool(token),
        "credential_source": "config" if configured_token else "environment" if token else "",
        "token_env": token_env,
        "token": token,
        "timeout": max(1.0, min(timeout, 120.0)),
        "retries": max(0, min(retries, 8)),
    }
