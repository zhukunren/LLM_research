"""Local evidence discovery, bounded reading and original-text quote location."""
from __future__ import annotations

from datetime import date, timedelta
import re
from typing import Any

from . import documents
from . import disclosures
from .db import connect

MAX_CHUNK_CHARS = 12_000


def list_disclosure_sources(stock_code: str, as_of: str, *, offset=0, limit=20) -> dict:
    _dates(as_of, None)
    result = disclosures.list_versions(stock_code=stock_code, as_of=as_of, observed_by=as_of, offset=offset, limit=limit)
    return {"items": [{"source_type": "disclosure", "source_id": item["id"], "stock_code": stock_code,
                      "title": item["metadata"]["title"], "available_at": item["metadata"]["publication_date"],
                      "publication_at": item["metadata"]["publication_date"], "page_count": item["pages"],
                      "report_period": item["metadata"]["report_period"], "source_sha256": item["sha256"],
                      "source_version": item["version"]} for item in result["items"]],
            "total": result["total"], "next_offset": offset + len(result["items"]) if offset + len(result["items"]) < result["total"] else None}


def read_disclosure_chunk(source_id: str, page_number: int, stock_code: str, as_of: str, *, offset=0, limit=MAX_CHUNK_CHARS) -> dict:
    _dates(as_of, None)
    if offset < 0 or not 1 <= limit <= MAX_CHUNK_CHARS:
        raise EvidenceSourceError("invalid_chunk", "原文读取范围无效")
    try:
        chunk = disclosures.read_page(source_id, page_number, as_of=as_of, offset=offset, limit=limit)
    except (disclosures.DisclosureError, ValueError, OSError) as exc:
        raise EvidenceSourceError("disclosure_unavailable", str(exc)) from exc
    meta = chunk["classification"]
    from .financial_contracts import timestamp, ZONE
    if timestamp(chunk["first_observed_at"]).astimezone(ZONE).date().isoformat() > as_of:
        raise EvidenceSourceError("historical_disclosure_missing", "此原文版本在截止日后才被平台观察到，不作为严格历史依据")
    if meta["stock_code"] != stock_code:
        raise EvidenceSourceError("wrong_company", "原文不属于指定公司")
    return {**chunk, "stock_code": stock_code, "title": meta["title"], "available_at": meta["publication_date"],
            "publication_at": meta["publication_date"], "source_sha256": chunk["sha256"], "source_version": chunk["version"],
            "as_of": as_of}


class EvidenceSourceError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def _dates(as_of: str, lookback_days: int | None) -> tuple[str, str | None]:
    try:
        cutoff = date.fromisoformat(as_of)
    except (ValueError, TypeError) as exc:
        raise EvidenceSourceError("invalid_cutoff", "资料读取必须指定有效截止日") from exc
    if lookback_days is not None and (type(lookback_days) is not int or not 1 <= lookback_days <= 3650):
        raise EvidenceSourceError("invalid_lookback", "资料回溯天数无效")
    return cutoff.isoformat(), (cutoff - timedelta(days=lookback_days)).isoformat() if lookback_days else None


def list_report_sources(
    stock_code: str, as_of: str, *, lookback_days: int | None = None, offset: int = 0, limit: int = 30,
    allowed_source_ids: frozenset[str] | None = None,
) -> dict[str, Any]:
    cutoff, earliest = _dates(as_of, lookback_days)
    if not isinstance(stock_code, str) or not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", stock_code):
        raise EvidenceSourceError("invalid_security", "资料读取必须绑定明确证券")
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 50:
        raise EvidenceSourceError("invalid_page", "资料列表分页范围无效")
    predicate = """material_kind='report' AND stock_code=? AND stock_code_status='confirmed' AND parse_status='indexed'
                   AND available_at_status='confirmed' AND available_at IS NOT NULL AND available_at<=?"""
    params: list[Any] = [stock_code, cutoff]
    if allowed_source_ids is not None:
        predicate += " AND id IN (" + ",".join("?" for _ in allowed_source_ids) + ")" if allowed_source_ids else " AND 0"
        params.extend(sorted(allowed_source_ids))
    if earliest:
        predicate += " AND available_at>=?"
        params.append(earliest)
    with connect() as connection:
        total = connection.execute(f"SELECT COUNT(*) FROM documents WHERE {predicate}", params).fetchone()[0]
        rows = connection.execute(
            f"""SELECT id,title,stock_code,publication_date,available_at,pages
                FROM documents WHERE {predicate} ORDER BY available_at DESC,id LIMIT ? OFFSET ?""",
            [*params, limit, offset],
        ).fetchall()
    return dict(
        items=[dict(source_type="report", source_id=row["id"], title=row["title"],
                    stock_code=row["stock_code"], publication_at=row["publication_date"],
                    available_at=row["available_at"], page_count=row["pages"]) for row in rows],
        total=total, offset=offset, next_offset=offset + len(rows) if offset + len(rows) < total else None,
        coverage=dict(scope="eligible_indexed_local_reports", listed=len(rows), total=total,
                      read_pages=0, corpus_read_complete=False),
    )


def read_report_chunk(
    source_id: str, page_number: int, stock_code: str, as_of: str, *,
    offset: int = 0, limit: int = MAX_CHUNK_CHARS, lookback_days: int | None = None,
) -> dict[str, Any]:
    cutoff, earliest = _dates(as_of, lookback_days)
    if not isinstance(stock_code, str) or not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", stock_code):
        raise EvidenceSourceError("invalid_security", "资料读取必须绑定明确证券")
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= MAX_CHUNK_CHARS:
        raise EvidenceSourceError("invalid_chunk", "原文分块范围无效")
    try:
        page = documents.read_page(source_id, page_number, as_of=cutoff, stock_code=stock_code, max_chars=None)
    except (KeyError, ValueError) as exc:
        raise EvidenceSourceError("source_page_not_found", "找不到指定原文页") from exc
    if not page["eligible_for_historical_screening"] or page["text"] is None:
        raise EvidenceSourceError("source_ineligible", page["eligibility_reason"] or "资料不符合本次范围")
    if earliest and page["available_at"] < earliest:
        raise EvidenceSourceError("source_outside_lookback", "资料早于本次回溯时间范围")
    text = page["text"]
    if offset > len(text):
        raise EvidenceSourceError("offset_out_of_range", "原文偏移超过页面长度")
    end = min(len(text), offset + limit)
    return dict(
        source_type="report", source_id=source_id, stock_code=stock_code, title=page["title"],
        publication_at=page["publication_date"], available_at=page["available_at"],
        page_number=page_number, char_start=offset, char_end=end, text=text[offset:end],
        original_characters=len(text), next_offset=end if end < len(text) else None,
        coverage=dict(read_characters=end-offset, page_complete=offset == 0 and end == len(text),
                      corpus_read_complete=False),
    )


def normalize_with_offsets(text: str) -> tuple[str, list[tuple[int, int]]]:
    """Collapse whitespace without losing the original character intervals."""
    normalized: list[str] = []
    spans: list[tuple[int, int]] = []
    for index, character in enumerate(text):
        if character.isspace():
            if normalized and normalized[-1] == " ":
                spans[-1] = (spans[-1][0], index + 1)
            else:
                normalized.append(" ")
                spans.append((index, index + 1))
        else:
            normalized.append(character)
            spans.append((index, index + 1))
    return "".join(normalized), spans


def locate_quote(chunk: dict[str, Any], quote: str, *, start_hint: int | None = None) -> dict[str, Any]:
    normalized, spans = normalize_with_offsets(chunk["text"])
    target = normalize_with_offsets(quote)[0].strip()
    if not target:
        raise EvidenceSourceError("empty_quote", "引用原文不能为空")
    def join_han_gaps(value, offsets):
        keep = [index for index, character in enumerate(value) if not (character == " " and 0 < index < len(value) - 1
            and '\u3400' <= value[index - 1] <= '\u9fff' and '\u3400' <= value[index + 1] <= '\u9fff')]
        return "".join(value[index] for index in keep), [offsets[index] for index in keep]

    compact, compact_spans = join_han_gaps(normalized, spans)
    compact_target, _ = join_han_gaps(target, [(index, index + 1) for index in range(len(target))])
    matches = set()
    # PDF layout often wraps a Chinese word in the middle. Ignore only Han-to-
    # Han whitespace, retaining exact source spans and ambiguity across both forms.
    for value, offsets, needle in ((normalized, spans, target), (compact, compact_spans, compact_target)):
        position = value.find(needle)
        while position != -1:
            start, end = offsets[position][0], offsets[position + len(needle) - 1][1]
            absolute_start = chunk["char_start"] + start
            if start_hint is None or absolute_start == start_hint:
                matches.add((start, end))
            position = value.find(needle, position + 1)
    if len(matches) != 1:
        raise EvidenceSourceError("quote_not_unique" if matches else "quote_not_found", "引用未在已读原文中唯一定位")
    start, end = next(iter(matches))
    return dict(source_type=chunk["source_type"], source_id=chunk["source_id"],
                stock_code=chunk["stock_code"], page_number=chunk["page_number"],
                char_start=chunk["char_start"] + start, char_end=chunk["char_start"] + end,
                quote=chunk["text"][start:end])
