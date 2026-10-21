"""Real HTTP authorization and personal-workspace isolation across two users."""
from dataclasses import replace
import io
import base64
import hashlib
import json
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient
import pytest

from apps.api.app import auth, db, identity, main, research_models
from apps.api.app.security_context import AccessDenied, LOCAL_ACTOR, actor_scope


@pytest.fixture
def users(tmp_path, monkeypatch):
    monkeypatch.setenv("LLMR_AUTH_MODE", "oidc")
    monkeypatch.setenv("LLMR_STATE_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("LLMR_UPLOAD_ROOT", str(tmp_path / "uploads"))
    monkeypatch.setenv("LLMR_ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    monkeypatch.setenv("LLMR_SANDBOX_STATE_ROOT", str(tmp_path / "sandbox"))
    monkeypatch.setenv("LLMR_IDENTITY_DB_PATH", str(tmp_path / "identity.db"))
    monkeypatch.setenv("LLMR_AUTH_ISSUER", "https://issuer.example")
    monkeypatch.setenv("LLMR_AUTH_CLIENT_ID", "fixture-client")
    monkeypatch.setenv("LLMR_AUTH_PUBLIC_URL", "https://app.example")
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "legacy.db")
    monkeypatch.setattr(research_models, "llm_settings", lambda: {"configured": False, "model": "gpt-6-luna", "reasoning_effort": "high"})
    identity.initialize()
    a = identity.user_from_oidc("https://issuer.example", "A", "Alice")
    b = identity.user_from_oidc("https://issuer.example", "B", "Bob")
    with TestClient(main.app, base_url="https://app.example") as client:
        yield client, a, b


def login(client, actor):
    token, csrf = identity.create_session(actor)
    client.cookies.set(auth.COOKIE, token)
    client.headers.update({"X-CSRF-Token": csrf, "Origin": "https://app.example"})
    return token, csrf


def create(client, request="same-request"):
    response = client.post("/api/v1/conversations", json={"entry_scope": "report", "request_id": request})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_two_users_cannot_read_modify_download_or_cancel_each_others_resources(users):
    client, a, b = users
    login(client, a)
    cid = create(client)
    attached = client.post(f"/api/v1/conversations/{cid}/attachments", data={"request_id": "upload"}, files={"file": ("private.txt", b'Alice private bytes', "text/plain")})
    assert attached.status_code == 201, attached.text
    attachment_id = attached.json()["id"]
    login(client, b)
    other = create(client)
    assert other != cid
    assert client.get("/api/v1/conversations").json()["items"][0]["id"] == other
    for method, path, body in [
        ("GET", f"/api/v1/conversations/{cid}", None),
        ("GET", f"/api/v1/conversations/{cid}/export", None),
        ("GET", f"/api/v1/conversations/{cid}/attachments/{attachment_id}/download", None),
        ("GET", f"/api/v1/conversations/{cid}/generated-files", None),
        ("DELETE", f"/api/v1/conversations/{cid}", None),
        ("PATCH", f"/api/v1/conversations/{cid}", {"title": "spoof"}),
    ]:
        result = client.request(method, path, json=body)
        assert result.status_code == 404, (method, path, result.text)
    assert client.post("/api/v1/conversations", json={"entry_scope": "report", "tenant_id": a.tenant_id}).status_code == 422
    login(client, a)
    assert client.get(attached.json()["url"]).content == b'Alice private bytes'
    assert client.get(f"/api/v1/conversations/{cid}").status_code == 200


def test_missing_session_csrf_and_read_only_role_fail_before_mutation(users):
    client, a, _ = users
    assert client.get("/api/v1/conversations").status_code == 401
    login(client, a)
    client.headers.pop("X-CSRF-Token")
    assert client.post("/api/v1/conversations", json={"entry_scope": "report"}).status_code == 403
    identity.set_permissions(a.user_id, role="viewer")
    viewer = identity.actor_for_user(a.user_id, a.tenant_id)
    login(client, viewer)
    assert client.get("/api/v1/conversations").status_code == 200
    assert client.post("/api/v1/conversations", json={"entry_scope": "report"}).status_code == 403
    assert client.post("/api/v1/maintenance/refresh").status_code == 403
    assert client.post("/auth/logout").status_code == 200
    assert client.get("/api/v1/me").status_code == 401


def test_database_context_does_not_leak_and_missing_actor_is_denied(users):
    _, a, b = users
    with actor_scope(a):
        db.init_db()
        path_a = db.database_path()
    with actor_scope(b):
        db.init_db()
        path_b = db.database_path()
    assert path_a != path_b
    with pytest.raises(AccessDenied):
        db.database_path()


def test_comparison_changes_and_quality_are_private_and_read_only_roles_cannot_modify(users):
    client, a, b = users
    login(client, a)
    project = client.post('/api/v1/research-projects', json={'name': '私有公司核验', 'request_id': 'project'}).json()
    pid = project['id']
    client.post(f'/api/v1/research-projects/{pid}/companies', json={'stock_code': '600519.SH'}).raise_for_status()
    matrix = client.post(f'/api/v1/research-projects/{pid}/matrices', json={'name': '私有对比', 'stock_codes': ['600519.SH'], 'questions': [{'id': 'orders', 'label': '订单', 'prompt': '核验订单'}], 'request_id': 'matrix'}).json()
    run = client.post(f"/api/v1/research-projects/{pid}/matrices/{matrix['id']}/runs", json={'as_of': '2026-09-10', 'mode': 'manual', 'request_id': 'run'}).json()
    client.post(f'/api/v1/research-projects/{pid}/companies/600519.SH/changes', json={'as_of': '2026-09-10', 'request_id': 'baseline'}).raise_for_status()
    login(client, b)
    for suffix in ('matrices', f"matrices/{matrix['id']}/runs", f"matrices/{matrix['id']}/runs/{run['id']}/export", 'quality', 'companies/600519.SH/changes'):
        assert client.get(f'/api/v1/research-projects/{pid}/{suffix}').status_code == 404
    identity.set_permissions(a.user_id, role='viewer')
    viewer = identity.actor_for_user(a.user_id, a.tenant_id)
    login(client, viewer)
    assert client.get(f'/api/v1/research-projects/{pid}/quality').status_code == 200
    assert client.get(f"/api/v1/research-projects/{pid}/matrices/{matrix['id']}/runs").status_code == 200
    assert client.post(f'/api/v1/research-projects/{pid}/companies/600519.SH/changes', json={'as_of': '2026-09-11', 'request_id': 'denied'}).status_code == 403
    assert client.post(f"/api/v1/research-projects/{pid}/matrices/{matrix['id']}/runs/{run['id']}/review", json={'stock_code': '600519.SH', 'question_id': 'orders', 'base_revision': 0, 'answer': 'denied', 'status': 'needs_review', 'request_id': 'denied'}).status_code == 403


def test_delegated_task_is_bound_to_actor_and_turn_and_revoked_with_permissions(users):
    client, a, b = users
    login(client, a)
    cid = create(client)
    with actor_scope(a):
        token = identity.service_token(a, cid, "turn-a", 60)
    delegated = identity.service_actor(token, cid, "turn-a")
    with actor_scope(b), pytest.raises(AccessDenied):
        identity.service_token(a, cid, "turn-a", 60)
    with actor_scope(delegated):
        assert db.database_path().is_file()
        assert db.database_path().name == "app.db"
    with pytest.raises(AccessDenied):
        identity.service_actor(token, cid, "turn-b")
    identity.set_permissions(a.user_id, active=False)
    with pytest.raises(AccessDenied):
        identity.service_actor(token, cid, "turn-a")
    assert client.get("/api/v1/me").status_code == 401


@pytest.mark.parametrize("client_auth", ["none", "client_secret_basic", "client_secret_post"])
def test_oidc_code_flow_uses_pkce_secure_cookie_and_consumes_state_once(users, monkeypatch, client_auth):
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa
    client, _, _ = users
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key())) | {"kid": "fixture", "alg": "RS256", "use": "sig"}
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", lambda self: {"keys": [jwk]})
    metadata = {"issuer": "https://issuer.example", "authorization_endpoint": "https://issuer.example/authorize", "token_endpoint": "https://issuer.example/token", "jwks_uri": "https://issuer.example/keys"}
    metadata["token_endpoint_auth_methods_supported"] = [client_auth]
    monkeypatch.setenv("LLMR_AUTH_CLIENT_SECRET", "fixture-secret" if client_auth != "none" else "")
    monkeypatch.setattr(auth.requests, "get", lambda *args, **kwargs: SimpleNamespace(raise_for_status=lambda: None, json=lambda: metadata))
    auth.discovery.cache_clear()
    try:
        started = client.get("/auth/login", follow_redirects=False)
        assert started.status_code == 307
        cookie = started.headers["set-cookie"].lower()
        assert "secure" in cookie and "httponly" in cookie and "samesite=lax" in cookie
        params = parse_qs(urlsplit(started.headers["location"]).query)
        exchanged = []

        def exchange(url, *, data, **kwargs):
            exchanged.append(data)
            assert url == metadata["token_endpoint"] and kwargs["allow_redirects"] is False
            assert kwargs["auth"] == (("fixture-client", "fixture-secret") if client_auth == "client_secret_basic" else None)
            assert data.get("client_secret") == ("fixture-secret" if client_auth == "client_secret_post" else None)
            challenge = base64.urlsafe_b64encode(hashlib.sha256(data["code_verifier"].encode()).digest()).rstrip(b"=").decode()
            assert challenge == params["code_challenge"][0]
            assert data["redirect_uri"] == "https://app.example/auth/callback"
            claims = {"iss": metadata["issuer"], "aud": "fixture-client", "sub": "flow-user", "exp": int(time.time()) + 120, "iat": int(time.time()), "nonce": params["nonce"][0]}
            token = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "fixture"})
            return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"id_token": token})

        monkeypatch.setattr(auth.requests, "post", exchange)
        callback = "/auth/callback?code=fixture-code&state=" + params["state"][0]
        completed = client.get(callback, follow_redirects=False)
        assert completed.status_code == 307, completed.text
        assert "httponly" in completed.headers["set-cookie"].lower()
        assert client.get("/api/v1/me").json()["mode"] == "oidc"
        client.cookies.set(auth.STATE_COOKIE, params["state"][0])
        assert client.get(callback, follow_redirects=False).status_code == 401
        assert len(exchanged) == 1
        with identity.connect() as c:
            stored = c.execute("SELECT token_hash FROM sessions").fetchone()[0]
        assert stored != client.cookies.get(auth.COOKIE)
    finally:
        auth.discovery.cache_clear()


def test_invalid_or_expired_state_never_exchanges_a_code(users, monkeypatch):
    client, _, _ = users
    monkeypatch.setattr(auth.requests, "post", lambda *args, **kwargs: pytest.fail("Invalid state must never reach token exchange"))
    client.cookies.set(auth.STATE_COOKIE, "expected")
    assert client.get("/auth/callback?code=code&state=forged").status_code == 401
    with identity.connect() as c:
        c.execute("INSERT INTO oidc_requests VALUES(?,?,?,?,0)", (identity.digest("expected"), "nonce", "verifier", "2000-01-01T00:00:00+00:00"))
    assert client.get("/auth/callback?code=code&state=expected").status_code == 401


def test_same_tenant_users_still_have_private_workspaces_and_public_names(users):
    client, a, b = users
    with identity.connect() as c:
        c.execute("INSERT INTO tenant_memberships VALUES(?,?,'editor')", (a.tenant_id, b.user_id))
    b = identity.actor_for_user(b.user_id, a.tenant_id)
    with actor_scope(replace(LOCAL_ACTOR, maintenance=True)):
        with db.connect() as c:
            c.execute("INSERT INTO security_catalog VALUES('600519.SH','公共名称','gonggong','gg','SH',?)", (identity.now(),))
    login(client, a)
    cid = create(client)
    login(client, b)
    assert client.get(f"/api/v1/conversations/{cid}").status_code == 404
    assert client.get("/api/v1/security-catalog?query=公共").status_code == 200
    with actor_scope(b):
        with db.connect() as c:
            assert c.execute("SELECT name FROM security_catalog WHERE stock_code='600519.SH'").fetchone()[0] == "公共名称"


def test_private_artifacts_and_pattern_images_remain_usable_for_owner(users):
    from PIL import Image
    from apps.api.app import patterns, research_workspace
    client, a, b = users
    login(client, a)
    cid = create(client)
    with actor_scope(a):
        output = research_workspace.directory(cid) / "outputs" / "proof.txt"
        output.parent.mkdir(parents=True)
        output.write_text("private result", encoding="utf-8")
    image = io.BytesIO()
    Image.new("RGB", (300, 180), "white").save(image, format="PNG")
    payload = {"name": "private image", "input_type": "screenshot", "representation": "price_path", "target_bars": 10, "points": [i/9 for i in range(10)], "source_image_base64": base64.b64encode(image.getvalue()).decode(), "source_image_mime": "image/png"}
    saved = client.post("/api/v1/patterns", json=payload)
    assert saved.status_code == 200, saved.text
    pid = saved.json()["id"]
    image_url = f"/api/v1/patterns/{pid}/source-image?version=1"
    file_url = f"/api/v1/conversations/{cid}/generated-files/proof.txt"
    assert client.get(image_url).content == image.getvalue()
    assert client.get(file_url).text == "private result"
    with actor_scope(a):
        root_a = patterns.upload_directory()
    login(client, b)
    assert client.get(image_url).status_code == 404
    assert client.get(file_url).status_code == 404
    with actor_scope(b):
        assert patterns.upload_directory() != root_a


def test_read_only_role_can_search_but_cannot_execute_or_use_admin_tools(users):
    client, a, _ = users
    identity.set_permissions(a.user_id, role="viewer")
    login(client, identity.actor_for_user(a.user_id, a.tenant_id))
    response = client.post("/api/v1/documents/search", json={"query": "订单", "mode": "exact"})
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "no-store"
    for path in ("/api/v1/indicators/preview", "/api/v1/patterns/preview", "/api/v1/settings/model-test", "/api/v1/documents/import-local"):
        assert client.post(path, json={}).status_code == 403
    client.headers.update({"X-User-ID": "local-admin", "X-Tenant-ID": "local", "X-Role": "owner"})
    assert client.get("/api/v1/me").json()["role"] == "viewer"


def test_server_operator_can_link_legacy_data_without_exposing_it_to_new_users(users):
    client, a, _ = users
    with actor_scope(replace(LOCAL_ACTOR, maintenance=True)):
        from apps.api.app.conversation_store import create_conversation
        cid = create_conversation("report")["id"]
    identity.link_external_identity("https://issuer.example", "legacy-user", "local-admin")
    legacy = identity.user_from_oidc("https://issuer.example", "legacy-user", "legacy")
    login(client, legacy)
    assert client.get(f"/api/v1/conversations/{cid}").status_code == 200
    login(client, a)
    assert client.get(f"/api/v1/conversations/{cid}").status_code == 404
    with pytest.raises(ValueError):
        identity.link_external_identity("https://issuer.example", "legacy-user", a.user_id)


def test_worker_propagates_each_owner_and_revocation_stops_late_completion(users, monkeypatch):
    from apps.api.app import report_catalog, worker
    from apps.api.app.security_context import current_actor
    _, a, b = users
    for actor in (a, b):
        with actor_scope(actor):
            db.init_db()
            with db.connect() as c:
                c.execute("INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at) VALUES('same-job','report_metadata','{}','queued','',?,?)", (identity.now(), identity.now()))
    observed = []

    def execute(lease):
        actor = current_actor()
        observed.append(actor.user_id)
        identity.set_permissions(actor.user_id, role="viewer")
        assert not lease.active()
        lease.finish("succeeded", "must not commit")

    monkeypatch.setattr(report_catalog, "execute", execute)
    assert worker.execute_job() and worker.execute_job()
    assert set(observed) == {a.user_id, b.user_id}
    for actor in (a, b):
        with actor_scope(identity.actor_for_user(actor.user_id, actor.tenant_id)):
            with db.connect() as c:
                assert c.execute("SELECT state,message FROM jobs WHERE id='same-job'").fetchone()[0] == "cancelled"


def test_revocation_before_commit_rolls_back_business_writes(users):
    _, a, _ = users
    with actor_scope(a):
        db.init_db()
        with pytest.raises(AccessDenied):
            with db.connect() as c:
                c.execute("INSERT INTO watchlists(id,name,created_at) VALUES('late','must rollback',?)", (identity.now(),))
                with identity.connect() as control:
                    control.execute("UPDATE users SET permissions_version=permissions_version+1 WHERE id=?", (a.user_id,))
    with actor_scope(identity.actor_for_user(a.user_id, a.tenant_id)):
        with db.connect() as c:
            assert c.execute("SELECT 1 FROM watchlists WHERE id='late'").fetchone() is None


@pytest.mark.parametrize("protocol", ["condition-decisions-v1", "screening-task-v1", "research-scan-v1", "research-turn-v1"])
def test_authorization_snapshot_does_not_disable_protocol_lease_guards(users, protocol):
    import sqlite3
    _, a, _ = users
    with actor_scope(a):
        db.init_db()
        with db.connect() as c:
            c.execute("INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at,required_protocol) VALUES('guard','report_metadata','{}','queued','',?,?,?)", (identity.now(), identity.now(), protocol))
            snapshot = json.loads(c.execute("SELECT authorization_json FROM jobs WHERE id='guard'").fetchone()[0])
            assert snapshot["user_id"] == a.user_id and snapshot["tenant_id"] == a.tenant_id
            with pytest.raises(sqlite3.IntegrityError):
                c.execute("UPDATE jobs SET state='running',lease_owner='old-worker',authorization_json='{}' WHERE id='guard'")
            c.execute("UPDATE jobs SET state='running',lease_owner=? WHERE id='guard'", (protocol + ":valid",))


def test_codex_state_formula_cache_and_research_snapshot_are_private(users, monkeypatch):
    import sqlite3
    from apps.api.app import conversation_store, generated_program, research_workspace
    from apps.api.app.storage import application_paths
    _, a, b = users
    from apps.api.app import settings
    monkeypatch.setattr(settings, "llm_settings", lambda: {"configured": False, "model": "gpt-6-luna", "reasoning_effort": "high"})
    monkeypatch.setenv("LLMR_CODEX_HOME", str(identity.identity_path().parent / "explicit-codex-state"))
    source = "def calculate(bars, params):\n    return {'result': bars['close'] > 0, 'metrics': {}}"
    caches, homes = [], []
    for actor, text in ((a, "Alice private report"), (b, "Bob private report")):
        with actor_scope(actor):
            db.init_db()
            caches.append(generated_program._load_module(source))
            homes.append(application_paths().codex_home)
            with db.connect() as c:
                c.execute("INSERT INTO documents(id,sha256,filename,title,pages,extracted_chars,parse_status,source_path,imported_at) VALUES('private','hash','private.pdf',?,1,20,'indexed','missing',?)", (text, identity.now()))
                c.execute("INSERT INTO document_pages VALUES('private',1,?)", (text,))
    assert caches[0][1] != caches[1][1] and caches[0][2] is not caches[1][2]
    assert homes[0] != homes[1]
    with actor_scope(a):
        cid = conversation_store.create_conversation("report")["id"]
        turn = conversation_store.add_user_message(cid, "snapshot", 0, "Research my reports")
        research_workspace.prepare(cid, turn["turn_id"])
        candidates = list((research_workspace.directory(cid).parent / "inputs").glob("*.sqlite*"))
        assert len(candidates) == 1
        with sqlite3.connect(candidates[0]) as c:
            assert c.execute("SELECT text FROM report_pages").fetchone()[0] == "Alice private report"
