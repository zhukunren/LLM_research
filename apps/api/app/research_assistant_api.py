from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import research_assistants

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


def assistant_error(exc: research_assistants.AssistantError):
    raise HTTPException(exc.status, {"code": "research_assistant_error", "message": str(exc)}) from exc


@router.get("")
def list_assistants(include_disabled: bool = False):
    return {"items": research_assistants.list_assistants(include_disabled), "default_id": "general"}


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
