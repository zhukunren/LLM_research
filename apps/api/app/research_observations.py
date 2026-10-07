"""User-maintained research candidates, independent of screening decisions."""
from __future__ import annotations

from typing import Literal
from uuid import uuid4

from pydantic import Field, field_validator, model_validator

from . import market
from .db import connect, json_dump, json_load, utc_now
from .screening_contracts import ContractModel


WatchStatus = Literal["watching", "priority", "ended"]


class CandidateError(ValueError):
    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


class CandidateInput(ContractModel):
    request_id: str = Field(min_length=1, max_length=100)
    conversation_id: str = Field(min_length=1, max_length=100)
    source_message_id: str = Field(min_length=1, max_length=100)
    stock_code: str = Field(pattern=r"^[A-Z0-9]{1,16}\.[A-Z]{1,6}$")
    note: str = Field(default="", max_length=2000)
    verification: str = Field(default="", max_length=2000)
    invalidation: str = Field(default="", max_length=2000)

    @field_validator("stock_code", mode="before")
    @classmethod
    def canonical_code(cls, value):
        return value.strip().upper() if isinstance(value, str) else value


class CandidatePatch(ContractModel):
    revision: int = Field(ge=1)
    status: WatchStatus | None = None
    note: str | None = Field(default=None, max_length=2000)
    verification: str | None = Field(default=None, max_length=2000)
    invalidation: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def validate_changes(self):
        changes = self.model_fields_set - {"revision"}
        if not changes or any(getattr(self, field) is None for field in changes):
            raise ValueError("请提供要修改的状态或记录，记录内容可以为空字符串。")
        return self


def _payload(row, name: str = "") -> dict:
    value = dict(row)
    value.pop("request_json", None)
    value["source_refs"] = json_load(value.pop("source_refs_json"))
    raw_scope = value.pop("source_scope_json")
    value["scope"] = json_load(raw_scope) if raw_scope else None
    value["as_of"] = value.pop("source_as_of")
    value["source_kind"] = "research_candidate"
    value["name"] = value.pop("name", name)
    return value


def _read_source(connection, payload: CandidateInput):
    conversation = connection.execute("SELECT workflow_type,project_id FROM conversations WHERE id=?", (payload.conversation_id,)).fetchone()
    if not conversation:
        raise CandidateError("找不到来源研究对话。", 404)
    if conversation["workflow_type"] != "research":
        raise CandidateError("研究候选必须来自研究对话，筛选批次请在筛选批次中跟踪。")
    message = connection.execute("SELECT * FROM conversation_messages WHERE id=? AND conversation_id=? AND role='assistant'", (payload.source_message_id, payload.conversation_id)).fetchone()
    if not message:
        raise CandidateError("找不到该研究对话的助手答复，不能保存这条来源。", 404)
    if not message["content"].strip():
        raise CandidateError("来源答复没有可保存的研究文字。")
    turn = None
    key = message["client_message_id"] or ""
    if key.startswith("assistant:"):
        turn = connection.execute("SELECT workflow_type,state,response_text,research_scope_json,research_scope_revision FROM conversation_turns WHERE id=? AND conversation_id=?", (key[len("assistant:"):], payload.conversation_id)).fetchone()
        if not turn:
            raise CandidateError("来源答复的研究回合记录缺失，不能保存为观察候选。", 409)
    else:
        # Some historical messages lack the client key. Only an unambiguous
        # recorded completion with identical text and timestamp proves their
        # origin; role/content alone cannot distinguish an error message.
        matches = connection.execute("""SELECT workflow_type,state,response_text,research_scope_json,research_scope_revision
            FROM conversation_turns WHERE conversation_id=? AND response_text=?
            AND julianday(updated_at)=julianday(?)""", (payload.conversation_id, message["content"], message["created_at"])).fetchall() if not key else []
        if len(matches) != 1:
            raise CandidateError("旧答复缺少可核验的成功研究回合，请完成一次研究后再保存观察候选。", 409)
        turn = matches[0]
    if turn and turn["workflow_type"] != "research":
        raise CandidateError("这条答复产生于条件选股流程，不能作为研究候选的来源。")
    if turn["state"] != "succeeded" or turn["response_text"] != message["content"]:
        raise CandidateError("只能将成功完成的研究答复保存为观察候选，请先完成当前研究。", 409)
    raw_scope = turn["research_scope_json"] if turn else None
    scope = (json_load(raw_scope) or None) if raw_scope else None
    return conversation, message, scope, turn["research_scope_revision"] if turn and scope else None


def create(payload: CandidateInput) -> dict:
    request_json = json_dump(payload.model_dump(mode="json"))
    with connect() as connection:
        # Checking the retry before looking up current sources makes a lost
        # response replay safe even after the source conversation changes later.
        existing = connection.execute("SELECT * FROM research_observation_candidates WHERE request_id=?", (payload.request_id,)).fetchone()
        if existing:
            if existing["request_json"] != request_json:
                raise CandidateError("相同加入观察请求不能更换来源、股票或记录内容。", 409)
            name = connection.execute("SELECT name FROM security_catalog WHERE stock_code=?", (existing["stock_code"],)).fetchone()
            return _payload(existing, name[0] if name else "")
        _read_source(connection, payload)
        known = connection.execute("SELECT name FROM security_catalog WHERE stock_code=?", (payload.stock_code,)).fetchone()
    if not known and not market.get_bars(payload.stock_code, limit=1):
        raise CandidateError("该股票不在本地证券资料或行情中，请选择已认可的证券代码。")
    now, candidate_id = utc_now(), str(uuid4())
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute("SELECT * FROM research_observation_candidates WHERE request_id=?", (payload.request_id,)).fetchone()
        if existing:
            if existing["request_json"] != request_json:
                raise CandidateError("相同加入观察请求不能更换来源、股票或记录内容。", 409)
            return _payload(existing, known[0] if known else "")
        conversation, message, scope, scope_revision = _read_source(connection, payload)
        connection.execute("""INSERT INTO research_observation_candidates
            (id,request_id,request_json,conversation_id,source_message_id,source_text,source_message_created_at,
             source_refs_json,project_id,source_scope_json,source_scope_revision,source_scope_status,source_as_of,
             stock_code,note,verification,invalidation,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
            candidate_id, payload.request_id, request_json, payload.conversation_id, payload.source_message_id,
            message["content"], message["created_at"], message["source_refs_json"], conversation["project_id"],
            json_dump(scope) if scope is not None else None, scope_revision, "frozen" if scope is not None else "unknown",
            scope.get("as_of") if isinstance(scope, dict) else None,
            payload.stock_code, payload.note, payload.verification, payload.invalidation, now, now,
        ))
        row = connection.execute("SELECT * FROM research_observation_candidates WHERE id=?", (candidate_id,)).fetchone()
    return _payload(row, known[0] if known else "")


def list_candidates(query: str = "", status: WatchStatus | None = None, offset: int = 0, limit: int = 30,
                    sort: Literal["updated", "priority", "name", "verification"] = "updated", needs_verification: bool = False) -> dict:
    query = query.strip()[:100]
    clauses, parameters = [], []
    if query:
        clauses.append("(instr(lower(c.stock_code),lower(?))>0 OR instr(lower(coalesce(s.name,'')),lower(?))>0 OR instr(lower(c.note),lower(?))>0)")
        parameters.extend([query] * 3)
    if status:
        clauses.append("c.status=?")
        parameters.append(status)
    if needs_verification:
        clauses.append("c.status!='ended' AND trim(c.verification)=''")
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    source = " FROM research_observation_candidates c LEFT JOIN security_catalog s ON s.stock_code=c.stock_code"
    order = {
        "updated": "c.updated_at DESC,c.rowid DESC",
        "priority": "(c.status='priority') DESC,c.updated_at DESC,c.rowid DESC",
        "name": "coalesce(nullif(s.name,''),c.stock_code),c.stock_code,c.id",
        "verification": "(c.status='ended'),(trim(c.verification)='') DESC,(c.status='priority') DESC,c.updated_at DESC,c.rowid DESC",
    }[sort]
    with connect() as connection:
        total = connection.execute("SELECT count(*)" + source + where, parameters).fetchone()[0]
        rows = connection.execute("SELECT c.*,coalesce(s.name,'') name" + source + where + " ORDER BY " + order + " LIMIT ? OFFSET ?", (*parameters, limit, offset)).fetchall()
    return {"items": [_payload(row) for row in rows], "total": total}


def get(candidate_id: str) -> dict:
    """Read a known record directly, independent of list filters and pagination."""
    with connect() as connection:
        row = connection.execute(
            "SELECT c.*,coalesce(s.name,'') name FROM research_observation_candidates c "
            "LEFT JOIN security_catalog s ON s.stock_code=c.stock_code WHERE c.id=?",
            (candidate_id,),
        ).fetchone()
    if not row:
        raise CandidateError("找不到研究候选。", 404)
    return _payload(row)


def patch(candidate_id: str, payload: CandidatePatch) -> dict:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT * FROM research_observation_candidates WHERE id=?", (candidate_id,)).fetchone()
        if not row:
            raise CandidateError("找不到研究候选。", 404)
        if row["revision"] != payload.revision:
            raise CandidateError("观察记录已更新，请重新加载后再保存，避免覆盖较新的修改。", 409)
        fields = payload.model_dump(exclude_unset=True)
        fields.pop("revision")
        assignments = ",".join(f"{field}=?" for field in fields)
        connection.execute(f"UPDATE research_observation_candidates SET {assignments},revision=revision+1,updated_at=? WHERE id=?", (*fields.values(), utc_now(), candidate_id))
        updated = connection.execute("SELECT c.*,coalesce(s.name,'') name FROM research_observation_candidates c LEFT JOIN security_catalog s ON s.stock_code=c.stock_code WHERE c.id=?", (candidate_id,)).fetchone()
    return _payload(updated)
