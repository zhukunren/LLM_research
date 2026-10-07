from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

from .db import connect, json_dump, utc_now
from .settings import REPORT_DIR, REPORT_UPLOAD_DIR, report_parser_settings
from .report_parser import parse_report
from . import report_search


SECURITY_PATTERN = re.compile(r"(?<!\d)(\d{4,6})\.(SH|SZ|BJ|HK|KS)\b", re.I)
DATE_PATTERN = re.compile(r"(?<!\d)(20\d{6})(?!\d)")


def _metadata(filename: str) -> tuple[str | None, str | None, str | None]:
    match = SECURITY_PATTERN.search(filename)
    security = f"{match.group(1)}.{match.group(2).upper()}" if match else None
    market = security.rsplit(".", 1)[-1] if security else None
    date_match = DATE_PATTERN.search(filename)
    date = f"{date_match.group(1)[:4]}-{date_match.group(1)[4:6]}-{date_match.group(1)[6:8]}" if date_match else None
    return date, market, security


def import_local_reports(*, paths: list[Path] | None = None) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    if paths is None:
        paths = []
        if REPORT_DIR.is_dir():
            paths.extend(REPORT_DIR.glob("*.pdf"))
        if REPORT_UPLOAD_DIR.is_dir():
            paths.extend(REPORT_UPLOAD_DIR.glob("*.pdf"))
    for path in sorted(paths):
        display_filename = path.name
        digest = None
        try:
            if path.parent == REPORT_UPLOAD_DIR and "--" in path.name:
                display_filename = path.name.split("--", 1)[1]
            data = path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            with connect() as connection:
                existing = connection.execute("SELECT id FROM documents WHERE sha256=?", (digest,)).fetchone()
            if existing:
                results.append({"id": existing[0], "sha256": digest, "filename": display_filename, "status": "already_imported"})
                continue
            doc_id = str(uuid4())
            publication_date, market, stock_code = _metadata(display_filename)
            parsed = parse_report(path, **report_parser_settings())
            if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise ValueError("研报 PDF 在解析期间发生变化，请重新导入。")
            # Parse outside the write transaction; OCR must not hold the writer
            # lock. A failed insert rolls back every page of this document.
            page_texts = parsed.page_texts
            chars = sum(map(len, page_texts))
            status = "indexed" if chars else "no_text"
            with connect() as connection:
                inserted = connection.execute(
                    """INSERT INTO documents
                       (id,sha256,filename,title,publication_date,market,stock_code,pages,extracted_chars,parse_status,source_path,imported_at,available_at,parser_metadata_json)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING""",
                    (doc_id, digest, display_filename, Path(display_filename).stem, publication_date, market, stock_code, len(page_texts), chars, status, str(path), utc_now(), publication_date, json_dump(parsed.metadata)),
                )
                if not inserted.rowcount:
                    existing = connection.execute("SELECT id FROM documents WHERE sha256=?", (digest,)).fetchone()
                    results.append({"id": existing[0], "sha256": digest, "filename": display_filename, "status": "already_imported"})
                    continue
                for page_number, text in enumerate(page_texts, start=1):
                    connection.execute(
                        "INSERT INTO document_pages(document_id,page_number,text) VALUES(?,?,?)",
                        (doc_id, page_number, text),
                    )
                    if text:
                        connection.execute(
                            "INSERT INTO document_pages_fts(document_id,page_number,text) VALUES(?,?,?)",
                            (doc_id, str(page_number), text),
                        )
            results.append({"id": doc_id, "sha256": digest, "filename": display_filename, "status": status, "pages": len(page_texts), "extracted_chars": chars, "parser_metadata": parsed.metadata})
        except Exception as exc:
            results.append({"filename": display_filename, "sha256": digest, "status": "failed", "reason": str(exc)[:300]})
    from .report_catalog import enqueue
    enqueue()
    return {
        "imported": sum(item["status"] in {"indexed", "no_text"} for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
        "results": results,
    }


def list_documents() -> list[dict[str, Any]]:
    with connect() as connection:
        rows = connection.execute(
            """SELECT id,filename,title,publication_date,market,stock_code,pages,extracted_chars,parse_status,imported_at,
                      stock_code_status,stock_code_confirmed_at,available_at,available_at_status,available_at_confirmed_at,
                      stock_code_source,stock_code_evidence_json,stock_code_model,stock_code_extracted_at,stock_code_prompt_version,
                      metadata_json,metadata_status,metadata_error,metadata_job_id,parser_metadata_json
               FROM documents ORDER BY publication_date DESC, filename"""
        ).fetchall()
        job_states = {row["id"]: dict(row) for row in connection.execute("SELECT id,state,message FROM jobs WHERE kind='report_metadata'")}
    from .db import json_load
    items = []
    for row in rows:
        item = dict(row)
        item["metadata"] = json_load(item.pop("metadata_json"))
        item["parser_metadata"] = json_load(item.pop("parser_metadata_json"))
        job = job_states.get(item["metadata_job_id"])
        if job and item["metadata_status"] != "ready":
            item["metadata_status"] = job["state"]
            if job["state"] == "failed" and not item["metadata_error"]:
                item["metadata_error"] = job["message"]
        items.append(item)
    return items


def search(query: str, as_of: str | None = None, stock_code: str | None = None, limit: int = 30, **options) -> dict[str, Any]:
    return report_search.search(query, as_of, stock_code, limit, **options)


def search_pages(query: str, as_of: str | None = None, stock_code: str | None = None, limit: int = 30, *, mode="exact", **options) -> list[dict[str, Any]]:
    return search(query, as_of, stock_code, limit, mode=mode, **options)["items"]


def search_source_catalog(query: str, as_of: str | None = None, stock_code: str | None = None, **options) -> dict[str, Any]:
    return report_search.search_source_catalog(query, as_of, stock_code, **options)


def read_page(
    document_id: str,
    page_number: int,
    *,
    as_of: str | None = None,
    stock_code: str | None = None,
    max_chars: int | None = 12000,
) -> dict[str, Any]:
    """Read one indexed source page and report its historical admissibility."""
    if page_number < 1:
        raise ValueError("研报页码必须是正整数")
    with connect() as connection:
        row = connection.execute(
            """SELECT d.id,d.sha256,d.filename,d.title,d.publication_date,d.market,d.stock_code,
                      d.stock_code_status,d.available_at,d.available_at_status,d.parse_status,
                      p.page_number,p.text
               FROM documents d JOIN document_pages p ON p.document_id=d.id
               WHERE d.id=? AND p.page_number=?""",
            (document_id, page_number),
        ).fetchone()
    if not row:
        raise KeyError("找不到研报页")

    result = {
        "document_id": row["id"],
        "sha256": row["sha256"],
        "filename": row["filename"],
        "title": row["title"],
        "publication_date": row["publication_date"],
        "market": row["market"],
        "stock_code": row["stock_code"],
        "security_binding_status": row["stock_code_status"],
        "available_at": row["available_at"],
        "availability_status": row["available_at_status"],
        "page_number": row["page_number"],
        "parse_status": row["parse_status"],
        "text": None,
        "original_characters": len(row["text"]),
        "truncated": False,
        "eligible_for_historical_screening": as_of is not None,
        "eligibility_reason": None if as_of else "未设置筛选截止日，不能判断历史可用性",
    }

    if as_of and (
        row["available_at_status"] != "confirmed"
        or not row["available_at"]
        or row["available_at"] > as_of
    ):
        result["eligible_for_historical_screening"] = False
        result["eligibility_reason"] = "研报首次可用日期未确认或晚于筛选截止日"
        return result
    if row["parse_status"] != "indexed":
        result["eligible_for_historical_screening"] = False
        result["eligibility_reason"] = "研报未成功建立可检索的页级文本"
        return result
    if stock_code and row["stock_code_status"] == "confirmed" and row["stock_code"] != stock_code:
        result["eligible_for_historical_screening"] = False
        result["eligibility_reason"] = "研报已确认绑定其他证券"
        return result
    if stock_code and row["stock_code_status"] != "confirmed":
        result["eligible_for_historical_screening"] = False
        result["eligibility_reason"] = "研报证券归属尚未确认"
        return result

    text = row["text"]
    if max_chars is not None:
        if max_chars < 1:
            raise ValueError("原文读取上限必须为正整数")
        result["truncated"] = len(text) > max_chars
        text = text[:max_chars]
    result["text"] = text
    return result


def _snippet(text: str, terms: list[str], length: int = 360) -> str:
    lowered = text.lower()
    positions = [lowered.find(term.lower()) for term in terms if lowered.find(term.lower()) >= 0]
    center = min(positions) if positions else 0
    start = max(0, center - length // 3)
    excerpt = " ".join(text[start : start + length].split())
    if start:
        excerpt = "…" + excerpt
    if start + length < len(text):
        excerpt += "…"
    return excerpt
