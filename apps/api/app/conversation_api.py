from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from . import codex_runtime, codex_store, conversation_store
from .screening_contracts import (
    AddUserMessageRequest,
    ConversationScope,
    CreateConversationRequest,
    SaveTaskRevisionRequest,
)

router = APIRouter(prefix="/api/v1/conversations", tags=["对话式筛选"])


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
    return conversation_store.create_conversation(payload.entry_scope)


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
        conversation_store.start_turn(conversation_id, turn_id)
        return codex_runtime.process_conversation_turn(conversation_id, turn_id)
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
