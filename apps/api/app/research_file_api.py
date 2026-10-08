from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from . import conversation_store, research_files, research_workspace


router = APIRouter(prefix="/api/v1/conversations", tags=["研究生成文件"])


def _unavailable() -> HTTPException:
    return HTTPException(404, {"code": "generated_file_unavailable", "message": "找不到可下载的研究文件"})


@router.get("/{conversation_id}/generated-files")
def list_generated_files(conversation_id: str):
    try:
        return {"items": research_files.list_generated_files(conversation_id), "format": "original"}
    except (conversation_store.ConversationNotFound, research_files.GeneratedFileError,
            research_workspace.WorkspaceError, OSError, ValueError) as exc:
        raise _unavailable() from exc


@router.get("/{conversation_id}/generated-files/{path:path}")
def download_generated_file(conversation_id: str, path: str):
    try:
        conversation_store.get_conversation(conversation_id, message_limit=1)
        target = research_files.generated_file_path(conversation_id, path)
        return FileResponse(
            target, filename=target.name, media_type=research_files.MEDIA_TYPES[target.suffix.lower()],
            content_disposition_type="attachment",
            headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"},
        )
    except (conversation_store.ConversationNotFound, research_files.GeneratedFileError,
            research_workspace.WorkspaceError, OSError, ValueError) as exc:
        raise _unavailable() from exc
