from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.formparsers import MultiPartException
from starlette.responses import FileResponse, JSONResponse

from . import research_attachments

router = APIRouter(prefix='/api/v1/conversations', tags=['研究附件'])


def _error(exc: research_attachments.AttachmentError):
    raise HTTPException(exc.status, {'code': 'research_attachment_error', 'message': str(exc)}) from exc


@router.get('/{conversation_id}/attachments')
def list_attachments(conversation_id: str):
    try: return research_attachments.list_attachments(conversation_id)
    except research_attachments.AttachmentError as exc: _error(exc)


@router.post('/{conversation_id}/attachments')
async def upload_attachment(conversation_id: str, request: Request):
    # Bound the body while parsing multipart, including chunked requests, rather
    # than trusting Content-Length or first spooling an unbounded upload to disk.
    consumed = 0
    exceeded = False
    async def receive():
        nonlocal consumed, exceeded
        message = await request.receive()
        consumed += len(message.get('body', b''))
        if consumed > research_attachments.MAX_FILE_BYTES + 64 * 1024:
            exceeded = True
            raise MultiPartException('附件请求超过大小限制')
        return message
    limited = Request(request.scope, receive=receive)
    try:
        async with limited.form(max_files=1, max_fields=1, max_part_size=1024) as form:
            if set(form.keys()) != {'file', 'request_id'} or len(form.getlist('file')) != 1 or len(form.getlist('request_id')) != 1:
                raise research_attachments.AttachmentError('请提供一个文件和上传请求标识')
            file, request_id = form['file'], form['request_id']
            if not isinstance(file, UploadFile) or not isinstance(request_id, str):
                raise research_attachments.AttachmentError('上传表单无效')
            result = await run_in_threadpool(research_attachments.upload, conversation_id, request_id, file.filename or '', file.file)
            return JSONResponse(result, status_code=200 if result['idempotent_replay'] else 201)
    except research_attachments.AttachmentError as exc: _error(exc)
    except (MultiPartException, StarletteHTTPException) as exc:
        raise HTTPException(413 if exceeded else 422, {'code': 'research_attachment_error', 'message': '附件请求超过大小限制' if exceeded else '上传表单无效，请重新选择文件'}) from exc


@router.get('/{conversation_id}/attachments/{attachment_id}/download')
def download_attachment(conversation_id: str, attachment_id: str):
    try:
        path, item = research_attachments.download(conversation_id, attachment_id)
        return FileResponse(path, filename=item['filename'], media_type=item['media_type'], content_disposition_type='attachment',
            headers={'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox"})
    except research_attachments.AttachmentError as exc: _error(exc)
