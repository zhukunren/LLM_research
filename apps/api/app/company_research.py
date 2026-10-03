"""Company dossiers and source-located evidence, bounded by an explicit research date."""
from __future__ import annotations

from datetime import date
import hashlib
from typing import Literal
from uuid import uuid4

from pydantic import Field

from . import evidence_sources, market, news_sources, research_projects
from .db import connect, json_dump, json_load, utc_now
from .screening_contracts import ContractModel


class EvidenceReference(ContractModel):
    kind: Literal["news", "report"]
    source_id: str = Field(min_length=1, max_length=100)
    page_number: int = Field(default=1, ge=1, le=5000)
    offset: int = Field(default=0, ge=0)
    quote: str = Field(min_length=3, max_length=3000)
    start_hint: int | None = Field(default=None, ge=0)
    stance: Literal["supports", "contradicts", "context"] = "supports"


class CreateClaim(ContractModel):
    note_revision: int = Field(ge=1)
    stock_code: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    statement: str = Field(min_length=1, max_length=2000)
    kind: Literal["fact", "forecast", "inference"]
    as_of: date
    evidence: list[EvidenceReference] = Field(min_length=1, max_length=4)
    request_id: str = Field(min_length=1, max_length=100)


def _require_company(connection, project_id: str, code: str, *, writable=False):
    research_projects._require_project(connection, project_id, writable=writable)
    if not connection.execute(
        "SELECT 1 FROM research_project_companies WHERE project_id=? AND stock_code=?", (project_id, code)
    ).fetchone():
        raise research_projects.ProjectError("这家公司尚未加入当前研究项目。", 404)


def sources(project_id: str, code: str, kind: str, as_of: str, offset=0, limit=20) -> dict:
    with connect() as connection:
        _require_company(connection, project_id, code)
    try:
        listing = evidence_sources.list_report_sources if kind == "report" else news_sources.list_news_sources
        return {**listing(code, as_of, offset=offset, limit=limit), "as_of": as_of}
    except evidence_sources.EvidenceSourceError as exc:
        raise research_projects.ProjectError(str(exc)) from exc


def source(project_id: str, code: str, kind: str, source_id: str, page: int, as_of: str, offset=0) -> dict:
    with connect() as connection:
        _require_company(connection, project_id, code)
    try:
        reading = evidence_sources.read_report_chunk if kind == "report" else news_sources.read_news_chunk
        chunk = reading(source_id, page, code, as_of, offset=offset, limit=12000)
        with connect() as connection:
            if kind == "report":
                fingerprint = connection.execute("SELECT sha256 FROM documents WHERE id=?", (source_id,)).fetchone()[0]
                version = None
            else:
                item = news_sources.get_item(source_id)
                fingerprint, version = hashlib.sha256(item["body"].encode("utf-8")).hexdigest(), item["version"]
        return {**chunk, "source_sha256": fingerprint, "source_version": version, "as_of": as_of,
                "offset_unit": "unicode_codepoints", "verification": "source_scope_checked"}
    except evidence_sources.EvidenceSourceError as exc:
        raise research_projects.ProjectError(str(exc)) from exc


def dossier(project_id: str, code: str, as_of: str) -> dict:
    with connect() as connection:
        _require_company(connection, project_id, code)
        name = connection.execute("SELECT name FROM security_catalog WHERE stock_code=?", (code,)).fetchone()
        note_count = connection.execute(
            """SELECT count(*) FROM research_notes n WHERE project_id=? AND (stock_code=? OR EXISTS(
               SELECT 1 FROM research_claims c WHERE c.note_id=n.id AND c.stock_code=?))""", (project_id, code, code)
        ).fetchone()[0]
        pending = connection.execute(
            """SELECT count(*) FROM documents WHERE stock_code=? AND
               (stock_code_status!='confirmed' OR available_at_status!='confirmed' OR available_at IS NULL)""", (code,)
        ).fetchone()[0]
    fingerprint = market.source_fingerprint()
    profile = market.cached_profile()
    bars = market.get_bars(code, as_of, 180)
    if market.source_fingerprint() != fingerprint:
        raise research_projects.ProjectError("行情正在更新，请重新加载公司研究。", 409)
    return {"stock_code": code, "name": name[0] if name else "", "as_of": as_of,
            "bars": bars, "market_as_of": bars[-1]["trade_date"] if bars else None,
            "market_quality": {key: profile.get(key, "unknown") for key in ("price_basis", "volume_unit", "amount_unit")},
            "invalid_bars": sum(not bar["quality_valid"] for bar in bars),
            "news": sources(project_id, code, "news", as_of), "reports": sources(project_id, code, "report", as_of),
            "pending_report_count": pending, "note_count": note_count,
            "coverage_note": "仅覆盖已接入的本地资料；没有资料不代表没有事件。未确认归属或首次可得日期的研报不用于历史证据。"}


def _claim_payload(row) -> dict:
    payload = dict(row)
    references = json_load(payload.pop("evidence_json"))
    payload.pop("request_json", None)
    payload["evidence"] = [{key: value for key, value in item.items() if key != "text"} for item in references]
    payload["verification"] = "quote_located"
    payload["semantic_support_verified"] = False
    return payload


def create_claim(project_id: str, note_id: str, payload: CreateClaim) -> dict:
    identity = json_dump(payload.model_dump(mode="json", exclude={"request_id"}))
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        research_projects._require_project(connection, project_id, writable=True)
        note = connection.execute("SELECT revision,stock_code FROM research_notes WHERE id=? AND project_id=?", (note_id, project_id)).fetchone()
        if not note:
            raise research_projects.ProjectError("找不到研究笔记。", 404)
        old = connection.execute("SELECT * FROM research_claims WHERE note_id=? AND request_id=?", (note_id, payload.request_id)).fetchone()
        if old:
            if old["request_json"] != identity:
                raise research_projects.ProjectError("相同保存请求不能使用不同的判断或引用。", 409)
            return _claim_payload(old)
        if note["revision"] != payload.note_revision:
            raise research_projects.ProjectError("笔记已更新，请重新打开依据编辑并核对当前内容。", 409)
        if note["stock_code"] and note["stock_code"] != payload.stock_code:
            raise research_projects.ProjectError("依据的公司应与笔记关联公司一致。")
        _require_company(connection, project_id, payload.stock_code, writable=True)
        references, seen = [], set()
        for reference in payload.evidence:
            chunk = source(project_id, payload.stock_code, reference.kind, reference.source_id, reference.page_number, payload.as_of.isoformat(), reference.offset)
            try:
                located = evidence_sources.locate_quote(chunk, reference.quote, start_hint=reference.start_hint)
            except evidence_sources.EvidenceSourceError as exc:
                raise research_projects.ProjectError(str(exc)) from exc
            key = (reference.kind, reference.source_id, reference.page_number, located["char_start"], located["char_end"])
            if key in seen:
                raise research_projects.ProjectError("同一判断不能重复附加相同原文。")
            seen.add(key)
            references.append({**chunk, "quote": located["quote"], "quote_start": located["char_start"],
                               "quote_end": located["char_end"], "stance": reference.stance,
                               "chunk_sha256": hashlib.sha256(chunk["text"].encode("utf-8")).hexdigest()})
        claim_id = str(uuid4())
        connection.execute(
            """INSERT INTO research_claims(id,note_id,note_revision,stock_code,statement,kind,as_of,request_id,
               request_json,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (claim_id, note_id, payload.note_revision, payload.stock_code, payload.statement, payload.kind,
             payload.as_of.isoformat(), payload.request_id, identity, json_dump(references), utc_now()),
        )
        research_projects._touch(connection, project_id)
        return _claim_payload(connection.execute("SELECT * FROM research_claims WHERE id=?", (claim_id,)).fetchone())


def claims(project_id: str, note_id: str, offset=0, limit=20) -> dict:
    with connect() as connection:
        research_projects._require_project(connection, project_id)
        if not connection.execute("SELECT 1 FROM research_notes WHERE id=? AND project_id=?", (note_id, project_id)).fetchone():
            raise research_projects.ProjectError("找不到研究笔记。", 404)
        total = connection.execute("SELECT count(*) FROM research_claims WHERE note_id=?", (note_id,)).fetchone()[0]
        rows = connection.execute("SELECT * FROM research_claims WHERE note_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?", (note_id, limit, offset)).fetchall()
    return {"items": [_claim_payload(row) for row in rows], "total": total,
            "next_offset": offset + len(rows) if offset + len(rows) < total else None}


def saved_evidence(project_id: str, claim_id: str, index: int) -> dict:
    with connect() as connection:
        research_projects._require_project(connection, project_id)
        row = connection.execute(
            """SELECT c.evidence_json FROM research_claims c JOIN research_notes n ON n.id=c.note_id
               WHERE c.id=? AND n.project_id=?""", (claim_id, project_id)
        ).fetchone()
    references = json_load(row[0]) if row else []
    if not 0 <= index < len(references):
        raise research_projects.ProjectError("找不到保存的原文依据。", 404)
    return {**references[index], "snapshot": True, "semantic_support_verified": False}
