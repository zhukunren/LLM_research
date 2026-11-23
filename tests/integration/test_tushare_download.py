import csv
from dataclasses import replace
from datetime import datetime
from decimal import Decimal
from io import StringIO

import pytest
from fastapi.testclient import TestClient

from apps.api.app import main, tushare_download_api as downloads
from apps.api.app.tushare_client import TushareError, TushareSnapshot


PATH = "/api/v1/tushare-download"
RANGE = {"start_date": "2026-11-19", "end_date": "2026-11-20"}


def snapshot(fields, *rows):
    return TushareSnapshot(b"fixture", {"data": {"fields": fields, "items": list(rows)}})


@pytest.fixture
def provider(monkeypatch):
    class Provider:
        calls = []
        answer = None

        def query_snapshot(self, endpoint, *, fields, **params):
            self.calls.append((endpoint, params))
            return self.answer(endpoint, params)

    provider = Provider()
    monkeypatch.setattr(downloads.tushare_sync, "create_client", lambda **_kwargs: provider)
    monkeypatch.setattr(downloads, "tushare_settings", lambda: {"configured": True, "token": "fixture-secret"})
    monkeypatch.setattr(downloads, "now", lambda: datetime(2026, 11, 23))
    return provider


def test_catalog_is_read_only_and_download_uses_fresh_provider_rows(provider):
    client = TestClient(main.app)
    catalog = client.get(f"{PATH}/catalog")
    assert catalog.json()["configured"] is True
    assert "fixture-secret" not in catalog.text
    assert not provider.calls

    value = Decimal("10.1234567890123456")
    provider.answer = lambda _endpoint, params: snapshot(
        ["ts_code", "trade_date", "close", "memo"], ["600519.SH", params["trade_date"], value, "=1+1"],
    )
    export = client.get(f"{PATH}/daily", params=RANGE)
    assert export.status_code == 200
    assert export.headers["x-row-count"] == "2"
    assert export.headers["cache-control"] == "no-store"
    assert export.headers["content-disposition"] == 'attachment; filename="tushare-daily-20261119-20261120.csv"'
    assert list(csv.reader(StringIO(export.content.decode("utf-8-sig")))) == [
        ["ts_code", "trade_date", "close", "memo"],
        ["600519.SH", "20261119", str(value), "'=1+1"],
        ["600519.SH", "20261120", str(value), "'=1+1"],
    ]
    assert provider.calls == [("daily", {"trade_date": "20261119"}), ("daily", {"trade_date": "20261120"})]

    provider.answer = lambda *_: snapshot(["ts_code", "trade_date", "close"], ["600519.SH", "20261120", 20])
    new = client.get(f"{PATH}/daily", params={"start_date": "2026-11-20", "end_date": "2026-11-20"})
    assert new.status_code == 200
    assert "600519.SH,20261120,20" in new.text


def test_capped_security_range_is_split_without_losing_rows(provider, monkeypatch):
    monkeypatch.setitem(downloads.DATASETS, "cyq_chips", replace(downloads.DATASETS["cyq_chips"], limit=2))

    def answer(_endpoint, params):
        start, end = params["start_date"], params["end_date"]
        rows = [["600519.SH", start, 1500]]
        if start != end:
            rows.append(["600519.SH", end, 1500])
        return snapshot(["ts_code", "trade_date", "price"], *rows)

    provider.answer = answer
    exported = TestClient(main.app).get(f"{PATH}/cyq_chips", params={**RANGE, "code": "600519.sh"})
    assert exported.status_code == 200
    assert exported.headers["x-row-count"] == "2"
    assert [(params["start_date"], params["end_date"]) for _, params in provider.calls] == [
        ("20261119", "20261120"), ("20261119", "20261119"), ("20261120", "20261120"),
    ]


def test_vip_financial_export_rejects_replayed_pages(provider, monkeypatch):
    monkeypatch.setattr(downloads, "VIP_PAGE_SIZE", 1)
    provider.answer = lambda *_: snapshot(["ts_code", "end_date"], ["600519.SH", "20251231"])
    response = TestClient(main.app).get(f"{PATH}/income", params={"period": "2025-12-31"})
    assert response.status_code == 502
    assert response.json()["code"] == "tushare_incomplete"
    assert "content-disposition" not in response.headers
    assert provider.calls == [
        ("income_vip", {"period": "20251231", "limit": 1, "offset": 0}),
        ("income_vip", {"period": "20251231", "limit": 1, "offset": 1}),
    ]


def test_filters_are_validated_before_taking_provider_quota(provider):
    client = TestClient(main.app)
    for dataset, params, status in [
        ("news", RANGE, 404),
        ("daily", {**RANGE, "fields": "open"}, 422),
        ("daily", {**RANGE, "start_date": "2026-11-01"}, 422),
        ("income", {"period": "2025-12-30"}, 422),
        ("cyq_perf", RANGE, 422),
    ]:
        assert client.get(f"{PATH}/{dataset}", params=params).status_code == status
    assert not provider.calls


def test_distinguishes_empty_results_permissions_and_wrong_scope(provider):
    client = TestClient(main.app)
    params = {**RANGE, "code": "600519.SH"}
    provider.answer = lambda *_: snapshot([])
    empty = client.get(f"{PATH}/daily", params=params)
    assert (empty.status_code, empty.json()["code"]) == (404, "tushare_empty")

    def denied(*_):
        raise TushareError("provider-only details", kind="denied")

    provider.answer = denied
    denied_response = client.get(f"{PATH}/daily", params=params)
    assert (denied_response.status_code, denied_response.json()["code"]) == (403, "tushare_denied")
    assert "provider-only details" not in denied_response.text

    provider.answer = lambda *_: snapshot(["ts_code", "trade_date"], ["000001.SZ", "20261120"])
    mismatch = client.get(f"{PATH}/daily", params=params)
    assert mismatch.json()["code"] == "tushare_invalid_response"


@pytest.mark.parametrize("dataset, filters, upstream, fields, row", [
    ("index_weight", {**RANGE, "code": "000300.SH"}, {"index_code": "000300.SH", "start_date": "20261119", "end_date": "20261120"},
     ["index_code", "trade_date", "weight"], ["000300.SH", "20261120", Decimal("3.04")]),
    ("cn_cpi", {"start_month": "2026-01", "end_month": "2026-10"}, {"start_m": "202601", "end_m": "202610"},
     ["month", "nt_yoy"], ["202610", Decimal("0.3")]),
    ("cn_gdp", {"start_quarter": "2025Q4", "end_quarter": "2026Q3"}, {"start_q": "2025Q4", "end_q": "2026Q3"},
     ["quarter", "gdp"], ["2026Q3", 321]),
    ("dc_index", {"start_date": "2026-11-20", "end_date": "2026-11-20", "option": "概念板块"},
     {"trade_date": "20261120", "idx_type": "概念板块"}, ["ts_code", "trade_date", "idx_type"], ["BK1184.DC", "20261120", "概念板块"]),
    ("share_float", {"start_date": "2026-11-25", "end_date": "2026-11-25"}, {"float_date": "20261125"},
     ["ts_code", "float_date", "float_share"], ["688981.SH", "20261125", 300]),
])
def test_added_downloads_use_the_documented_date_and_code_parameters(provider, dataset, filters, upstream, fields, row):
    provider.answer = lambda *_: snapshot(fields, row)
    response = TestClient(main.app).get(f"{PATH}/{dataset}", params=filters)
    assert response.status_code == 200
    assert response.headers["x-row-count"] == "1"
    assert provider.calls == [(dataset, upstream)]


def test_industry_membership_requests_the_first_page_explicitly(provider, monkeypatch):
    name = "index_member_all"
    monkeypatch.setitem(downloads.DATASETS, name, replace(downloads.DATASETS[name], page_size=1))

    def answer(_endpoint, params):
        page = [["600519.SH", "Y"], ["000001.SZ", "Y"]][params["offset"]:params["offset"] + 1]
        return snapshot(["ts_code", "is_new"], *page)

    provider.answer = answer
    response = TestClient(main.app).get(f"{PATH}/{name}")
    assert response.status_code == 200
    assert response.headers["x-row-count"] == "2"
    assert provider.calls == [(name, {"is_new": "Y", "limit": 1, "offset": offset}) for offset in range(3)]


def test_adjusted_bars_use_same_day_factors_and_a_common_cutoff(provider):
    dates = ["20261119", "20261120"]
    factors = [["600519.SH", dates[0], Decimal("2")], ["600519.SH", dates[1], Decimal("4")]]
    bars = snapshot(["ts_code", "trade_date", "open", "high", "low", "close", "vol"],
                    ["600519.SH", dates[0], 19, 22, 18, 20, 2], ["600519.SH", dates[1], 9, 11, 8, 10, 3])
    provider.answer = lambda endpoint, _params: snapshot(["ts_code", "trade_date", "adj_factor"], *factors) if endpoint == "adj_factor" else bars
    client = TestClient(main.app)
    response = client.get(f"{PATH}/daily_adjusted", params={**RANGE, "code": "600519.SH"})
    assert response.status_code == 200
    rows = list(csv.DictReader(StringIO(response.content.decode("utf-8-sig"))))
    assert [Decimal(row["close_qfq"]) for row in rows] == [10, 10]
    assert [Decimal(row["close_hfq"]) for row in rows] == [40, 40]
    assert [row["qfq_base_date"] for row in rows] == [dates[1], dates[1]]
    assert [row["vol"] for row in rows] == ["2", "3"]
    assert [endpoint for endpoint, _ in provider.calls] == ["adj_factor", "daily"]

    factors.pop()
    missing = client.get(f"{PATH}/daily_adjusted", params={**RANGE, "code": "600519.SH"})
    assert missing.status_code == 502
    assert missing.json()["code"] == "tushare_adjustment_missing"
    assert "content-disposition" not in missing.headers
