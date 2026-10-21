from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from . import intelligence
from .intelligence_contracts import BriefKind, StartBrief, KIND_DEFINITIONS

router = APIRouter(prefix="/api/v1/intelligence", tags=["情报台"])


def call(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except intelligence.IntelligenceError as exc:
        raise HTTPException(exc.status, {"code": "intelligence_error", "message": str(exc)}) from exc


@router.get("")
def history(kind: BriefKind = "market", offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100)):
    return {**call(intelligence.list_runs, kind, offset, limit), "kinds": [
        {"id": key, "name": value["name"], "description": value["description"]} for key, value in KIND_DEFINITIONS.items()]}


@router.post("/runs", status_code=202)
def start(payload: StartBrief):
    return call(intelligence.start, payload)


@router.get("/runs/{brief_id}")
def detail(brief_id: str):
    return call(intelligence.detail, brief_id)


@router.post("/runs/{brief_id}/resume")
def resume(brief_id: str):
    call(intelligence.resume, brief_id)
    return call(intelligence.detail, brief_id)


@router.post("/runs/{brief_id}/cancel")
def cancel(brief_id: str):
    call(intelligence.cancel, brief_id)
    return call(intelligence.detail, brief_id)


@router.get("/runs/{brief_id}/evidence/{source_id}")
def evidence(brief_id: str, source_id: str):
    return call(intelligence.evidence, brief_id, source_id)


@router.get("/runs/{brief_id}/export")
def export(brief_id: str):
    content = call(intelligence.export_markdown, brief_id)
    return Response(content, media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="intelligence-{brief_id}.md"', "Cache-Control": "no-store"})
