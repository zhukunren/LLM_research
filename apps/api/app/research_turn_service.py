"""Queue Codex turns independently of the browser's HTTP connection."""
from __future__ import annotations

import logging
from uuid import uuid4

from . import codex_runtime, conversation_store, screening_service
from .db import connect, json_dump, utc_now


logger = logging.getLogger(__name__)


def enqueue_turn(conversation_id: str, turn_id: str) -> dict:
    turn = conversation_store.get_turn(conversation_id, turn_id)
    with connect() as connection:
        existing = connection.execute(
            "SELECT job_id FROM research_turn_jobs WHERE turn_id=? AND conversation_id=?", (turn_id, conversation_id)
        ).fetchone()
    if existing or turn["state"] in {"succeeded", "awaiting_user", "failed", "cancelled"}:
        return turn
    available = codex_runtime.availability()
    if not available["available"]:
        raise codex_runtime.CodexRuntimeError(str(available["reason"]))
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        turn_row = connection.execute(
            """SELECT t.state,c.state AS conversation_state FROM conversation_turns t
               JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.id=?""",
            (turn_id, conversation_id),
        ).fetchone()
        existing = connection.execute("SELECT 1 FROM research_turn_jobs WHERE turn_id=?", (turn_id,)).fetchone()
        if not existing:
            if not turn_row or turn_row["state"] != "awaiting_agent" or turn_row["conversation_state"] != "active":
                raise conversation_store.ConversationConflict("此回合已被处理或已经结束")
            job_id, now = str(uuid4()), utc_now()
            connection.execute(
                """INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at,required_protocol)
                   VALUES(?,'research_turn',?,'queued','等待开始研究',?,?,'research-turn-v1')""",
                (job_id, json_dump({"conversation_id": conversation_id, "turn_id": turn_id}), now, now),
            )
            connection.execute(
                "INSERT INTO research_turn_jobs(turn_id,conversation_id,job_id,created_at) VALUES(?,?,?,?)",
                (turn_id, conversation_id, job_id, now),
            )
    return conversation_store.get_turn(conversation_id, turn_id)


def active(conversation_id: str, turn_id: str) -> bool:
    with connect() as connection:
        row = connection.execute(
            """SELECT j.state,j.lease_expires_at FROM research_turn_jobs r JOIN jobs j ON j.id=r.job_id
               WHERE r.turn_id=? AND r.conversation_id=?""", (turn_id, conversation_id)
        ).fetchone()
    return row is None or (row["state"] == "running" and row["lease_expires_at"] is not None and row["lease_expires_at"] > utc_now())


def execute_turn(lease) -> None:
    conversation_id, turn_id = lease.payload["conversation_id"], lease.payload["turn_id"]
    try:
        if not lease.active():
            return
        turn = conversation_store.get_turn(conversation_id, turn_id)
        if turn["state"] in {"succeeded", "awaiting_user", "failed", "cancelled"}:
            lease.finish("cancelled" if turn["state"] == "cancelled" else "failed" if turn["state"] == "failed" else "succeeded", "研究回合已结束")
            return
        conversation_store.start_turn(conversation_id, turn_id)
        turn = codex_runtime.process_conversation_turn(conversation_id, turn_id)
        if turn["result"].get("ready_to_execute") and lease.active():
            screening_service.enqueue_turn(conversation_id, turn_id)
        status = "cancelled" if turn["state"] == "cancelled" else "failed" if turn["state"] == "failed" else "succeeded"
        lease.finish(status, "研究已完成" if status == "succeeded" else "研究已结束")
    except Exception as exc:
        conversation_store.fail_turn(conversation_id, turn_id, str(exc), include_queued=True)
        lease.finish("failed", f"研究处理失败：{str(exc)[:500]}")
        logger.exception("Background research turn failed: %s", turn_id)
