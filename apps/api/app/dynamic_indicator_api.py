import asyncio
from contextlib import suppress
import threading

from fastapi import APIRouter, HTTPException, Query, Request
from starlette.concurrency import run_in_threadpool

from . import dynamic_indicators as indicators

router = APIRouter(prefix="/api/v1/dynamic-indicators", tags=["动态数值指标"])


def _call(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except indicators.IndicatorError as exc:
        raise HTTPException(exc.status_code, {"code": exc.code, "message": str(exc)}) from exc


@router.get("")
def list_indicators(include_history: bool = False, limit: int = Query(default=100, ge=1, le=200)):
    return {"items": indicators.list_indicators(include_history, limit)}


@router.post("/preview")
async def preview_indicator(payload: indicators.PreviewIndicatorRequest, request: Request):
    stopped = threading.Event()

    async def watch_disconnect():
        while not stopped.is_set():
            if await request.is_disconnected():
                stopped.set()
                return
            await asyncio.sleep(0.05)

    monitor = asyncio.create_task(watch_disconnect())
    try:
        return await run_in_threadpool(_call, indicators.preview_indicator, payload, is_active=lambda: not stopped.is_set())
    except indicators.runtime_executor.RuntimeCancelled as exc:
        raise HTTPException(409, {"code": "indicator_cancelled", "message": "指标试算已取消"}) from exc
    finally:
        stopped.set()
        monitor.cancel()
        with suppress(asyncio.CancelledError):
            await monitor


@router.post("/save", status_code=201)
def save_indicator(payload: indicators.SaveIndicatorRequest):
    return _call(indicators.save_indicator, payload)


@router.get("/trials")
def list_trials(conversation_id: str | None = None, limit: int = Query(default=30, ge=1, le=100)):
    return {"items": indicators.list_trials(conversation_id, limit)}


@router.get("/trials/{trial_id}")
def get_trial(trial_id: str):
    return _call(indicators.get_trial, trial_id)


@router.get("/{indicator_id}")
def get_indicator(indicator_id: str, version: int | None = Query(default=None, ge=1)):
    return _call(indicators.get_indicator, indicator_id, version)


@router.get("/{indicator_id}/versions")
def list_versions(indicator_id: str):
    return {"items": _call(indicators.list_versions, indicator_id)}


@router.get("/{indicator_id}/versions/{version}")
def get_version(indicator_id: str, version: int):
    return _call(indicators.get_indicator, indicator_id, version)


@router.post("/{indicator_id}/condition")
@router.post("/{indicator_id}/screening-condition")
def build_condition(indicator_id: str, payload: indicators.IndicatorConditionRequest):
    return _call(indicators.build_condition, indicator_id, payload)
