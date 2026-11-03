from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from apps.api.app import db, main, market
from apps.api.app.security_context import ActorContext, actor_scope
from apps.api.app import pattern_research


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "pattern-research.db")
    monkeypatch.setattr(market, "source_fingerprint", lambda: ("synthetic", 20, 1))
    monkeypatch.setattr(market, "latest_market_date", lambda day: day)
    rows = [{"trade_date": (date(2026, 1, 1) + timedelta(days=i)).isoformat(), "open": i + 1.,
             "high": i + 3., "low": i + .5, "close": i + 2., "quality_valid": True} for i in range(20)]
    monkeypatch.setattr(market, "iter_recent_bars", lambda *args: iter([("600000.SH", rows)]))
    with TestClient(main.app) as session:
        yield session


def payload(**changes):
    return {"name": "研究形态", "input_type": "drawing", "representation": "price_path",
            "target_bars": 10, "points": list(range(10)), "params": {"min_similarity": 95, "match_mode": "recent", "recent_bars": 20}, **changes}


def test_direct_match_cutoff_snapshot_annotations_and_no_future_bars(client):
    response = client.post("/api/v1/patterns/match?limit=12&as_of=2026-01-15", json=payload())
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["as_of"] == "2026-01-15"
    assert result["template_timing"] == "unknown"
    assert all(bar["trade_date"] <= result["as_of"] for item in result["items"] for bar in item["bars"])
    identifier = result["search_run_id"]
    detail = client.get(f"/api/v1/patterns/search-runs/{identifier}").json()
    assert detail["template"]["params"]["min_similarity"] == 95
    assert detail["result"] == result
    key = result["items"][0]["stock_code"] + "@" + result["items"][0]["start_date"]
    updated = client.patch(f"/api/v1/patterns/search-runs/{identifier}", json={"selected_key": key, "note": "对照记录"})
    assert updated.status_code == 200
    assert updated.json()["result"] == result
    assert client.patch(f"/api/v1/patterns/search-runs/{identifier}", json={"selected_key": "fake"}).status_code == 422
    assert client.patch(f"/api/v1/patterns/search-runs/{identifier}", json={"note": "x" * 4001}).status_code == 422
    assert client.get("/api/v1/patterns/search-runs").json()["items"][0]["note"] == "对照记录"


def test_saved_versions_copy_and_explicit_search_preserve_old_read_api(client):
    first = client.post("/api/v1/patterns", json=payload(note="初版")).json()
    second = client.post("/api/v1/patterns", json=payload(id=first["id"], note="第二版")).json()
    copy = client.post("/api/v1/patterns", json=payload(name="副本", note="独立副本")).json()
    assert second["version"] == 2 and copy["id"] != first["id"] and copy["version"] == 1
    assert len(client.get("/api/v1/patterns?include_history=true").json()["items"]) == 3
    path = f"/api/v1/patterns/{first['id']}"
    old = client.get(path + "/best-match?version=1")
    assert old.status_code == 200 and old.json()["items"]
    assert not client.get("/api/v1/patterns/search-runs").json()["items"]
    saved = client.post(path + "/search?version=1&as_of=2026-01-15&limit=12")
    assert saved.status_code == 200, saved.text
    detail = client.get("/api/v1/patterns/search-runs/" + saved.json()["search_run_id"]).json()
    assert detail["template"]["version"] == 1 and detail["template"]["note"] == "初版"
    assert client.post(path + "/search?version=999").status_code == 404
    assert client.post(path + "/search?version=1&as_of=2999-01-01").status_code == 422
    assert client.get(path + "/best-match?version=1&as_of=garbage").status_code == 422
    assert client.post("/api/v1/patterns/match?as_of=2999-01-01", json=payload()).status_code == 422
    assert client.post("/api/v1/patterns/match?limit=25", json=payload()).status_code == 422


def test_missing_market_still_persists_honest_result(client, monkeypatch):
    monkeypatch.setattr(market, "source_fingerprint", lambda: None)
    result = client.post("/api/v1/patterns/match", json=payload()).json()
    assert result["state"] == "unknown" and result["items"] == []
    assert result["scanned_securities"] == result["valid_securities"] == 0
    assert result["search_run_id"]


def test_record_owner_predicate_even_if_two_actors_share_same_schema(client):
    # legacy=True deliberately binds both actors to one temporary schema;
    # the normal runtime separately owns each workspace database as well.
    with db.connect() as connection:
        connection.execute("DROP TABLE workspace_owner")  # emulate a pre-owner shared schema in this temporary DB
    first = ActorContext("owner", "tenant", legacy=True)
    second = ActorContext("other", "tenant", legacy=True)
    with actor_scope(first):
        result = pattern_research.save_search(payload(), {"items": []}, {})
        identifier = result["search_run_id"]
    with actor_scope(second):
        assert pattern_research.list_search_runs()["items"] == []
        with pytest.raises(Exception) as error:
            pattern_research.get_search_run(identifier)
        assert error.value.status_code == 404
    with actor_scope(first):
        assert pattern_research.get_search_run(identifier)["id"] == identifier


def test_search_and_annotations_reject_untrusted_origin_before_write(client):
    pattern = client.post("/api/v1/patterns", json=payload()).json()
    response = client.post(f"/api/v1/patterns/{pattern['id']}/search?version=1", headers={"Origin": "https://untrusted.example"})
    assert response.status_code == 403
    assert not client.get("/api/v1/patterns/search-runs").json()["items"]


def test_annotations_update_only_submitted_fields_after_interleaved_read(client, monkeypatch):
    result = client.post("/api/v1/patterns/match?as_of=2026-01-15", json=payload()).json()
    identifier = result["search_run_id"]
    key = result["items"][0]["stock_code"] + "@" + result["items"][0]["start_date"]
    original_row = pattern_research._row
    interleaved = False

    def row_with_competing_note(record_id):
        nonlocal interleaved
        stale = original_row(record_id)
        if not interleaved:
            interleaved = True
            with db.connect() as connection:
                connection.execute("UPDATE pattern_search_runs SET note='另一标签刚保存的备注' WHERE id=?", (record_id,))
        return stale

    monkeypatch.setattr(pattern_research, "_row", row_with_competing_note)
    updated = client.patch(f"/api/v1/patterns/search-runs/{identifier}", json={"selected_key": key}).json()
    assert updated["note"] == "另一标签刚保存的备注"
    assert updated["selected_key"] == key


def test_oversized_snapshot_rejected_and_not_partially_persisted(client, monkeypatch):
    monkeypatch.setattr(pattern_research, "MAX_SNAPSHOT_BYTES", 100)
    result = client.post("/api/v1/patterns/match?as_of=2026-01-15", json=payload())
    assert result.status_code == 413
    assert client.get("/api/v1/patterns/search-runs").json()["items"] == []
