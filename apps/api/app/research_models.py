from __future__ import annotations

import hashlib
import json
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from .settings import llm_settings, research_model_settings


class ResearchModelError(ValueError):
    pass


# Only models supported by this research runtime are offered. A provider's image,
# audio, review or unknown model IDs never become selectable by discovery alone.
MODEL_DEFINITIONS = {
    "gpt-6-luna": ("GPT-6 Luna", "日常研究与资料分析", ("none", "low", "medium", "high", "xhigh", "max"), True),
    "gpt-5.6-luna": ("GPT-5.6 Luna", "轻量研究与快速问答", ("low", "medium", "high", "max"), True),
    "gpt-6-astra": ("GPT-6 Astra", "复杂研究与深入分析", ("low", "medium", "high", "xhigh", "max"), False),
    "gpt-6-sol": ("GPT-6 Sol", "综合研究与推理", ("low", "medium", "high", "xhigh", "max"), False),
}
EFFORT_LABELS = {"none": "即时", "minimal": "极轻", "low": "轻量", "medium": "标准", "high": "深入",
                 "xhigh": "更深入", "max": "最大", "ultra": "极致"}
_cache: dict[str, tuple[float, set[str], str]] = {}
_cache_lock = threading.Lock()


def _discover(settings: dict) -> tuple[set[str], str]:
    """Bounded, cached discovery. Never return provider URLs, credentials or errors."""
    if not settings.get("configured"):
        return set(), "unconfigured"
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


def catalog() -> dict[str, Any]:
    settings, policy = llm_settings(), research_model_settings()
    discovered, discovery_state = _discover(settings)
    configured = str(settings.get("model") or "gpt-6-luna")
    definitions = dict(MODEL_DEFINITIONS)
    # A custom configured model is explicit operator support, with only its
    # configured effort exposed until the operator declares further capabilities.
    for model_id in dict.fromkeys([configured, *policy["allowed_models"]]):
        if model_id not in definitions:
            definitions[model_id] = (model_id, "服务端配置模型", (str(settings.get("reasoning_effort") or "high"),), model_id == configured)
    result = []
    for model_id, (label, description, default_efforts, free_supported) in definitions.items():
        efforts = policy["reasoning_efforts"].get(model_id, default_efforts)
        default_effort = str(settings.get("reasoning_effort") or "high")
        if default_effort not in efforts:
            default_effort = "high" if "high" in efforts else efforts[0]
        reason = None
        if policy["account_tier"] == "free" and (re.search(r"(?:^|-)(astra|sol)(?:-|$)", model_id, re.I) or not free_supported):
            reason = "当前 Free 账户不可用"
        elif policy["allowed_models"] and model_id not in policy["allowed_models"]:
            reason = "管理员未启用此模型"
        elif not settings.get("configured"):
            reason = "模型服务尚未配置"
        elif discovery_state == "authentication_failed":
            reason = "模型服务认证失败"
        elif model_id not in discovered and (model_id != configured or discovery_state == "verified"):
            reason = "当前模型服务尚未确认支持"
        result.append({"id": model_id, "label": label, "description": description, "available": reason is None,
                       "unavailable_reason": reason, "reasoning_efforts": [{"id": effort, "label": EFFORT_LABELS[effort]} for effort in efforts],
                       "default_reasoning_effort": default_effort})
    default = next(item for item in result if item["id"] == configured)
    return {"models": result, "default_model_id": configured, "default_reasoning_effort": default["default_reasoning_effort"],
            "account_tier": policy["account_tier"], "discovery_status": discovery_state}


def resolve_selection(model_id: str | None = None, reasoning_effort: str | None = None,
                      *, allow_unconfigured_default: bool = False) -> dict[str, str]:
    value = catalog()
    selected_id = model_id or value["default_model_id"]
    item = next((item for item in value["models"] if item["id"] == selected_id), None)
    if item is None:
        raise ResearchModelError("模型不在可用目录中，请选择已配置模型")
    if not item["available"] and not (allow_unconfigured_default and not model_id and value["discovery_status"] == "unconfigured"
                                      and item["unavailable_reason"] == "模型服务尚未配置"):
        raise ResearchModelError(f"{item['label']}：{item['unavailable_reason']}")
    effort = reasoning_effort or item["default_reasoning_effort"]
    if effort not in {entry["id"] for entry in item["reasoning_efforts"]}:
        raise ResearchModelError("此模型不支持所选推理档位")
    return {"model_id": selected_id, "reasoning_effort": effort}


def legacy_selection() -> dict[str, str]:
    """Display a legacy row without network I/O; validate again before executing."""
    settings = llm_settings()
    return {"model_id": str(settings.get("model") or "gpt-6-luna"),
            "reasoning_effort": str(settings.get("reasoning_effort") or "high")}
