from fastapi import APIRouter, Query

from . import task_status


router = APIRouter(prefix="/api/v1", tags=["任务进展"])


@router.get("/tasks")
def tasks(active_only: bool = True, limit: int = Query(100, ge=1, le=200)):
    return task_status.list_tasks(active_only=active_only, limit=limit)
