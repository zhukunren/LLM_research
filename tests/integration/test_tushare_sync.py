from __future__ import annotations

from datetime import datetime

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from apps.api.app import db, news_sources, tushare_sync


def payload(fields, items):
    return {"code": 0, "data": {"fields": fields, "items": items}}


class FakeRelay:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    def raw_query(self, api_name: str, **params):
        self.calls.append((api_name, params))
        if api_name == "trade_cal":
            return payload(
                ["exchange", "cal_date", "is_open", "pretrade_date"],
                [["SSE", "20260915", 1, "20260912"], ["SSE", "20260916", 1, "20260915"]],
            )
        if api_name == "daily":
            records = {
                "20260915": [
                    ["000001.SZ", "20260915", 10, 11, 9, 10.5, 10, 0.5, 5, 100, 1050, None, None],
                    ["600000.SH", "20260915", 20, 22, 19, 21, 20, 1, 5, 200, 4200, None, None],
                    ["000002.SZ", "20260915", 8, 9, 7, 8.5, 8, 0.5, 6, 300, 2550, None, None],
                ],
                "20260916": [["000001.SZ", "20260916", 10.5, 11.2, 10, 11, 10.5, 0.5, 5, 110, 1210, None, None]],
            }
            rows = records[params["trade_date"]]
            start = params.get("offset", 0)
            end = start + params.get("limit", len(rows))
            return payload(
                ["ts_code", "trade_date", "open", "high", "low", "close", "pre_close", "change", "pct_chg", "vol", "amount", "ah_vol", "ah_amount"],
                rows[start:end],
            )
        if api_name == "news":
            if params["src"] == "eastmoney":
                return payload(
                    ["datetime", "content", "title", "channels"],
                    [["2026-09-15 09:30:00", "公司(000001.SZ)披露新的业务进展。", "业务进展", "eastmoney"]],
                )
            return payload([], [])
        raise AssertionError(api_name)


@pytest.fixture
def isolated_store(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "sync.db")
    monkeypatch.setattr(tushare_sync, "STOCK_FILE", tmp_path / "stock_daily.parquet")
    monkeypatch.setattr(tushare_sync, "DAILY_PAGE_SIZE", 2)
    monkeypatch.setattr(tushare_sync, "SOURCE_DELAY_SECONDS", 0)
    db.init_db()
    return tmp_path


def test_market_sync_pages_and_atomically_merges_new_bars(isolated_store):
    stock_file = tushare_sync.STOCK_FILE
    pq.write_table(
        pa.Table.from_pylist(
            [{"trade_date": datetime(2026, 9, 14), "stock_code": "600000.SH", "open": 19.0, "high": 20.0, "low": 18.0, "close": 19.5, "volume": 10.0, "amount": 195.0}]
        ),
        stock_file,
    )
    result = tushare_sync.sync_market_data(FakeRelay(), as_of=datetime(2026, 9, 16).date())
    assert result["status"] == "updated"
    assert result["rows_written"] == 4
    assert result["missing_or_failed_days"] == []
    with duckdb.connect(database=":memory:") as connection:
        rows = connection.execute(
            "SELECT stock_code,trade_date::DATE,close FROM read_parquet(?) ORDER BY trade_date,stock_code", [str(stock_file)]
        ).fetchall()
    assert rows == [
        ("600000.SH", datetime(2026, 9, 14).date(), 19.5),
        ("000001.SZ", datetime(2026, 9, 15).date(), 10.5),
        ("000002.SZ", datetime(2026, 9, 15).date(), 8.5),
        ("600000.SH", datetime(2026, 9, 15).date(), 21.0),
        ("000001.SZ", datetime(2026, 9, 16).date(), 11.0),
    ]


def test_daily_reader_accepts_a_relay_full_day_fallback(monkeypatch):
    monkeypatch.setattr(tushare_sync, "DAILY_PAGE_SIZE", 2)
    monkeypatch.setattr(tushare_sync, "SOURCE_DELAY_SECONDS", 0)

    class FullDayFallback:
        def raw_query(self, api_name: str, **params):
            assert api_name == "daily"
            rows = [
                ["000001.SZ", "20260915"],
                ["000002.SZ", "20260915"],
                ["000003.SZ", "20260915"],
            ]
            # The high-offset cache route returns the whole day, including
            # records already seen on the preceding regular page.
            return payload(["ts_code", "trade_date"], rows[:2] if params["offset"] == 0 else rows)

    rows = tushare_sync._daily_rows(FullDayFallback(), datetime(2026, 9, 15).date())
    assert len(rows) == 5
    assert len({(row["ts_code"], row["trade_date"]) for row in rows}) == 3


def test_full_sync_imports_news_without_claiming_missing_history(isolated_store):
    relay = FakeRelay()
    result = tushare_sync.sync_tushare(as_of="2026-09-16", days=2, client=relay)
    assert result["stages"]["market"]["status"] == "updated"
    assert "reports" not in result["stages"]
    assert result["stages"]["news"]["history_complete"] is False
    assert result["stages"]["news"]["import"]["created"] == 1
    assert all(api_name != "report_rc" for api_name, _ in relay.calls)
    assert news_sources.browse()["external_sync"] is True
    saved = news_sources.list_news_sources("000001.SZ", "2026-09-15")
    assert saved["total"] == 1
    assert "Tushare news/eastmoney" in news_sources.get_item(saved["items"][0]["source_id"])["source"]
