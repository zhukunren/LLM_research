"""ChatGPT sign-in and model requests through the project's local Codex binary."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .model_modes import ModelPreset
from .storage import storage_paths


PROVIDER = "openai"
AUTH_OVERRIDES = (
    'model_provider="openai"',
    'forced_login_method="chatgpt"',
    'chatgpt_base_url="https://chatgpt.com/backend-api/"',
    'cli_auth_credentials_store="file"',
)


class LocalCodexError(RuntimeError):
    pass


def home() -> Path:
    return storage_paths().codex_home


def binary() -> str:
    configured = os.environ.get("LLMR_CODEX_BIN", "").strip()
    if configured:
        return configured
    from codex_cli_bin import bundled_codex_path

    return str(bundled_codex_path())


def environment(source: dict[str, str]) -> dict[str, str]:
    env = source.copy()
    for key in (
        "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN",
        "CODEX_REFRESH_TOKEN_URL_OVERRIDE", "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
        "CODEX_APP_SERVER_LOGIN_CLIENT_ID", "LLMR_CODEX_API_KEY", "LLMR_LLM_API_KEY", "LLMR_LLM_BASE_URL",
    ):
        env.pop(key, None)
    env.update({"CODEX_HOME": str(home()), "CODEX_SQLITE_HOME": str(home())})
    if proxy := env.get("LLMR_CODEX_HTTPS_PROXY"):
        for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
            env[key] = proxy
    return env


def _flags(overrides: tuple[str, ...]) -> list[str]:
    return [part for item in overrides for part in ("-c", item)]


def discover(timeout_seconds: int) -> tuple[set[str], str]:
    if not (home() / "auth.json").is_file():
        return set(), "authentication_failed"
    try:
        codex = binary()
        env = environment(os.environ.copy())
        flags = _flags(AUTH_OVERRIDES)
        login = subprocess.run([codex, *flags, "login", "status"], env=env, stdin=subprocess.DEVNULL,
                               capture_output=True, encoding="utf-8", timeout=timeout_seconds)
        if login.returncode != 0:
            return set(), "authentication_failed"
        result = subprocess.run([codex, *flags, "debug", "models"], env=env, stdin=subprocess.DEVNULL,
                                capture_output=True, encoding="utf-8", timeout=timeout_seconds)
        if result.returncode == 0:
            models = json.loads(result.stdout)["models"]
            return {item["slug"] for item in models if isinstance(item.get("slug"), str)}, "verified"
    except (OSError, ImportError, subprocess.TimeoutExpired, ValueError, TypeError, KeyError, AttributeError):
        pass
    return set(), "unreachable"


def complete(
    preset: ModelPreset,
    instructions: str,
    prompt: str,
    *,
    timeout_seconds: int,
    max_output_tokens: int,
    schema: dict[str, Any] | None = None,
) -> tuple[str, dict[str, int]]:
    """Run an ephemeral, tool-free invocation for application-owned text tasks."""
    with tempfile.TemporaryDirectory(prefix="llmr-codex-text-") as directory:
        workspace = Path(directory)
        instruction_file = workspace / "instructions.md"
        instruction_file.write_text(instructions, encoding="utf-8")
        tier = "fast" if preset.service_tier == "priority" else "default"
        overrides = AUTH_OVERRIDES + (
            f"model_instructions_file={json.dumps(str(instruction_file))}",
            f'model_reasoning_effort="{preset.reasoning_effort}"',
            f'service_tier="{tier}"',
            'web_search="disabled"',
            'features.shell_tool=false',
            'features.unified_exec=false',
            'features.plugins=false',
            'features.multi_agent=false',
            'features.multi_agent_v2=false',
        )
        schema_args = []
        if schema is not None:
            schema_file = workspace / "output-schema.json"
            schema_file.write_text(json.dumps(schema, ensure_ascii=False), encoding="utf-8")
            schema_args = ["--output-schema", str(schema_file)]
        try:
            result = subprocess.run(
                [binary(), "-a", "never", *_flags(overrides), "exec", "--ignore-user-config", "--ignore-rules",
                 "--skip-git-repo-check", "--ephemeral", "--json", "-s", "read-only", "-C", directory,
                 "-m", preset.model_id, *schema_args, "-"],
                env=environment(os.environ.copy()), cwd=directory, capture_output=True, encoding="utf-8",
                input=f"{prompt}\n\nKeep the final response within {max_output_tokens} output tokens.",
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired:
            raise LocalCodexError(f"本机 Codex 超过 {timeout_seconds} 秒未完成请求") from None
        except (OSError, ImportError):
            raise LocalCodexError("本机 Codex 无法启动") from None

    if result.returncode != 0:
        details = (result.stdout + result.stderr).lower()
        if "model_not_found" in details or "not supported when using codex" in details:
            raise LocalCodexError(f"本机 Codex 账户无法调用 {preset.model_id}（model_not_found）")
        if "401" in details or "not logged in" in details or "auth" in details and "expired" in details:
            raise LocalCodexError("本机 Codex 登录已失效，请重新登录 ChatGPT")
        if "429" in details or "rate_limit" in details or "usage limit" in details:
            raise LocalCodexError("本机 Codex 账户达到请求或使用限额")
        raise LocalCodexError("本机 Codex 未完成模型请求，请检查服务日志或重试")

    answer, usage = None, {}
    for line in result.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "item.completed" and event.get("item", {}).get("type") == "agent_message":
            answer = event["item"].get("text")
        elif event.get("type") == "turn.completed" and isinstance(event.get("usage"), dict):
            usage = event["usage"]
    if not isinstance(answer, str) or not answer.strip():
        raise LocalCodexError("本机 Codex 未返回文本")
    return answer, usage
