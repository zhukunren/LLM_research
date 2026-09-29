from __future__ import annotations

from contextlib import contextmanager, nullcontext
from datetime import UTC, datetime, timedelta
import sqlite3
from threading import Event, Thread

from typing import Any
from uuid import uuid4

from .db import connect, json_dump, json_load, utc_now
from .execution_policy import denies_execution
from .screening_contracts import ConversationSourceReference, ScreeningTaskRevision


class ConversationNotFound(KeyError):
    pass


class ConversationConflict(ValueError):
    pass


class ConversationStoreError(ValueError):
    pass


TURN_LEASE_SECONDS = 90


def _lease_cutoff() -> str:
    return (datetime.now(UTC) - timedelta(seconds=TURN_LEASE_SECONDS)).isoformat(timespec="seconds")


def _fail_running_turn(connection, conversation_id: str, turn_id: str, message: str, code: str) -> bool:
    """Release only this running turn, independently of task revision mutations."""
    now = utc_now()
    result = json_dump({"runtime": "codex", "error_code": code, "ready_to_execute": False,
                        "execution_authorized": False})
    changed = connection.execute(
        """UPDATE conversation_turns SET state='failed',response_text=?,result_json=?,updated_at=?
           WHERE id=? AND conversation_id=? AND state='running'""",
        (message, result, now, turn_id, conversation_id),
    ).rowcount
    if not changed:
        return False
    connection.execute(
        """INSERT INTO conversation_messages(id,conversation_id,role,content,client_message_id,created_at)
           VALUES(?,?,'assistant',?,?,?)""",
        (str(uuid4()), conversation_id, message, f"assistant:{turn_id}", now),
    )
    connection.execute(
        "UPDATE conversations SET pending_execute_message_id=NULL,updated_at=? WHERE id=?",
        (now, conversation_id),
    )
    return True


def fail_turn(conversation_id: str, turn_id: str, message: str) -> bool:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        return _fail_running_turn(connection, conversation_id, turn_id,
                                  message.strip() or "本次处理失败，请重试。", "runtime_failed")


def recover_expired_turns() -> int:
    cutoff = _lease_cutoff()
    with connect() as connection:
        # Most reads have nothing to recover and need no write lock.
        expired = connection.execute(
            "SELECT 1 FROM conversation_turns WHERE state='running' AND updated_at<=? LIMIT 1", (cutoff,),
        ).fetchone()
        if not expired:
            return 0
        connection.execute("BEGIN IMMEDIATE")
        rows = connection.execute(
            "SELECT id,conversation_id FROM conversation_turns WHERE state='running' AND updated_at<=?", (cutoff,),
        ).fetchall()
        return sum(_fail_running_turn(connection, row["conversation_id"], row["id"],
            "上次处理已中断，已保存的条件仍保留。请重新处理或继续描述要求。", "turn_interrupted") for row in rows)


def heartbeat_turn(conversation_id: str, turn_id: str) -> bool:
    with connect() as connection:
        return bool(connection.execute(
            """UPDATE conversation_turns SET updated_at=?
               WHERE id=? AND conversation_id=? AND state='running' AND updated_at>?""",
            (utc_now(), turn_id, conversation_id, _lease_cutoff()),
        ).rowcount)


@contextmanager
def keep_turn_alive(conversation_id: str, turn_id: str):
    stop = Event()

    def heartbeat():
        while not stop.wait(15):
            try:
                if not heartbeat_turn(conversation_id, turn_id):
                    return
            except sqlite3.Error:
                return  # Expiration prevents a disconnected processor publishing later.

    thread = Thread(target=heartbeat, name="conversation-heartbeat", daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=1)


def create_conversation(entry_scope: str) -> dict[str, Any]:
    conversation_id = str(uuid4())
    now = utc_now()
    with connect() as connection:
        connection.execute(
            "INSERT INTO conversations(id, entry_scope, created_at, updated_at) VALUES(?,?,?,?)",
            (conversation_id, entry_scope, now, now),
        )
    return {
        "id": conversation_id,
        "task_id": conversation_id,
        "entry_scope": entry_scope,
        "task_revision": 0,
        "active_run_id": None,
        "state": "active",
        "created_at": now,
        "updated_at": now,
    }


def list_conversations(entry_scope: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    recover_expired_turns()
    limit = max(1, min(int(limit), 100))
    with connect() as connection:
        rows = connection.execute(
            """SELECT c.id,c.entry_scope,c.task_revision,c.active_run_id,c.state,c.created_at,c.updated_at,
                      (SELECT substr(m.content,1,120) FROM conversation_messages m
                       WHERE m.conversation_id=c.id AND m.role='user'
                       ORDER BY m.rowid LIMIT 1) AS title,
                      (SELECT t.state FROM conversation_turns t WHERE t.conversation_id=c.id ORDER BY t.rowid DESC LIMIT 1) AS last_turn_state
               FROM conversations c
               WHERE (? IS NULL OR c.entry_scope=?)
               ORDER BY c.updated_at DESC,c.id DESC LIMIT ?""",
            (entry_scope, entry_scope, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def _message_payload(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "role": row["role"],
        "content": row["content"],
        "source_refs": json_load(row["source_refs_json"]),
        "created_at": row["created_at"],
    }


def _freeze_source_refs(
    connection,
    conversation_id: str,
    references: list[ConversationSourceReference],
) -> list[dict[str, Any]]:
    frozen = []
    seen = set()
    for reference in references:
        source_id = reference.source_id.upper() if reference.kind == "security" else reference.source_id
        key = (reference.kind, source_id, reference.page_number, reference.version)
        if key in seen:
            raise ConversationStoreError("同一条消息不能重复附加相同来源")
        seen.add(key)

        if reference.kind == "report_page":
            row = connection.execute(
                """SELECT d.id,d.sha256,d.title,d.available_at,d.available_at_status,
                          d.stock_code,d.stock_code_status,p.page_number
                   FROM documents d JOIN document_pages p ON p.document_id=d.id
                   WHERE d.id=? AND p.page_number=?""",
                (source_id, reference.page_number),
            ).fetchone()
            if not row:
                raise ConversationStoreError("研报来源或页码不存在")
            frozen.append({
                "kind": "report_page",
                "source_id": row["id"],
                "source_sha256": row["sha256"],
                "title": row["title"],
                "page_number": row["page_number"],
                "available_at": row["available_at"],
                "availability_status": row["available_at_status"],
                "stock_code": row["stock_code"],
                "security_binding_status": row["stock_code_status"],
            })
        elif reference.kind == "news_item":
            row = connection.execute("SELECT id,title,version,available_at,stock_codes_json FROM news_records WHERE id=?", (source_id,)).fetchone()
            if not row:
                raise ConversationStoreError("资讯来源不存在")
            frozen.append(dict(kind="news_item", source_id=row["id"], title=row["title"],
                               version=row["version"], available_at=row["available_at"], stock_codes=json_load(row["stock_codes_json"])))
        elif reference.kind == "screening_run":
            row = connection.execute(
                "SELECT id,as_of,status FROM screening_runs WHERE id=?",
                (source_id,),
            ).fetchone()
            if not row:
                raise ConversationStoreError("筛选记录来源不存在")
            frozen.append({"kind": "screening_run", "source_id": row["id"], "as_of": row["as_of"], "status": row["status"]})
        elif reference.kind == "security":
            frozen.append({"kind": "security", "source_id": source_id})
        else:
            table = "patterns" if reference.kind == "pattern" else "filters"
            row = connection.execute(
                f"SELECT id,version FROM {table} WHERE id=? AND version=?",
                (source_id, reference.version),
            ).fetchone()
            if not row:
                raise ConversationStoreError("已保存条件或形态来源版本不存在")
            frozen.append({
                "kind": reference.kind,
                "source_id": row["id"],
                "version": row["version"],
            })
    return frozen


def get_conversation(conversation_id: str, message_limit: int = 100) -> dict[str, Any]:
    recover_expired_turns()
    message_limit = max(1, min(int(message_limit), 100))
    with connect() as connection:
        conversation = connection.execute(
            "SELECT * FROM conversations WHERE id=?", (conversation_id,)
        ).fetchone()
        if not conversation:
            raise ConversationNotFound(conversation_id)
        messages = connection.execute(
            """SELECT id,role,content,source_refs_json,created_at,order_id FROM (
                   SELECT *,rowid AS order_id FROM conversation_messages
                   WHERE conversation_id=?
                   ORDER BY rowid DESC LIMIT ?
               ) ORDER BY order_id""",
            (conversation_id, message_limit),
        ).fetchall()
        turns = connection.execute(
            """SELECT id,user_message_id,base_revision,state,response_text,result_json,created_at,updated_at
               FROM conversation_turns WHERE conversation_id=?
               ORDER BY rowid DESC LIMIT 20""",
            (conversation_id,),
        ).fetchall()

    return {
        "id": conversation["id"],
        "task_id": conversation["id"],
        "entry_scope": conversation["entry_scope"],
        "task_revision": conversation["task_revision"],
        "active_run_id": conversation["active_run_id"],
        "pending_execution": conversation["pending_execute_message_id"] is not None,
        "state": conversation["state"],
        "created_at": conversation["created_at"],
        "updated_at": conversation["updated_at"],
        "messages": [_message_payload(row) for row in messages],
        "turns": [
            {
                "id": row["id"],
                "user_message_id": row["user_message_id"],
                "base_revision": row["base_revision"],
                "state": row["state"],
                "response_text": row["response_text"],
                "result": json_load(row["result_json"]),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in turns
        ],
    }


def add_user_message(
    conversation_id: str,
    client_message_id: str,
    base_revision: int,
    content: str,
    source_refs: list[ConversationSourceReference] | None = None,
    *,
    _connection: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    if _connection is None:
        recover_expired_turns()
    with (nullcontext(_connection) if _connection is not None else connect()) as connection:
        if _connection is None:
            connection.execute("BEGIN IMMEDIATE")
        conversation = connection.execute(
            "SELECT task_revision,state FROM conversations WHERE id=?", (conversation_id,)
        ).fetchone()
        if not conversation:
            raise ConversationNotFound(conversation_id)
        if conversation["state"] != "active":
            raise ConversationConflict("此对话已归档，不能继续修改")
        frozen_sources = _freeze_source_refs(connection, conversation_id, source_refs or [])
        source_refs_json = json_dump(frozen_sources)

        existing = connection.execute(
            """SELECT m.id AS message_id,m.content AS content,m.source_refs_json AS source_refs_json,t.id AS turn_id,
                      t.base_revision AS base_revision,t.state AS state
               FROM conversation_messages m
               JOIN conversation_turns t ON t.user_message_id=m.id
               WHERE m.conversation_id=? AND m.role='user' AND m.client_message_id=?""",
            (conversation_id, client_message_id),
        ).fetchone()
        if existing:
            if (
                existing["content"] != content
                or existing["source_refs_json"] != source_refs_json
                or existing["base_revision"] != base_revision
            ):
                raise ConversationConflict("相同消息ID不能提交不同内容、来源或条件版本")
            return {
                "message_id": existing["message_id"],
                "turn_id": existing["turn_id"],
                "base_revision": existing["base_revision"],
                "state": existing["state"],
                "source_refs": json_load(existing["source_refs_json"]),
                "idempotent_replay": True,
            }
        if base_revision != conversation["task_revision"]:
            raise ConversationConflict(
                f"当前条件已更新到版本 {conversation['task_revision']}，请先读取最新版本"
            )
        active_turn = connection.execute(
            """SELECT id FROM conversation_turns
               WHERE conversation_id=? AND state IN ('awaiting_agent','running') LIMIT 1""",
            (conversation_id,),
        ).fetchone()
        if active_turn:
            raise ConversationConflict("上一条消息仍在处理，请等待完成后再继续")

        now = utc_now()
        message_id, turn_id = str(uuid4()), str(uuid4())
        connection.execute(
            """INSERT INTO conversation_messages(
                   id,conversation_id,role,content,client_message_id,source_refs_json,created_at
               ) VALUES(?,?,'user',?,?,?,?)""",
            (message_id, conversation_id, content, client_message_id, source_refs_json, now),
        )
        connection.execute(
            """INSERT INTO conversation_turns(
                   id,conversation_id,user_message_id,base_revision,state,created_at,updated_at
               ) VALUES(?,?,?,?,'awaiting_agent',?,?)""",
            (turn_id, conversation_id, message_id, base_revision, now, now),
        )
        connection.execute(
            """UPDATE conversations SET updated_at=?,
               pending_execute_message_id=CASE WHEN ? THEN NULL ELSE pending_execute_message_id END WHERE id=?""",
            (now, denies_execution(content), conversation_id),
        )
        return {
            "message_id": message_id,
            "turn_id": turn_id,
            "base_revision": base_revision,
            "state": "awaiting_agent",
            "source_refs": frozen_sources,
            "idempotent_replay": False,
        }


def get_turn(conversation_id: str, turn_id: str) -> dict[str, Any]:
    recover_expired_turns()
    with connect() as connection:
        row = connection.execute(
            """SELECT id,conversation_id,user_message_id,base_revision,state,response_text,result_json,
                      created_at,updated_at
               FROM conversation_turns WHERE id=? AND conversation_id=?""",
            (turn_id, conversation_id),
        ).fetchone()
    if not row:
        raise ConversationNotFound(turn_id)
    return {
        "id": row["id"],
        "conversation_id": row["conversation_id"],
        "user_message_id": row["user_message_id"],
        "base_revision": row["base_revision"],
        "state": row["state"],
        "response_text": row["response_text"],
        "result": json_load(row["result_json"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def get_pending_execute_message(conversation_id: str) -> str | None:
    with connect() as connection:
        row = connection.execute(
            "SELECT pending_execute_message_id FROM conversations WHERE id=?",
            (conversation_id,),
        ).fetchone()
    if not row:
        raise ConversationNotFound(conversation_id)
    return row[0]


def set_pending_execute_message(
    conversation_id: str,
    expected_revision: int,
    message_id: str,
) -> None:
    """Record a server-checked execution grant for the current user message."""
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        conversation = connection.execute(
            "SELECT task_revision,state FROM conversations WHERE id=?", (conversation_id,)
        ).fetchone()
        if not conversation:
            raise ConversationNotFound(conversation_id)
        if conversation["state"] != "active":
            raise ConversationConflict("此对话已归档，不能授予执行授权")
        if conversation["task_revision"] != expected_revision:
            raise ConversationConflict("任务版本已经变化，请重新读取当前研究状态")
        source = connection.execute(
            """SELECT id FROM conversation_messages
               WHERE id=? AND conversation_id=? AND role='user'""",
            (message_id, conversation_id),
        ).fetchone()
        if not source:
            raise ConversationStoreError("执行授权必须绑定当前对话中的用户消息")
        connection.execute(
            "UPDATE conversations SET pending_execute_message_id=?,updated_at=? WHERE id=?",
            (message_id, utc_now(), conversation_id),
        )


def clear_pending_execute_message(conversation_id: str, expected_revision: int) -> None:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        conversation = connection.execute(
            "SELECT task_revision,state FROM conversations WHERE id=?", (conversation_id,)
        ).fetchone()
        if not conversation:
            raise ConversationNotFound(conversation_id)
        if conversation["state"] != "active":
            raise ConversationConflict("此对话已归档，不能撤销执行授权")
        if conversation["task_revision"] != expected_revision:
            raise ConversationConflict("任务版本已经变化，请重新读取当前研究状态")
        connection.execute(
            "UPDATE conversations SET pending_execute_message_id=NULL,updated_at=? WHERE id=?",
            (utc_now(), conversation_id),
        )


def get_user_message(conversation_id: str, message_id: str) -> dict[str, Any]:
    with connect() as connection:
        row = connection.execute(
            """SELECT id,role,content,source_refs_json,created_at
               FROM conversation_messages WHERE id=? AND conversation_id=? AND role='user'""",
            (message_id, conversation_id),
        ).fetchone()
    if not row:
        raise ConversationNotFound(message_id)
    return _message_payload(row)


def start_turn(conversation_id: str, turn_id: str) -> dict[str, Any]:
    """Atomically claim a queued conversation turn for one processor."""
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        conversation = connection.execute(
            "SELECT task_revision,state FROM conversations WHERE id=?", (conversation_id,)
        ).fetchone()
        turn = connection.execute(
            """SELECT id,base_revision,state FROM conversation_turns
               WHERE id=? AND conversation_id=?""",
            (turn_id, conversation_id),
        ).fetchone()
        if not conversation or not turn:
            raise ConversationNotFound(turn_id)
        if conversation["state"] != "active":
            raise ConversationConflict("对话已归档，不能处理回合")
        if turn["state"] != "awaiting_agent":
            raise ConversationConflict("此回合已被领取或已经结束")
        if turn["base_revision"] != conversation["task_revision"]:
            raise ConversationConflict("处理期间条件版本已变化，请基于最新版本重新提交")
        now = utc_now()
        connection.execute(
            "UPDATE conversation_turns SET state='running',updated_at=? WHERE id=?",
            (now, turn_id),
        )
        connection.execute(
            "UPDATE conversations SET updated_at=? WHERE id=?", (now, conversation_id)
        )
        return {"id": turn_id, "base_revision": turn["base_revision"], "state": "running"}


def finish_turn(
    conversation_id: str,
    turn_id: str,
    expected_task_revision: int,
    state: str,
    response_text: str,
    result: dict[str, Any],
    pending_execute_message_id: str | None = None,
    *,
    _connection: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    if state not in {"awaiting_user", "succeeded", "failed"}:
        raise ConversationStoreError("对话回合终态无效")
    if not response_text.strip():
        raise ConversationStoreError("助手回合必须生成可见回复")
    result_json = json_dump(result)

    with (nullcontext(_connection) if _connection is not None else connect()) as connection:
        if _connection is None:
            connection.execute("BEGIN IMMEDIATE")
        conversation = connection.execute(
            "SELECT task_revision,state FROM conversations WHERE id=?",
            (conversation_id,),
        ).fetchone()
        if not conversation:
            raise ConversationNotFound(conversation_id)
        if conversation["state"] != "active":
            raise ConversationConflict("对话已归档，不能发布回合结果")
        if conversation["task_revision"] != expected_task_revision:
            raise ConversationConflict("处理期间条件版本发生变化，助手结果未发布")
        turn = connection.execute(
            "SELECT state,response_text,result_json,updated_at FROM conversation_turns WHERE id=? AND conversation_id=?",
            (turn_id, conversation_id),
        ).fetchone()
        if not turn:
            raise ConversationNotFound(turn_id)

        assistant_message_key = f"assistant:{turn_id}"
        previous_message = connection.execute(
            """SELECT id,content FROM conversation_messages
               WHERE conversation_id=? AND role='assistant' AND client_message_id=?""",
            (conversation_id, assistant_message_key),
        ).fetchone()
        if turn["state"] in {"awaiting_user", "succeeded", "failed", "cancelled"}:
            if (
                turn["state"] == state
                and turn["response_text"] == response_text
                and turn["result_json"] == result_json
                and previous_message
                and previous_message["content"] == response_text
            ):
                return {"turn_id": turn_id, "state": state, "idempotent_replay": True}
            raise ConversationConflict("对话回合已结束，结果不能覆盖")
        if turn["state"] not in {"awaiting_agent", "running"}:
            raise ConversationConflict("对话回合当前不能完成")
        if turn["state"] == "running" and turn["updated_at"] <= _lease_cutoff():
            raise ConversationConflict("对话回合已中断，迟到结果不能发布")
        if pending_execute_message_id is not None:
            source = connection.execute(
                """SELECT 1 FROM conversation_messages
                   WHERE id=? AND conversation_id=? AND role='user'""",
                (pending_execute_message_id, conversation_id),
            ).fetchone()
            if not source:
                raise ConversationStoreError("待执行授权必须引用同一对话内的用户消息")

        now = utc_now()
        if previous_message:
            if previous_message["content"] != response_text:
                raise ConversationConflict("助手回合已存在不同的不可变消息")
        else:
            connection.execute(
                """INSERT INTO conversation_messages(
                       id,conversation_id,role,content,client_message_id,source_refs_json,created_at
                   ) VALUES(?,?,'assistant',?,?,'[]',?)""",
                (str(uuid4()), conversation_id, response_text, assistant_message_key, now),
            )
        connection.execute(
            """UPDATE conversation_turns
               SET state=?,response_text=?,result_json=?,updated_at=?
               WHERE id=? AND conversation_id=?""",
            (state, response_text, result_json, now, turn_id, conversation_id),
        )
        connection.execute(
            """UPDATE conversations
               SET pending_execute_message_id=?,updated_at=?
               WHERE id=?""",
            (pending_execute_message_id, now, conversation_id),
        )
        return {"turn_id": turn_id, "state": state, "idempotent_replay": False}


def save_task_revision(
    conversation_id: str,
    base_revision: int,
    source_message_id: str,
    candidate: ScreeningTaskRevision,
    *,
    _connection: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    if candidate.task_id != conversation_id or candidate.revision != base_revision + 1:
        raise ConversationStoreError("条件修订必须属于当前对话，并且版本号必须递增1")
    task_json = json_dump(candidate.model_dump(mode="json"))

    with (nullcontext(_connection) if _connection is not None else connect()) as connection:
        if _connection is None:
            connection.execute("BEGIN IMMEDIATE")
        conversation = connection.execute(
            "SELECT task_revision,state FROM conversations WHERE id=?", (conversation_id,)
        ).fetchone()
        if not conversation:
            raise ConversationNotFound(conversation_id)
        if conversation["state"] != "active":
            raise ConversationConflict("此对话已归档，不能修改条件")
        source = connection.execute(
            """SELECT id FROM conversation_messages
               WHERE id=? AND conversation_id=? AND role='user'""",
            (source_message_id, conversation_id),
        ).fetchone()
        if not source:
            raise ConversationStoreError("条件修订必须引用当前对话中的用户消息")
        latest_user_message = connection.execute(
            """SELECT id FROM conversation_messages
               WHERE conversation_id=? AND role='user'
               ORDER BY rowid DESC LIMIT 1""",
            (conversation_id,),
        ).fetchone()
        if latest_user_message["id"] != source_message_id:
            raise ConversationStoreError("条件修订必须引用本对话最新用户消息")

        if conversation["task_revision"] == base_revision + 1:
            existing = connection.execute(
                """SELECT source_message_id,task_json FROM screening_task_revisions
                   WHERE conversation_id=? AND revision=?""",
                (conversation_id, candidate.revision),
            ).fetchone()
            if (
                existing
                and existing["source_message_id"] == source_message_id
                and existing["task_json"] == task_json
            ):
                return {
                    "conversation_id": conversation_id,
                    "revision": candidate.revision,
                    "task": json_load(task_json),
                    "idempotent_replay": True,
                }
        if conversation["task_revision"] != base_revision:
            raise ConversationConflict(
                f"当前条件已更新到版本 {conversation['task_revision']}，请基于该版本重新修改"
            )

        now = utc_now()
        connection.execute(
            """INSERT INTO screening_task_revisions(
                   conversation_id,revision,source_message_id,task_json,created_at
               ) VALUES(?,?,?,?,?)""",
            (conversation_id, candidate.revision, source_message_id, task_json, now),
        )
        connection.execute(
            "UPDATE conversations SET task_revision=?,updated_at=? WHERE id=?",
            (candidate.revision, now, conversation_id),
        )
        return {
            "conversation_id": conversation_id,
            "revision": candidate.revision,
            "task": json_load(task_json),
            "idempotent_replay": False,
        }


def get_task_revision(conversation_id: str, revision: int) -> ScreeningTaskRevision:
    with connect() as connection:
        row = connection.execute(
            """SELECT task_json FROM screening_task_revisions
               WHERE conversation_id=? AND revision=?""",
            (conversation_id, revision),
        ).fetchone()
    if not row:
        raise ConversationNotFound(f"{conversation_id}:{revision}")
    return ScreeningTaskRevision.model_validate(json_load(row["task_json"]))
