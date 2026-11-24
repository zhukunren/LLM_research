from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from . import local_codex
from .model_modes import DEFAULT_MODEL_MODE, MODEL_PRESETS
from .settings import llm_settings, research_model_settings


class ResearchModelError(ValueError):
    pass


_cache: dict[str, tuple[float, set[str], str]] = {}
_cache_lock = threading.Lock()


def discover_local(timeout_seconds: int = 3) -> tuple[set[str], str]:
    auth_file = local_codex.home() / "auth.json"
    try:
        stamp = auth_file.stat().st_mtime_ns
    except OSError:
        return set(), "authentication_failed"
    key = str(auth_file)
    with _cache_lock:
        entry = _cache.get(f"{key}:{stamp}")
        if entry and entry[0] > time.monotonic():
            return entry[1], entry[2]
        models, state = local_codex.discover(timeout_seconds)
        if len(_cache) > 8:
            _cache.clear()
        _cache[f"{key}:{stamp}"] = (time.monotonic() + (300 if state == "verified" else 30), models, state)
    return models, state


def _discover(settings: dict) -> tuple[set[str], str]:
    """Bounded, cached discovery. Never return provider URLs, credentials or errors."""
    if not settings.get("configured"):
        return set(), "unconfigured"
    if settings.get("backend") == "local_codex":
        return discover_local()
    key = hashlib.sha256((str(settings.get("base_url")) + "\0" + str(settings.get("api_key"))).encode()).hexdigest()
    with _cache_lock:
        cached = _cache.get(key)
        if cached and cached[0] > time.monotonic():
            return cached[1], cached[2]
        base = str(settings["base_url"]).rstrip("/")
        url = base + ("/models" if base.endswith("/v1") else "/v1/models")
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + str(settings["api_key"]), "Accept": "application/json"})
        models, state = set(), "unreachable"
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                body = json.loads(response.read(1_000_001))
            models = {item["id"] for item in body.get("data", []) if isinstance(item, dict)
                      and isinstance(item.get("id"), str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", item["id"])}
            state = "verified"
        except urllib.error.HTTPError as exc:
            state = "authentication_failed" if exc.code in {401, 403} else "unreachable"
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        if len(_cache) > 8:
            _cache.clear()
        _cache[key] = (time.monotonic() + (300 if state == "verified" else 30), models, state)
        return models, state


def catalog(settings: dict | None = None) -> dict[str, Any]:
    settings = llm_settings() if settings is None else settings
    policy = research_model_settings()
    discovered, discovery_state = _discover(settings)
    default = MODEL_PRESETS[DEFAULT_MODEL_MODE]
    disabled_models = {value.strip() for value in os.environ.get("LLMR_DISABLED_MODELS", "").split(",")}
    result = []
    for preset in MODEL_PRESETS.values():
        model_id, effort = preset.model_id, preset.reasoning_effort
        reason = None
        if not settings.get("configured"):
            reason = "模型服务尚未配置"
        elif model_id in disabled_models:
            reason = "管理员已禁用此档位"
        elif policy["account_tier"] == "free":
            reason = "当前 Free 账户不可用"
        elif policy["allowed_models"] and model_id not in policy["allowed_models"]:
            reason = "管理员未启用此模型"
        elif effort not in policy["reasoning_efforts"].get(model_id, (effort,)):
            reason = "服务配置未启用固定推理档位"
        elif discovery_state == "authentication_failed":
            reason = "本机 Codex 尚未登录 ChatGPT" if settings.get("backend") == "local_codex" else "模型服务认证失败"
        elif discovery_state == "verified" and model_id not in discovered:
            reason = f"当前服务商未提供 {model_id}"
        elif discovery_state == "unreachable" and (preset != default or settings.get("backend") == "local_codex"):
            reason = "暂时无法确认此档位可用"
        result.append({"id": model_id, "label": preset.label, "description": model_id, "available": reason is None,
                       "unavailable_reason": reason, "reasoning_efforts": [{"id": effort, "label": effort}],
                       "default_reasoning_effort": effort})
    return {"models": result, "default_model_id": default.model_id, "default_reasoning_effort": default.reasoning_effort,
            "account_tier": policy["account_tier"], "discovery_status": discovery_state}


def resolve_selection(model_id: str | None = None, reasoning_effort: str | None = None,
                      *, settings: dict | None = None) -> dict[str, str]:
    value = catalog(settings) if settings is not None else catalog()
    selected_id = model_id or value["default_model_id"]
    item = next((item for item in value["models"] if item["id"] == selected_id), None)
    if item is None:
        raise ResearchModelError("请选择即时或深度档")
    if not item["available"]:
        raise ResearchModelError(f"{item['label']}：{item['unavailable_reason']}")
    effort = reasoning_effort or item["default_reasoning_effort"]
    if effort not in {entry["id"] for entry in item["reasoning_efforts"]}:
        raise ResearchModelError("此模型的推理档位固定，请选择即时或深度档")
    return {"model_id": selected_id, "reasoning_effort": effort}
