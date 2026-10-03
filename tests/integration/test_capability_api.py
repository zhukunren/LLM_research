from datetime import date

from fastapi.testclient import TestClient
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from apps.api.app import db, main, market


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "capabilities-test.db")
    stock_file = tmp_path / "sample.parquet"
    pq.write_table(
        pa.table(
            {
                "stock_code": ["600000.SH"],
                "trade_date": [date(2026, 9, 14)],
                "open": [10.0],
                "high": [11.0],
                "low": [9.0],
                "close": [10.5],
                "volume": [100.0],
                "amount": [1050.0],
            }
        ),
        stock_file,
    )
    monkeypatch.setattr(main, "STOCK_FILE", stock_file)
    monkeypatch.setattr(main, "llm_settings", lambda: {"configured": False})
    monkeypatch.setattr(
        market,
        "cached_profile",
        lambda: {
            "available": True,
            "path": "D:/example-only/local.parquet",
            "sha256": "b" * 64,
            "first_date": "2024-01-01",
            "last_date": "2026-09-14",
            "markets": {"SH": 2},
            "rows": 100,
            "securities": 2,
            "columns": [{"name": "close", "type": "DOUBLE"}],
            "price_basis": "unknown",
            "volume_unit": "unknown",
            "amount_unit": "unknown",
            "quality_status": "basic_checks_passed",
            "formal_execution_ready": False,
            "formal_blockers": ["复权口径未确认"],
        },
    )
    with TestClient(main.app) as session:
        yield session


def test_capability_routes_report_runtime_state_without_breaking_existing_contract(client):
    legacy = client.get("/api/v1/capabilities")
    manifest = client.get("/api/v1/screening-capabilities")
    assert legacy.status_code == 200
    assert legacy.json()["menus"][-1] == "screening"
    assert legacy.json()["workspace_menus"] == ["research", "screening", "watchlist", "news", "technical", "patterns", "reports"]
    assert legacy.json()["news_data"] == "local_import_and_tushare_sync"
    assert legacy.json()["news_external_sync"] is True
    assert len(legacy.json()["screening_capabilities"]["capabilities"]) >= 10
    assert manifest.status_code == 200
    assert manifest.json() == legacy.json()["screening_capabilities"]


def test_data_coverage_returns_scope_and_units_without_local_path(client):
    response = client.get("/api/v1/data/coverage")
    result = response.json()
    assert response.status_code == 200
    assert result["last_date"] == "2026-09-14"
    assert result["source_id"] == "b" * 64
    assert result["price_basis"] == "unknown"
    assert result["formal_execution_ready"] is False
    assert "path" not in result
    assert "example-only" not in response.text


def test_capability_check_reads_parquet_schema_without_accepting_invalid_files(tmp_path):
    invalid_file = tmp_path / "invalid.parquet"
    invalid_file.write_text("not parquet", encoding="utf-8")
    assert main.market.daily_bar_source_available(invalid_file) is False

    missing_field = tmp_path / "missing-field.parquet"
    pq.write_table(pa.table({"stock_code": ["600000.SH"], "close": [10.0]}), missing_field)
    assert main.market.daily_bar_source_available(missing_field) is False
