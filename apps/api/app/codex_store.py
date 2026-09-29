from __future__ import annotations

import json
from typing import Any

from .db import connect, json_dump, json_load, utc_now


def get_thread(conversation_id: str) -> dict[str, Any] | None:
    with connect() as connection:
        row = connection.execute(
            """SELECT conversation_id,thread_id,model,runtime_version,created_at,updated_at
               FROM codex_threads WHERE conversation_id=?""",
            (conversation_id,),
        ).fetchone()
    return dict(row) if row else None


def bind_thread(
    conversation_id: str,
    thread_id: str,
    model: str,
    runtime_version: str | None,
) -> dict[str, Any]:
    now = utc_now()
    with connect() as connection:
        connection.execute(
            """INSERT INTO codex_threads(conversation_id,thread_id,model,runtime_version,created_at,updated_at)
               VALUES(?,?,?,?,?,?)
               ON CONFLICT(conversation_id) DO UPDATE SET
                 thread_id=excluded.thread_id,
                 model=excluded.model,
                 runtime_version=excluded.runtime_version,
                 updated_at=excluded.updated_at""",
            (conversation_id, thread_id, model, runtime_version, now, now),
        )
        row = connection.execute(
            """SELECT conversation_id,thread_id,model,runtime_version,created_at,updated_at
               FROM codex_threads WHERE conversation_id=?""",
            (conversation_id,),
        ).fetchone()
    return dict(row)


def append_event(
    conversation_id: str,
    app_turn_id: str,
    codex_thread_id: str,
    codex_turn_id: str | None,
    sequence: int,
    method: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    if sequence < 0:
        raise ValueError("Codex event sequence cannot be negative")
    payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(payload_json.encode("utf-8")) > 256 * 1024:
        payload = {"truncated": True, "method": method}
        payload_json = json_dump(payload)
    now = utc_now()
    with connect() as connection:
        connection.execute(
            """INSERT INTO codex_turn_events(
                   conversation_id,app_turn_id,codex_thread_id,codex_turn_id,
                   sequence,method,payload_json,created_at
               ) VALUES(?,?,?,?,?,?,?,?)
               ON CONFLICT(app_turn_id,sequence) DO NOTHING""",
            (
                conversation_id,
                app_turn_id,
                codex_thread_id,
                codex_turn_id,
                sequence,
                method,
                payload_json,
                now,
            ),
        )
    return {
        "conversation_id": conversation_id,
        "app_turn_id": app_turn_id,
        "codex_thread_id": codex_thread_id,
        "codex_turn_id": codex_turn_id,
        "sequence": sequence,
        "method": method,
        "payload": payload,
        "created_at": now,
    }


def list_events(
    conversation_id: str,
    app_turn_id: str,
    after: int = -1,
    limit: int = 200,
) -> dict[str, Any]:
    after = max(-1, int(after))
    limit = max(1, min(int(limit), 500))
    with connect() as connection:
        rows = connection.execute(
            """SELECT sequence,method,payload_json,codex_thread_id,codex_turn_id,created_at
               FROM codex_turn_events
               WHERE conversation_id=? AND app_turn_id=? AND sequence>?
               ORDER BY sequence LIMIT ?""",
            (conversation_id, app_turn_id, after, limit + 1),
        ).fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [
        {
            "sequence": row["sequence"],
            "method": row["method"],
            "payload": json_load(row["payload_json"]),
            "codex_thread_id": row["codex_thread_id"],
            "codex_turn_id": row["codex_turn_id"],
            "created_at": row["created_at"],
        }
        for row in rows
    ]
    return {
        "items": items,
        "next_after": items[-1]["sequence"] if items else after,
        "has_more": has_more,
    }


def status(conversation_id: str, app_turn_id: str | None = None) -> dict[str, Any]:
    thread = get_thread(conversation_id)
    result: dict[str, Any] = {
        "available": thread is not None,
        "thread": thread,
        "last_event_sequence": None,
    }
    if app_turn_id:
        with connect() as connection:
            row = connection.execute(
                "SELECT MAX(sequence) AS sequence FROM codex_turn_events WHERE app_turn_id=?",
                (app_turn_id,),
            ).fetchone()
        result["last_event_sequence"] = row["sequence"] if row else None
    return result
