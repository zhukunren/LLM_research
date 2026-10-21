"""Trusted identity propagated through HTTP, worker and MCP execution."""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import os
from typing import Mapping


class AccessDenied(ValueError):
    def __init__(self, message: str, status: int = 403):
        self.status = status
        super().__init__(message)


@dataclass(frozen=True)
class ActorContext:
    user_id: str
    tenant_id: str
    role: str = "editor"
    platform_admin: bool = False
    permissions_version: int = 1
    legacy: bool = False
    maintenance: bool = False
    workspace: Mapping[str, str] | None = None


LOCAL_ACTOR = ActorContext("local-admin", "local", "owner", True, legacy=True)
_actor: ContextVar[ActorContext | None] = ContextVar("llmr_actor", default=None)


def auth_mode() -> str:
    from .settings import _read_config
    config = _read_config()
    mode = os.environ.get("LLMR_AUTH_MODE") or config.get("auth", "mode", fallback="local")
    if mode not in {"local", "oidc"}:
        raise ValueError("LLMR_AUTH_MODE must be local or oidc")
    return mode


def current_actor() -> ActorContext:
    actor = _actor.get()
    if actor is None:
        if auth_mode() == "local":
            return LOCAL_ACTOR
        raise AccessDenied("请先登录。", 401)
    if not actor.maintenance and auth_mode() == "oidc":
        from .identity import assert_actor_current
        assert_actor_current(actor)
    return actor


@contextmanager
def actor_scope(actor: ActorContext):
    token = _actor.set(actor)
    try:
        yield actor
    finally:
        _actor.reset(token)


def can_write(actor: ActorContext) -> bool:
    return actor.role in {"owner", "editor"}


def has_actor_scope() -> bool:
    return _actor.get() is not None
