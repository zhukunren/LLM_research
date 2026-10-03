from __future__ import annotations

from datetime import date
from typing import Literal
from fastapi import APIRouter, HTTPException, Query

from . import research_projects as projects
from . import company_research as company
from .screening_contracts import ContractModel
from pydantic import Field


router = APIRouter(prefix="/api/v1", tags=["研究项目与笔记"])


class LinkConversation(ContractModel):
    project_id: str | None = Field(default=None, min_length=1, max_length=100)


def _call(operation, *args):
    try:
        return operation(*args)
    except projects.ProjectError as exc:
        raise HTTPException(exc.status, {"code": "research_project_error", "message": str(exc)}) from exc


@router.get("/research-projects")
def list_projects():
    return {"items": projects.list_projects()}


@router.post("/research-projects")
def create_project(payload: projects.CreateProject):
    return _call(projects.create_project, payload)


@router.get("/research-projects/{project_id}")
def get_project(project_id: str):
    return _call(projects.get_project, project_id)


@router.patch("/research-projects/{project_id}")
def update_project(project_id: str, payload: projects.UpdateProject):
    return _call(projects.update_project, project_id, payload)


@router.post("/research-projects/{project_id}/companies")
def add_company(project_id: str, payload: projects.CompanyInput):
    return _call(projects.add_company, project_id, payload.stock_code)


@router.delete("/research-projects/{project_id}/companies/{stock_code}")
def remove_company(project_id: str, stock_code: str):
    return _call(projects.remove_company, project_id, stock_code)


@router.patch("/conversations/{conversation_id}/project")
def link_conversation(conversation_id: str, payload: LinkConversation):
    return _call(projects.link_conversation, conversation_id, payload.project_id)


@router.post("/research-projects/{project_id}/notes")
def create_note(project_id: str, payload: projects.CreateNote):
    return _call(projects.create_note, project_id, payload)


@router.patch("/research-projects/{project_id}/notes/{note_id}")
def update_note(project_id: str, note_id: str, payload: projects.UpdateNote):
    return _call(projects.update_note, project_id, note_id, payload)


@router.post("/research-projects/{project_id}/notes/from-message")
def save_message(project_id: str, payload: projects.SaveMessage):
    return _call(projects.save_message, project_id, payload.message_id)


@router.get("/research-projects/{project_id}/files")
def project_files(project_id: str):
    return {"items": _call(projects.project_files, project_id)}


@router.get("/research-projects/{project_id}/notes/{note_id}/history")
def note_history(project_id: str, note_id: str):
    return {"items": _call(projects.note_history, project_id, note_id)}


@router.get("/research-projects/{project_id}/companies/{stock_code}")
def company_dossier(project_id: str, stock_code: str, as_of: date):
    return _call(company.dossier, project_id, stock_code, as_of.isoformat())


@router.get("/research-projects/{project_id}/companies/{stock_code}/sources")
def company_sources(project_id: str, stock_code: str, kind: Literal["news", "report"], as_of: date,
                    offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=50)):
    return _call(company.sources, project_id, stock_code, kind, as_of.isoformat(), offset, limit)


@router.get("/research-projects/{project_id}/companies/{stock_code}/source")
def company_source(project_id: str, stock_code: str, kind: Literal["news", "report"], source_id: str,
                   as_of: date, page: int = Query(1, ge=1, le=5000), offset: int = Query(0, ge=0)):
    return _call(company.source, project_id, stock_code, kind, source_id, page, as_of.isoformat(), offset)


@router.get("/research-projects/{project_id}/notes/{note_id}/claims")
def note_claims(project_id: str, note_id: str, offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=50)):
    return _call(company.claims, project_id, note_id, offset, limit)


@router.post("/research-projects/{project_id}/notes/{note_id}/claims")
def create_claim(project_id: str, note_id: str, payload: company.CreateClaim):
    return _call(company.create_claim, project_id, note_id, payload)


@router.get("/research-projects/{project_id}/claims/{claim_id}/evidence/{index}")
def saved_claim_evidence(project_id: str, claim_id: str, index: int):
    return _call(company.saved_evidence, project_id, claim_id, index)
