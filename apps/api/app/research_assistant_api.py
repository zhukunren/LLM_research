from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from . import conversation_store, research_assistants, research_assistant_runs

router = APIRouter(prefix="/api/v1/research-assistants", tags=["研究助手"])


class AssistantInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=60)
    description: str = Field(default="", max_length=240)
    instructions: str = Field(min_length=1, max_length=16000)
    enabled: bool = True


class AssistantUpdate(AssistantInput):
    base_revision: int = Field(ge=1)


class AssistantCreate(AssistantInput):
    request_id: str | None = Field(default=None, min_length=1, max_length=100)


class AssistantLaunch(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    request_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
    model_id: str | None = Field(default=None, min_length=1, max_length=100)
    reasoning_effort: str | None = Field(default=None, min_length=1, max_length=32)


def assistant_error(exc: research_assistants.AssistantError):
    raise HTTPException(exc.status, {"code": "research_assistant_error", "message": str(exc)}) from exc


@router.get("")
def list_assistants(include_disabled: bool = False):
    return {"items": research_assistants.list_assistants(include_disabled), "default_id": "general"}


@router.post("/{assistant_id}/launch")
def launch_assistant(assistant_id: str, payload: AssistantLaunch):
    try:
        result = research_assistant_runs.launch_assistant(assistant_id, **payload.model_dump())
        return JSONResponse(status_code=202 if result["state"] in {"awaiting_agent", "running"} else 200, content=result)
    except research_assistant_runs.LaunchError as exc:
        raise HTTPException(exc.status, {"code": "research_assistant_launch_error", "message": str(exc), "details": exc.context or None}) from exc
    except research_assistants.AssistantError as exc:
        assistant_error(exc)
    except conversation_store.ConversationConflict as exc:
        raise HTTPException(409, {"code": "conversation_conflict", "message": str(exc)}) from exc
    except conversation_store.ConversationStoreError as exc:
        raise HTTPException(422, {"code": "conversation_error", "message": str(exc)}) from exc


@router.post("", status_code=201)
def create_assistant(payload: AssistantCreate):
    try:
        return research_assistants.save_assistant(**payload.model_dump())
    except research_assistants.AssistantError as exc:
        assistant_error(exc)


@router.put("/{assistant_id}")
def update_assistant(assistant_id: str, payload: AssistantUpdate):
    try:
        return research_assistants.save_assistant(**payload.model_dump(), assistant_id=assistant_id)
    except research_assistants.AssistantError as exc:
        assistant_error(exc)
