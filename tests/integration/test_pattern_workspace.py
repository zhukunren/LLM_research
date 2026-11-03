"""Unified-workspace lineage through real HTTP routes and isolated storage only."""
import base64
from datetime import date, timedelta
import io

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from apps.api.app import auth, db, identity, main, market, pattern_language, patterns
from apps.api.app.security_context import actor_scope


@pytest.fixture
def storage(tmp_path, monkeypatch):
    # Patch import-time paths as well as dynamic workspace paths before startup.
    for variable, child in {
        "LLMR_STATE_ROOT": "state", "LLMR_UPLOAD_ROOT": "uploads",
        "LLMR_ARTIFACT_ROOT": "artifacts", "LLMR_DATA_ROOT": "data",
        "LLMR_SANDBOX_STATE_ROOT": "sandbox", "LLMR_CONFIG_FILE": "missing.ini",
        "LLMR_IDENTITY_DB_PATH": "identity.db",
    }.items():
        monkeypatch.setenv(variable, str(tmp_path / child))
    monkeypatch.setenv("LLMR_AUTH_MODE", "local")
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "state" / "patterns.db")
    monkeypatch.setattr(main, "PATTERN_UPLOAD_DIR", tmp_path / "uploads" / "patterns")
    monkeypatch.setattr(patterns, "PATTERN_UPLOAD_DIR", tmp_path / "uploads" / "patterns")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "data" / "missing.parquet")
    monkeypatch.setattr(market, "source_fingerprint", lambda: ("workspace-fixture", 1))
    monkeypatch.setattr(market, "get_bar_window", lambda *args: rows())
    monkeypatch.setattr(market, "latest_market_date", lambda cutoff: min(cutoff, "2026-01-31"))
    monkeypatch.setattr(market, "iter_recent_bars", lambda *args: iter([
        ("600000.SH", rows(20)), ("600001.SH", rows(20))]))
    monkeypatch.setattr(pattern_language, "llm_settings", lambda: {"configured": False})
    return tmp_path


@pytest.fixture
def client(storage):
    with TestClient(main.app) as session:
        yield session


def rows(count=10):
    return [{"trade_date": (date(2026, 1, 1) + timedelta(days=i)).isoformat(),
             "open": i + 10., "high": i + 12., "low": i + 9., "close": i + 11.,
             "quality_valid": True} for i in range(count)]


def payload(**changes):
    return {"name": "自定义副本", "input_type": "drawing", "representation": "price_path",
            "target_bars": 10, "points": list(range(10)), "params": {"min_similarity": 90}, **changes}


def post(client, path, body):
    response = client.post("/api/v1/patterns" + path, json=body)
    assert response.status_code == 200, response.text
    return response.json()


def window(client):
    return post(client, "/market-window", {
        "stock_code": "600000.SH", "start_date": "2026-01-01", "end_date": "2026-01-31"})


def image_payload():
    stream = io.BytesIO()
    Image.new("RGB", (120, 90), "white").save(stream, format="PNG")
    raw = stream.getvalue()
    return raw, {"source_image_base64": base64.b64encode(raw).decode(),
                 "source_image_mime": "image/png", "source_image_filename": "original.png"}


def source_ref(pattern, origin_type):
    return {"origin_type": origin_type, "source_pattern_id": pattern["id"],
            "source_pattern_version": pattern["version"]}


def test_market_copy_keeps_original_immutable_and_never_claims_real_prices(client):
    snapshot = window(client)
    original_input = payload(input_type="market_window", source_window_id=snapshot["snapshot_id"],
                             points=snapshot["points"], candlesticks=snapshot["candlesticks"],
                             representation="ohlc_sequence")
    original = post(client, "", original_input)
    altered = {**original_input, "points": [42.] * 10}
    for path in ("", "/match"):
        assert client.post("/api/v1/patterns" + path, json=altered).status_code == 422
    derived = post(client, "", payload(derivation={"origin_type": "market_window", "source_window_id": snapshot["snapshot_id"]}))
    assert derived["id"] != original["id"]
    assert derived["input_type"] == "drawing" and derived["market_source"] is None
    assert derived["points"] != snapshot["points"]
    assert derived["derivation"]["market_source"]["bars"] == rows()
    assert derived["derivation"]["market_source"]["snapshot_id"] == snapshot["snapshot_id"]
    second = post(client, "", payload(id=derived["id"], points=[3.] * 10))
    assert second["version"] == 2 and second["derivation"] == derived["derivation"]
    copied = post(client, "", payload(derivation=source_ref(second, "market_window")))
    assert copied["derivation"]["market_source"] == original["market_source"]
    history = client.get("/api/v1/patterns?include_history=true").json()["items"]
    assert next(item for item in history if item["id"] == original["id"])["points"] == snapshot["points"]
    assert len([item for item in history if item["id"] == derived["id"]]) == 2


def test_derived_market_search_keeps_exclusion_cutoff_and_frozen_lineage(client):
    snapshot = window(client)
    draft = payload(points=list(reversed(range(10))), derivation={"origin_type": "market_window", "source_window_id": snapshot["snapshot_id"]})
    result = post(client, "/match?as_of=2026-01-09&limit=12", draft)
    assert result["template_timing"] == "post_hoc"
    assert result["items"] == []  # fewer than ten bars are known at this cutoff
    result = post(client, "/match?as_of=2026-01-15&limit=12", draft)
    assert {item["stock_code"] for item in result["items"]} == {"600001.SH"}
    assert all(bar["trade_date"] <= "2026-01-15" for item in result["items"] for bar in item["bars"])
    detail = client.get("/api/v1/patterns/search-runs/" + result["search_run_id"]).json()
    assert detail["template"]["market_source"] is None
    assert detail["template"]["derivation"]["market_source"]["snapshot_id"] == snapshot["snapshot_id"]
    # Origin controls only exclusion/timing. The opposite, edited path is scored.
    item = result["items"][0]
    assert item["similarity"] == patterns.score_window(detail["template"], item["bars"], match_mode="current")["similarity"]
    assert item["similarity"] < 90
    saved = post(client, "", draft)
    retained = post(client, "/match?as_of=2026-01-15", payload(id=saved["id"]))
    assert {item["stock_code"] for item in retained["items"]} == {"600001.SH"}
    saved_result = post(client, f"/{saved['id']}/search?version=1&as_of=2026-01-15", {})
    assert {item["stock_code"] for item in saved_result["items"]} == {"600001.SH"}
    assert client.post("/api/v1/patterns/match?as_of=2999-01-01", json=draft).status_code == 422


def test_screenshot_copy_and_versions_retain_exact_original_bytes(client, storage):
    raw, image = image_payload()
    original = post(client, "", payload(input_type="screenshot", **image))
    edited = post(client, "", payload(points=[2.] * 10, derivation=source_ref(original, "screenshot")))
    assert edited["source_image"] == original["source_image"] == edited["derivation"]["source_image"]
    assert edited["market_source"] is None
    assert client.get(f"/api/v1/patterns/{edited['id']}/source-image?version=1").content == raw
    revised = post(client, "", payload(id=edited["id"], points=[4.] * 10))
    assert revised["version"] == 2 and revised["source_image"] == original["source_image"]
    copied = post(client, "", payload(derivation=source_ref(revised, "screenshot")))
    assert client.get(f"/api/v1/patterns/{copied['id']}/source-image?version=1").content == raw
    assert len(list((storage / "uploads" / "patterns").iterdir())) == 1


def test_unsaved_screenshot_edits_can_match_and_save_same_original(client, storage):
    raw, image = image_payload()
    draft = payload(derivation={"origin_type": "screenshot"}, **image)
    result = post(client, "/match?as_of=2026-01-15", draft)
    record = client.get("/api/v1/patterns/search-runs/" + result["search_run_id"]).json()
    assert record["template"]["source_image"]["filename"] == "original.png"
    assert "source_image_base64" not in record["template"]
    saved = post(client, "", draft)
    assert record["template"]["source_image"] == saved["source_image"]
    assert client.get(f"/api/v1/patterns/{saved['id']}/source-image?version=1").content == raw
    assert len(list((storage / "uploads" / "patterns").iterdir())) == 1


def test_text_copy_keeps_original_prompt_and_generated_points(client):
    draft = post(client, "/draft", {"prompt": "近10个交易日的双底形态"})
    edited_input = payload(derivation={"origin_type": "natural_language", "source_draft_id": draft["id"]})
    edited = post(client, "", edited_input)
    assert edited["provenance"]["original_points"] == draft["points"] != edited["points"]
    assert edited["provenance"]["original_prompt"] == draft["prompt"]
    copied = post(client, "", payload(derivation=source_ref(edited, "natural_language")))
    assert copied["provenance"] == edited["provenance"]
    result = post(client, "/match", edited_input)
    record = client.get("/api/v1/patterns/search-runs/" + result["search_run_id"]).json()
    assert record["template"]["provenance"]["draft_id"] == draft["id"]


@pytest.mark.parametrize("derived", [False, True])
def test_repeated_text_matches_reuse_cache_without_false_confirmation(client, monkeypatch, derived):
    draft = post(client, "/draft", {"prompt": "近10个交易日的双底形态"})
    body = payload(derivation={"origin_type": "natural_language", "source_draft_id": draft["id"]}) if derived else payload(
        input_type="natural_language", source_draft_id=draft["id"], points=draft["points"])
    scans = []

    def scan(*args):
        scans.append(args)
        return iter([("600001.SH", rows(20))])

    monkeypatch.setattr(market, "iter_recent_bars", scan)
    monkeypatch.setattr(main, "utc_now", lambda: "2026-01-31T10:00:00+00:00")
    first = post(client, "/match?as_of=2026-01-15", body)
    monkeypatch.setattr(main, "utc_now", lambda: "2026-01-31T10:00:01+00:00")
    second = post(client, "/match?as_of=2026-01-15", body)
    assert first["items"] == second["items"]
    assert len(scans) == 1
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM pattern_examples").fetchone()[0] == 1
    first_record = client.get("/api/v1/patterns/search-runs/" + first["search_run_id"]).json()
    second_record = client.get("/api/v1/patterns/search-runs/" + second["search_run_id"]).json()
    provenance = first_record["template"]["provenance"]
    assert provenance == second_record["template"]["provenance"]
    assert provenance["draft_created_at"] == draft["created_at"]
    assert "confirmed_at" not in provenance
    saved = post(client, "", body)
    assert saved["provenance"]["confirmed_at"] == "2026-01-31T10:00:01+00:00"
    assert saved["provenance"]["draft_created_at"] == draft["created_at"]


@pytest.mark.parametrize("derivation", [
    {"origin_type": "market_window", "source_window_id": "missing"},
    {"origin_type": "natural_language", "source_draft_id": "missing"},
    {"origin_type": "screenshot"},
    {"origin_type": "drawing"},
    {"origin_type": "drawing", "source_pattern_id": "missing", "source_pattern_version": 1},
    {"origin_type": "drawing", "source_pattern_id": "missing"},
    {"origin_type": "drawing", "source_pattern_version": 1},
    {"origin_type": "screenshot", "source_window_id": "missing"},
    {"origin_type": "market_window", "source_window_id": "missing", "source_draft_id": "other"},
    {"origin_type": "market_window", "market_source": {"snapshot_id": "forged"}},
    {"origin_type": "screenshot", "source_image": {"sha256": "forged"}},
])
def test_invalid_and_client_forged_origins_never_persist(client, derivation):
    for suffix in ("", "/match"):
        response = client.post("/api/v1/patterns" + suffix, json=payload(derivation=derivation))
        assert response.status_code in (404, 422), response.text
    assert client.get("/api/v1/patterns").json()["items"] == []
    assert client.get("/api/v1/patterns/search-runs").json()["items"] == []


def test_mismatched_origin_and_replacement_image_are_rejected(client):
    _, image = image_payload()
    screenshot = post(client, "", payload(input_type="screenshot", **image))
    for body in (
        payload(derivation=source_ref(screenshot, "market_window")),
        payload(derivation=source_ref(screenshot, "screenshot"), **image),
        payload(input_type="screenshot", derivation=source_ref(screenshot, "screenshot")),
        payload(source_draft_id="claimed", derivation=source_ref(screenshot, "screenshot")),
    ):
        for suffix in ("", "/match"):
            assert client.post("/api/v1/patterns" + suffix, json=body).status_code == 422
    incomplete = post(client, "/draft", {"prompt": "不能表达的描述"})
    assert client.post("/api/v1/patterns", json=payload(derivation={
        "origin_type": "natural_language", "source_draft_id": incomplete["id"]})).status_code == 422


def test_http_workspace_ownership_and_viewer_write_guards(storage, monkeypatch):
    monkeypatch.setenv("LLMR_AUTH_MODE", "oidc")
    monkeypatch.setenv("LLMR_AUTH_ISSUER", "https://issuer.example")
    monkeypatch.setenv("LLMR_AUTH_CLIENT_ID", "workspace-fixture")
    monkeypatch.setenv("LLMR_AUTH_PUBLIC_URL", "https://app.example")
    identity.initialize()
    owner = identity.user_from_oidc("https://issuer.example", "owner", "Owner")
    other = identity.user_from_oidc("https://issuer.example", "other", "Other")

    def login(session, actor):
        token, csrf = identity.create_session(actor)
        session.cookies.set(auth.COOKIE, token)
        session.headers.update({"X-CSRF-Token": csrf, "Origin": "https://app.example"})

    with TestClient(main.app, base_url="https://app.example") as session:
        login(session, owner)
        snapshot = window(session)
        saved = post(session, "", payload())
        login(session, other)
        for derivation in ({"origin_type": "market_window", "source_window_id": snapshot["snapshot_id"]}, source_ref(saved, "drawing")):
            response = session.post("/api/v1/patterns", json=payload(derivation=derivation))
            assert response.status_code == 404, response.text
        identity.set_permissions(owner.user_id, role="viewer")
        login(session, identity.actor_for_user(owner.user_id, owner.tenant_id))
        for suffix in ("", "/match"):
            assert session.post("/api/v1/patterns" + suffix, json=payload(derivation=source_ref(saved, "drawing"))).status_code == 403
        with actor_scope(other):
            with db.connect() as connection:
                assert connection.execute("SELECT COUNT(*) FROM patterns").fetchone()[0] == 0
                assert db.database_path().is_relative_to(storage)
