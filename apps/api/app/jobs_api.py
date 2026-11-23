from __future__ import annotations

from fastapi import APIRouter

from . import jobs
from .api_responses import bad_request
from .db import connect

router = APIRouter(prefix="/api/v1/jobs")


@router.get("/{job_id}")
def get_job(job_id: str):
    with connect() as connection:
        row = connection.execute("SELECT id,kind,state,progress,message,created_at,updated_at FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row:
        bad_request("找不到后台任务", 404, "job_not_found")
    return dict(row)


@router.post("/{job_id}/cancel")
def cancel_job(job_id: str):
    try:
        return jobs.cancel(job_id)
    except KeyError:
        bad_request("找不到后台任务", 404, "job_not_found")


@router.post("/{job_id}/retry")
def retry_job(job_id: str):
    try:
        return jobs.retry(job_id)
    except KeyError:
        bad_request("找不到后台任务", 404, "job_not_found")
    except ValueError as exc:
        bad_request(str(exc), 409, "job_not_retryable")
