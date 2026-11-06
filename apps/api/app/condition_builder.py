"""Typed reusable conditions, with a recorded single-company validation before saving."""
from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime
import time
from typing import Annotated, Literal, Union
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from pydantic import Field, field_validator

from . import market, patterns, screening_templates
from .condition_contract import filter_object
from .condition_names import ConditionNameError, check_condition_name, normalized_condition_name
from .db import connect, json_dump, json_load, utc_now
from .evidence_analysis import EvidenceRequest
from .screening_contracts import ContractModel

router = APIRouter(prefix="/api/v1/condition-builder", tags=["可复用条件"])


class TechnicalDefinition(ContractModel):
    kind: Literal["technical"]
    template_id: str = Field(min_length=1, max_length=100)
    template_version: int = Field(ge=1, strict=True)
    parameters: dict[str, int | float]

    @field_validator("parameters", mode="before")
    @classmethod
    def numeric_parameters(cls, value):
        return screening_templates.ApplyTemplateRequest.numeric_parameters(value)


class PatternDefinition(ContractModel):
    kind: Literal["pattern"]
    pattern_id: str = Field(min_length=1, max_length=100)
    pattern_version: int = Field(ge=1, strict=True)
    minimum_similarity: float = Field(ge=0, le=100, strict=True)
    match_mode: Literal["current", "recent"]
    recent_bars: int = Field(ge=1, le=120, strict=True)


class EvidenceDefinition(ContractModel):
    kind: Literal["news", "report"]
    question: str = Field(min_length=1, max_length=1000)
    fact_requirement: Literal["actual", "forecast", "any"]
    event_requirement: Literal["any", "planned", "in_progress", "completed"] = "any"
    lookback_calendar_days: int = Field(ge=1, le=3650, strict=True)
    numeric_requirement: bool = Field(default=False, strict=True)
    quantifier: Literal["exists", "all"] = "exists"
    minimum_independent_events: int = Field(default=1, ge=1, le=100, strict=True)


Definition = Annotated[Union[TechnicalDefinition, PatternDefinition, EvidenceDefinition], Field(discriminator="kind")]


class PreviewRequest(ContractModel):
    definition: Definition
    stock_code: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    as_of: date


class SaveRequest(ContractModel):
    builder_draft_id: str = Field(min_length=1, max_length=100)
    definition: Definition
    name: str = Field(min_length=1, max_length=100)


def fail(message: str, status: int = 422):
    raise HTTPException(status, {"code": "condition_builder_error", "message": message})


def question_expression(definition: EvidenceDefinition) -> dict:
    return {"op": "evidence_query", "evaluation_mode": "question",
            "lookback_calendar_days": definition.lookback_calendar_days,
            **definition.model_dump(exclude={"kind", "lookback_calendar_days"})}


def evaluate_question(library: str, expression: dict, stock_code: str, as_of: str, *, active=lambda: True) -> dict:
    from . import news_adapter, report_adapter
    request = EvidenceRequest.model_validate({key: value for key, value in expression.items()
                                             if key not in {"op", "evaluation_mode", "lookback_calendar_days"}})
    condition = {"condition_id": "reusable_sample", "expression": request.model_dump()}
    reference = {"reference_id": "sample"}
    evaluator = news_adapter.evaluate if library == "news" else report_adapter.evaluate
    result = evaluator(condition, reference, stock_code, as_of,
                       lookback_days=expression["lookback_calendar_days"], active=active)
    data = result.model_dump(mode="json")
    return {"state": data["state"], "reason": data["explanation"],
            "evaluation_status": data["evaluation_status"], "reason_code": data["reason_code"],
            "evidence": data["actual_values"].get("evidence", []),
            "coverage": data["actual_values"].get("coverage", {}), "evidence_refs": data["evidence_refs"]}


@router.post("/preview")
def preview(payload: PreviewRequest):
    definition = payload.definition
    as_of = payload.as_of.isoformat()
    if payload.as_of > datetime.now(ZoneInfo("Asia/Shanghai")).date():
        fail("样本日期不能晚于今天")
    fingerprint = market.source_fingerprint()
    expression, source = None, None
    try:
        if isinstance(definition, TechnicalDefinition):
            if definition.template_id in screening_templates.COMBINATIONS:
                fail("请创建单条条件；多条规则的关系请在条件组合中编排")
            template, expression, description = screening_templates.compile_template(
                definition.template_id, definition.template_version, definition.parameters)
            result = screening_templates.preview_template(definition.template_id,
                screening_templates.TemplatePreviewRequest(version=definition.template_version,
                    parameters=definition.parameters, stock_code=payload.stock_code, as_of=payload.as_of))
        elif isinstance(definition, PatternDefinition):
            with connect() as connection:
                row = connection.execute("SELECT name,pattern_json FROM patterns WHERE id=? AND version=?",
                                         (definition.pattern_id, definition.pattern_version)).fetchone()
            if not row:
                fail("找不到所选形态版本，请重新选择", 404)
            source = {"name": row["name"], "content": json_load(row["pattern_json"])}
            if definition.match_mode == "recent" and source["content"].get("algorithm_version") not in {"path-window-v2", "candle-window-v2"}:
                fail("此目标使用旧版匹配算法，仅支持当前窗口；近期匹配请在形态工作台另存新版本")
            template = {**source["content"], "id": definition.pattern_id, "name": source["name"], "version": definition.pattern_version}
            description = f"与{source['name']} v{definition.pattern_version}的相似度不低于{definition.minimum_similarity:g}分"
            profile = market.cached_profile()
            if profile.get("last_date") and as_of > profile["last_date"]:
                fail(f"行情只更新到 {profile['last_date']}")
            required = template["target_bars"] + (definition.recent_bars - 1 if definition.match_mode == "recent" else 0)
            bars = market.get_bars(payload.stock_code, as_of, min(500, required))
            effective = profile.get("last_date") if as_of == profile.get("last_date") else market.latest_market_date(as_of)
            if not bars or effective and bars[-1]["trade_date"] != effective:
                result = {"state": "unknown", "reason": "样本缺少目标交易日行情，不能用更早价格代替判断。"}
            else:
                result = patterns.score_window(template, bars, match_mode=definition.match_mode, recent_bars=definition.recent_bars)
                if result["state"] != "unknown":
                    result["state"] = "true" if result["similarity"] >= definition.minimum_similarity else "false"
                result["threshold"] = definition.minimum_similarity
                result["actual_date"] = bars[-1]["trade_date"]
        else:
            expression = question_expression(definition)
            description = definition.question
            started = time.monotonic()
            result = evaluate_question(definition.kind, expression, payload.stock_code, as_of,
                                       active=lambda: time.monotonic() - started < 90)
    except HTTPException:
        raise
    except ValueError as exc:
        fail(str(exc))
    except Exception as exc:
        fail(f"样本核验未完成：{type(exc).__name__}，请重试。", 502)
    if definition.kind in {"technical", "pattern"} and market.source_fingerprint() != fingerprint:
        fail("试算期间行情更新了，请重新试算", 409)
    draft_id, now = str(uuid4()), utc_now()
    plan = {"builder_version": 1, "definition": definition.model_dump(mode="json"), "expression": expression,
            "source_pattern": source, "description": description,
            "sample": {"stock_code": payload.stock_code, "as_of": as_of}, "result": result, "verified_at": now}
    with connect() as connection:
        connection.execute("INSERT INTO condition_drafts(id,prompt,plan_json,created_at) VALUES(?,?,?,?)",
                           (draft_id, description[:4000], json_dump(plan), now))
    return {"builder_draft_id": draft_id, **{key: plan[key] for key in ("definition", "description", "sample", "result", "verified_at")}}


@router.post("/save")
def save(payload: SaveRequest):
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT plan_json,saved_json FROM condition_drafts WHERE id=?", (payload.builder_draft_id,)).fetchone()
        if not row:
            fail("找不到这份样本验证，请重新验证", 404)
        plan = json_load(row["plan_json"])
        if plan.get("builder_version") != 1:
            fail("请使用可复用条件创建入口的验证记录")
        if plan["definition"] != payload.definition.model_dump(mode="json"):
            fail("条件已修改，请按新设置重新验证后保存", 409)
        if row["saved_json"]:
            saved = json_load(row["saved_json"])
            if saved["asset"]["name"] != payload.name:
                fail("此验证记录已保存；如需另建条件，请重新验证", 409)
            return saved
        try:
            name = check_condition_name(connection, payload.name)
        except ConditionNameError as exc:
            fail(str(exc), exc.status)
        asset_id, now = str(uuid4()), utc_now()
        proof = {"created_by": "condition_builder", "builder_draft_id": payload.builder_draft_id,
                 "definition": plan["definition"], "sample": plan["sample"],
                 "sample_state": plan["result"]["state"], "verified_at": plan["verified_at"]}
        if payload.definition.kind == "pattern":
            latest = connection.execute("SELECT name FROM patterns p WHERE version=(SELECT MAX(version) FROM patterns WHERE id=p.id)").fetchall()
            if any(normalized_condition_name(item["name"]) == normalized_condition_name(name) for item in latest):
                fail("已有同名形态条件，请调整名称", 409)
            content = deepcopy(plan["source_pattern"]["content"])
            definition = payload.definition
            origin = (content.get("derivation") or {}).get("origin_type", content["input_type"])
            content.update(input_type="drawing", note=plan["description"],
                derivation={"origin_type": origin, "source_pattern_id": definition.pattern_id, "source_pattern_version": definition.pattern_version},
                provenance={**(content.get("provenance") or {}), **proof},
                params={**content.get("params", {}), "min_similarity": definition.minimum_similarity,
                        "match_mode": definition.match_mode, "recent_bars": definition.recent_bars})
            connection.execute("INSERT INTO patterns(id,name,version,pattern_json,created_at) VALUES(?,?,1,?,?)",
                               (asset_id, name, json_dump(content), now))
            asset = {"id": asset_id, "version": 1, "name": name, **content, "created_at": now}
            reference = {"op": "pattern_ref", "pattern_id": asset_id, "version": 1, "min_similarity": definition.minimum_similarity,
                         "match_mode": definition.match_mode, "recent_bars": definition.recent_bars, "score_weight": 1}
            kind = "pattern"
        else:
            kind = "filter"
            dsl = {"schema_version": "1.1", "kind": payload.definition.kind, "name": name,
                   "description": plan["description"], "expression": plan["expression"], "status": "validated", "provenance": proof}
            connection.execute("INSERT INTO filters(id,library,name,description,version,dsl_json,created_at) VALUES(?,?,?,?,1,?,?)",
                               (asset_id, payload.definition.kind, name, plan["description"], json_dump(dsl), now))
            asset = filter_object(connection.execute("SELECT * FROM filters WHERE id=? AND version=1", (asset_id,)).fetchone())
            reference = {"op": "filter_ref", "filter_id": asset_id, "version": 1, "score_weight": 1}
        result = {"asset_kind": kind, "asset": asset, "reference": reference}
        connection.execute("INSERT INTO audit_events(action,entity_type,entity_id,version,details_json,created_at) VALUES('save_verified_condition',?,?,1,?,?)",
                           (kind, asset_id, json_dump(proof), now))
        connection.execute("UPDATE condition_drafts SET saved_json=? WHERE id=?", (json_dump(result), payload.builder_draft_id))
    return result
