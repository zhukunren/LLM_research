import asyncio
import json
import sqlite3
import threading

import pytest
from starlette.requests import Request
from starlette.responses import JSONResponse

from apps.api.app import authorization, db, identity, jobs, maintenance_service, security_catalog, worker
from apps.api.app.security_context import actor_scope


@pytest.fixture
def workspaces(tmp_path, monkeypatch):
    for name in ("STATE", "UPLOAD", "ARTIFACT", "SANDBOX_STATE"):
        monkeypatch.setenv(f"LLMR_{name}_ROOT", str(tmp_path / name.lower()))
    monkeypatch.setenv("LLMR_AUTH_MODE", "oidc")
    monkeypatch.setenv("LLMR_IDENTITY_DB_PATH", str(tmp_path / "identity.db"))
    monkeypatch.setenv("LLMR_CONFIG_FILE", str(tmp_path / "absent.ini"))
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "legacy.db")
    identity.initialize()
    admin = identity.actor_for_user("local-admin", "local")
    with actor_scope(admin):
        db.init_db()
        with db.connect() as connection:
            connection.execute("INSERT INTO security_catalog VALUES('000001.SZ','旧名称','old','old','SZ',?)", (db.utc_now(),))
    users = [identity.user_from_oidc("https://fixture.invalid", name, name) for name in ("Alice", "Bob")]
    for actor in users:
        with actor_scope(actor):
            db.init_db()
    return admin, users


@pytest.mark.parametrize("kind", ["screening", "report_evaluation"])
@pytest.mark.parametrize("claimed", [False, True])
def test_revocation_terminates_runs_and_allows_retry_after_permissions_return(workspaces, kind, claimed):
    _, (actor, _) = workspaces
    table = "screening_runs" if kind == "screening" else "report_evaluation_runs"
    key = "run_id" if kind == "screening" else "evaluation_run_id"
    payload = {key: "run"}
    with actor_scope(actor):
        with db.connect() as connection:
            if kind == "screening":
                connection.execute("INSERT INTO screening_runs(id,strategy_id,strategy_version,as_of,mode,status,result_json,created_at) VALUES('run','strategy',1,'2026-10-15','exploratory','queued','{}',?)", (db.utc_now(),))
            else:
                connection.execute("INSERT INTO report_evaluation_runs(id,filter_id,filter_version,as_of,lookback_start,model,prompt_version,status,coverage_json,result_json,job_id,created_at) VALUES('run','filter',1,'2026-10-15','2026-10-01','fixture','fixture','queued','{}','{}','job',?)", (db.utc_now(),))
            connection.execute("INSERT INTO jobs(id,kind,payload_json,state,created_at,updated_at,required_protocol) VALUES('job',?,?,'queued',?,?,?)",
                               (kind, json.dumps(payload), db.utc_now(), db.utc_now(), "condition-decisions-v1" if kind == "screening" else "legacy"))
        lease = jobs.claim("job") if claimed else None
    identity.set_permissions(actor.user_id, role="viewer")
    viewer = identity.actor_for_user(actor.user_id, actor.tenant_id)
    with actor_scope(viewer), db.connect() as connection:
        run = connection.execute(f"SELECT status,finished_at FROM {table} WHERE id='run'").fetchone()
        assert run["status"] == "cancelled" and run["finished_at"]
        assert connection.execute("SELECT state,lease_owner FROM jobs WHERE id='job'").fetchone()[:] == ("cancelled", None)
    identity.set_permissions(actor.user_id, role="editor")
    editor = identity.actor_for_user(actor.user_id, actor.tenant_id)
    with actor_scope(editor):
        if lease:
            assert not lease.finish("succeeded", "late result")
        retried = jobs.retry("job")
        assert retried["status"] == "queued"
        with db.connect() as connection:
            assert connection.execute(f"SELECT status FROM {table} WHERE id=?", (retried[key],)).fetchone()[0] == "queued"


def test_worker_rotates_between_users_even_when_first_user_has_more_work(workspaces, monkeypatch):
    _, users = workspaces
    first, second = sorted(users, key=lambda actor: (actor.tenant_id, actor.user_id))
    for index, actor in enumerate((first, second)):
        with actor_scope(actor), db.connect() as connection:
            for number in range(3 if index == 0 else 1):
                connection.execute("INSERT INTO jobs(id,kind,payload_json,state,created_at,updated_at) VALUES(?,'data_sync','{}','queued',?,?)",
                                   (f"{index}-{number}", "2026-01-02" if index == 0 else "2026-01-01", db.utc_now()))
    order = []
    def complete(lease):
        order.append(lease.id)
        lease.finish("succeeded", "fixture")
    monkeypatch.setattr(maintenance_service, "refresh_data", complete)
    for _ in range(4):
        assert worker.execute_job(kinds=("data_sync",))
    assert order == ["0-0", "1-0", "0-1", "0-2"]


def test_existing_workspace_requests_do_not_take_a_write_lock_or_block_the_event_loop(workspaces, monkeypatch):
    _, (actor, _) = workspaces
    token, _ = identity.create_session(actor)
    with actor_scope(actor):
        path = db.database_path()
    held = sqlite3.connect(path, check_same_thread=False)
    held.execute("BEGIN IMMEDIATE")
    release, released = threading.Event(), threading.Event()
    def unlock():
        release.wait(2)
        held.rollback()
        held.close()
        released.set()
    thread = threading.Thread(target=unlock)
    thread.start()
    monkeypatch.setattr(db, "init_db", lambda: pytest.fail("Existing workspace must not run migrations"))
    async def exercise():
        request = Request({"type": "http", "method": "GET", "path": "/api/v1/me",
                           "headers": [(b"cookie", f"llmr_session={token}".encode())]})
        async def next_request(_request):
            return JSONResponse({"ok": True})
        response = await authorization.authenticate_request(request, next_request)
        assert response.status_code == 200
        assert not released.is_set(), "A read waited for the unrelated write transaction"
    try:
        asyncio.run(exercise())
    finally:
        release.set()
        thread.join()


def test_first_workspace_initialization_runs_off_the_event_loop(workspaces, monkeypatch):
    _, (actor, _) = workspaces
    token, _ = identity.create_session(actor)
    entered, release = threading.Event(), threading.Event()
    thread_ids = []
    def slow_initialize():
        thread_ids.append(threading.get_ident())
        entered.set()
        assert release.wait(2)
        # The actor context is preserved in the initialization worker thread.
        assert actor.user_id in str(db.database_path())
    monkeypatch.setattr(db, "ensure_initialized", slow_initialize)
    async def exercise():
        request = Request({"type": "http", "method": "GET", "path": "/api/v1/me",
                           "headers": [(b"cookie", f"llmr_session={token}".encode())]})
        async def next_request(_request):
            return JSONResponse({"ok": True})
        pending = asyncio.create_task(authorization.authenticate_request(request, next_request))
        try:
            while not entered.is_set():
                await asyncio.sleep(0.01)
            assert thread_ids != [threading.get_ident()]
        finally:
            release.set()
        assert (await pending).status_code == 200
    asyncio.run(exercise())


@pytest.mark.parametrize("personal_admin", [False, True])
def test_public_names_update_existing_users_and_sql_joins_without_private_writes(workspaces, personal_admin):
    admin, users = workspaces
    if personal_admin:
        with identity.connect() as connection:
            connection.execute("UPDATE users SET platform_admin=1 WHERE id=?", (users[0].user_id,))
        users[0] = identity.actor_for_user(users[0].user_id, users[0].tenant_id)
        admin = users[0]
    class Client:
        def raw_query(self, *_args, **_kwargs):
            return {"code": 0, "data": {"fields": ["ts_code", "name"], "items": [["000001.SZ", "新名称"], ["000002.SZ", "新证券"]]}}
    with actor_scope(admin):
        assert security_catalog.refresh(Client()) == 2
    for actor in users:
        with actor_scope(actor):
            assert security_catalog.names() == {"000001.SZ": "新名称", "000002.SZ": "新证券"}
            with db.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                assert connection.execute("SELECT name FROM main.security_catalog WHERE stock_code='000001.SZ'").fetchone()[0] == "旧名称"
                assert connection.execute("SELECT name FROM security_catalog WHERE " + security_catalog.query_clause(), security_catalog.query_params("新证券")).fetchone()[0] == "新证券"
                connection.execute("INSERT INTO watchlists(id,name,created_at) VALUES('list','fixture',?)", (db.utc_now(),))
                with pytest.raises(sqlite3.OperationalError):
                    connection.execute("UPDATE security_catalog SET name='not allowed'")
    with sqlite3.connect(security_catalog.public_catalog_path()) as connection:
        assert connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [("security_catalog",)]
