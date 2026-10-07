import pytest
from fastapi.testclient import TestClient

from apps.api.app import db, main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "security.db")
    monkeypatch.setenv("LLMR_WEB_PORT", "5173")
    with TestClient(main.app, base_url="http://127.0.0.1:8067") as session:
        yield session


@pytest.mark.parametrize("headers", [
    {"Origin": "http://untrusted.example", "Content-Type": "application/x-www-form-urlencoded"},
    {"Origin": "null"},
    {"Origin": "http://localhost.untrusted.example:5173"},
    {"Origin": "http://127.0.0.1:9999"},
    {"Origin": "http://localhost:5173@untrusted.example"},
    {"Origin": "http://localhost:5173/forged"},
    {"Origin": "http://localhost:invalid"},
    {"Origin": "http://localhost:5173?forged"},
    {"Referer": "https://untrusted.example/form"},
    {"Sec-Fetch-Site": "cross-site"},
])
def test_untrusted_browser_cannot_enqueue_maintenance(client, headers):
    response = client.post("/api/v1/maintenance/refresh", headers=headers)
    assert response.status_code == 403
    assert response.json()["code"] == "untrusted_origin"
    assert response.headers["X-Request-ID"] == response.json()["request_id"]
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


@pytest.mark.parametrize("method,path,payload", [
    ("POST", "/api/v1/watchlists", {"name": "blocked"}),
    ("PATCH", "/api/v1/research-projects/missing", {"base_revision": 1, "name": "blocked"}),
    ("DELETE", "/api/v1/watchlists/missing/items/600000.SH", None),
])
def test_write_origin_check_precedes_validation_and_route_handlers(client, method, path, payload):
    response = client.request(method, path, json=payload, headers={"Origin": "https://untrusted.example"})
    assert response.status_code == 403
    assert response.json()["code"] == "untrusted_origin"
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM watchlists").fetchone()[0] == 0


@pytest.mark.parametrize("headers", [
    {"Origin": "http://127.0.0.1:8067", "Sec-Fetch-Site": "same-origin"},
    {"Origin": "http://localhost:8067"},
    {"Origin": "http://127.0.0.1:5173", "Sec-Fetch-Site": "same-site"},
    {"Origin": "http://localhost:5173"},
    {"Referer": "http://127.0.0.1:8067/#/home"},
    {},
])
def test_user_mode_dev_mode_and_local_clients_can_write(client, headers):
    response = client.post("/api/v1/watchlists", json={"name": "allowed"}, headers=headers)
    assert response.status_code == 200
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM watchlists").fetchone()[0] == 1


def test_cross_site_read_and_preflight_are_not_write_operations(client):
    assert client.get("/api/v1/health", headers={"Origin": "https://untrusted.example"}).status_code == 200
    response = client.options("/api/v1/watchlists", headers={
        "Origin": "http://127.0.0.1:5173", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
    })
    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "http://127.0.0.1:5173"


def test_host_header_cannot_expand_same_origin_allowlist(client):
    response = client.post("/api/v1/maintenance/refresh", headers={
        "Host": "untrusted.example", "Origin": "http://untrusted.example",
    })
    assert response.status_code == 403
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
