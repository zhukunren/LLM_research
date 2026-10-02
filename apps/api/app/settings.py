from __future__ import annotations

import os
import configparser
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_ROOT = Path(os.environ.get("LLMR_DATA_ROOT", PROJECT_ROOT / "data")).resolve()
DB_PATH = Path(os.environ.get("LLMR_DB_PATH", PROJECT_ROOT / "runtime" / "app.db")).resolve()
STOCK_FILE = DATA_ROOT / "stock_data" / "stock_daily.parquet"
REPORT_DIR = DATA_ROOT / "research_report"
REPORT_UPLOAD_DIR = PROJECT_ROOT / "runtime" / "uploads" / "reports"
PATTERN_UPLOAD_DIR = PROJECT_ROOT / "runtime" / "uploads" / "patterns"
MIGRATIONS_DIR = PROJECT_ROOT / "apps" / "api" / "migrations"
MAX_RECENT_BARS = 500
ALLOWED_MARKETS = {"SH", "SZ", "BJ"}


def _read_config() -> configparser.ConfigParser:
    config = configparser.ConfigParser(interpolation=None)
    config_path = PROJECT_ROOT / "config.ini"
    if config_path.is_file():
        try:
            with config_path.open("r", encoding="utf-8-sig") as stream:
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
    if not config.has_section(provider_section) or not (PROJECT_ROOT / "config.ini").is_file():
        api_mode = os.environ.get("LLMR_LLM_API_MODE", api_mode).strip().lower()
        api_path = os.environ.get("LLMR_LLM_API_PATH", os.environ.get("LLMR_LLM_CHAT_PATH", api_path))
    return {
        "configured": bool(base_url and key and model),
        "base_url": base_url,
        "api_key": key,
        "model": model,
        "reasoning_effort": reasoning_effort,
        "api_mode": api_mode,
        "api_path": api_path,
    }


def research_settings() -> dict[str, int]:
    config = _read_config()
    section = config["research"] if config.has_section("research") else {}
    values = {}
    for name, default, minimum, maximum in (
        ("turn_timeout_seconds", 1200, 30, 7200),
        ("max_tool_calls", 0, 0, 10000),
        ("max_output_file_bytes", 50 * 1024 * 1024, 1024, 200 * 1024 * 1024),
    ):
        value = int(os.environ.get("LLMR_RESEARCH_" + name.upper(), section.get(name, str(default))))
        if not minimum <= value <= maximum:
            raise ValueError(f"research.{name} 应在 {minimum} 到 {maximum} 之间")
        values[name] = value
    return values


def research_mode_settings(mode: str | None) -> dict[str, int | str]:
    """Return user-facing research budgets without widening business write access."""
    normalized = (mode or "research").strip().lower()
    if normalized not in {"research", "screening", "advanced"}:
        normalized = "research"
    values: dict[str, int | str] = {**research_settings(), "mode": normalized}
    if normalized == "advanced":
        values["turn_timeout_seconds"] = max(int(values["turn_timeout_seconds"]), 3600)
        values["max_output_file_bytes"] = max(int(values["max_output_file_bytes"]), 200 * 1024 * 1024)
    return values


def default_research_mode() -> str:
    config = _read_config()
    section = config["research"] if config.has_section("research") else {}
    value = os.environ.get("LLMR_RESEARCH_MODE", section.get("mode", "research")).strip().lower()
    return value if value in {"research", "screening", "advanced"} else "research"


def tushare_settings() -> dict[str, str | float | int | bool]:
    """Read relay settings without exposing credentials to API callers.

    ``tushare_relay.py`` can provide its own default key for a local relay.
    An explicit config or environment value takes precedence, which keeps the
    project deployable when that adapter default is intentionally removed.
    """

    config = _read_config()
    relay = config["tushare"] if config.has_section("tushare") else {}
    api_key = (
        relay.get("relay_api_key", "")
        or relay.get("api_key", "")
        or os.environ.get(relay.get("relay_api_key_env", "TUSHARE_RELAY_API_KEY"), "")
    ).strip()
    base_url = (
        relay.get("relay_base_url", "")
        or relay.get("base_url", "")
        or os.environ.get("TUSHARE_RELAY_BASE_URL", "")
    ).strip()
    try:
        timeout = float(relay.get("timeout", "30"))
    except ValueError:
        timeout = 30.0
    try:
        retries = int(relay.get("retries", "3"))
    except ValueError:
        retries = 3
    return {
        "configured": bool(api_key),
        "uses_adapter_default": not bool(api_key),
        "api_key_env": relay.get("relay_api_key_env", "TUSHARE_RELAY_API_KEY"),
        "api_key": api_key,
        "base_url": base_url,
        "timeout": max(1.0, min(timeout, 120.0)),
        "retries": max(0, min(retries, 8)),
    }
