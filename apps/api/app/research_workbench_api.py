from datetime import date

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from . import jobs, research_matrices, research_projects, research_tracking
from . import research_quality

router = APIRouter(prefix="/api/v1/research-projects", tags=["公司研究工作区"])


def _call(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except research_projects.ProjectError as exc:
        raise HTTPException(exc.status, {"code": "research_workbench_error", "message": str(exc)}) from exc


@router.get("/{project_id}/matrices")
def list_matrices(project_id: str, include_matrix: str | None = Query(default=None, max_length=100)):
    return _call(research_matrices.list_matrices, project_id, include_matrix)


@router.post("/{project_id}/matrices")
def create_matrix(project_id: str, payload: research_matrices.CreateMatrix):
    return _call(research_matrices.create, project_id, payload)


@router.get("/{project_id}/matrices/{matrix_id}/runs")
def list_runs(project_id: str, matrix_id: str, include_run: str | None = Query(default=None, max_length=100)):
    return _call(research_matrices.runs, project_id, matrix_id, include_run)


@router.post("/{project_id}/matrices/{matrix_id}/runs")
def start_run(project_id: str, matrix_id: str, payload: research_matrices.StartRun):
    return _call(research_matrices.start, project_id, matrix_id, payload)


@router.post("/{project_id}/matrices/{matrix_id}/runs/{matrix_run_id}/review")
def review_cell(project_id: str, matrix_id: str, matrix_run_id: str, payload: research_matrices.ReviewCell):
    return _call(research_matrices.review_cell, project_id, matrix_id, matrix_run_id, payload)


@router.get("/{project_id}/matrices/{matrix_id}/runs/{matrix_run_id}/evidence")
def read_evidence(project_id: str, matrix_id: str, matrix_run_id: str, stock_code: str, question_id: str, index: int = Query(0, ge=0, le=3)):
    return _call(research_matrices.evidence, project_id, matrix_id, matrix_run_id, stock_code, question_id, index)


@router.get("/{project_id}/matrices/{matrix_id}/runs/{matrix_run_id}/export")
def export_comparison(project_id: str, matrix_id: str, matrix_run_id: str):
    content = _call(research_matrices.export_excel, project_id, matrix_id, matrix_run_id)
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="research-comparison-{matrix_run_id}.xlsx"', "Cache-Control": "no-store"})


@router.post("/{project_id}/matrices/{matrix_id}/runs/{matrix_run_id}/cancel")
def cancel_run(project_id: str, matrix_id: str, matrix_run_id: str):
    def cancel():
        from .db import connect
        with connect() as connection:
            _, run = research_matrices._run(connection, project_id, matrix_id, matrix_run_id, writable=True)
        if run["job_id"]:
            jobs.cancel(run["job_id"])
        return research_matrices.runs(project_id, matrix_id)
    return _call(cancel)


@router.get("/{project_id}/companies/{stock_code}/changes")
def changes(project_id: str, stock_code: str):
    return _call(research_tracking.list_checks, project_id, stock_code)


@router.post("/{project_id}/companies/{stock_code}/changes")
def check_changes(project_id: str, stock_code: str, payload: research_tracking.CheckChanges):
    return _call(research_tracking.check, project_id, stock_code, payload)


@router.post("/{project_id}/change-checks/{check_id}/review")
def review_change(project_id: str, check_id: str, payload: research_tracking.ReviewChange):
    return _call(research_tracking.review, project_id, check_id, payload)


@router.get("/{project_id}/change-checks/{check_id}/sources/{change_key}")
def read_change_source(project_id: str, check_id: str, change_key: str, page: int = Query(1, ge=1, le=5000), offset: int = Query(0, ge=0)):
    return _call(research_tracking.source, project_id, check_id, change_key, page, offset)


@router.get("/{project_id}/quality")
def quality(project_id: str):
    return _call(research_quality.project_audit, project_id)
