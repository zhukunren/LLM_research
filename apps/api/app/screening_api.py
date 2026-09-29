from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from . import screening_service

router = APIRouter(prefix="/api/v1", tags=["对话筛选运行"])


def _service_error(exc: screening_service.ScreeningServiceError) -> None:
    raise HTTPException(
        exc.status_code,
        {"code": exc.code, "message": str(exc)},
    )


@router.post("/conversations/{conversation_id}/turns/{turn_id}/execute", status_code=202)
def enqueue_screening_turn(conversation_id: str, turn_id: str):
    try:
        return screening_service.enqueue_turn(conversation_id, turn_id)
    except screening_service.ScreeningServiceError as exc:
        _service_error(exc)


@router.get("/conversations/{conversation_id}/screening-runs/{run_id}")
def get_screening_task_run(conversation_id: str, run_id: str):
    try:
        return screening_service.get_task_run(conversation_id, run_id)
    except screening_service.ScreeningServiceError as exc:
        _service_error(exc)


@router.get("/conversations/{conversation_id}/screening-runs")
def list_screening_task_runs(conversation_id: str, limit: int = Query(default=50, ge=1, le=100)):
    return {"items": screening_service.list_task_runs(conversation_id, limit)}


@router.get("/conversations/{conversation_id}/screening-runs/{run_id}/decisions")
def get_screening_task_decisions(
    conversation_id: str,
    run_id: str,
    state: str = "",
    query: str = "",
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
):
    try:
        return screening_service.list_task_decisions(
            conversation_id,
            run_id,
            state=state,
            query=query,
            offset=offset,
            limit=limit,
        )
    except screening_service.ScreeningServiceError as exc:
        _service_error(exc)


@router.get("/conversations/{conversation_id}/screening-runs/{run_id}/explanation")
def explain_screening_task_run(conversation_id: str, run_id: str, stock_code: str | None = None):
    try:
        return screening_service.explain_task_run(conversation_id, run_id, stock_code=stock_code)
    except screening_service.ScreeningServiceError as exc:
        _service_error(exc)
