"""Idempotent, recoverable entry points for server-defined research tasks."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import logging
import sqlite3

from . import codex_runtime, conversation_store, research_assistants, research_turn_service
from .db import connect, json_dump, utc_now
from .screening_contracts import ResearchScope
from .settings import research_web_search_mode

logger = logging.getLogger(__name__)
SHANGHAI = timezone(timedelta(hours=8), name="Asia/Shanghai")


class LaunchError(research_assistants.AssistantError):
    def __init__(self, message: str, status: int = 503, **context):
        super().__init__(message, status)
        self.context = context


def shanghai_now() -> datetime:
    return datetime.now(SHANGHAI)


def _response(row, turn: dict, *, replay: bool) -> dict:
    job = turn.get("job") or {}
    return {
        "request_id": row["request_id"], "assistant_id": row["assistant_id"],
        "conversation_id": row["conversation_id"], "turn_id": row["turn_id"],
        "job_id": job.get("id"), "state": turn["state"], "job_state": job.get("state"),
        "as_of_date": row["as_of_date"], "started_at": row["started_at"], "timezone": row["timezone"],
        "assistant_revision": row["assistant_revision"], "skill_hash": row["skill_hash"],
        "idempotent_replay": replay,
    }


def launch_assistant(assistant_id: str, request_id: str, *, model_id: str | None = None,
                     reasoning_effort: str | None = None) -> dict:
    """Commit the request, conversation and frozen first turn together, then enqueue.

    Enqueue is independently idempotent. A crash after either commit resumes using
    the same request ID, without replaying a completed/cancelled/failed turn.
    """
    request = {"assistant_id": assistant_id, "model_id": model_id, "reasoning_effort": reasoning_effort}
    request_json = json_dump(request)
    request_hash = hashlib.sha256(request_json.encode("utf-8")).hexdigest()
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT * FROM research_assistant_launches WHERE request_id=?", (request_id,)).fetchone()
        replay = row is not None
        if row:
            if row["request_hash"] != request_hash:
                raise LaunchError("同一启动请求不能更换助手、模型或推理档位。", 409)
        else:
            chosen = research_assistants.selection_snapshot(connection, assistant_id)
            if chosen["launch_mode"] != "immediate":
                raise LaunchError("这个助手需要先输入研究问题。", 422)
            if research_web_search_mode() != "live":
                raise LaunchError("此助手需要实时网页检索。请启用实时检索后重试。")
            started = shanghai_now()
            as_of_date = started.date().isoformat()
            started_at = started.isoformat(timespec="seconds")
            prompt = chosen["default_prompt"].format(as_of_date=as_of_date)
            prompt += f"\n\n研究时间：{started_at}（Asia/Shanghai）。所有信息须在此时间之前已公开；研究截止日为 {as_of_date}。"
            conversation = conversation_store.create_conversation(
                "news", workflow_type="research", research_depth="standard", assistant_id=assistant_id,
                model_id=model_id, reasoning_effort=reasoning_effort, _connection=connection,
            )
            # Initial scope is installed before the first immutable turn snapshot.
            # It deliberately does not use the local stock file's historical date.
            scope = ResearchScope(as_of=started.date()).model_dump(mode="json")
            connection.execute("UPDATE conversations SET research_scope_json=? WHERE id=?", (json_dump(scope), conversation["id"]))
            turn = conversation_store.add_user_message(
                conversation["id"], "assistant-launch:" + request_id, 0, prompt,
                research_scope_revision=0, assistant_revision=0, _connection=connection,
            )
            now = utc_now()
            connection.execute(
                """INSERT INTO research_assistant_launches(
                       request_id,request_hash,request_json,assistant_id,assistant_revision,skill_hash,
                       conversation_id,turn_id,as_of_date,started_at,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (request_id, request_hash, request_json, assistant_id, chosen["revision"], chosen["skill_hash"],
                 conversation["id"], turn["turn_id"], as_of_date, started_at, now, now),
            )
            row = connection.execute("SELECT * FROM research_assistant_launches WHERE request_id=?", (request_id,)).fetchone()
        connection.execute("UPDATE research_assistant_launches SET launch_attempts=launch_attempts+1,updated_at=? WHERE request_id=?", (utc_now(), request_id))
    context = {"request_id": request_id, "assistant_id": assistant_id,
               "conversation_id": row["conversation_id"], "turn_id": row["turn_id"]}
    try:
        research_turn_service.enqueue_turn(row["conversation_id"], row["turn_id"])
        # Another caller may have queued the same turn after enqueue's first
        # read. Reload so every accepted launch returns the committed job ID.
        turn = conversation_store.get_turn(row["conversation_id"], row["turn_id"])
    except (codex_runtime.CodexRuntimeError, sqlite3.Error) as exc:
        # Persist a safe, actionable diagnostic. The original queued turn remains
        # available to both the existing process endpoint and this same request.
        message = str(exc) if isinstance(exc, codex_runtime.CodexRuntimeError) else "暂时无法加入研究队列，请重试。"
        with connect() as connection:
            connection.execute("UPDATE research_assistant_launches SET last_error=?,updated_at=? WHERE request_id=?", (message[:500], utc_now(), request_id))
        logger.warning("Research assistant launch pending: %s", context)
        raise LaunchError(message, recoverable=True, **context) from exc
    with connect() as connection:
        connection.execute("UPDATE research_assistant_launches SET last_error=NULL,updated_at=? WHERE request_id=?", (utc_now(), request_id))
    result = _response(row, turn, replay=replay)
    logger.info("Research assistant launch: %s", result)
    return result
