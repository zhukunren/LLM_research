from datetime import date
from typing import Literal
from urllib.parse import unquote, urlsplit

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from . import disclosures, documents
from .disclosure_sources import MAX_PDF_BYTES, OFFICIAL_DOMAINS
from .security_context import AccessDenied, can_write, current_actor

router = APIRouter(prefix="/api/v1", tags=["原始披露"])


def _call(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except AccessDenied:
        raise
    except disclosures.DisclosureError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except documents.DocumentIntegrityError as exc:
        raise HTTPException(409, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, "原始 PDF 暂不可用，请恢复原件后重试") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/disclosures")
def list_disclosures(stock_code: str | None = Query(None, pattern=r"^\d{6}\.(SH|SZ|BJ)$"),
                     report_period: date | None = None, document_type: disclosures.DocumentType | None = None,
                     document_form: disclosures.DocumentForm | None = None,
                     classification: Literal["pending", "confirmed"] | None = None, q: str = Query("", max_length=300),
                     as_of: date | None = None, observed_by: date | None = None, offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100)):
    return _call(disclosures.list_versions, stock_code=stock_code, report_period=report_period.isoformat() if report_period else None,
                 document_type=document_type, document_form=document_form, classification=classification, query=q,
                 as_of=as_of.isoformat() if as_of else None, observed_by=observed_by.isoformat() if observed_by else None, offset=offset, limit=limit)


@router.get("/disclosures/import-options")
def import_options():
    return {"max_pdf_bytes": MAX_PDF_BYTES, "official_domains": OFFICIAL_DOMAINS, "automatic_collection": False,
            "can_write": can_write(current_actor())}


@router.post("/disclosures/import-url", status_code=202)
def import_url(payload: disclosures.ImportRequest):
    if not payload.url:
        raise HTTPException(422, "请填写官方 PDF 原文链接")
    filename = unquote(urlsplit(payload.url).path).rsplit("/", 1)[-1]
    if not filename.lower().endswith(".pdf"):
        filename = "原始披露.pdf"
    return _call(disclosures.enqueue, payload, filename=filename)


@router.post("/disclosures/upload", status_code=202)
async def upload(file: UploadFile = File(...), payload: str = Form(...)):
    try:
        try:
            request = disclosures.ImportRequest.model_validate_json(payload)
        except ValueError as exc:
            raise HTTPException(422, "分类或导入参数无效，请核对公司、报告期、类型和日期") from exc
        data = bytearray()
        while chunk := await file.read(64 * 1024):
            data.extend(chunk)
            if len(data) > MAX_PDF_BYTES:
                raise HTTPException(413, "每份 PDF 最多 50 MB")
        return await run_in_threadpool(_call, disclosures.enqueue, request, data=bytes(data), filename=file.filename or "原始披露.pdf")
    finally:
        await file.close()


@router.get("/disclosure-imports")
def list_imports():
    return _call(disclosures.recent_imports)


@router.get("/disclosure-imports/{import_id}")
def import_status(import_id: str):
    return _call(disclosures.read_import, import_id)


@router.post("/disclosure-imports/{import_id}/retry", status_code=202)
def retry(import_id: str):
    return _call(disclosures.retry, import_id)


@router.get("/disclosures/versions/{version_id}")
def detail(version_id: str, as_of: date | None = None):
    return _call(disclosures.detail, version_id, as_of=as_of.isoformat() if as_of else None)


@router.patch("/disclosures/versions/{version_id}/metadata")
def metadata(version_id: str, payload: disclosures.MetadataUpdate):
    return _call(disclosures.update_metadata, version_id, payload)


@router.get("/disclosures/versions/{version_id}/pdf")
def pdf(version_id: str, as_of: date | None = None):
    path, version = _call(disclosures.pdf_path, version_id, as_of=as_of.isoformat() if as_of else None)
    return FileResponse(path, media_type="application/pdf", filename=version["filename"], content_disposition_type="inline",
                        headers={"Cache-Control": "private, no-cache", "ETag": '"' + version["sha256"] + '"'})


@router.get("/disclosures/versions/{version_id}/pages/{page}")
def page(version_id: str, page: int, as_of: date | None = None, offset: int = Query(0, ge=0), limit: int = Query(12000, ge=1, le=20000)):
    return _call(disclosures.read_page, version_id, page, as_of=as_of.isoformat() if as_of else None, offset=offset, limit=limit)


@router.get("/disclosures/versions/{version_id}/search")
def search(version_id: str, q: str = Query(..., min_length=1, max_length=200), as_of: date | None = None,
           offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100)):
    return _call(disclosures.search_pages, version_id, q, as_of=as_of.isoformat() if as_of else None, offset=offset, limit=limit)
