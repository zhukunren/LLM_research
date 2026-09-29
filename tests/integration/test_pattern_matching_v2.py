from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from apps.api.app import db, main, market, pattern_adapter, worker
from apps.api.app.rules import validate_tree


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "pattern-v2.db")
    with TestClient(main.app) as session:
        yield session


def pattern_payload(**changes):
    payload = {
        "name": "近期上升", "input_type": "drawing", "representation": "price_path", "target_bars": 10,
        "points": [float(index) for index in range(10)], "candlesticks": [],
        "params": {"min_similarity": 88, "match_mode": "recent", "recent_bars": 20},
    }
    payload.update(changes)
    return payload


def test_saved_pattern_persists_similarity_threshold_and_window_settings(client):
    saved = client.post("/api/v1/patterns", json=pattern_payload())
    assert saved.status_code == 200, saved.text
    result = saved.json()
    assert result["algorithm_version"] == "path-window-v2"
    assert result["params"]["min_similarity"] == 88
    assert result["params"]["match_mode"] == "recent"
    assert result["params"]["recent_bars"] == 20
    assert client.post("/api/v1/patterns", json=pattern_payload(params={"min_similarity": 101, "match_mode": "current", "recent_bars": 20})).status_code == 422
    assert client.post("/api/v1/patterns", json=pattern_payload(params={"min_similarity": 88, "match_mode": "history", "recent_bars": 20})).status_code == 422


def test_preview_reads_full_recent_range_and_adapter_threshold_controls_screening(client, monkeypatch):
    saved = client.post("/api/v1/patterns", json=pattern_payload(
        target_bars=10, points=[0, 1, 2, 3, 4, 5, 6, 7, 8, 8],
        params={"min_similarity": 90, "match_mode": "recent", "recent_bars": 5},
    )).json()
    bars = [{"trade_date": f"2026-01-{index + 1:02d}", "open": float(value), "high": float(value) + 1, "low": float(value) - 1,
             "close": float(value), "volume": 1, "amount": 1, "quality_valid": True}
            for index, value in enumerate([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 9, 8, 7, 6])]
    observed = []
    monkeypatch.setattr(market, "get_bars", lambda code, as_of, limit: observed.append(limit) or bars[-limit:])
    preview = client.post("/api/v1/patterns/preview", json={"stock_code": "600000.SH", "pattern_id": saved["id"],
        "pattern_version": 1, "match_mode": "recent", "recent_bars": 5})
    assert preview.status_code == 200, preview.text
    assert observed == [14]
    assert preview.json()["match_mode"] == "recent"
    assert 0 < preview.json()["match_age_bars"] <= 5

    condition = {"condition_id": "pattern", "expression": {"pattern_id": saved["id"], "pattern_version": 1,
                 "minimum_similarity": 90, "match_mode": "recent", "recent_bars": 5}, "implementation_id": "saved-pattern"}
    asset = {"id": saved["id"], "version": 1, "name": saved["name"], "template": saved}
    reference = {"reference_id": "p", "_pattern_template": asset, "_bars": bars, "_effective_market_date": "2026-01-15"}
    assert pattern_adapter.required_history_bars(condition, reference, asset) == 14
    low = pattern_adapter.evaluate(condition, reference | {"parameter_overrides": {"minimum_similarity": 0}}, "600000.SH", "2026-01-15")
    high = pattern_adapter.evaluate(condition, reference | {"parameter_overrides": {"minimum_similarity": 99}}, "600000.SH", "2026-01-15")
    assert low.state == "true"
    assert high.state == "unknown" or high.state == "false"


def test_legacy_strategy_reference_preserves_similarity_limit_and_recent_window():
    template = {"id": "shape", "name": "近期模板", "version": 1, "target_bars": 4,
                "points": [10, 11, 12, 13], "algorithm_version": "path-window-v2",
                "params": {"min_similarity": 80, "match_mode": "recent", "recent_bars": 5}}
    bars = [{"trade_date": f"2026-01-{index + 1:02d}", "close": float(value), "quality_valid": True}
            for index, value in enumerate([10, 11, 12, 13, 10, 9, 8, 7])]
    node = {"op": "pattern_ref", "pattern_id": "shape", "version": 1, "min_similarity": 95,
            "match_mode": "recent", "recent_bars": 5, "score_weight": 1}
    assert validate_tree(node, {}, {("shape", 1)}) == []
    state, details, _score = worker._eval_tree(node, "600000.SH", bars, {}, {("shape", 1): template}, {})
    assert state == "true"
    assert details[0]["match_mode"] == "recent"
    assert details[0]["threshold"] == 95
    too_high = {**node, "min_similarity": 100.1}
    assert "相似度阈值" in "；".join(validate_tree(too_high, {}, {("shape", 1)}))
