from __future__ import annotations

from contextlib import nullcontext
import sqlite3
from typing import Any
from uuid import uuid4

from pydantic import Field

from .db import connect, json_dump, json_load, utc_now
from .screening_contracts import ContractModel, ScreeningTaskRevision, validate_executable_task


class SaveScreeningTaskRequest(ContractModel):
    name: str = Field(min_length=1, max_length=120)
    request_id: str = Field(min_length=1, max_length=100)
    revision: int | None = Field(default=None, ge=1)
    asset_id: str | None = Field(default=None, min_length=1, max_length=100)


class SavedTaskError(ValueError):
    def __init__(self, code: str, message: str, status_code: int = 422):
        self.code, self.status_code = code, status_code
        super().__init__(message)


def _row(row) -> dict[str, Any]:
    return {
        "id": row["id"], "name": row["name"], "version": row["version"],
        "task": json_load(row["task_json"]), "created_at": row["created_at"],
    }


def save_task(task: ScreeningTaskRevision, *, name: str, asset_id: str | None = None,
              request_id: str | None = None, _connection: sqlite3.Connection | None = None) -> dict[str, Any]:
    name = name.strip()
    if not name or len(name) > 120:
        raise SavedTaskError("invalid_name", "方案名称不能为空且最多120个字符。")
    try:
        validate_executable_task(task)
    except ValueError as exc:
        raise SavedTaskError("task_incomplete", str(exc)) from exc
    task_json = json_dump(task.model_dump(mode="json"))
    request_json = json_dump({"name": name, "asset_id": asset_id, "task": task.model_dump(mode="json")})
    with (nullcontext(_connection) if _connection is not None else connect()) as connection:
        if _connection is None:
            connection.execute("BEGIN IMMEDIATE")
        if request_id:
            previous = connection.execute(
                "SELECT * FROM saved_screening_task_requests WHERE request_id=?", (request_id,),
            ).fetchone()
            if previous:
                if previous["request_json"] != request_json:
                    raise SavedTaskError("save_request_conflict", "相同保存请求不能更改名称、条件或资产。", 409)
                row = connection.execute("SELECT * FROM saved_screening_tasks WHERE id=? AND version=?",
                                         (previous["asset_id"], previous["asset_version"])).fetchone()
                return {**_row(row), "idempotent_replay": True}
        asset_id = asset_id or str(uuid4())
        latest = connection.execute("SELECT * FROM saved_screening_tasks WHERE id=? ORDER BY version DESC LIMIT 1", (asset_id,)).fetchone()
        version = (latest["version"] + 1) if latest else 1
        replay = bool(latest and latest["task_json"] == task_json and latest["name"] == name)
        now = utc_now()
        if replay:
            row = latest
        else:
            connection.execute(
                "INSERT INTO saved_screening_tasks(id,name,version,task_json,created_at) VALUES(?,?,?,?,?)",
                (asset_id, name, version, task_json, now),
            )
            row = connection.execute("SELECT * FROM saved_screening_tasks WHERE id=? AND version=?", (asset_id, version)).fetchone()
        if request_id:
            connection.execute(
                "INSERT INTO saved_screening_task_requests VALUES(?,?,?,?,?)",
                (request_id, request_json, row["id"], row["version"], now),
            )
    return {**_row(row), "idempotent_replay": replay}


def get_task(asset_id: str, version: int | None = None) -> dict[str, Any]:
    with connect() as connection:
        row = connection.execute(
            "SELECT * FROM saved_screening_tasks WHERE id=? AND (? IS NULL OR version=?) ORDER BY version DESC LIMIT 1",
            (asset_id, version, version),
        ).fetchone()
    if not row:
        raise SavedTaskError("saved_task_not_found", "找不到已保存的筛选任务。", 404)
    return _row(row)


def list_tasks(include_history: bool = False, limit: int = 100) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 200))
    query = (
        "SELECT * FROM saved_screening_tasks ORDER BY created_at DESC,id,version DESC LIMIT ?"
        if include_history else
        """SELECT s.* FROM saved_screening_tasks s
           JOIN (SELECT id,MAX(version) AS version FROM saved_screening_tasks GROUP BY id) latest
             ON latest.id=s.id AND latest.version=s.version
           ORDER BY s.created_at DESC,s.id LIMIT ?"""
    )
    with connect() as connection:
        rows = connection.execute(query, (limit,)).fetchall()
    return [_row(row) for row in rows]


def reuse_task(
    task: dict[str, Any], *, conversation_id: str, base_revision: int,
) -> ScreeningTaskRevision:
    current = ScreeningTaskRevision.model_validate(task)
    return current.model_copy(update={
        "task_id": conversation_id,
        "revision": base_revision + 1,
        "original_user_messages": list(current.original_user_messages),
    })
