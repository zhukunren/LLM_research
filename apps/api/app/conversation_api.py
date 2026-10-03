from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, FileResponse

from . import codex_runtime, codex_store, conversation_store, research_workspace, research_turn_service
from .settings import default_research_mode
from .screening_contracts import (
    AddUserMessageRequest,
    ConversationScope,
    CreateConversationRequest,
    SaveTaskRevisionRequest,
    UpdateResearchModeRequest,
)

router = APIRouter(prefix="/api/v1/conversations", tags=["对话式筛选"])


@router.get("/research-modes")
def get_research_modes():
    return {"default_mode": default_research_mode()}


@router.get("/{conversation_id}/research-files")
def list_research_files(conversation_id: str):
    try:
        conversation_store.get_conversation(conversation_id, message_limit=1)
        return {"items": research_workspace.list_outputs(conversation_id)}
    except conversation_store.ConversationNotFound as exc:
        _store_error(exc)


@router.get("/{conversation_id}/research-files/{path:path}")
def get_research_file(conversation_id: str, path: str):
    try:
        conversation_store.get_conversation(conversation_id, message_limit=1)
        target = research_workspace.output_path(conversation_id, path)
        return FileResponse(target, filename=target.name, media_type="application/octet-stream",
                            headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})
    except conversation_store.ConversationNotFound as exc:
        _store_error(exc)
    except research_workspace.WorkspaceError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/{conversation_id}/turns/{turn_id}/cancel")
def cancel_research_turn(conversation_id: str, turn_id: str):
    try:
        with conversation_store.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT state FROM conversation_turns WHERE id=? AND conversation_id=?",
                                     (turn_id, conversation_id)).fetchone()
            if row is None:
                raise conversation_store.ConversationNotFound(turn_id)
            if row["state"] in {"running", "awaiting_agent"}:
                revision = connection.execute("SELECT task_revision FROM conversations WHERE id=?", (conversation_id,)).fetchone()[0]
                conversation_store.finish_turn(
                    conversation_id, turn_id, revision, "cancelled", "研究已停止，已生成的工作文件和成果已保留。可以继续追问。",
                    {"runtime": "codex", "ready_to_execute": False}, _connection=connection)
                connection.execute(
                    """UPDATE jobs SET state='cancelled',message='用户已停止研究',updated_at=?,lease_owner=NULL,lease_expires_at=NULL
                       WHERE id=(SELECT job_id FROM research_turn_jobs WHERE turn_id=? AND conversation_id=?)
                         AND state IN ('queued','running')""",
                    (conversation_store.utc_now(), turn_id, conversation_id),
                )
        return conversation_store.get_turn(conversation_id, turn_id)
    except (conversation_store.ConversationNotFound, conversation_store.ConversationConflict) as exc:
        _store_error(exc)


def _store_error(exc: Exception) -> None:
    if isinstance(exc, conversation_store.ConversationNotFound):
        raise HTTPException(404, {"code": "conversation_not_found", "message": "找不到对话或修订"})
    if isinstance(exc, conversation_store.ConversationConflict):
        raise HTTPException(409, {"code": "conversation_conflict", "message": str(exc)})
    if isinstance(exc, conversation_store.ConversationStoreError):
        raise HTTPException(422, {"code": "invalid_conversation_request", "message": str(exc)})
    raise exc


@router.post("")
def create_conversation(payload: CreateConversationRequest):
    try:
        return conversation_store.create_conversation(payload.entry_scope, payload.research_mode or default_research_mode(), payload.project_id)
    except conversation_store.ConversationStoreError as exc:
        _store_error(exc)


@router.get("")
def list_conversations(
    scope: ConversationScope | None = None,
    limit: int = Query(default=50, ge=1, le=100),
):
    return {"items": conversation_store.list_conversations(scope, limit)}


@router.get("/{conversation_id}")
def get_conversation(
    conversation_id: str,
    message_limit: int = Query(default=100, ge=1, le=100),
):
    try:
        return conversation_store.get_conversation(conversation_id, message_limit)
    except conversation_store.ConversationNotFound as exc:
        _store_error(exc)


@router.patch("/{conversation_id}/mode")
def update_research_mode(conversation_id: str, payload: UpdateResearchModeRequest):
    try:
        return conversation_store.update_research_mode(conversation_id, payload.research_mode)
    except (conversation_store.ConversationNotFound, conversation_store.ConversationConflict, conversation_store.ConversationStoreError) as exc:
        _store_error(exc)


@router.post("/{conversation_id}/messages")
def add_user_message(conversation_id: str, payload: AddUserMessageRequest):
    try:
        result = conversation_store.add_user_message(
            conversation_id,
            payload.client_message_id,
            payload.base_revision,
            payload.content,
            payload.source_refs,
        )
    except (
        conversation_store.ConversationNotFound,
        conversation_store.ConversationConflict,
        conversation_store.ConversationStoreError,
    ) as exc:
        _store_error(exc)
    return JSONResponse(
        status_code=200 if result["idempotent_replay"] else 202,
        content=result,
    )


@router.get("/{conversation_id}/turns/{turn_id}")
def get_conversation_turn(conversation_id: str, turn_id: str):
    try:
        return conversation_store.get_turn(conversation_id, turn_id)
    except conversation_store.ConversationNotFound as exc:
        _store_error(exc)


@router.post("/{conversation_id}/turns/{turn_id}/process")
def process_conversation_turn(conversation_id: str, turn_id: str):
    try:
        turn = research_turn_service.enqueue_turn(conversation_id, turn_id)
        return JSONResponse(status_code=202 if turn["state"] in {"awaiting_agent", "running"} else 200, content=turn)
    except codex_runtime.CodexRuntimeError as exc:
        raise HTTPException(
            503,
            {"code": "codex_runtime_unavailable", "message": str(exc)},
        ) from exc
    except (
        conversation_store.ConversationNotFound,
        conversation_store.ConversationConflict,
        conversation_store.ConversationStoreError,
    ) as exc:
        _store_error(exc)


@router.get("/{conversation_id}/turns/{turn_id}/codex-events")
def list_codex_turn_events(
    conversation_id: str,
    turn_id: str,
    after: int = Query(default=-1, ge=-1),
    limit: int = Query(default=200, ge=1, le=500),
):
    try:
        conversation_store.get_turn(conversation_id, turn_id)
        return codex_store.list_events(conversation_id, turn_id, after=after, limit=limit)
    except conversation_store.ConversationNotFound as exc:
        _store_error(exc)


@router.get("/{conversation_id}/codex-status")
def get_codex_status(conversation_id: str):
    try:
        conversation_store.get_conversation(conversation_id, message_limit=1)
        return codex_store.status(conversation_id)
    except conversation_store.ConversationNotFound as exc:
        _store_error(exc)


@router.get("/{conversation_id}/revisions/{revision}")
def get_task_revision(conversation_id: str, revision: int):
    try:
        task = conversation_store.get_task_revision(conversation_id, revision)
        return task.model_dump(mode="json")
    except conversation_store.ConversationNotFound as exc:
        _store_error(exc)


@router.post("/{conversation_id}/revisions")
def save_task_revision(conversation_id: str, payload: SaveTaskRevisionRequest):
    try:
        result = conversation_store.save_task_revision(
            conversation_id,
            payload.base_revision,
            payload.source_message_id,
            payload.task,
        )
    except (
        conversation_store.ConversationNotFound,
        conversation_store.ConversationConflict,
        conversation_store.ConversationStoreError,
    ) as exc:
        _store_error(exc)
    return JSONResponse(
        status_code=200 if result["idempotent_replay"] else 201,
        content=result,
    )
