from __future__ import annotations

from datetime import date
from typing import Literal
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from . import research_projects as projects
from . import company_research as company
from . import research_pdf, research_pdf_service
from .research_pdf import PDFError
from .screening_contracts import ContractModel
from pydantic import Field


router = APIRouter(prefix="/api/v1", tags=["研究项目与笔记"])


class LinkConversation(ContractModel):
    project_id: str | None = Field(default=None, min_length=1, max_length=100)


def _call(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except projects.ProjectError as exc:
        raise HTTPException(exc.status, {"code": "research_project_error", "message": str(exc)}) from exc
    except PDFError as exc:
        raise HTTPException(503, {"code": "research_pdf_failed", "message": str(exc)}) from exc
    except research_pdf_service.ExportError as exc:
        raise HTTPException(exc.status, {"code": "research_pdf_job_error", "message": str(exc)}) from exc


def _save_note(operation, project_id: str, *args):
    return _call(operation, project_id, *args)


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
    return _save_note(projects.create_note, project_id, payload)


@router.patch("/research-projects/{project_id}/notes/{note_id}")
def update_note(project_id: str, note_id: str, payload: projects.UpdateNote):
    return _save_note(projects.update_note, project_id, note_id, payload)


@router.post("/research-projects/{project_id}/notes/from-message")
def save_message(project_id: str, payload: projects.SaveMessage):
    return _save_note(projects.save_message, project_id, payload.message_id)


@router.post("/conversations/{conversation_id}/notes/from-message")
def save_conversation_message(conversation_id: str, payload: projects.SaveMessage):
    note = _call(projects.save_conversation_message, conversation_id, payload.message_id)
    # Repeated saves return the same note and the same durable generation task.
    note["pdf"] = _call(research_pdf_service.enqueue_note, note["project_id"], note["id"], note["revision"])
    return note


class GenerateReports(ContractModel):
    request_id: str = Field(min_length=1, max_length=100)


class GenerateNotePDF(ContractModel):
    revision: int | None = Field(default=None, ge=1)


@router.post("/research-projects/{project_id}/research-pdf-jobs")
def generate_project_reports(project_id: str, payload: GenerateReports):
    return _call(research_pdf_service.enqueue_discovery, "project", project_id, payload.request_id)


@router.post("/research-projects/{project_id}/research-pdf-jobs/{export_id}/retry")
def retry_project_report(project_id: str, export_id: str):
    return _call(research_pdf_service.retry_export, "project", project_id, export_id)


@router.post("/research-projects/{project_id}/notes/{note_id}/pdf-jobs")
def generate_note_report(project_id: str, note_id: str, payload: GenerateNotePDF):
    return _call(research_pdf_service.enqueue_note, project_id, note_id, payload.revision)


@router.get("/research-projects/{project_id}/notes/{note_id}/pdf-status")
def note_report_status(project_id: str, note_id: str, revision: int | None = Query(default=None, ge=1)):
    _call(research_pdf_service.require_owner, "project", project_id)
    with projects.connect() as connection:
        note = connection.execute("SELECT revision FROM research_notes WHERE project_id=? AND id=?", (project_id, note_id)).fetchone()
        version = connection.execute("SELECT 1 FROM research_note_versions WHERE note_id=? AND revision=?", (note_id, revision or (note["revision"] if note else 0))).fetchone()
        if not note or not version:
            raise HTTPException(404, "找不到此研究笔记版本。")
        return {"pdf": research_pdf_service.note_status(project_id, note_id, revision or note["revision"], connection=connection)}


@router.get("/research-projects/{project_id}/files")
def project_files(project_id: str):
    return {"items": _call(projects.project_files, project_id)}


@router.get("/research-projects/{project_id}/research-pdfs/{filename}")
def project_pdf(project_id: str, filename: str):
    _call(projects.get_project, project_id)
    try:
        target, name = research_pdf.pdf_path(project_id, filename, project=True)
    except PDFError as exc:
        raise HTTPException(404, str(exc)) from exc
    return FileResponse(target, filename=name, media_type="application/pdf", headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})


@router.get("/research-projects/{project_id}/notes/{note_id}/pdf")
def note_pdf(project_id: str, note_id: str, revision: int | None = Query(default=None, ge=1)):
    item = _call(research_pdf_service.download_note, project_id, note_id, revision=revision)
    target, name = research_pdf.pdf_path(project_id, item["url"].rsplit("/", 1)[-1], project=True)
    return FileResponse(target, filename=name, media_type="application/pdf", headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})


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
    result = _call(company.create_claim, project_id, note_id, payload)
    # New evidence creates another immutable PDF input; previous PDFs remain available.
    _call(research_pdf_service.enqueue_note, project_id, note_id, payload.note_revision)
    return result


@router.get("/research-projects/{project_id}/claims/{claim_id}/evidence/{index}")
def saved_claim_evidence(project_id: str, claim_id: str, index: int):
    return _call(company.saved_evidence, project_id, claim_id, index)
