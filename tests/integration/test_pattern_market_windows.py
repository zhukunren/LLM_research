from datetime import date, datetime, timedelta

from fastapi.testclient import TestClient
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from apps.api.app import db, main, market
from apps.api.app.pattern_examples import best_window
from apps.api.app.patterns import score_window


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "patterns.db")
    with TestClient(main.app) as session:
        yield session


def bars(count=10):
    return [{"trade_date": (date(2026, 1, 2) + timedelta(days=i * 2)).isoformat(),
             "open": 10. + i, "high": 12. + i, "low": 9. + i, "close": 11. + i,
             "volume": 100., "amount": 1000., "quality_valid": True} for i in range(count)]


def fetch_window(client, monkeypatch, rows=None):
    monkeypatch.setattr(market, "get_bar_window", lambda *args: rows if rows is not None else bars())
    return client.post("/api/v1/patterns/market-window", json={
        "stock_code": " 600000.sh ", "start_date": "2026-01-01", "end_date": "2026-01-31"})


def payload(source, **changes):
    return {"name": "行情模板", "input_type": "market_window", "source_window_id": source["snapshot_id"],
            "representation": "ohlc_sequence", "points": source["points"], "target_bars": source["target_bars"],
            "candlesticks": source["candlesticks"], **changes}


def test_freezes_real_dates_and_prices_across_market_updates(client, monkeypatch):
    response = fetch_window(client, monkeypatch)
    assert response.status_code == 200, response.text
    source = response.json()
    assert source["stock_code"] == "600000.SH"
    assert source["target_bars"] == 10
    assert source["start_date"] == "2026-01-02"
    assert source["end_date"] == "2026-01-20"
    assert source["price_basis"] == "unadjusted"
    monkeypatch.setattr(market, "get_bar_window", lambda *a: pytest.fail("Saving must use the frozen snapshot"))
    saved = client.post("/api/v1/patterns", json=payload(source))
    assert saved.status_code == 200, saved.text
    assert saved.json()["market_source"]["bars"] == bars()
    again = client.post("/api/v1/patterns", json=payload(source, id=saved.json()["id"], representation="price_path", candlesticks=[]))
    assert again.status_code == 200, again.text
    assert again.json()["version"] == 2
    assert client.get("/api/v1/patterns").json()["items"][0]["market_source"]["snapshot_id"] == source["snapshot_id"]


@pytest.mark.parametrize("rows,reason", [(bars(0), "只有 0 根"), (bars(9), "只有 9 根"),
    (bars(251), "超过 250"), ([{**row, "quality_valid": False} for row in bars()], "无效行情"),
    ([bars()[0]] * 10, "重复交易日"), ([{**row, "high": 1} for row in bars()], "OHLC 高低关系")])
def test_rejects_short_long_invalid_or_duplicate_intervals(client, monkeypatch, rows, reason):
    result = fetch_window(client, monkeypatch, rows)
    assert result.status_code == 422, result.text
    assert reason in result.text


def test_validates_dates_codes_and_snapshot_consistency(client, monkeypatch):
    source = fetch_window(client, monkeypatch).json()
    for changes in ({"start_date": "2026-02-01"}, {"end_date": "2999-01-01"},
                    {"stock_code": "600000.SH' OR 1=1"}, {"start_date": "2026-02-30"}):
        request = {"stock_code": "600000.SH", "start_date": "2026-01-01", "end_date": "2026-01-31", **changes}
        assert client.post("/api/v1/patterns/market-window", json=request).status_code == 422
    for changes in ({"source_window_id": "missing"}, {"points": [99.] * 10},
                    {"candlesticks": [{"open": 1., "high": 2., "low": .5, "close": 1.5}] * 10}):
        assert client.post("/api/v1/patterns", json=payload(source, **changes)).status_code == 422
        assert client.post("/api/v1/patterns/match", json=payload(source, **changes)).status_code == 422


def test_matching_excludes_source_and_returns_ranked_multiple_securities(client, monkeypatch):
    source = fetch_window(client, monkeypatch).json()
    monkeypatch.setattr(market, "source_fingerprint", lambda: ("market-window-fixture", 1, 1))
    monkeypatch.setattr(market, "latest_market_date", lambda *a: "2026-01-20")
    monkeypatch.setattr(market, "iter_recent_bars", lambda *a: iter([
        ("600000.SH", bars()), ("600001.SH", bars()), ("000002.SZ", bars())]))
    result = client.post("/api/v1/patterns/match?limit=12", json=payload(source))
    assert result.status_code == 200, result.text
    assert {item["stock_code"] for item in result.json()["items"]} == {"600001.SH", "000002.SZ"}
    assert "排除来源股票" in result.json()["scope"]
    saved = client.post("/api/v1/patterns", json=payload(source)).json()
    result = client.get(f"/api/v1/patterns/{saved['id']}/best-match?version=1&limit=12")
    assert {item["stock_code"] for item in result.json()["items"]} == {"600001.SH", "000002.SZ"}


def test_market_update_during_fetch_does_not_freeze_mixed_source(client, monkeypatch):
    fingerprints = iter([("old", 1), ("new", 2)])
    monkeypatch.setattr(market, "source_fingerprint", lambda: next(fingerprints))
    assert fetch_window(client, monkeypatch).status_code == 409
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM pattern_market_windows").fetchone()[0] == 0


def test_market_range_query_has_inclusive_bounds_and_never_silently_truncates(tmp_path, monkeypatch):
    source = tmp_path / "window.parquet"
    monkeypatch.setattr(market, "STOCK_FILE", source)
    rows = [{**bar, "stock_code": "600000.SH", "trade_date": datetime.fromisoformat(bar["trade_date"])} for bar in bars(260)]
    pq.write_table(pa.Table.from_pylist(rows + [{**rows[1], "stock_code": "000002.SZ"}]), source)
    result = market.get_bar_window("600000.SH", "2026-01-04", "2026-01-08")
    assert [row["trade_date"] for row in result] == ["2026-01-04", "2026-01-06", "2026-01-08"]
    assert all(row["quality_valid"] for row in result)
    assert len(market.get_bar_window("600000.SH", "2026-01-01", "2028-01-01")) == 251


@pytest.mark.parametrize("count", [10, 40, 250])
def test_batch_candle_scan_matches_original_scores_and_window_selection(count):
    import numpy as np
    rng = np.random.default_rng(321)
    closes = 20 + np.cumsum(rng.normal(0, .3, count + 119))
    rows = [{"trade_date": (date(2025, 1, 1) + timedelta(days=i)).isoformat(), "open": float(close + .2),
             "high": float(close + 1.), "low": float(close - .7), "close": float(close), "quality_valid": True}
            for i, close in enumerate(closes)]
    candles = [{key: row[key] for key in ("open", "high", "low", "close")} for row in rows[30:30 + count]]
    template = {"target_bars": count, "points": [candle["close"] for candle in candles], "candlesticks": candles,
                "representation": "ohlc_sequence", "algorithm_version": "candle-window-v2"}
    rows[2]["high"] = 0
    rows[-4]["quality_valid"] = False
    expected = None
    for start in range(len(rows) - count, -1, -1):
        result = score_window(template, rows[start:start + count], match_mode="current")
        if result.get("similarity") is not None and (expected is None or result["similarity"] > expected["similarity"]):
            expected = result
    actual = best_window(template, rows)
    assert actual["start_date"] == expected["start_date"]
    assert actual["similarity"] == expected["similarity"]
    assert actual["distance_components"] == expected["distance_components"]
    flat = [{**row, "open": 10., "high": 10., "low": 10., "close": 10., "quality_valid": True} for row in rows]
    flat_template = {**template, "points": [10.] * count, "candlesticks": flat[:count]}
    assert best_window(flat_template, flat)["end_date"] == flat[-1]["trade_date"]
