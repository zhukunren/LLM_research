"""Financial contracts and bounded pilot evidence in the current workspace."""
import json
from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from . import financial_probe, financial_store, financial_sync, financial_metrics, financial_facts
from .db import connect
from .tushare_endpoints import manifest
from .security_context import AccessDenied
from .financial_contracts import timestamp

router = APIRouter(prefix="/api/v1", tags=["财务接口与试点"])


@router.get("/financial-data/metrics")
def metric_catalog():
    from .security_context import can_write, current_actor
    return {"items": financial_metrics.catalog(), "formula_version": financial_metrics.FORMULA_VERSION,
            "can_save": can_write(current_actor())}


@router.get("/companies/{stock_code}/financials")
def company_financials(stock_code: str, as_of: date, start_year: int | None = None,
                       basis: Literal["annual", "cumulative", "quarter", "ttm"] = "annual",
                       mode: Literal["latest", "as_of"] = "latest", metrics: str = Query("", max_length=1000)):
    try:
        query = financial_metrics.FinancialQuery(stock_code=stock_code, as_of=as_of, start_year=start_year,
            basis=basis, mode=mode, metrics=metrics.split(",") if metrics else list(financial_metrics.DEFAULT_METRICS))
        return financial_metrics.calculate(query)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/financial-data/calculations")
def save_calculation(payload: financial_metrics.FinancialQuery, expected_id: str | None = Query(None, pattern=r"^[a-f0-9]{64}$")):
    try:
        return financial_metrics.freeze(payload, expected_id=expected_id)
    except financial_metrics.CalculationChanged as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/financial-data/calculations/{calculation_id}")
def read_calculation(calculation_id: str):
    try:
        return financial_metrics.read_calculation(calculation_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/financial-facts/{fact_id}/provenance")
def fact_provenance(fact_id: str):
    try:
        return financial_facts.provenance(fact_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/financial-data/series-status")
def series_status():
    return financial_sync.status()


@router.post("/maintenance/financial-sync", status_code=202)
def start_series(payload: financial_sync.SyncRequest):
    try:
        return financial_sync.start(payload)
    except AccessDenied:
        raise
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/financial-data/syncs/{financial_run_id}")
def read_sync(financial_run_id: str):
    try:
        result = financial_sync.read_run(financial_run_id)
        result["credential_matches"] = result.pop("credential_id") == financial_probe.credential_id()
        return result
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/maintenance/financial-sync/{financial_run_id}/retry", status_code=202)
def retry_sync(financial_run_id: str):
    try:
        return financial_sync.retry(financial_run_id)
    except AccessDenied:
        raise
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/financial-data/contracts")
def contracts():
    return manifest()


@router.get("/financial-data/status")
def status():
    return financial_probe.status()


@router.post("/maintenance/financial-probe", status_code=202)
def start_probe(payload: financial_probe.ProbeRequest):
    try:
        return financial_probe.start(payload)
    except AccessDenied:
        raise
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/financial-data/probes/{probe_id}")
def read_probe(probe_id: str):
    try:
        result = financial_store.read_run(probe_id)
        result["credential_matches"] = result.pop("credential_id") == financial_probe.credential_id()
        return result
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/financial-data/records/{record_id}")
def read_record(record_id: str):
    with connect() as connection:
        row = connection.execute("SELECT record_json FROM financial_source_records WHERE id=?", (record_id,)).fetchone()
        if not row:
            raise HTTPException(404, "找不到此数据版本")
        observations = [dict(item) for item in connection.execute(
            "SELECT run_id,sample_key,response_hash,observed_at FROM financial_source_observations WHERE record_id=? ORDER BY observed_at",
            (record_id,))]
    observations.sort(key=lambda item: timestamp(item["observed_at"]))
    return {"record": json.loads(row[0]), "observations": observations}
