import json

import pytest

from apps.api.app import index_market


def row(day, close=11):
    return {"ts_code": "000001.SH", "trade_date": day, "open": 10, "high": 12, "low": 9, "close": close, "vol": 100, "amount": None}


@pytest.fixture
def cache(tmp_path, monkeypatch):
    monkeypatch.setattr(index_market, "INDEX_FILE", tmp_path / "index.json")
    clock = [1000.0]
    monkeypatch.setattr(index_market.time, "time", lambda: clock[0])
    return clock


def test_incomplete_response_refreshed_after_ttl(cache, monkeypatch):
    calls = []
    def fetch(*args):
        calls.append(args)
        return ([row("2026-09-15")] if len(calls) == 1 else [row("2026-09-15"), row("2026-09-16")]), "fixture"
    monkeypatch.setattr(index_market, "_fetch", fetch)
    assert len(index_market.get_bars("2026-09-16")) == 1
    assert len(index_market.get_bars("2026-09-16")) == 1
    assert len(calls) == 1
    cache[0] += index_market.CACHE_TTL_SECONDS
    assert len(index_market.get_bars("2026-09-16")) == 2
    assert len(calls) == 2


def test_same_day_bar_can_be_corrected_after_ttl(cache, monkeypatch):
    monkeypatch.setattr(index_market, "_fetch", lambda *a: ([row("2026-09-16", 10)], "fixture"))
    assert index_market.get_bars("2026-09-16")[-1]["close"] == 10
    cache[0] += index_market.CACHE_TTL_SECONDS
    monkeypatch.setattr(index_market, "_fetch", lambda *a: ([row("2026-09-16", 11)], "fixture"))
    assert index_market.get_bars("2026-09-16")[-1]["close"] == 11


def test_weekend_response_is_throttled_but_not_permanent(cache, monkeypatch):
    calls = []
    def fetch(*args):
        calls.append(args)
        return [row("2026-09-18")], "fixture"
    monkeypatch.setattr(index_market, "_fetch", fetch)
    index_market.get_bars("2026-09-20")
    index_market.get_bars("2026-09-20")
    assert len(calls) == 1
    cache[0] += index_market.CACHE_TTL_SECONDS
    index_market.get_bars("2026-09-20")
    assert len(calls) == 2


def test_old_cache_bounds_do_not_prove_freshness(cache, monkeypatch):
    index_market.INDEX_FILE.write_text(json.dumps({"requested_start": "2020-01-01", "requested_end": "2030-01-01", "bars": []}))
    monkeypatch.setattr(index_market, "_fetch", lambda *a: ([row("2026-09-16")], "fixture"))
    assert index_market.get_bars("2026-09-16")[-1]["trade_date"] == "2026-09-16"


def test_refresh_failure_preserves_cache_but_does_not_extend_ttl(cache, monkeypatch):
    monkeypatch.setattr(index_market, "_fetch", lambda *a: ([row("2026-09-16")], "fixture"))
    expected = index_market.get_bars("2026-09-16")
    original = index_market.INDEX_FILE.read_text()
    cache[0] += index_market.CACHE_TTL_SECONDS
    def fail(*args):
        raise RuntimeError("offline")
    monkeypatch.setattr(index_market, "_fetch", fail)
    assert index_market.get_bars("2026-09-16") == expected
    assert index_market.INDEX_FILE.read_text() == original
    monkeypatch.setattr(index_market, "_fetch", lambda *a: ([row("2026-09-16", 10)], "fixture"))
    assert index_market.get_bars("2026-09-16")[-1]["close"] == 10
