from apps.api.app.market import STOCK_FILE, iter_recent_bars


def test_replacing_sample_parquet_refreshes_profile_without_restart(tmp_path, monkeypatch):
    from datetime import datetime
    import pyarrow as pa
    import pyarrow.parquet as pq
    from apps.api.app import market

    source = tmp_path / "daily.parquet"
    monkeypatch.setattr(market, "STOCK_FILE", source)
    assert market.cached_profile()["available"] is False
    row = {"stock_code": "600000.SH", "trade_date": datetime(2026, 9, 14), "open": 10., "high": 12., "low": 9., "close": 11., "volume": 100., "amount": 1100.}
    pq.write_table(pa.Table.from_pylist([row]), source)
    assert market.cached_profile()["rows"] == 1
    pq.write_table(pa.Table.from_pylist([row, {**row, "trade_date": datetime(2026, 9, 15)}]), source)
    updated = market.cached_profile()
    assert updated["rows"] == 2
    assert updated["last_date"] == "2026-09-15"


def test_real_dataset_scanner_yields_typed_as_of_bars() -> None:
    if not STOCK_FILE.is_file():
        return
    stock_code, bars = next(iter_recent_bars("2026-09-14", per_stock=30))
    assert stock_code.endswith((".SH", ".SZ", ".BJ"))
    assert 10 <= len(bars) <= 30
    assert bars[-1]["trade_date"] <= "2026-09-14"
    assert isinstance(bars[-1]["close"], float)


def test_selected_pool_scan_filters_codes_and_cutoff_in_query(tmp_path, monkeypatch):
    from datetime import datetime
    import pyarrow as pa
    import pyarrow.parquet as pq
    from apps.api.app import market

    source = tmp_path / "pool.parquet"
    monkeypatch.setattr(market, "STOCK_FILE", source)
    row = {"stock_code": "600000.SH", "trade_date": datetime(2026, 9, 14), "open": 10., "high": 12., "low": 9., "close": 11., "volume": 100., "amount": 1100.}
    pq.write_table(pa.Table.from_pylist([row, {**row, "stock_code": "600001.SH"}, {**row, "trade_date": datetime(2026, 9, 15)}]), source)
    scanned = list(market.iter_recent_bars("2026-09-14", 30, ["600000.SH"]))
    assert len(scanned) == 1
    assert scanned[0][0] == "600000.SH"
    assert len(scanned[0][1]) == 1
    assert list(market.iter_recent_bars("2026-09-14", 30, [])) == []
    assert list(market.iter_recent_bars("2026-09-14", 30, ["600000.SH' OR 1=1 --"])) == []
