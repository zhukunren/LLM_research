from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from . import conversation_store, research_scan_service
from .research_tools import StartResearchScanArgs


router = APIRouter(prefix="/api/v1/conversations", tags=["只读研究扫描"])


def _error(exc: research_scan_service.ResearchScanError):
    raise HTTPException(exc.status_code, {"code": exc.code, "message": str(exc)}) from exc


@router.post("/{conversation_id}/turns/{turn_id}/research-scans", status_code=202)
def start_research_scan(conversation_id: str, turn_id: str, payload: StartResearchScanArgs):
    try:
        return research_scan_service.enqueue_scan(
            conversation_id,
            turn_id,
            name=payload.name,
            program=payload.program,
            as_of=payload.as_of,
            universe=payload.universe,
            stock_codes=payload.stock_codes,
            execution_mode=payload.execution_mode,
        )
    except research_scan_service.ResearchScanError as exc:
        _error(exc)


@router.get("/{conversation_id}/research-scans")
def list_research_scans(conversation_id: str, limit: int = Query(default=50, ge=1, le=100)):
    try:
        conversation_store.get_conversation(conversation_id, message_limit=1)
    except conversation_store.ConversationNotFound as exc:
        raise HTTPException(404, {"code": "conversation_not_found", "message": "找不到此对话"}) from exc
    return {"items": research_scan_service.list_scans(conversation_id, limit)}


@router.get("/{conversation_id}/research-scans/{scan_id}")
def get_research_scan(conversation_id: str, scan_id: str):
    try:
        return research_scan_service.get_scan(conversation_id, scan_id)
    except research_scan_service.ResearchScanError as exc:
        _error(exc)


@router.get("/{conversation_id}/research-scans/{scan_id}/decisions")
def get_research_scan_decisions(
    conversation_id: str,
    scan_id: str,
    state: str = "",
    query: str = "",
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=200),
):
    try:
        return research_scan_service.list_decisions(
            conversation_id, scan_id, state=state, query=query, offset=offset, limit=limit
        )
    except research_scan_service.ResearchScanError as exc:
        _error(exc)


@router.post("/{conversation_id}/research-scans/{scan_id}/cancel")
def cancel_research_scan(conversation_id: str, scan_id: str):
    try:
        return research_scan_service.cancel_scan(conversation_id, scan_id)
    except research_scan_service.ResearchScanError as exc:
        _error(exc)


@router.get("/{conversation_id}/research-scans/{scan_id}/export")
def export_research_scan(conversation_id: str, scan_id: str):
    try:
        rows = research_scan_service.export_csv(conversation_id, scan_id)
    except research_scan_service.ResearchScanError as exc:
        _error(exc)
    return StreamingResponse(rows, media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="research-scan-{scan_id}.csv"',
        "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
    })
