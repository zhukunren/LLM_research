from fastapi import APIRouter, HTTPException, Query

from . import conversation_store, saved_screening_tasks
from .db import connect, json_load
from .screening_contracts import ContractModel
from pydantic import Field
from datetime import date


class ReuseSavedTaskRequest(ContractModel):
    base_revision: int = Field(ge=0)
    source_message_id: str = Field(min_length=1, max_length=100)
    version: int | None = Field(default=None, ge=1)
    as_of: date | None = None

router = APIRouter(prefix="/api/v1", tags=["已保存筛选任务"])


def _error(exc):
    raise HTTPException(exc.status_code, {"code": exc.code, "message": str(exc)}) from exc


@router.get("/saved-screening-tasks")
def list_saved_tasks(include_history: bool = False, limit: int = Query(default=100, ge=1, le=200)):
    return {"items": saved_screening_tasks.list_tasks(include_history, limit)}


@router.get("/saved-screening-tasks/{asset_id}")
def get_saved_task(asset_id: str, version: int | None = Query(default=None, ge=1)):
    try:
        return saved_screening_tasks.get_task(asset_id, version)
    except saved_screening_tasks.SavedTaskError as exc:
        _error(exc)


@router.post("/conversations/{conversation_id}/saved-screening-tasks", status_code=201)
def save_current_task(conversation_id: str, payload: saved_screening_tasks.SaveScreeningTaskRequest):
    try:
        conversation = conversation_store.get_conversation(conversation_id, message_limit=1)
        revision = payload.revision or conversation["task_revision"]
        task = conversation_store.get_task_revision(conversation_id, revision)
        return saved_screening_tasks.save_task(task, name=payload.name, asset_id=payload.asset_id)
    except (conversation_store.ConversationNotFound, saved_screening_tasks.SavedTaskError) as exc:
        if isinstance(exc, conversation_store.ConversationNotFound):
            raise HTTPException(404, {"code": "conversation_not_found", "message": "找不到对话或任务修订。"}) from exc
        _error(exc)


@router.post("/conversations/{conversation_id}/saved-screening-tasks/{asset_id}/reuse", status_code=201)
def reuse_saved_task(conversation_id: str, asset_id: str, payload: ReuseSavedTaskRequest):
    try:
        saved = saved_screening_tasks.get_task(asset_id, payload.version)
        task = saved_screening_tasks.reuse_task(saved["task"], conversation_id=conversation_id, base_revision=payload.base_revision)
        if payload.as_of is not None:
            from . import market
            latest = market.cached_profile().get("last_date")
            if latest and payload.as_of.isoformat() > latest:
                raise HTTPException(422, f"行情只更新到 {latest}。")
            task = task.model_copy(update={"scope": task.scope.model_copy(update={"as_of": payload.as_of})})
        # Publish the revision and finish its user turn together. A reused task is
        # editable immediately and never carries execution authorization.
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            turn = connection.execute(
                """SELECT id,state,base_revision,result_json FROM conversation_turns
                   WHERE conversation_id=? AND user_message_id=?""",
                (conversation_id, payload.source_message_id),
            ).fetchone()
            if not turn or turn["base_revision"] != payload.base_revision:
                raise conversation_store.ConversationConflict("请基于当前对话重新复用任务。")
            replay = turn["state"] == "succeeded" and json_load(turn["result_json"]).get("intent") == "reuse"
            if turn["state"] != "awaiting_agent" and not replay:
                raise conversation_store.ConversationConflict("这条消息已经在处理或已结束，请重新发起复用。")
            result = conversation_store.save_task_revision(
                conversation_id, payload.base_revision, payload.source_message_id, task, _connection=connection,
            )
            conversation_store.finish_turn(
                conversation_id, turn["id"], task.revision, "succeeded",
                f"已复用“{saved['name']}”的第 {saved['version']} 版。请核对股票范围与截止日，可继续描述修改要求，或确认后开始筛选。",
                {"intent": "reuse", "task_revision": task.revision, "saved_task_id": saved["id"],
                 "saved_task_version": saved["version"], "execution_authorized": False, "ready_to_execute": False},
                _connection=connection,
            )
        return result
    except (conversation_store.ConversationNotFound, conversation_store.ConversationConflict,
            conversation_store.ConversationStoreError, saved_screening_tasks.SavedTaskError) as exc:
        if isinstance(exc, saved_screening_tasks.SavedTaskError):
            _error(exc)
        raise HTTPException(409, {"code": "conversation_conflict", "message": str(exc)}) from exc
