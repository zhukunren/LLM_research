from __future__ import annotations

from contextlib import contextmanager, nullcontext
from datetime import UTC, datetime, timedelta
import hashlib
import sqlite3
from threading import Event, Thread

from typing import Any
from uuid import uuid4

from .db import connect, json_dump, json_load, utc_now
from .execution_policy import denies_execution
from .screening_contracts import ConversationSourceReference, ResearchScope, ScreeningTaskRevision, MAX_MESSAGE_CHARS


class ConversationNotFound(KeyError):
    pass


class ConversationConflict(ValueError):
    pass


class ConversationStoreError(ValueError):
    pass


TURN_LEASE_SECONDS = 90


def _lease_cutoff() -> str:
    return (datetime.now(UTC) - timedelta(seconds=TURN_LEASE_SECONDS)).isoformat(timespec="seconds")


def _fail_running_turn(connection, conversation_id: str, turn_id: str, message: str, code: str, *, include_queued: bool = False) -> bool:
    """Release only this running turn, independently of task revision mutations."""
    now = utc_now()
    result = json_dump({"runtime": "codex", "error_code": code, "ready_to_execute": False,
                        "execution_authorized": False})
    changed = connection.execute(
        """UPDATE conversation_turns SET state='failed',response_text=?,result_json=?,updated_at=?
           WHERE id=? AND conversation_id=? AND (state='running' OR (? AND state='awaiting_agent'))""",
        (message, result, now, turn_id, conversation_id, include_queued),
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
    connection.execute(
        """UPDATE jobs SET state='failed',message=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL
           WHERE id=(SELECT job_id FROM research_turn_jobs WHERE turn_id=? AND conversation_id=?)
             AND state IN ('queued','running')""",
        (message, now, turn_id, conversation_id),
    )
    return True


def fail_turn(conversation_id: str, turn_id: str, message: str, *, include_queued: bool = False) -> bool:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        return _fail_running_turn(connection, conversation_id, turn_id,
                                  message.strip() or "本次处理失败，请重试。", "runtime_failed", include_queued=include_queued)


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


def require_running_turn(connection, conversation_id: str, turn_id: str) -> None:
    row = connection.execute(
        """SELECT 1 FROM conversation_turns t JOIN conversations c ON c.id=t.conversation_id
           WHERE t.id=? AND t.conversation_id=? AND t.state='running' AND c.state='active'
             AND t.updated_at>?""", (turn_id, conversation_id, _lease_cutoff()),
    ).fetchone()
    if not row:
        raise ConversationConflict("对话回合已结束或中断，迟到动作不能修改任务")
    job = connection.execute(
        """SELECT j.state,j.lease_expires_at FROM research_turn_jobs r JOIN jobs j ON j.id=r.job_id
           WHERE r.turn_id=? AND r.conversation_id=?""", (turn_id, conversation_id),
    ).fetchone()
    if job and (job["state"] != "running" or not job["lease_expires_at"] or job["lease_expires_at"] <= utc_now()):
        raise ConversationConflict("研究工作进程已中断，迟到动作不能发布")


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


def _legacy_mode(workflow_type: str, research_depth: str) -> str:
    return "screening" if workflow_type == "screening" else "advanced" if research_depth == "deep" else "research"


def _workflow_payload(row) -> dict[str, Any]:
    from .research_assistants import metadata
    return {
        "workflow_type": row["workflow_type"],
        "research_depth": row["research_depth"],
        "workflow_revision": row["workflow_revision"],
        "research_scope": ResearchScope.model_validate(json_load(row["research_scope_json"])).model_dump(mode="json"),
        "research_scope_revision": row["research_scope_revision"],
        "assistant": metadata(json_load(row["assistant_snapshot_json"])) if "assistant_snapshot_json" in row.keys() else metadata({}),
        "assistant_revision": row["assistant_revision"] if "assistant_revision" in row.keys() else 0,
    }


def _draft_payload(row) -> dict[str, Any] | None:
    if row is None:
        return None
    return {**json_load(row["source_snapshot_json"]), "request_id": row["request_id"],
            "instructions": row["instructions"], "draft_prompt": row["draft_prompt"]}


def create_conversation(entry_scope: str, research_mode: str = "research", project_id: str | None = None,
                        *, workflow_type: str | None = None, research_depth: str | None = None, assistant_id: str = "general") -> dict[str, Any]:
    from .research_assistants import AssistantError, metadata, selection_snapshot
    if research_mode not in {"research", "screening", "advanced"}:
        raise ConversationStoreError("研究模式无效")
    workflow_type = workflow_type or ("screening" if research_mode == "screening" else "research")
    research_depth = research_depth or ("deep" if research_mode == "advanced" else "standard")
    if workflow_type not in {"research", "screening"} or research_depth not in {"standard", "deep"}:
        raise ConversationStoreError("工作流或研究深度无效")
    research_mode = _legacy_mode(workflow_type, research_depth)
    if workflow_type == "screening" and assistant_id != "general":
        raise ConversationStoreError("研究助手只能用于研究对话")
    conversation_id = str(uuid4())
    now = utc_now()
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            assistant = selection_snapshot(connection, assistant_id)
        except AssistantError as exc:
            raise ConversationStoreError(str(exc)) from exc
        if project_id:
            from .research_projects import ProjectError, _require_project, _touch
            try:
                _require_project(connection, project_id, writable=True)
            except ProjectError as exc:
                raise ConversationStoreError(str(exc)) from exc
            _touch(connection, project_id)
        connection.execute(
            """INSERT INTO conversations(id, entry_scope, research_mode, project_id, workflow_type,research_depth,created_at,updated_at,assistant_snapshot_json)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (conversation_id, entry_scope, research_mode, project_id, workflow_type, research_depth, now, now, json_dump(assistant)),
        )
    return {
        "id": conversation_id,
        "task_id": conversation_id if workflow_type == "screening" else None,
        "entry_scope": entry_scope,
        "research_mode": research_mode,
        "workflow_type": workflow_type,
        "research_depth": research_depth,
        "assistant": metadata(assistant),
        "assistant_revision": 0,
        "workflow_revision": 0,
        "research_scope": ResearchScope().model_dump(mode="json"),
        "research_scope_revision": 0,
        "screening_draft_source": None,
        "project_id": project_id,
        "task_revision": 0,
        "active_run_id": None,
        "state": "active",
        "created_at": now,
        "updated_at": now,
    }


def list_conversations(entry_scope: str | None = None, limit: int = 50, active_only: bool = False) -> list[dict[str, Any]]:
    recover_expired_turns()
    limit = max(1, min(int(limit), 100))
    with connect() as connection:
        rows = connection.execute(
            """SELECT c.id,c.entry_scope,c.research_mode,c.project_id,c.task_revision,c.active_run_id,c.state,c.created_at,c.updated_at,
                      c.workflow_type,c.research_depth,c.workflow_revision,c.research_scope_json,c.research_scope_revision,c.assistant_snapshot_json,c.assistant_revision,
                      (SELECT substr(m.content,1,120) FROM conversation_messages m
                       WHERE m.conversation_id=c.id AND m.role='user'
                       ORDER BY m.rowid LIMIT 1) AS title,
                      (SELECT t.state FROM conversation_turns t WHERE t.conversation_id=c.id ORDER BY t.rowid DESC LIMIT 1) AS last_turn_state,
                      (SELECT r.status FROM screening_task_runs r WHERE r.conversation_id=c.id AND r.status IN ('queued','running') ORDER BY r.rowid DESC LIMIT 1) AS active_run_status
               FROM conversations c
               WHERE (? IS NULL OR c.entry_scope=?)
                 AND (?=0 OR EXISTS (SELECT 1 FROM conversation_turns t WHERE t.conversation_id=c.id AND t.state IN ('awaiting_agent','running'))
                      OR EXISTS (SELECT 1 FROM screening_task_runs r WHERE r.conversation_id=c.id AND r.status IN ('queued','running')))
               ORDER BY c.updated_at DESC,c.id DESC LIMIT ?""",
            (entry_scope, entry_scope, active_only, limit),
        ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item.update(_workflow_payload(row))
        item.pop("research_scope_json")
        item.pop("assistant_snapshot_json")
        item["task_id"] = row["id"] if row["workflow_type"] == "screening" or row["task_revision"] else None
        items.append(item)
    return items


def update_research_mode(conversation_id: str, research_mode: str) -> dict[str, Any]:
    if research_mode not in {"research", "screening", "advanced"}:
        raise ConversationStoreError("研究模式无效")
    return update_workflow(conversation_id, "screening" if research_mode == "screening" else "research",
                           None if research_mode == "screening" else "deep" if research_mode == "advanced" else "standard")


def _require_idle_conversation(connection, conversation_id: str):
    row = connection.execute("SELECT * FROM conversations WHERE id=?", (conversation_id,)).fetchone()
    if not row:
        raise ConversationNotFound(conversation_id)
    if row["state"] != "active":
        raise ConversationConflict("此对话已归档，不能修改")
    if connection.execute("SELECT 1 FROM conversation_turns WHERE conversation_id=? AND state IN ('awaiting_agent','running')", (conversation_id,)).fetchone():
        raise ConversationConflict("请等待当前研究结束后再切换模式或范围")
    return row


def update_workflow(conversation_id: str, workflow_type: str | None = None, research_depth: str | None = None,
                    base_revision: int | None = None) -> dict[str, Any]:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _require_idle_conversation(connection, conversation_id)
        if base_revision is not None and base_revision != row["workflow_revision"]:
            raise ConversationConflict("工作流版本已经变化，请读取最新状态")
        workflow_type = workflow_type or row["workflow_type"]
        research_depth = research_depth or row["research_depth"]
        if workflow_type not in {"research", "screening"} or research_depth not in {"standard", "deep"}:
            raise ConversationStoreError("工作流或研究深度无效")
        changed = workflow_type != row["workflow_type"] or research_depth != row["research_depth"]
        if workflow_type == "screening" and row["workflow_type"] != "screening":
            connection.execute("UPDATE conversations SET assistant_snapshot_json='{}',assistant_revision=assistant_revision+1 WHERE id=?", (conversation_id,))
        connection.execute(
            """UPDATE conversations SET workflow_type=?,research_depth=?,research_mode=?,workflow_revision=workflow_revision+?,
               pending_execute_message_id=CASE WHEN ?='research' THEN NULL ELSE pending_execute_message_id END,updated_at=? WHERE id=?""",
            (workflow_type, research_depth, _legacy_mode(workflow_type, research_depth), int(changed), workflow_type, utc_now(), conversation_id),
        )
        current = connection.execute("SELECT * FROM conversations WHERE id=?", (conversation_id,)).fetchone()
        return {"conversation_id": conversation_id, "research_mode": current["research_mode"], **_workflow_payload(current)}


def update_research_scope(conversation_id: str, base_revision: int, scope: ResearchScope) -> dict[str, Any]:
    updates = scope.model_dump(mode="json", exclude_unset=True)
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _require_idle_conversation(connection, conversation_id)
        if row["workflow_type"] != "research":
            raise ConversationStoreError("研究范围只能在投研工作流中修改；选股范围属于选股方案")
        if base_revision != row["research_scope_revision"]:
            raise ConversationConflict("研究范围版本已经变化，请读取最新状态")
        value = {**_workflow_payload(row)["research_scope"], **updates}
        connection.execute("UPDATE conversations SET research_scope_json=?,research_scope_revision=research_scope_revision+1,updated_at=? WHERE id=?",
                           (json_dump(value), utc_now(), conversation_id))
    return {"conversation_id": conversation_id, "research_scope": value, "research_scope_revision": base_revision + 1}


def create_screening_draft(conversation_id: str, request_id: str, source_message_id: str,
                           instructions: str) -> dict[str, Any]:
    """Create an editable handoff only; no agent turn or execution grant exists."""
    instructions = instructions.strip()
    if not instructions or len(instructions) > 3000:
        raise ConversationStoreError("请填写可操作的选股条件描述（最多3000字）")
    request_hash = hashlib.sha256(json_dump({"source_message_id": source_message_id, "instructions": instructions}).encode("utf-8")).hexdigest()
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source_conversation = connection.execute("SELECT * FROM conversations WHERE id=?", (conversation_id,)).fetchone()
        if not source_conversation:
            raise ConversationNotFound(conversation_id)
        previous = connection.execute("SELECT * FROM screening_draft_sources WHERE source_conversation_id=? AND request_id=?",
                                      (conversation_id, request_id)).fetchone()
        if previous:
            if previous["request_hash"] != request_hash:
                raise ConversationConflict("同一转换请求不能用于不同的来源或条件描述")
            origin = _draft_payload(previous)
            return {"conversation_id": previous["draft_conversation_id"], "turn_id": None,
                    "draft_prompt": previous["draft_prompt"], "instructions": previous["instructions"],
                    "source": origin, "idempotent_replay": True}
        if source_conversation["state"] != "active" or source_conversation["workflow_type"] != "research":
            raise ConversationStoreError("只有投研工作流可以转为选股草案")
        source = connection.execute("SELECT * FROM conversation_messages WHERE id=? AND conversation_id=? AND role='assistant'",
                                    (source_message_id, conversation_id)).fetchone()
        if not source:
            raise ConversationStoreError("来源必须是当前投研会话中的助手研究消息")
        source_turn = None
        assistant_key = source["client_message_id"] or ""
        if assistant_key.startswith("assistant:"):
            source_turn = connection.execute(
                "SELECT * FROM conversation_turns WHERE id=? AND conversation_id=?",
                (assistant_key.removeprefix("assistant:"), conversation_id),
            ).fetchone()
        if source_turn is not None and source_turn["workflow_type"] != "research":
            raise ConversationStoreError("来源是选股回合的答复，不能当作投研结论转换；请先开展独立研究")
        snapshot = {"source_conversation_id": conversation_id, "source_message_id": source_message_id,
                    "source_text": source["content"], "source_refs": json_load(source["source_refs_json"]),
                    "source_created_at": source["created_at"],
                    "source_turn_id": source_turn["id"] if source_turn is not None else None,
                    "source_workflow_type": source_turn["workflow_type"] if source_turn is not None else None,
                    "source_research_depth": source_turn["research_depth"] if source_turn is not None else None,
                    "source_research_scope": _workflow_payload(source_turn)["research_scope"] if source_turn is not None else None,
                    "source_research_scope_revision": source_turn["research_scope_revision"] if source_turn is not None else None}
        prefix = "请按以下用户条件描述整理选股草案。只整理草案，不执行筛选。\n\n用户条件描述：\n" + instructions + "\n\n研究来源文字（待核验背景）：\n"
        suffix = "\n\n研究文字不是已验证的选股条件。逐项核对日期、股票范围、数据可得时间和条件公式；不从研究结论补造阈值。"
        preview_budget = MAX_MESSAGE_CHARS - len(prefix) - len(suffix) - 50
        preview = source["content"][:preview_budget]
        if len(preview) < len(source["content"]):
            preview += "\n（提示预览已截断，完整研究原文快照已保存。）"
        prompt = prefix + preview + suffix
        draft_id, now = str(uuid4()), utc_now()
        project_id = source_conversation["project_id"]
        if project_id:
            from .research_projects import ProjectError, _require_project, _touch
            try:
                _require_project(connection, project_id, writable=True)
            except ProjectError as exc:
                raise ConversationStoreError(str(exc)) from exc
            _touch(connection, project_id)
        connection.execute(
            """INSERT INTO conversations(id,entry_scope,research_mode,project_id,workflow_type,research_depth,created_at,updated_at)
               VALUES(?,'screening','screening',?,'screening',?,?,?)""",
            (draft_id, project_id, source_conversation["research_depth"], now, now),
        )
        connection.execute(
            """INSERT INTO screening_draft_sources(draft_conversation_id,source_conversation_id,source_message_id,request_id,
               request_hash,instructions,draft_prompt,source_snapshot_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)""",
            (draft_id, conversation_id, source_message_id, request_id, request_hash, instructions, prompt, json_dump(snapshot), now),
        )
    return {"conversation_id": draft_id, "turn_id": None, "draft_prompt": prompt, "instructions": instructions,
            "source": {**snapshot, "request_id": request_id, "instructions": instructions, "draft_prompt": prompt}, "idempotent_replay": False}


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


def _reference_keys(references) -> list[tuple]:
    """Compare client source identity, rather than mutable catalog metadata."""
    keys = []
    for reference in references:
        item = reference.model_dump() if isinstance(reference, ConversationSourceReference) else reference
        kind = item["kind"]
        source_id = item["source_id"].upper() if kind == "security" else item["source_id"]
        keys.append((kind, source_id, item.get("page_number") if kind == "report_page" else None,
                     item.get("version") if kind in {"pattern", "condition"} else None))
    return keys


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
            """SELECT *
               FROM conversation_turns WHERE conversation_id=?
               ORDER BY rowid DESC LIMIT 20""",
            (conversation_id,),
        ).fetchall()
        turn_jobs = {row["turn_id"]: {key: row[key] for key in ("id", "state", "progress", "message")}
                     for row in connection.execute(
                         """SELECT r.turn_id,j.id,j.state,j.progress,j.message FROM research_turn_jobs r
                         JOIN jobs j ON j.id=r.job_id WHERE r.conversation_id=?""", (conversation_id,))}
        draft_source = connection.execute("SELECT * FROM screening_draft_sources WHERE draft_conversation_id=?", (conversation_id,)).fetchone()

    return {
        "id": conversation["id"],
        "task_id": conversation["id"] if conversation["workflow_type"] == "screening" or conversation["task_revision"] else None,
        "entry_scope": conversation["entry_scope"],
        "research_mode": conversation["research_mode"],
        **_workflow_payload(conversation),
        "screening_draft_source": _draft_payload(draft_source),
        "project_id": conversation["project_id"],
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
                **_workflow_payload(row),
                "state": row["state"],
                "response_text": row["response_text"],
                "result": json_load(row["result_json"]),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "job": turn_jobs.get(row["id"]),
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
    research_scope_revision: int | None = None,
    assistant_revision: int | None = None,
    _connection: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    if _connection is None:
        recover_expired_turns()
    with (nullcontext(_connection) if _connection is not None else connect()) as connection:
        if _connection is None:
            connection.execute("BEGIN IMMEDIATE")
        conversation = connection.execute(
            "SELECT * FROM conversations WHERE id=?", (conversation_id,)
        ).fetchone()
        if not conversation:
            raise ConversationNotFound(conversation_id)
        if conversation["state"] != "active":
            raise ConversationConflict("此对话已归档，不能继续修改")
        existing = connection.execute(
            """SELECT m.id AS message_id,m.content AS content,m.source_refs_json AS source_refs_json,t.id AS turn_id,
                      t.base_revision AS base_revision,t.state AS state,t.workflow_type,t.research_depth,t.workflow_revision,
                      t.research_scope_json,t.research_scope_revision,t.requested_research_scope_revision,t.assistant_snapshot_json,t.assistant_revision,t.requested_assistant_revision
               FROM conversation_messages m
               JOIN conversation_turns t ON t.user_message_id=m.id
               WHERE m.conversation_id=? AND m.role='user' AND m.client_message_id=?""",
            (conversation_id, client_message_id),
        ).fetchone()
        if existing:
            if (
                existing["content"] != content
                or _reference_keys(json_load(existing["source_refs_json"])) != _reference_keys(source_refs or [])
                or existing["base_revision"] != base_revision
                or existing["requested_research_scope_revision"] != research_scope_revision
                or existing["requested_assistant_revision"] != assistant_revision
            ):
                raise ConversationConflict("相同消息ID不能提交不同内容、来源或条件版本")
            return {
                "message_id": existing["message_id"],
                "turn_id": existing["turn_id"],
                "base_revision": existing["base_revision"],
                **_workflow_payload(existing),
                "state": existing["state"],
                "source_refs": json_load(existing["source_refs_json"]),
                "idempotent_replay": True,
            }
        frozen_sources = _freeze_source_refs(connection, conversation_id, source_refs or [])
        source_refs_json = json_dump(frozen_sources)
        if conversation["workflow_type"] == "screening" and base_revision != conversation["task_revision"]:
            raise ConversationConflict(
                f"当前条件已更新到版本 {conversation['task_revision']}，请先读取最新版本"
            )
        if (conversation["workflow_type"] == "research" and research_scope_revision is not None
                and research_scope_revision != conversation["research_scope_revision"]):
            raise ConversationConflict("研究范围版本已经变化，请读取最新状态")
        if (conversation["workflow_type"] == "research" and assistant_revision is not None
                and assistant_revision != conversation["assistant_revision"]):
            raise ConversationConflict("研究助手已经变化，请读取最新状态后再发送")
        active_turn = connection.execute(
            """SELECT id FROM conversation_turns
               WHERE conversation_id=? AND state IN ('awaiting_agent','running') LIMIT 1""",
            (conversation_id,),
        ).fetchone()
        if active_turn:
            raise ConversationConflict("上一条消息仍在处理，请等待完成后再继续")

        now = utc_now()
        from .research_assistants import selection_snapshot
        frozen_assistant = json_load(conversation["assistant_snapshot_json"]) or selection_snapshot(connection)
        message_id, turn_id = str(uuid4()), str(uuid4())
        connection.execute(
            """INSERT INTO conversation_messages(
                   id,conversation_id,role,content,client_message_id,source_refs_json,created_at
               ) VALUES(?,?,'user',?,?,?,?)""",
            (message_id, conversation_id, content, client_message_id, source_refs_json, now),
        )
        connection.execute(
            """INSERT INTO conversation_turns(
                   id,conversation_id,user_message_id,base_revision,state,workflow_type,research_depth,workflow_revision,
                   research_scope_json,research_scope_revision,requested_research_scope_revision,created_at,updated_at,
                   assistant_snapshot_json,assistant_revision,requested_assistant_revision
               ) VALUES(?,?,?,?,'awaiting_agent',?,?,?,?,?,?,?,?,?,?,?)""",
            (turn_id, conversation_id, message_id, base_revision, conversation["workflow_type"], conversation["research_depth"],
             conversation["workflow_revision"], conversation["research_scope_json"], conversation["research_scope_revision"],
             research_scope_revision, now, now, json_dump(frozen_assistant), conversation["assistant_revision"], assistant_revision),
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
            **_workflow_payload(conversation),
            "state": "awaiting_agent",
            "source_refs": frozen_sources,
            "idempotent_replay": False,
        }


def get_turn(conversation_id: str, turn_id: str) -> dict[str, Any]:
    recover_expired_turns()
    with connect() as connection:
        row = connection.execute(
            """SELECT *
               FROM conversation_turns WHERE id=? AND conversation_id=?""",
            (turn_id, conversation_id),
        ).fetchone()
        job = connection.execute(
            """SELECT j.id,j.state,j.progress,j.message FROM research_turn_jobs r JOIN jobs j ON j.id=r.job_id
               WHERE r.turn_id=? AND r.conversation_id=?""", (turn_id, conversation_id),
        ).fetchone()
    if not row:
        raise ConversationNotFound(turn_id)
    return {
        "id": row["id"],
        "conversation_id": row["conversation_id"],
        "user_message_id": row["user_message_id"],
        "base_revision": row["base_revision"],
        **_workflow_payload(row),
        "state": row["state"],
        "response_text": row["response_text"],
        "result": json_load(row["result_json"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "job": dict(job) if job else None,
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
    *, turn_id: str | None = None,
) -> None:
    """Record a server-checked execution grant for the current user message."""
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if turn_id is not None:
            require_running_turn(connection, conversation_id, turn_id)
        conversation = connection.execute(
            "SELECT task_revision,state,workflow_type FROM conversations WHERE id=?", (conversation_id,)
        ).fetchone()
        if not conversation:
            raise ConversationNotFound(conversation_id)
        if conversation["state"] != "active":
            raise ConversationConflict("此对话已归档，不能授予执行授权")
        if conversation["workflow_type"] != "screening":
            raise ConversationStoreError("正式选股执行授权只能在选股工作流中授予")
        if turn_id is not None:
            turn = connection.execute("SELECT workflow_type FROM conversation_turns WHERE id=? AND conversation_id=?", (turn_id, conversation_id)).fetchone()
            if not turn or turn["workflow_type"] != "screening":
                raise ConversationStoreError("投研回合不能授予正式选股执行权限")
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


def clear_pending_execute_message(conversation_id: str, expected_revision: int, *, turn_id: str | None = None) -> None:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if turn_id is not None:
            require_running_turn(connection, conversation_id, turn_id)
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
            """SELECT id,base_revision,state,workflow_type FROM conversation_turns
               WHERE id=? AND conversation_id=?""",
            (turn_id, conversation_id),
        ).fetchone()
        if not conversation or not turn:
            raise ConversationNotFound(turn_id)
        if conversation["state"] != "active":
            raise ConversationConflict("对话已归档，不能处理回合")
        if turn["state"] != "awaiting_agent":
            raise ConversationConflict("此回合已被领取或已经结束")
        if turn["workflow_type"] == "screening" and turn["base_revision"] != conversation["task_revision"]:
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
    if state not in {"awaiting_user", "succeeded", "failed", "cancelled"}:
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
        turn = connection.execute(
            "SELECT state,response_text,result_json,updated_at,workflow_type FROM conversation_turns WHERE id=? AND conversation_id=?",
            (turn_id, conversation_id),
        ).fetchone()
        if not turn:
            raise ConversationNotFound(turn_id)
        if turn["workflow_type"] == "screening" and conversation["task_revision"] != expected_task_revision:
            raise ConversationConflict("处理期间条件版本发生变化，助手结果未发布")
        if turn["workflow_type"] == "research" and pending_execute_message_id is not None:
            raise ConversationStoreError("投研回合不能授予正式选股执行权限")

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
        if turn["state"] == "running" and state != "cancelled":
            require_running_turn(connection, conversation_id, turn_id)
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
    turn_id: str | None = None,
) -> dict[str, Any]:
    if candidate.task_id != conversation_id or candidate.revision != base_revision + 1:
        raise ConversationStoreError("条件修订必须属于当前对话，并且版本号必须递增1")
    task_json = json_dump(candidate.model_dump(mode="json"))

    with (nullcontext(_connection) if _connection is not None else connect()) as connection:
        if _connection is None:
            connection.execute("BEGIN IMMEDIATE")
        if turn_id is not None:
            require_running_turn(connection, conversation_id, turn_id)
        conversation = connection.execute(
            "SELECT task_revision,state,workflow_type FROM conversations WHERE id=?", (conversation_id,)
        ).fetchone()
        if not conversation:
            raise ConversationNotFound(conversation_id)
        if conversation["state"] != "active":
            raise ConversationConflict("此对话已归档，不能修改条件")
        if conversation["workflow_type"] != "screening":
            raise ConversationStoreError("请先将研究转为选股草案，再修改选股条件")
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
