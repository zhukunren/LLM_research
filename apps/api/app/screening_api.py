from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field, model_validator
from typing import Literal

from . import screening_service
from .screening_contracts import ContractModel
from .screening_templates import router as templates_router

router = APIRouter(prefix="/api/v1", tags=["对话筛选运行"])
router.include_router(templates_router)


class ExecuteTurnRequest(ContractModel):
    action: Literal["message", "button"] = "message"
    revision: int | None = Field(default=None, ge=1)
    request_id: str | None = Field(default=None, min_length=1, max_length=100)

    @model_validator(mode="after")
    def button_requires_snapshot(self):
        if self.action == "button" and (self.revision is None or self.request_id is None):
            raise ValueError("按钮执行必须指定任务版本和请求标识")
        return self


def _service_error(exc: screening_service.ScreeningServiceError) -> None:
    raise HTTPException(
        exc.status_code,
        {"code": exc.code, "message": str(exc)},
    )


@router.post("/conversations/{conversation_id}/turns/{turn_id}/execute", status_code=202)
def enqueue_screening_turn(conversation_id: str, turn_id: str, payload: ExecuteTurnRequest | None = None):
    try:
        action = payload.action if payload else "message"
        return screening_service.enqueue_turn(conversation_id, turn_id, button_authorized=action == "button",
                                              button_revision=payload.revision if payload else None,
                                              button_request_id=payload.request_id if payload else None)
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
