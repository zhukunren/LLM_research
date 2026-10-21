"""Server-owned users, memberships, opaque sessions and delegated task credentials."""
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
from uuid import uuid4
from dataclasses import asdict, replace
from types import MappingProxyType

from .security_context import AccessDenied, ActorContext, LOCAL_ACTOR
from .storage import storage_paths


def identity_path() -> Path:
    return Path(os.environ.get("LLMR_IDENTITY_DB_PATH") or storage_paths().state_root / "identity.db").resolve()


def now() -> str:
    return datetime.now(UTC).isoformat()


def expiry(seconds: int) -> str:
    return (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat()


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


@contextmanager
def connect():
    path = identity_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA journal_mode=WAL")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize() -> None:
    from .settings import PROJECT_ROOT
    if os.environ.get("LLMR_REQUIRE_EXTERNAL_STORAGE", "false").lower() in {"true", "1"} and identity_path().is_relative_to(PROJECT_ROOT):
        raise ValueError("Identity storage must be outside the application directory")
    with connect() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
          platform_admin INTEGER NOT NULL DEFAULT 0, permissions_version INTEGER NOT NULL DEFAULT 1,
          legacy_workspace INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id));
        CREATE TABLE IF NOT EXISTS tenant_memberships(
          tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
          role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(tenant_id,user_id));
        CREATE TABLE IF NOT EXISTS external_identities(
          issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(issuer,subject));
        CREATE TABLE IF NOT EXISTS sessions(
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), tenant_id TEXT NOT NULL REFERENCES tenants(id),
          csrf_hash TEXT NOT NULL, csrf_token TEXT NOT NULL, permissions_version INTEGER NOT NULL,
          expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS oidc_requests(
          state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS service_sessions(
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), tenant_id TEXT NOT NULL REFERENCES tenants(id),
          conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, permissions_version INTEGER NOT NULL, expires_at TEXT NOT NULL,
          workspace_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS identity_audit(
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL);
        ''')
        c.execute("INSERT OR IGNORE INTO users(id,name,platform_admin,legacy_workspace,created_at) VALUES('local-admin','本机维护者',1,1,?)", (now(),))
        c.execute("INSERT OR IGNORE INTO tenants VALUES('local','local-admin')")
        c.execute("INSERT OR IGNORE INTO tenant_memberships VALUES('local','local-admin','owner')")


def _actor(c, user_id: str, tenant_id: str) -> ActorContext:
    row = c.execute("""SELECT u.*,m.role FROM users u JOIN tenant_memberships m ON m.user_id=u.id
                      WHERE u.id=? AND m.tenant_id=? AND u.active=1""", (user_id, tenant_id)).fetchone()
    if not row:
        raise AccessDenied("账户或所属空间已停用。", 401)
    return ActorContext(user_id, tenant_id, row["role"], bool(row["platform_admin"]), row["permissions_version"], bool(row["legacy_workspace"]))


def actor_for_user(user_id: str, tenant_id: str) -> ActorContext:
    with connect() as c:
        return _actor(c, user_id, tenant_id)


def assert_actor_current(actor: ActorContext) -> None:
    live = actor_for_user(actor.user_id, actor.tenant_id)
    if live.permissions_version != actor.permissions_version or live.role != actor.role or live.legacy != actor.legacy or live.platform_admin != actor.platform_admin:
        raise AccessDenied("权限已变更，请重新登录。", 401)


def user_from_oidc(issuer: str, subject: str, name: str) -> ActorContext:
    if not subject or len(subject) > 500:
        raise AccessDenied("登录身份无效。", 401)
    with connect() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT user_id FROM external_identities WHERE issuer=? AND subject=?", (issuer, subject)).fetchone()
        if row:
            user_id = row[0]
            tenant = c.execute("SELECT tenant_id FROM tenant_memberships WHERE user_id=? ORDER BY tenant_id LIMIT 1", (user_id,)).fetchone()[0]
        else:
            user_id, tenant = uuid4().hex, uuid4().hex
            c.execute("INSERT INTO users(id,name,created_at) VALUES(?,?,?)", (user_id, name[:120] or "研究用户", now()))
            c.execute("INSERT INTO tenants VALUES(?,?)", (tenant, user_id))
            c.execute("INSERT INTO tenant_memberships VALUES(?,?,'editor')", (tenant, user_id))
            c.execute("INSERT INTO external_identities VALUES(?,?,?)", (issuer, subject, user_id))
        return _actor(c, user_id, tenant)


def create_session(actor: ActorContext) -> tuple[str, str]:
    assert_actor_current(actor)
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    with connect() as c:
        c.execute("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,0)", (digest(token), actor.user_id, actor.tenant_id,
            digest(csrf), csrf, actor.permissions_version, expiry(8 * 3600)))
        c.execute("INSERT INTO identity_audit VALUES(?,?,?,?)", (uuid4().hex, actor.user_id, "login", now()))
    return token, csrf


def session_actor(token: str) -> tuple[ActorContext, str]:
    with connect() as c:
        row = c.execute("SELECT * FROM sessions WHERE token_hash=? AND revoked=0 AND expires_at>?", (digest(token), now())).fetchone()
        if not row:
            raise AccessDenied("登录已失效，请重新登录。", 401)
        actor = _actor(c, row["user_id"], row["tenant_id"])
        if actor.permissions_version != row["permissions_version"]:
            raise AccessDenied("权限已变更，请重新登录。", 401)
        return actor, row["csrf_token"]


def revoke_session(token: str) -> None:
    with connect() as c:
        c.execute("UPDATE sessions SET revoked=1 WHERE token_hash=?", (digest(token),))


def set_permissions(user_id: str, *, role: str | None = None, active: bool | None = None) -> None:
    if role is not None and role not in {"owner", "editor", "viewer"}:
        raise ValueError("Invalid role")
    previous = [actor for actor in execution_actors() if actor.user_id == user_id]
    with connect() as c:
        if not c.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone():
            raise KeyError(user_id)
        c.execute("UPDATE users SET permissions_version=permissions_version+1,active=COALESCE(?,active) WHERE id=?", (int(active) if active is not None else None, user_id))
        if role is not None:
            c.execute("UPDATE tenant_memberships SET role=? WHERE user_id=?", (role, user_id))
        c.execute("UPDATE sessions SET revoked=1 WHERE user_id=?", (user_id,))
        c.execute("DELETE FROM service_sessions WHERE user_id=?", (user_id,))
        c.execute("INSERT INTO identity_audit VALUES(?,?,?,?)", (uuid4().hex, user_id, "permissions_changed", now()))
    for prior in previous:
        from .security_context import actor_scope
        from . import db
        with actor_scope(replace(prior, maintenance=True)):
            if db.database_path().is_file():
                with db.connect() as c:
                    from .jobs import cancel_workspace_jobs
                    c.execute("BEGIN IMMEDIATE")
                    cancel_workspace_jobs(c, message="用户权限已撤销")


def execution_actors() -> list[ActorContext]:
    with connect() as c:
        rows = c.execute("SELECT user_id,tenant_id FROM tenant_memberships ORDER BY tenant_id,user_id").fetchall()
        result = []
        for row in rows:
            try:
                result.append(_actor(c, row[0], row[1]))
            except AccessDenied:
                continue
        return result


def service_token(actor: ActorContext, conversation_id: str, turn_id: str, seconds: int) -> str:
    assert_actor_current(actor)
    from .security_context import can_write, current_actor
    bound = current_actor()
    if (bound.user_id, bound.tenant_id) != (actor.user_id, actor.tenant_id):
        raise AccessDenied("研究任务身份与工作空间不匹配。", 403)
    if not can_write(actor):
        raise AccessDenied("当前账户不能执行研究任务。", 403)
    token = secrets.token_urlsafe(32)
    from .storage import application_paths
    workspace = {key: str(value) for key, value in asdict(application_paths()).items()}
    with connect() as c:
        c.execute("INSERT INTO service_sessions VALUES(?,?,?,?,?,?,?,?)", (digest(token), actor.user_id, actor.tenant_id,
            conversation_id, turn_id, actor.permissions_version, expiry(seconds), json.dumps(workspace)))
    return token


def link_external_identity(issuer: str, subject: str, user_id: str) -> None:
    """Trusted operator action; never exposed as a user or agent capability."""
    if not issuer or not subject or len(subject) > 500:
        raise ValueError("Issuer and subject are required")
    with connect() as c:
        if not c.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone():
            raise KeyError(user_id)
        existing = c.execute("SELECT user_id FROM external_identities WHERE issuer=? AND subject=?", (issuer, subject)).fetchone()
        if existing and existing[0] != user_id:
            raise ValueError("This OIDC identity is already linked to another workspace")
        c.execute("INSERT OR IGNORE INTO external_identities VALUES(?,?,?)", (issuer, subject, user_id))
        c.execute("INSERT INTO identity_audit VALUES(?,?,?,?)", (uuid4().hex, user_id, "identity_linked", now()))


def service_actor(token: str, conversation_id: str, turn_id: str) -> ActorContext:
    with connect() as c:
        row = c.execute("SELECT * FROM service_sessions WHERE token_hash=? AND expires_at>? AND conversation_id=? AND turn_id=?",
                        (digest(token), now(), conversation_id, turn_id)).fetchone()
        if not row:
            raise AccessDenied("研究任务凭证无效。", 401)
        actor = _actor(c, row["user_id"], row["tenant_id"])
        if actor.permissions_version != row["permissions_version"]:
            raise AccessDenied("研究任务权限已撤销。", 401)
        return replace(actor, workspace=MappingProxyType(json.loads(row["workspace_json"])))
