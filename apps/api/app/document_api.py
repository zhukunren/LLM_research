from __future__ import annotations

import hashlib
import re
from uuid import uuid4

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from . import documents
from .api_responses import bad_request
from .db import connect, json_dump, json_load, utc_now
from .models import ConfirmAvailabilityInput, ConfirmSecurityBindingInput, ReportSearchInput
from .model_modes import DEFAULT_MODEL_MODE, MODEL_PRESETS, ModelMode
from .report_evidence import PROMPT_VERSION, normalize_quote
from .security_context import current_actor

router = APIRouter(prefix="/api/v1/documents")


@router.get("")
def list_documents():
    legacy = current_actor().legacy
    upload_directory = documents.upload_directory()
    source_files = len(list(documents.REPORT_DIR.glob("*.pdf"))) if legacy and documents.REPORT_DIR.exists() else 0
    if upload_directory.exists():
        source_files += len(list(upload_directory.glob("*.pdf")))
    items = documents.list_documents()
    for item in items:
        try:
            item["stock_code_evidence"] = json_load(item.pop("stock_code_evidence_json", "[]"))
        except (TypeError, ValueError):
            item["stock_code_evidence"] = []
    return {"items": items, "source_files": source_files}


@router.post("/import-local")
def import_documents():
    return documents.import_local_reports()


@router.post("/catalog")
def catalog_documents(retry_failed: bool = False, model_mode: ModelMode = DEFAULT_MODEL_MODE):
    from .report_catalog import enqueue
    return enqueue(retry_failed=retry_failed, model_mode=model_mode)


@router.get("/{document_id}/pdf")
def document_pdf(document_id: str):
    with connect() as connection:
        row = connection.execute("SELECT source_path,sha256,filename FROM documents WHERE id=?", (document_id,)).fetchone()
    if not row:
        bad_request("找不到研报", 404, "document_not_found")
    try:
        path = documents.original_snapshot(row["source_path"], row["sha256"])
    except FileNotFoundError:
        bad_request("研报 PDF 原件不存在", 404, "document_pdf_missing")
    except documents.DocumentIntegrityError as exc:
        bad_request(str(exc), 409, "document_pdf_integrity_mismatch")
    return FileResponse(path, media_type="application/pdf", filename=row["filename"], content_disposition_type="inline")


@router.post("/{document_id}/security-binding")
def confirm_document_security_binding(document_id: str, payload: ConfirmSecurityBindingInput):
    stock_code = payload.stock_code.upper()
    with connect() as connection:
        row = connection.execute("SELECT filename,stock_code FROM documents WHERE id=?", (document_id,)).fetchone()
        if not row:
            bad_request("找不到研报", 404, "document_not_found")
        previous_code = row[1]
        now = utc_now()
        connection.execute(
            "UPDATE documents SET stock_code=?,market=?,stock_code_status='confirmed',stock_code_source='manual',stock_code_prompt_version=NULL,stock_code_confirmed_at=? WHERE id=?",
            (stock_code, stock_code.rsplit(".", 1)[1], now, document_id),
        )
        connection.execute(
            "INSERT INTO audit_events(action,entity_type,entity_id,details_json,created_at) VALUES('confirm_security_binding','document',?,?,?)",
            (document_id, json_dump({"previous_code": previous_code, "confirmed_code": stock_code}), now),
        )
    return {"document_id": document_id, "filename": row[0], "stock_code": stock_code, "binding_status": "confirmed", "confirmed_at": now}


@router.post("/{document_id}/confirm-llm-security-binding")
def confirm_llm_security_binding(document_id: str):
    with connect() as connection:
        row = connection.execute(
            "SELECT filename,stock_code,stock_code_status,stock_code_evidence_json,stock_code_model,stock_code_prompt_version FROM documents WHERE id=?",
            (document_id,),
        ).fetchone()
        if not row:
            bad_request("找不到研报", 404, "document_not_found")
        if row[2] != "llm_candidate" or not row[1]:
            bad_request("没有唯一、带原文依据的 LLM 主体代码候选可确认", 409, "llm_security_candidate_unavailable")
        evidence = json_load(row[3])
        issuer_candidates = [
            item for item in evidence
            if isinstance(item, dict) and item.get("role") == "issuer"
        ] if isinstance(evidence, list) else []
        issuer_codes = {str(item.get("canonical_code", "")).upper() for item in issuer_candidates}
        valid_candidates = []
        for item in issuer_candidates:
            code = str(item.get("canonical_code", "")).upper()
            quote = item.get("quote")
            reported_code = item.get("reported_code")
            page_number = item.get("page")
            if code != row[1] or not re.fullmatch(r"\d{4,6}\.(SH|SZ|BJ|HK|KS)", code):
                continue
            if not isinstance(quote, str) or not isinstance(reported_code, str) or not isinstance(page_number, int):
                continue
            if normalize_quote(code) not in normalize_quote(quote) or normalize_quote(reported_code) not in normalize_quote(quote):
                continue
            page = connection.execute(
                "SELECT text FROM document_pages WHERE document_id=? AND page_number=?", (document_id, page_number)
            ).fetchone()
            if not page or normalize_quote(quote) not in normalize_quote(page[0]):
                continue
            valid_candidates.append(item)
        if issuer_codes != {row[1]} or not valid_candidates:
            bad_request("LLM 主体代码候选缺少唯一有效页码引用", 409, "llm_security_candidate_unverified")
        if row[4] not in {preset.model_id for preset in MODEL_PRESETS.values()}:
            bad_request("LLM 候选生成模型已变化，请重新运行判断口径后再确认", 409, "llm_security_candidate_model_changed")
        if row[5] != PROMPT_VERSION:
            bad_request("LLM 候选由旧版提示词生成，请重新运行判断口径后再确认", 409, "llm_security_candidate_prompt_changed")
        now = utc_now()
        connection.execute(
            "UPDATE documents SET stock_code_status='confirmed',stock_code_confirmed_at=? WHERE id=?",
            (now, document_id),
        )
        connection.execute(
            "INSERT INTO audit_events(action,entity_type,entity_id,details_json,created_at) VALUES('confirm_llm_security_binding','document',?,?,?)",
            (document_id, json_dump({"stock_code": row[1], "model": row[4], "evidence": valid_candidates[0]}), now),
        )
    return {"document_id": document_id, "filename": row[0], "stock_code": row[1], "binding_status": "confirmed", "source": "llm_page_evidence", "model": row[4], "evidence": valid_candidates[0], "confirmed_at": now}


@router.post("/{document_id}/confirm-availability")
def confirm_document_availability(document_id: str, payload: ConfirmAvailabilityInput):
    with connect() as connection:
        row = connection.execute("SELECT filename,publication_date,available_at FROM documents WHERE id=?", (document_id,)).fetchone()
        if not row:
            bad_request("找不到研报", 404, "document_not_found")
        previous = row[2]
        now = utc_now()
        connection.execute(
            "UPDATE documents SET available_at=?,available_at_status='confirmed',available_at_confirmed_at=? WHERE id=?",
            (payload.available_at, now, document_id),
        )
        connection.execute(
            "INSERT INTO audit_events(action,entity_type,entity_id,details_json,created_at) VALUES('confirm_report_availability','document',?,?,?)",
            (document_id, json_dump({"previous_available_at": previous, "confirmed_available_at": payload.available_at, "publication_date_candidate": row[1]}), now),
        )
    return {"document_id": document_id, "filename": row[0], "publication_date_candidate": row[1], "available_at": payload.available_at, "availability_status": "confirmed", "confirmed_at": now}


@router.post("/upload")
async def upload_document(file: UploadFile = File(...)):
    if file.content_type != "application/pdf" or not file.filename or not file.filename.lower().endswith(".pdf"):
        bad_request("只支持 PDF 文件")
    upload_directory = documents.upload_directory()
    upload_directory.mkdir(parents=True, exist_ok=True)
    source_name = file.filename.replace("\\", "/").rsplit("/", 1)[-1]
    safe_name = re.sub(r"[^\w .()（）\[\]：_-]", "_", source_name, flags=re.UNICODE).strip(" .")[-160:] or "report.pdf"
    target = upload_directory / f"{uuid4()}--{safe_name}"
    size = 0
    try:
        with target.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > 50 * 1024 * 1024:
                    output.close()
                    target.unlink(missing_ok=True)
                    bad_request("单个 PDF 不能超过 50 MB")
                output.write(chunk)
        if target.read_bytes()[:5] != b"%PDF-":
            target.unlink(missing_ok=True)
            bad_request("文件内容不是有效 PDF")
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        result = await run_in_threadpool(documents.import_local_reports, paths=[target])
        current = next((item for item in result["results"] if item.get("sha256") == digest), None)
        return {"uploaded": True, "bytes": size, "result": current, "import_summary": {"imported": result["imported"], "failed": result["failed"]}}
    finally:
        await file.close()


@router.post("/search")
def search_documents(payload: ReportSearchInput):
    return documents.search(payload.query, payload.as_of.isoformat() if payload.as_of else None,
                            payload.stock_code, payload.limit, mode=payload.mode, offset=payload.offset,
                            confirmed_security_only=bool(payload.stock_code and payload.as_of))


@router.get("/{document_id}/pages/{page_number}")
def get_document_page(document_id: str, page_number: int):
    try:
        page = documents.read_page(document_id, page_number, max_chars=None)
    except KeyError:
        bad_request("找不到研报页", 404, "document_page_not_found")
    return {**page, "stock_code_candidate": page["stock_code"]}
