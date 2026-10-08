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


def test_failed_day_retried_after_later_day_advances_watermark(isolated_store):
    class FailingRelay(FakeRelay):
        def raw_query(self, api_name, **params):
            if api_name == "daily" and params["trade_date"] == "20260915":
                raise RuntimeError("temporary outage")
            return super().raw_query(api_name, **params)

    first = tushare_sync.sync_market_data(FailingRelay(), as_of=datetime(2026, 9, 16).date())
    assert first["status"] == "partial"
    assert first["new_watermark"] == "2026-09-16"
    relay = FakeRelay()
    second = tushare_sync.sync_market_data(relay, as_of=datetime(2026, 9, 16).date())
    assert second["updated_days"] == ["2026-09-15"]
    assert second["rows_written"] == 3
    assert second["missing_or_failed_days"] == []
    assert all(p["trade_date"] != "20260916" for api, p in relay.calls if api == "daily")


@pytest.mark.parametrize("bad_field,bad_value", [("close", -1), ("trade_date", "20260914")])
def test_invalid_or_wrong_day_rejected_atomically_and_retried(isolated_store, bad_field, bad_value):
    class InvalidRelay(FakeRelay):
        def raw_query(self, api_name, **params):
            response = super().raw_query(api_name, **params)
            if api_name == "daily" and params["trade_date"] == "20260915" and params.get("offset") == 0:
                response["data"]["items"][0][response["data"]["fields"].index(bad_field)] = bad_value
            return response

    first = tushare_sync.sync_market_data(InvalidRelay(), as_of=datetime(2026, 9, 16).date())
    assert first["status"] == "partial"
    assert first["rows_written"] == 1
    assert first["rows_rejected"] == 1
    assert first["updated_days"] == ["2026-09-16"]
    second = tushare_sync.sync_market_data(FakeRelay(), as_of=datetime(2026, 9, 16).date())
    assert second["updated_days"] == ["2026-09-15"]
    assert second["rows_written"] == 3


def test_legacy_partial_day_is_revalidated_not_skipped(isolated_store):
    row = tushare_sync._daily_record({"ts_code": "000001.SZ", "trade_date": "20260916", "open": 10, "high": 11, "low": 9, "close": 10, "vol": 10, "amount": 100})
    tushare_sync._write_market_update([row])
    result = tushare_sync.sync_market_data(FakeRelay(), as_of=datetime(2026, 9, 16).date())
    assert result["updated_days"] == ["2026-09-16"]
    assert result["rows_written"] == 1
    with duckdb.connect(database=":memory:") as connection:
        assert connection.execute("SELECT close FROM read_parquet(?)", [str(tushare_sync.STOCK_FILE)]).fetchone()[0] == 11


def test_current_day_never_sealed_as_complete(isolated_store, monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 16, 16, tzinfo=tz)

    monkeypatch.setattr(tushare_sync, "datetime", Clock)
    tushare_sync.sync_market_data(FakeRelay(), as_of=datetime(2026, 9, 16).date())
    second = tushare_sync.sync_market_data(FakeRelay(), as_of=datetime(2026, 9, 16).date())
    assert second["updated_days"] == ["2026-09-16"]


def test_failed_initial_window_survives_without_parquet(isolated_store):
    class EmptyRelay(FakeRelay):
        def raw_query(self, api_name, **params):
            if api_name == "daily":
                return payload([], [])
            return super().raw_query(api_name, **params)

    first = tushare_sync.sync_market_data(EmptyRelay(), as_of=datetime(2026, 9, 16).date(), initial_days=2)
    assert first["status"] == "partial"
    second = tushare_sync.sync_market_data(FakeRelay(), as_of=datetime(2026, 10, 16).date(), initial_days=2)
    assert second["requested_start"] == "2026-09-15"
    assert second["updated_days"] == ["2026-09-15", "2026-09-16"]


def test_migration_budget_resumes_unprocessed_days(isolated_store, monkeypatch):
    monkeypatch.setattr(tushare_sync, "MARKET_DAYS_PER_SYNC", 1)
    first = tushare_sync.sync_market_data(FakeRelay(), as_of=datetime(2026, 9, 16).date())
    assert first["updated_days"] == ["2026-09-15"]
    assert first["deferred_days"] == ["2026-09-16"]
    assert first["status"] == "partial"
    second = tushare_sync.sync_market_data(FakeRelay(), as_of=datetime(2026, 9, 16).date())
    assert second["updated_days"] == ["2026-09-16"]
    assert second["deferred_days"] == []


def test_sync_supports_earlier_requested_history(isolated_store):
    first = tushare_sync.sync_market_data(FakeRelay(), as_of=datetime(2026, 9, 16).date(), initial_days=1)
    assert first["updated_days"] == ["2026-09-16"]
    second = tushare_sync.sync_market_data(FakeRelay(), as_of=datetime(2026, 9, 15).date(), initial_days=1)
    assert second["updated_days"] == ["2026-09-15"]


def test_external_parquet_change_invalidates_completion(isolated_store):
    tushare_sync.sync_market_data(FakeRelay(), as_of=datetime(2026, 9, 16).date())
    row = tushare_sync._daily_record({"ts_code": "000001.SZ", "trade_date": "20260916", "open": 10, "high": 11, "low": 9, "close": 10, "vol": 10, "amount": 100})
    tushare_sync._write_market_update([row])
    result = tushare_sync.sync_market_data(FakeRelay(), as_of=datetime(2026, 9, 16).date())
    assert result["updated_days"] == ["2026-09-15", "2026-09-16"]


def test_new_session_prioritized_over_legacy_backlog(isolated_store, monkeypatch):
    from datetime import date, timedelta
    first_day = date(2020, 1, 1)
    latest = date(2026, 9, 14)
    def record(day):
        return {"ts_code": "000001.SZ", "trade_date": day.isoformat(), "open": 10, "high": 11, "low": 9, "close": 10, "vol": 10, "amount": 100}
    tushare_sync._write_market_update([tushare_sync._daily_record(record(first_day)), tushare_sync._daily_record(record(latest))])
    old_days = [first_day + timedelta(days=i) for i in range(60)]
    new_day = date(2026, 9, 15)
    monkeypatch.setattr(tushare_sync, "_open_days", lambda *a: old_days + [latest, new_day])
    monkeypatch.setattr(tushare_sync, "_daily_rows", lambda client, day: [record(day)])
    result = tushare_sync.sync_market_data(object(), as_of=new_day)
    assert result["updated_days"][0] == new_day.isoformat()
    assert len(result["updated_days"]) == tushare_sync.MARKET_DAYS_PER_SYNC
    assert len(result["deferred_days"]) == 32
    assert result["status"] == "partial"
