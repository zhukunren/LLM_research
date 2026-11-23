from __future__ import annotations

from datetime import date, timedelta
from uuid import uuid4

from fastapi import APIRouter

from .api_responses import bad_request
from .db import connect, json_dump, json_load, utc_now
from .filter_api import require_filter
from .models import ReportEvaluationInput
from .report_evidence import PROMPT_VERSION, model_name
from .rules import validate_filter
from .settings import llm_settings

router = APIRouter(prefix="/api/v1")


@router.post("/filters/{filter_id}/evaluate-reports")
def evaluate_report_filter(filter_id: str, payload: ReportEvaluationInput, version: int | None = None):
    item = require_filter(filter_id, version)
    if item["library"] != "report" or item["expression"].get("evaluation_mode") != "rubric":
        bad_request("该条件不是可执行的结构化研报判断口径", 422, "report_rubric_required")
    errors = validate_filter("report", item["expression"])
    if errors:
        bad_request("研报判断口径校验失败", 422, "invalid_report_rubric", errors)
    as_of = date.fromisoformat(payload.as_of)
    lookback = int(item["expression"].get("lookback_calendar_days", 365))
    lookback_start = (as_of - timedelta(days=lookback)).isoformat()
    run_id, job_id, now = str(uuid4()), str(uuid4()), utc_now()
    configured = bool(llm_settings()["configured"])
    status = "queued" if configured else "blocked_dependency"
    coverage = {"state": status, "message": None if configured else "未配置文本模型；口径已保存，但不会伪造研报评估。"}
    result = {"assessments": [], "by_security": {}, "coverage": coverage}
    with connect() as connection:
        connection.execute(
            """INSERT INTO report_evaluation_runs
               (id,filter_id,filter_version,as_of,lookback_start,model,prompt_version,status,coverage_json,result_json,job_id,created_at,finished_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (run_id, item["id"], item["version"], payload.as_of, lookback_start, model_name(), PROMPT_VERSION, status, json_dump(coverage), json_dump(result), job_id, now, now if not configured else None),
        )
        connection.execute(
            "INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (job_id, "report_evaluation", json_dump({"evaluation_run_id": run_id, "filter_id": item["id"], "filter_version": item["version"]}), status, coverage["message"] or "等待研报评估 worker", now, now),
        )
    if not configured:
        return {
            "id": run_id, "job_id": job_id, "filter_id": item["id"], "filter_version": item["version"],
            "as_of": payload.as_of, "lookback_start": lookback_start, "model": model_name(),
            "prompt_version": PROMPT_VERSION, "status": status, "coverage": coverage, "result": result,
            "created_at": now,
        }
    return {
        "id": run_id, "job_id": job_id, "filter_id": item["id"], "filter_version": item["version"],
        "as_of": payload.as_of, "lookback_start": lookback_start, "model": model_name(),
        "prompt_version": PROMPT_VERSION, "status": status, "coverage": coverage, "result": result,
        "created_at": now, "message": "研报判断口径已进入后台评估队列；只处理截止日和回溯范围内的报告。",
    }


@router.get("/report-evaluations/{evaluation_id}")
def get_report_evaluation(evaluation_id: str):
    with connect() as connection:
        row = connection.execute("SELECT * FROM report_evaluation_runs WHERE id=?", (evaluation_id,)).fetchone()
        job = connection.execute("SELECT id,state,progress,message,updated_at FROM jobs WHERE id=?", (row[10],)).fetchone() if row else None
    if not row:
        bad_request("找不到研报评估任务", 404, "report_evaluation_not_found")
    return {
        "id": row[0], "filter_id": row[1], "filter_version": row[2], "as_of": row[3],
        "lookback_start": row[4], "model": row[5], "prompt_version": row[6], "status": row[7],
        "coverage": json_load(row[8]), "result": json_load(row[9]), "created_at": row[11],
        "finished_at": row[12], "job": dict(job) if job else None,
    }


@router.get("/report-evaluations")
def list_report_evaluations(filter_id: str, version: int):
    with connect() as connection:
        rows = connection.execute(
            "SELECT id,status,as_of,model,created_at FROM report_evaluation_runs WHERE filter_id=? AND filter_version=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
            (filter_id, version),
        ).fetchall()
    return {"items": [dict(row) for row in rows]}
