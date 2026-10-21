"""OIDC authorization-code login with PKCE and server-side, revocable sessions."""
from functools import lru_cache
import base64
import hashlib
import hmac
import os
import secrets
from urllib.parse import quote_plus, urlencode, urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse
import requests

from . import identity
from .security_context import AccessDenied, auth_mode, current_actor
from .settings import _read_config

router = APIRouter()
COOKIE = "llmr_session"
STATE_COOKIE = "llmr_oidc_state"


def option(name: str, default="") -> str:
    return os.environ.get("LLMR_AUTH_" + name.upper()) or _read_config().get("auth", name, fallback=default)


def settings() -> dict:
    issuer = option("issuer")
    client = option("client_id")
    public = option("public_url").rstrip("/")
    development = option("allow_http_loopback", "false") == "true"
    for value in (issuer, public):
        parts = urlsplit(value)
        allowed = parts.scheme == "https" or (development and parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1", "::1"})
        if not value or not allowed or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
            raise AccessDenied("登录服务尚未正确配置。", 503)
    if not client:
        raise AccessDenied("登录服务尚未配置 client ID。", 503)
    if urlsplit(public).path not in {"", "/"}:
        raise AccessDenied("public_url 必须为站点根地址。", 503)
    return {"issuer": issuer, "client_id": client, "client_secret": option("client_secret"),
            "public_url": public, "redirect_uri": public + "/auth/callback", "secure": urlsplit(public).scheme == "https"}


@lru_cache(maxsize=8)
def discovery(issuer: str) -> dict:
    response = requests.get(issuer.rstrip("/") + "/.well-known/openid-configuration", timeout=15, allow_redirects=False)
    response.raise_for_status()
    result = response.json()
    if result.get("issuer", "") != issuer:
        raise AccessDenied("登录服务 issuer 不匹配。", 503)
    development = option("allow_http_loopback", "false") == "true"
    for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        parsed = urlsplit(result.get(key, ""))
        allowed = parsed.scheme == "https" or (development and parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"})
        if not allowed or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise AccessDenied("登录服务端点无效。", 503)
    if "code_challenge_methods_supported" in result and "S256" not in result["code_challenge_methods_supported"]:
        raise AccessDenied("登录服务需要支持 PKCE S256。", 503)
    return result


def verify_id_token(token: str, nonce: str, configuration: dict, metadata: dict) -> dict:
    import jwt
    key = jwt.PyJWKClient(metadata["jwks_uri"], timeout=15).get_signing_key_from_jwt(token)
    claims = jwt.decode(token, key.key, algorithms=["RS256"], audience=configuration["client_id"], issuer=configuration["issuer"],
                        options={"require": ["iss", "aud", "sub", "exp", "iat", "nonce"]})
    if claims.get("azp", configuration["client_id"]) != configuration["client_id"] or (isinstance(claims["aud"], list) and len(claims["aud"]) > 1 and "azp" not in claims):
        raise AccessDenied("登录 audience 不匹配。", 401)
    if not isinstance(claims["nonce"], str) or not hmac.compare_digest(claims["nonce"].encode(), nonce.encode()):
        raise AccessDenied("登录 nonce 不匹配。", 401)
    return claims


@router.get("/api/v1/auth/status")
def status():
    return {"mode": auth_mode(), "login_url": "/auth/login" if auth_mode() == "oidc" else None}


@router.get("/api/v1/me")
def me(request: Request):
    actor = current_actor()
    return {"user_id": actor.user_id, "tenant_id": actor.tenant_id, "role": actor.role,
            "platform_admin": actor.platform_admin, "permissions_version": actor.permissions_version,
            "mode": auth_mode(), "csrf_token": getattr(request.state, "csrf_token", "")}


@router.get("/auth/login")
def login():
    if auth_mode() != "oidc":
        return RedirectResponse("/")
    configuration = settings()
    metadata = discovery(configuration["issuer"])
    state, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(3))
    with identity.connect() as c:
        c.execute("DELETE FROM oidc_requests WHERE expires_at<=?", (identity.now(),))
        c.execute("INSERT INTO oidc_requests VALUES(?,?,?,?,0)", (identity.digest(state), nonce, verifier, identity.expiry(600)))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    params = {"client_id": configuration["client_id"], "redirect_uri": configuration["redirect_uri"],
              "response_type": "code", "scope": "openid profile email", "state": state, "nonce": nonce,
              "code_challenge": challenge, "code_challenge_method": "S256"}
    response = RedirectResponse(metadata["authorization_endpoint"] + "?" + urlencode(params))
    response.set_cookie(STATE_COOKIE, state, max_age=600, httponly=True, secure=configuration["secure"], samesite="lax")
    return response


@router.get("/auth/callback")
def callback(request: Request, code: str = "", state: str = ""):
    try:
        configuration = settings()
        expected = request.cookies.get(STATE_COOKIE, "")
        if not code or not state or not expected or not hmac.compare_digest(state.encode(), expected.encode()):
            raise AccessDenied("登录请求已失效。", 401)
        with identity.connect() as c:
            c.execute("BEGIN IMMEDIATE")
            pending = c.execute("SELECT * FROM oidc_requests WHERE state_hash=? AND used=0 AND expires_at>?", (identity.digest(state), identity.now())).fetchone()
            if not pending:
                raise AccessDenied("登录请求已使用或过期。", 401)
            c.execute("UPDATE oidc_requests SET used=1 WHERE state_hash=?", (identity.digest(state),))
        metadata = discovery(configuration["issuer"])
        body = {"grant_type": "authorization_code", "code": code, "redirect_uri": configuration["redirect_uri"],
                "client_id": configuration["client_id"], "code_verifier": pending["verifier"]}
        authentication = None
        if configuration["client_secret"]:
            methods = metadata.get("token_endpoint_auth_methods_supported", ["client_secret_basic"])
            if "client_secret_basic" in methods:
                authentication = (quote_plus(configuration["client_id"]), quote_plus(configuration["client_secret"]))
            elif "client_secret_post" in methods:
                body["client_secret"] = configuration["client_secret"]
            else:
                raise AccessDenied("登录服务的客户端认证方式尚不支持。", 503)
        exchanged = requests.post(metadata["token_endpoint"], data=body, auth=authentication, timeout=15, allow_redirects=False)
        exchanged.raise_for_status()
        claims = verify_id_token(exchanged.json()["id_token"], pending["nonce"], configuration, metadata)
        actor = identity.user_from_oidc(configuration["issuer"], claims["sub"], str(claims.get("name") or "研究用户"))
        token, _ = identity.create_session(actor)
        response = RedirectResponse("/")
        response.set_cookie(COOKIE, token, max_age=8*3600, httponly=True, secure=configuration["secure"], samesite="lax")
        response.delete_cookie(STATE_COOKIE)
        return response
    except Exception:
        # Never return provider tokens, URLs, client secrets or JWT error detail.
        return JSONResponse({"code": "login_failed", "message": "登录未完成，请重新登录。"}, status_code=401)


@router.post("/auth/logout")
def logout(request: Request):
    identity.revoke_session(request.cookies.get(COOKIE, ""))
    response = JSONResponse({"logged_out": True})
    response.delete_cookie(COOKIE)
    return response
