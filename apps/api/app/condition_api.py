from __future__ import annotations

from datetime import date
from typing import Any, Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import Field, field_validator

from . import market, news_library, news_sources
from .model_client import ModelRequestError
from .condition_contract import describe_filter, filter_object
from .condition_language import compile_plan
from .db import connect, json_dump, json_load, utc_now
from .models import StrictModel
from .rules import RuleError, combine, evaluate_filter, resolve_filter_expression

router = APIRouter(prefix="/api/v1/condition-drafts", tags=["自然语言条件"])


class DraftRequest(StrictModel):
    prompt: str = Field(min_length=1, max_length=4000)
    previous_draft_id: str | None = None
    library: Literal["technical", "news", "report"] | None = None
    source_document_id: str | None = None
    source_page: int | None = Field(default=None, ge=1)
    start_date: date | None = None
    end_date: date | None = None

    @field_validator("prompt")
    @classmethod
    def nonblank(cls, value: str):
        if not value.strip():
            raise ValueError("请先写下筛选要求")
        return value.strip()


class ConditionEdit(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    parameters: dict[str, Any] = Field(default_factory=dict)


class ConfirmRequest(StrictModel):
    edits: dict[str, ConditionEdit] = Field(default_factory=dict)


class PreviewRequest(ConfirmRequest):
    stock_code: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    as_of: str

    @field_validator("as_of")
    @classmethod
    def valid_date(cls, value: str):
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError("请使用有效的 YYYY-MM-DD 日期")
        return value


def fail(message: str, status=422):
    raise HTTPException(status, {"message": message, "code": "condition_draft_error"})


def read_draft(draft_id: str) -> dict:
    with connect() as connection:
        row = connection.execute("SELECT * FROM condition_drafts WHERE id=?", (draft_id,)).fetchone()
    if not row:
        fail("找不到这份条件草稿", 404)
    return {"id": row["id"], "prompt": row["prompt"], "created_at": row["created_at"], **json_load(row["plan_json"]), "saved": json_load(row["saved_json"]) if row["saved_json"] else None}


@router.post("")
def create_draft(payload: DraftRequest):
    previous = read_draft(payload.previous_draft_id) if payload.previous_draft_id else None
    previous_libraries = {item["library"] for item in previous["conditions"]} if previous else set()
    legacy_same_library = previous and previous.get("library_context") is None and previous_libraries == {payload.library}
    if previous and previous.get("library_context") != payload.library and not legacy_same_library:
        fail("不能把其他资料库的草稿当作本次补充的来源")
    source_document = None
    if payload.source_document_id:
        if payload.library != "report" or not payload.source_page:
            fail("研报来源需要在研报库提供有效页码")
        with connect() as connection:
            doc = connection.execute("SELECT d.id,d.title,d.sha256 FROM documents d JOIN document_pages p ON p.document_id=d.id WHERE d.id=? AND p.page_number=?", (payload.source_document_id, payload.source_page)).fetchone()
        if not doc:
            fail("来源研报或页码不存在", 404)
        source_document = {"document_id": doc[0], "title": doc[1], "sha256": doc[2], "page": payload.source_page}
    elif payload.source_page:
        fail("页码必须附带来源研报")
    news_matches = None
    if payload.library == "news" and (payload.start_date or payload.end_date):
        try:
            news_matches = news_library.match_news(payload.prompt, payload.start_date, payload.end_date)
        except news_sources.NewsError as exc:
            fail(str(exc), exc.status)
        except ModelRequestError as exc:
            fail(str(exc), 502)
    if news_matches is not None:
        plan = {"news_matches": news_matches, "conditions": [], "tree": None, "issues": [],
                "assumptions": [], "status": "matched", "source": "configured_llm",
                "model": None, "compiler_version": "news-date-match-v1"}
    else:
        plan = compile_plan(payload.prompt, payload.library)
    plan["library_context"] = payload.library
    plan["source_document"] = source_document or (previous.get("source_document") if previous else None)
    plan["previous_draft_id"] = payload.previous_draft_id
    plan["original_prompt"] = previous.get("original_prompt", previous["prompt"]) if previous else payload.prompt
    draft_id, now = str(uuid4()), utc_now()
    with connect() as connection:
        connection.execute("INSERT INTO condition_drafts(id,prompt,plan_json,created_at) VALUES(?,?,?,?)", (draft_id, payload.prompt, json_dump(plan), now))
    return read_draft(draft_id)


@router.get("")
def list_drafts(library: Literal["technical", "news", "report"] | None = None):
    with connect() as connection:
        rows = connection.execute("""SELECT id,prompt,created_at,saved_json FROM condition_drafts
            WHERE (? IS NULL OR json_extract(plan_json,'$.library_context')=? OR
                (json_extract(plan_json,'$.library_context') IS NULL AND json_array_length(plan_json,'$.conditions')>0
                 AND NOT EXISTS (SELECT 1 FROM json_each(plan_json,'$.conditions') item WHERE json_extract(item.value,'$.library')!=?)))
            ORDER BY rowid DESC LIMIT 30""", (library, library, library)).fetchall()
    return {"items": [{"id": row[0], "prompt": row[1], "created_at": row[2], "saved": bool(row[3])} for row in rows]}


@router.get("/{draft_id}")
def get_draft(draft_id: str):
    return read_draft(draft_id)


def edited_conditions(draft: dict, payload: ConfirmRequest) -> list[dict]:
    if draft["status"] != "ready":
        fail("请先补充未明确或未支持的要求；不能把不完整的描述保存为完整条件")
    keys = {item["key"] for item in draft["conditions"]}
    if set(payload.edits) - keys:
        fail("编辑包含不存在的条件")
    items = []
    for item in draft["conditions"]:
        edit = payload.edits.get(item["key"], ConditionEdit())
        try:
            expression = resolve_filter_expression(item["library"], item["expression"], edit.parameters)
        except RuleError as exc:
            fail(str(exc))
        if edit.name is not None and not edit.name.strip():
            fail("条件名称不能为空")
        if item["library"] == "technical" and expression.get("op") == "timeseries_filter" and not expression.get("summary"):
            expression["summary"] = item["source_quote"]
        contract = describe_filter(item["library"], expression)
        default_name = item["source_quote"] if item["library"] == "technical" and expression.get("op") == "timeseries_filter" else item["name"]
        items.append({**item, "name": edit.name.strip() if edit.name else (contract["summary"][:100] if edit.parameters else default_name), "expression": expression, "contract": contract})
    return items


@router.post("/{draft_id}/preview")
def preview_draft(draft_id: str, payload: PreviewRequest):
    draft = read_draft(draft_id)
    confirmation = ConfirmRequest(edits=payload.edits)
    if draft["saved"]:
        saved_confirmation = ConfirmRequest.model_validate(draft["saved"]["confirmation"])
        if payload.edits and confirmation != saved_confirmation:
            fail("这份草稿已确认保存，试算应使用已确认参数；如需调整，请到条件库创建新版本", 409)
        confirmation = saved_confirmation
    items = edited_conditions(draft, confirmation)
    profile = market.cached_profile()
    if profile.get("last_date") and payload.as_of > profile["last_date"]:
        fail(f"截止日不能晚于行情最新日期 {profile['last_date']}")
    bars = market.get_bars(payload.stock_code, payload.as_of, 500)
    expected_date = profile.get("last_date") if payload.as_of == profile.get("last_date") else market.latest_market_date(payload.as_of)
    stale = bool(bars and expected_date and bars[-1]["trade_date"] != expected_date)
    details = []
    for item in items:
        detail = evaluate_filter(item["expression"], bars) if item["library"] == "technical" else {"state": "unknown", "reason": item["contract"]["availability_label"]}
        if stale:
            detail.update({"state": "unknown", "reason": "该证券在所选市场交易日没有行情；不能用更早的价格代替当前判断"})
        details.append({**detail, "key": item["key"], "name": item["name"], "summary": item["contract"]["summary"], "effective_expression": item["expression"]})
    states = {item["key"]: item["state"] for item in details}

    def evaluate(node):
        return states[node["key"]] if node["op"] == "condition" else combine(node["op"], [evaluate(child) for child in node["children"]])

    return {"stock_code": payload.stock_code, "as_of": payload.as_of, "actual_date": bars[-1]["trade_date"] if bars else None, "state": evaluate(draft["tree"]), "details": details, "mode": "exploratory"}


@router.post("/{draft_id}/confirm")
def confirm_draft(draft_id: str, payload: ConfirmRequest):
    from .condition_names import check_condition_name, ConditionNameError
    draft = read_draft(draft_id)
    items = edited_conditions(draft, payload)
    confirmation = payload.model_dump()
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        saved = connection.execute("SELECT saved_json FROM condition_drafts WHERE id=?", (draft_id,)).fetchone()[0]
        if saved:
            result = json_load(saved)
            if result["confirmation"] != confirmation:
                fail("这份草稿已经保存。请在条件库创建新版本，或重新生成草稿", 409)
            return result
        now, refs, filters = utc_now(), {}, []
        for item in items:
            try:
                item["name"] = check_condition_name(connection, item["name"])
            except ConditionNameError as exc:
                raise HTTPException(exc.status, {"message": str(exc), "code": exc.code}) from exc
            asset_id = str(uuid4())
            provenance = {"created_by": "natural_language", "draft_id": draft_id,
                          "original_prompt": draft["original_prompt"], "prompt": draft["prompt"],
                          "source_quote": item["source_quote"], "source": draft["source"], "model": draft["model"],
                          "compiler_version": draft["compiler_version"], "assumptions": draft["assumptions"],
                          "library_context": draft.get("library_context"), "source_document": draft.get("source_document"),
                          "original_expression": next(c["expression"] for c in draft["conditions"] if c["key"] == item["key"]),
                          "confirmation_edits": confirmation["edits"].get(item["key"], {}), "confirmed_at": now}
            dsl = {"schema_version": "1.1", "kind": item["library"], "name": item["name"], "description": item["contract"]["summary"], "expression": item["expression"], "status": "validated", "provenance": provenance}
            connection.execute("INSERT INTO filters(id,library,name,description,version,dsl_json,created_at) VALUES(?,?,?,?,1,?,?)", (asset_id, item["library"], item["name"], dsl["description"], json_dump(dsl), now))
            connection.execute("INSERT INTO audit_events(action,entity_type,entity_id,version,details_json,created_at) VALUES('confirm_natural_language','filter',?,1,?,?)", (asset_id, json_dump(provenance), now))
            refs[item["key"]] = {"op": "filter_ref", "filter_id": asset_id, "version": 1, "score_weight": 1}
            filters.append(filter_object(connection.execute("SELECT * FROM filters WHERE id=?", (asset_id,)).fetchone()))

        def bind(node):
            return refs[node["key"]] if node["op"] == "condition" else {"op": node["op"], "children": [bind(child) for child in node["children"]]}

        result = {"filters": filters, "tree": bind(draft["tree"]), "confirmation": confirmation, "confirmed_at": now}
        connection.execute("UPDATE condition_drafts SET saved_json=? WHERE id=?", (json_dump(result), draft_id))
    return result
