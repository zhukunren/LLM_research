from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Callable, Literal
from uuid import uuid4

from pydantic import BaseModel, Field, ValidationError

from . import conversation_store, documents, market, screening_artifacts, evidence_sources, news_sources
from .db import connect, json_dump, json_load, utc_now
from .tool_protocol import ToolCall, ToolDefinition
from . import saved_screening_tasks
from .execution_policy import denies_execution, requests_execution
from .models import StrictModel
from .screening_artifacts import ArtifactError, store_artifact
from .screening_contracts import ScreeningTaskRevision, validate_executable_task
from .settings import ALLOWED_MARKETS, research_settings

MAX_TOOL_ARGUMENT_BYTES = 64 * 1024
MAX_INLINE_TOOL_RESULT_BYTES = 32 * 1024
MAX_STOCK_SEARCH_RESULTS = 50
MAX_REPORT_SEARCH_RESULTS = 30
MAX_REPORT_PAGE_CHARS = 12_000
TASK_MUTATION_TOOLS = frozenset({"propose_screening_task"})
SCREENING_WORKFLOW_TOOLS = frozenset({
    "propose_screening_task", "save_screening_plan", "authorize_screening_execution",
    "revoke_screening_execution", "preview_screening_program", "execute_screening_task",
})

class ToolArgs(StrictModel):
    pass


class DescribeCapabilitiesArgs(ToolArgs):
    domain: Literal[
        "market", "report", "news", "pattern", "runtime",
        "securities", "fundamentals", "composition",
    ] | None
    include_unavailable: bool


class EmptyToolArgs(ToolArgs):
    pass


class SearchSecuritiesArgs(ToolArgs):
    query: str = Field(max_length=80)
    market_code: Literal["SH", "SZ", "BJ"] | None
    limit: int = Field(ge=1, le=MAX_STOCK_SEARCH_RESULTS)


class ReadMarketWindowArgs(ToolArgs):
    stock_code: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    limit: int = Field(ge=1, le=500)
    as_of: date | None = None


class SearchReportPagesArgs(ToolArgs):
    query: str = Field(min_length=1, max_length=300)
    stock_code: str | None
    limit: int = Field(ge=1, le=MAX_REPORT_SEARCH_RESULTS)
    mode: Literal["smart", "exact"] = "smart"


class ReadReportPageArgs(ToolArgs):
    document_id: str = Field(min_length=1, max_length=100)
    page_number: int = Field(ge=1, le=5000)
    stock_code: str | None


class ListReportSourcesArgs(ToolArgs):
    stock_code: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    offset: int = Field(ge=0)
    limit: int = Field(ge=1, le=50)


class ReadEvidenceChunkArgs(ToolArgs):
    source_id: str = Field(min_length=1, max_length=100)
    page_number: int = Field(ge=1, le=5000)
    stock_code: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    offset: int = Field(ge=0)
    limit: int = Field(ge=1, le=12000)


class InspectSavedConditionsArgs(ToolArgs):
    query: str = Field(max_length=100)
    library: Literal["technical", "news", "report", "pattern", "screening"] | None
    include_history: bool
    limit: int = Field(ge=1, le=50)


class ReadArtifactChunkArgs(ToolArgs):
    artifact_id: str = Field(min_length=1, max_length=100)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1, le=12000)


class ScreeningTaskPayload(ToolArgs):
    """Top-level task shape; nested contract validation stays server-owned."""

    task_id: str
    revision: int
    original_user_messages: list[str]
    conditions: list[Any] = Field(
        description=(
            "Condition objects. Technical conditions MUST include program with contract_version "
            "python-screen-v1 and expression={} ; do not use indicator or formula DSL."
        )
    )
    references: list[Any] = Field(
        description="Condition references with reference_id, condition_id, parameter_overrides, and optional source_quote."
    )
    logic_tree: Any = Field(
        description=(
            'Canonical tree only: {"op":"condition","reference_id":"r1"}, or '
            '{"op":"all|any|not","children":[...]}. Do not use type, operator, or condition_id nodes.'
        )
    )
    scope: Any = Field(
        description="Scope object with universe {kind: all_a_shares|watchlist|explicit}, as_of, lookbacks, price_basis, ranking."
    )
    unresolved: list[Any]


class ProposeScreeningTaskArgs(ToolArgs):
    task: ScreeningTaskPayload


class TaskRevisionArgs(ToolArgs):
    revision: int = Field(ge=0)


class SaveScreeningPlanArgs(ToolArgs):
    revision: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=120)


class ListSavedTasksArgs(ToolArgs):
    limit: int = Field(default=50, ge=1, le=100)


class EmptyResearchStateArgs(ToolArgs):
    pass


@dataclass(frozen=True)
class ToolContext:
    conversation_id: str
    turn_id: str
    task_revision: int
    as_of: str | None = None
    universe_kind: str | None = None
    stock_codes: frozenset[str] | None = None
    report_lookback_calendar_days: int | None = None
    news_lookback_calendar_days: int | None = None
    allowed_document_ids: frozenset[str] | None = None
    allowed_news_ids: frozenset[str] | None = None
    workflow_type: str = "screening"
    research_depth: str = "standard"
    research_scope_revision: int = 0


@dataclass(frozen=True)
class _Registration:
    tool: ToolDefinition
    argument_model: type[ToolArgs]
    handler: Callable[[ToolArgs, ToolContext], dict[str, Any]]
    capability_id: str | None


class ToolDispatchError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def _schema_for(model: type[ToolArgs]) -> dict[str, Any]:
    schema = model.model_json_schema()
    schema.setdefault("additionalProperties", False)
    schema.setdefault("properties", {})
    return schema


def _safe_json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _safe_json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe_json_value(item) for item in value]
    raise ValueError("工具返回了合同不支持的数据类型")


def _data_source_id() -> str | None:
    fingerprint = market.source_fingerprint()
    if not fingerprint:
        return None
    canonical = json.dumps(fingerprint, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _check_market_scope(context: ToolContext, stock_code: str) -> None:
    if context.workflow_type == "research":
        if stock_code.rsplit(".", 1)[-1] not in ALLOWED_MARKETS:
            raise ToolDispatchError("market_unavailable", "当前只接入沪深北市场日线")
        if context.stock_codes is not None and stock_code not in context.stock_codes:
            raise ToolDispatchError("security_outside_research_scope", "证券不在当前回合的研究范围内")
        return
    if not context.as_of:
        raise ToolDispatchError("as_of_required", "请先确定筛选截止日")
    if context.universe_kind is None:
        raise ToolDispatchError("universe_required", "请先确定股票范围")
    suffix = stock_code.rsplit(".", 1)[-1]
    if suffix not in ALLOWED_MARKETS:
        raise ToolDispatchError("market_unavailable", "当前只接入沪深北市场日线")
    if context.universe_kind != "all_a_shares" and (
        context.stock_codes is None or stock_code not in context.stock_codes
    ):
        raise ToolDispatchError("security_outside_universe", "证券不在本次冻结的筛选范围内")


def _describe_capabilities(args: ToolArgs, _: ToolContext) -> dict[str, Any]:
    from .capability_service import screening_capability_manifest

    manifest = screening_capability_manifest()
    capabilities = manifest["capabilities"]
    if args.domain:
        capabilities = [item for item in capabilities if item["domain"] == args.domain]
    if not args.include_unavailable:
        capabilities = [item for item in capabilities if item["availability"] != "unavailable"]
    return {"version": manifest["version"], "capabilities": capabilities}


def _market_coverage(_: ToolArgs, __: ToolContext) -> dict[str, Any]:
    from .capability_service import data_coverage

    return data_coverage()


def _search_securities(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    as_of = context.as_of
    if context.workflow_type == "research" and not as_of:
        as_of = market.cached_profile().get("last_date")
    if not as_of:
        raise ToolDispatchError("as_of_required", "搜索证券前请先确定筛选截止日")
    if context.universe_kind is None and context.workflow_type != "research":
        raise ToolDispatchError("universe_required", "搜索证券前请先确定股票范围")
    items = market.search_securities(
        args.query,
        args.market_code or "",
        args.limit,
        as_of=as_of,
    )
    if context.universe_kind not in {None, "all_a_shares"}:
        allowed = context.stock_codes or frozenset()
        items = [item for item in items if item["stock_code"] in allowed]
    return {
        "as_of": as_of,
        "items": items,
        "coverage_note": "只返回截至指定日有行情的证券；代码搜索不是公司名称、行业或证券资格数据。",
    }


def _read_market_window(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    _check_market_scope(context, args.stock_code)
    as_of = context.as_of
    if context.workflow_type == "research":
        requested = args.as_of.isoformat() if args.as_of else None
        if as_of and requested and requested > as_of:
            raise ToolDispatchError("date_outside_research_scope", "请求日期晚于当前回合的研究截止日")
        as_of = requested or as_of or market.cached_profile().get("last_date")
        if not as_of:
            raise ToolDispatchError("market_date_unavailable", "本地行情没有可用日期")
    elif args.as_of and args.as_of.isoformat() != as_of:
        raise ToolDispatchError("date_outside_screening_scope", "行情读取必须使用当前筛选方案的截止日")
    bars = market.get_bars(args.stock_code, as_of, args.limit)
    return {
        "stock_code": args.stock_code,
        "requested_as_of": as_of,
        "last_bar_date": bars[-1]["trade_date"] if bars else None,
        "bars": bars,
        "source_id": _data_source_id(),
        "price_basis": "unknown",
        "volume_unit": "unknown",
        "amount_unit": "unknown",
    }


def _search_report_pages(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    if args.stock_code:
        _check_market_scope(context, args.stock_code)
    elif context.universe_kind == "explicit" and context.stock_codes and len(context.stock_codes) == 1:
        args = args.model_copy(update={"stock_code": next(iter(context.stock_codes))})
    earliest = None
    if context.report_lookback_calendar_days is not None and context.as_of:
        earliest = (date.fromisoformat(context.as_of) - timedelta(days=context.report_lookback_calendar_days)).isoformat()
    filters = dict(mode=args.mode, allowed_source_ids=context.allowed_document_ids,
                   available_after=earliest,
                   stock_codes=context.stock_codes if context.universe_kind == "explicit" else None)
    result = documents.search(
        args.query,
        context.as_of,
        args.stock_code,
        args.limit,
        confirmed_security_only=bool(args.stock_code),
        **filters,
    )
    items = result["items"]
    unverified_security_hits = 0
    if args.stock_code:
        broader = documents.search(args.query, context.as_of, args.stock_code, 1, **filters)
        unverified_security_hits = broader["total"] - result["total"]
    else:
        for item in items:
            item["eligible_for_specific_security_screening"] = (
                item["stock_code"] is not None
                and item["security_binding_status"] == "confirmed"
            )
    return {
        **result,
        "as_of": context.as_of,
        "items": items,
        "excluded_unverified_security_hits": unverified_security_hits,
        "scope": "indexed_local_pages",
        "coverage_note": result["coverage_note"] + "证券未确认绑定的研报不作为单股证据。",
    }


def _read_report_page(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    if context.allowed_document_ids is not None and args.document_id not in context.allowed_document_ids:
        raise ToolDispatchError("document_outside_scope", "研报不在当前对话允许的来源范围内")
    stock_code = args.stock_code
    if stock_code:
        _check_market_scope(context, stock_code)
    elif context.universe_kind == "explicit" and context.stock_codes and len(context.stock_codes) == 1:
        stock_code = next(iter(context.stock_codes))
    try:
        result = documents.read_page(
            args.document_id,
            args.page_number,
            as_of=context.as_of,
            stock_code=stock_code,
            max_chars=MAX_REPORT_PAGE_CHARS,
        )
        if context.as_of and context.report_lookback_calendar_days and result.get("available_at"):
            earliest = date.fromisoformat(context.as_of) - timedelta(days=context.report_lookback_calendar_days)
            if date.fromisoformat(result["available_at"]) < earliest:
                result.update(text=None, eligible_for_historical_screening=False,
                              eligibility_reason="研报早于本次回溯范围")
        return result
    except KeyError:
        raise ToolDispatchError("document_page_not_found", "找不到指定研报页") from None


def _list_report_sources(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    _check_market_scope(context, args.stock_code)
    try:
        return evidence_sources.list_report_sources(
            args.stock_code, context.as_of, lookback_days=context.report_lookback_calendar_days,
            offset=args.offset, limit=args.limit, allowed_source_ids=context.allowed_document_ids,
        )
    except evidence_sources.EvidenceSourceError as exc:
        raise ToolDispatchError(exc.code, str(exc)) from exc


def _read_evidence_chunk(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    _check_market_scope(context, args.stock_code)
    if context.allowed_document_ids is not None and args.source_id not in context.allowed_document_ids:
        raise ToolDispatchError("document_outside_scope", "资料不在当前对话允许的来源范围内")
    try:
        return evidence_sources.read_report_chunk(
            args.source_id, args.page_number, args.stock_code, context.as_of,
            offset=args.offset, limit=args.limit, lookback_days=context.report_lookback_calendar_days,
        )
    except evidence_sources.EvidenceSourceError as exc:
        raise ToolDispatchError(exc.code, str(exc)) from exc


def _list_news_sources(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    _check_market_scope(context, args.stock_code)
    try:
        return news_sources.list_news_sources(args.stock_code, context.as_of,
            lookback_days=context.news_lookback_calendar_days, offset=args.offset, limit=args.limit,
            allowed_source_ids=context.allowed_news_ids)
    except evidence_sources.EvidenceSourceError as exc:
        raise ToolDispatchError(exc.code, str(exc)) from exc


def _read_news_chunk(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    _check_market_scope(context, args.stock_code)
    if context.allowed_news_ids is not None and args.source_id not in context.allowed_news_ids:
        raise ToolDispatchError("source_outside_scope", "资讯不在当前指定来源中")
    try:
        return news_sources.read_news_chunk(args.source_id, args.page_number, args.stock_code, context.as_of,
            lookback_days=context.news_lookback_calendar_days, offset=args.offset, limit=args.limit)
    except evidence_sources.EvidenceSourceError as exc:
        raise ToolDispatchError(exc.code, str(exc)) from exc


def _inspect_saved_conditions(args: ToolArgs, _: ToolContext) -> dict[str, Any]:
    query = f"%{args.query.strip()}%"
    limit = args.limit
    items: list[dict[str, Any]] = []
    with connect() as connection:
        if args.library not in {"pattern", "screening"}:
            if args.include_history:
                rows = connection.execute(
                    """SELECT id,library,name,description,version,dsl_json,created_at
                       FROM filters WHERE (? IS NULL OR library=?)
                         AND (?='' OR name LIKE ? OR description LIKE ?)
                       ORDER BY created_at DESC,id,version DESC LIMIT ?""",
                    (args.library, args.library, args.query, query, query, limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    """SELECT f.id,f.library,f.name,f.description,f.version,f.dsl_json,f.created_at
                       FROM filters f
                       JOIN (
                         SELECT id,MAX(version) AS version FROM filters
                         WHERE (? IS NULL OR library=?)
                         GROUP BY id
                       ) latest ON latest.id=f.id AND latest.version=f.version
                       WHERE (?='' OR f.name LIKE ? OR f.description LIKE ?)
                       ORDER BY f.created_at DESC,f.id LIMIT ?""",
                    (args.library, args.library, args.query, query, query, limit),
                ).fetchall()
            items.extend(
                {
                    "id": row["id"],
                    "kind": "condition",
                    "library": row["library"],
                    "name": row["name"],
                    "description": row["description"],
                    "version": row["version"],
                    "expression": json_load(row["dsl_json"]),
                    "created_at": row["created_at"],
                }
                for row in rows
            )
        if args.library in {None, "pattern"} and len(items) < limit:
            if args.include_history:
                rows = connection.execute(
                    """SELECT id,name,version,pattern_json,created_at FROM patterns
                       WHERE (?='' OR name LIKE ?)
                       ORDER BY created_at DESC,id,version DESC LIMIT ?""",
                    (args.query, query, limit - len(items)),
                ).fetchall()
            else:
                rows = connection.execute(
                    """SELECT p.id,p.name,p.version,p.pattern_json,p.created_at
                       FROM patterns p
                       JOIN (
                         SELECT id,MAX(version) AS version FROM patterns GROUP BY id
                       ) latest ON latest.id=p.id AND latest.version=p.version
                       WHERE (?='' OR p.name LIKE ?)
                       ORDER BY p.created_at DESC,p.id LIMIT ?""",
                    (args.query, query, limit - len(items)),
                ).fetchall()
            for row in rows:
                data = json_load(row["pattern_json"])
                items.append(
                    {
                        "id": row["id"],
                        "kind": "pattern",
                        "name": row["name"],
                        "version": row["version"],
                        "input_type": data.get("input_type"),
                        "representation": data.get("representation"),
                        "target_bars": data.get("target_bars"),
                        "params": data.get("params", {}),
                        "created_at": row["created_at"],
                    }
                )
        if args.library in {None, "screening"} and len(items) < limit:
            if args.include_history:
                rows = connection.execute(
                    """SELECT id,name,version,strategy_json,created_at FROM strategies
                       WHERE (?='' OR name LIKE ?)
                       ORDER BY created_at DESC,id,version DESC LIMIT ?""",
                    (args.query, query, limit - len(items)),
                ).fetchall()
            else:
                rows = connection.execute(
                    """SELECT s.id,s.name,s.version,s.strategy_json,s.created_at
                       FROM strategies s
                       JOIN (SELECT id,MAX(version) AS version FROM strategies GROUP BY id) latest
                         ON latest.id=s.id AND latest.version=s.version
                       WHERE (?='' OR s.name LIKE ?)
                       ORDER BY s.created_at DESC,s.id LIMIT ?""",
                    (args.query, query, limit - len(items)),
                ).fetchall()
            for row in rows:
                data = json_load(row["strategy_json"])
                items.append(
                    {
                        "id": row["id"],
                        "kind": "screening",
                        "name": row["name"],
                        "version": row["version"],
                        "tree": data.get("tree"),
                        "top_n": data.get("top_n"),
                        "created_at": row["created_at"],
                    }
                )
    return {"items": items[:limit], "history_included": args.include_history}


def _read_artifact(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    try:
        return screening_artifacts.read_artifact_chunk(
            args.artifact_id,
            context.conversation_id,
            args.offset,
            args.limit,
        )
    except screening_artifacts.ArtifactError as exc:
        raise ToolDispatchError("artifact_unavailable", str(exc)) from None


def _current_turn_user_message(context: ToolContext) -> dict[str, Any]:
    try:
        turn = conversation_store.get_turn(context.conversation_id, context.turn_id)
        if turn["state"] != "running":
            raise ToolDispatchError("conversation_turn_inactive", "此对话回合已结束，不能继续修改任务")
        return conversation_store.get_user_message(
            context.conversation_id,
            turn["user_message_id"],
        )
    except conversation_store.ConversationNotFound as exc:
        raise ToolDispatchError("conversation_turn_not_found", "找不到当前研究回合") from exc


def _research_state(_: ToolArgs, context: ToolContext) -> dict[str, Any]:
    conversation = conversation_store.get_conversation(context.conversation_id, message_limit=50)
    if context.workflow_type == "research":
        return {
            "conversation_id": context.conversation_id, "turn_id": context.turn_id,
            "workflow_type": "research", "research_depth": context.research_depth,
            "research_scope_revision": context.research_scope_revision,
            "research_scope": {"as_of": context.as_of, "stock_codes": sorted(context.stock_codes) if context.stock_codes is not None else [],
                               "report_lookback_calendar_days": context.report_lookback_calendar_days,
                               "news_lookback_calendar_days": context.news_lookback_calendar_days},
            "task_revision": 0, "task": None, "pending_execution_message_id": None,
            "note": "研究状态独立于筛选方案；可操作的判断可通过研究回答的转换动作形成独立选股草稿。",
        }
    task = None
    if conversation["task_revision"]:
        try:
            task = conversation_store.get_task_revision(
                context.conversation_id,
                conversation["task_revision"],
            ).model_dump(mode="json")
        except conversation_store.ConversationNotFound:
            task = None
    return {
        "conversation_id": context.conversation_id,
        "turn_id": context.turn_id,
        "task_revision": conversation["task_revision"],
        "pending_execution_message_id": conversation_store.get_pending_execute_message(context.conversation_id),
        "task": task,
        "user_messages": [
            {"id": item["id"], "content": item["content"], "created_at": item["created_at"]}
            for item in conversation["messages"]
            if item["role"] == "user"
        ],
        "note": "任务修订必须覆盖当前用户要求；执行授权只由明确的执行动作触发。",
    }


def _normalize_task_shape(raw: dict[str, Any], *, fallback_quote: str = "当前筛选要求") -> dict[str, Any]:
    """Repair harmless model naming drift before the strict domain validator.

    This only maps structural aliases. It never invents thresholds, data scope,
    or a technical implementation.
    """
    candidate = dict(raw)
    conditions = candidate.get("conditions") if isinstance(candidate.get("conditions"), list) else []
    normalized_conditions: list[dict[str, Any]] = []
    for item in conditions:
        if not isinstance(item, dict):
            continue
        condition = dict(item)
        if not condition.get("library"):
            condition["library"] = condition.get("type") or condition.get("domain") or condition.get("condition_type")
        if not condition.get("description") and condition.get("name"):
            condition["description"] = condition["name"]
        if not condition.get("source_quote"):
            condition["source_quote"] = condition.get("description") or condition.get("name") or condition.get("condition_id")
        condition.pop("type", None)
        condition.pop("domain", None)
        condition.pop("condition_type", None)
        condition.pop("name", None)
        condition_parameters = condition.get("parameters") if isinstance(condition.get("parameters"), dict) else {}
        condition.pop("parameters", None)
        if condition.get("library") == "technical" and isinstance(condition.get("program"), dict):
            program = dict(condition["program"])
            if "source_code" not in program:
                program["source_code"] = program.get("code") or program.get("source") or ""
            program.pop("entrypoint", None)
            program.pop("output_contract", None)
            program["contract_version"] = "python-screen-v1"
            program.setdefault("required_fields", ["close"])
            program.setdefault("required_history_bars", 20)
            if program["source_code"]:
                program.setdefault("parameters", condition_parameters)
                program.setdefault(
                    "parameter_specs",
                    {
                        name: {"label": name, "type": "integer" if type(value) is int else "number"}
                        for name, value in program["parameters"].items()
                    },
                )
                condition["program"] = program
                condition["expression"] = {}
                condition["implementation_id"] = "llm-python-screen"
                condition["implementation_version"] = "python-screen-v1"
            else:
                condition["program"] = None
                condition["expression"] = {"draft_parameters": condition_parameters}
                condition.pop("implementation_id", None)
                condition.pop("implementation_version", None)
        elif condition.get("library") == "technical" and not condition.get("program"):
            condition["expression"] = condition.get("expression") or {"draft_parameters": condition_parameters}
        normalized_conditions.append(condition)
    candidate["conditions"] = normalized_conditions
    scope = candidate.get("scope") if isinstance(candidate.get("scope"), dict) else {}
    candidate["scope"] = {
        "universe": scope.get("universe"),
        "as_of": scope.get("as_of"),
        "report_lookback_calendar_days": scope.get("report_lookback_calendar_days"),
        "news_lookback_calendar_days": scope.get("news_lookback_calendar_days"),
        "price_basis": scope.get("price_basis"),
        "ranking": scope.get("ranking"),
    }
    condition_ids = [
        item.get("condition_id")
        for item in conditions
        if isinstance(item, dict) and isinstance(item.get("condition_id"), str)
    ]
    references = candidate.get("references") if isinstance(candidate.get("references"), list) else []
    normalized_refs = [dict(item) for item in references if isinstance(item, dict)]
    ref_by_condition: dict[str, str] = {}
    for index, item in enumerate(normalized_refs):
        condition_id = item.get("condition_id")
        reference_id = item.get("reference_id")
        if isinstance(condition_id, str) and isinstance(reference_id, str):
            ref_by_condition[condition_id] = reference_id
        if "parameter_overrides" not in item:
            item["parameter_overrides"] = {}
        normalized_refs[index] = item
    for condition_id in condition_ids:
        if condition_id not in ref_by_condition:
            reference_id = f"r-{condition_id}"
            normalized_refs.append({
                "reference_id": reference_id,
                "condition_id": condition_id,
                "parameter_overrides": {},
            })
            ref_by_condition[condition_id] = reference_id

    def normalize_node(node: Any) -> dict[str, Any]:
        if not isinstance(node, dict):
            raise ValueError("组合逻辑节点必须是对象，不能忽略损坏的条件")
        if set(node) - {"op", "type", "operator", "children", "reference_id", "condition_id"}:
            raise ValueError("组合逻辑包含无法识别的字段，请使用明确的 all、any、not 结构")
        aliases = {"all": "all", "and": "all", "any": "any", "or": "any", "not": "not", "condition": "condition"}
        operators = [node[key] for key in ("op", "type", "operator") if key in node]
        if any(not isinstance(value, str) or value.lower() not in aliases for value in operators):
            raise ValueError("无法识别组合逻辑运算符，不能替换为默认关系")
        mapped = {aliases[value.lower()] for value in operators}
        if len(mapped) > 1:
            raise ValueError("组合逻辑中的运算符相互冲突")
        op = next(iter(mapped), "condition" if "condition_id" in node or "reference_id" in node else None)
        if op == "condition":
            if "children" in node:
                raise ValueError("条件引用不能同时包含子逻辑")
            reference_id = node.get("reference_id")
            if not isinstance(reference_id, str):
                reference_id = ref_by_condition.get(node.get("condition_id"))
            if not reference_id:
                raise ValueError("组合逻辑引用了无法识别的条件")
            return {"op": "condition", "reference_id": reference_id}
        if op in {"all", "any", "not"}:
            raw_children = node.get("children")
            if not isinstance(raw_children, list) or not raw_children or {"reference_id", "condition_id"} & set(node):
                raise ValueError("组合逻辑必须包含完整的子条件")
            return {"op": op, "children": [normalize_node(child) for child in raw_children]}
        raise ValueError("缺少明确的组合逻辑运算符")

    raw_tree = candidate.get("logic_tree")
    if raw_tree is None and normalized_refs:
        raise ValueError("条件之间的组合关系尚未确定，不能自动设为全部满足")
    tree = normalize_node(raw_tree) if raw_tree is not None else None
    candidate["references"] = normalized_refs
    candidate["logic_tree"] = tree
    normalized_unresolved: list[dict[str, Any]] = []
    for item in candidate.get("unresolved", []) if isinstance(candidate.get("unresolved"), list) else []:
        if not isinstance(item, dict):
            continue
        kind = item.get("kind") if item.get("kind") in {"clarification", "unsupported", "missing_data", "conflict"} else "clarification"
        source_quote = item.get("source_quote") or item.get("field") or fallback_quote
        if re.sub(r"\s+", "", str(source_quote)) not in re.sub(r"\s+", "", fallback_quote):
            source_quote = fallback_quote
        question = item.get("question") or item.get("reason") or "这项要求还需要补充明确口径。"
        normalized_unresolved.append({
            "kind": kind,
            "source_quote": str(source_quote),
            "question": str(question),
            "suggestion": item.get("suggestion") if isinstance(item.get("suggestion"), str) else None,
        })
    candidate["unresolved"] = normalized_unresolved
    return candidate


def _propose_screening_task(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    raw = args.task.model_dump(mode="json")
    if len(json.dumps(raw, ensure_ascii=False, separators=(",", ":"))) > 200_000:
        raise ToolDispatchError("task_too_large", "筛选任务过大，无法保存")
    unsupported = list(raw.get("unresolved") or [])
    for condition in raw.get("conditions", []):
        if isinstance(condition, dict) and condition.get("library") == "technical" and not condition.get("program"):
            quote = str(condition.get("source_quote") or condition.get("description") or "技术条件")
            if not any(item.get("source_quote") == quote for item in unsupported if isinstance(item, dict)):
                unsupported.append({
                    "kind": "unsupported",
                    "source_quote": quote,
                    "question": "这项技术条件还没有 python-screen-v1 程序实现；请确认计算口径后再生成普通 Python 实现。",
                    "suggestion": "需要 screen(context, frames, params) 及明确的历史长度、字段和参数。",
                })
    raw["unresolved"] = unsupported
    try:
        conversation = conversation_store.get_conversation(context.conversation_id, message_limit=100)
        base_revision = conversation["task_revision"]
        current_user = _current_turn_user_message(context)
        raw = _normalize_task_shape(raw, fallback_quote=current_user["content"])
        user_text = re.sub(r"\s+", "", current_user["content"])
        for condition in raw.get("conditions", []):
            if isinstance(condition, dict):
                quote = re.sub(r"\s+", "", str(condition.get("source_quote") or ""))
                if not quote or quote not in user_text:
                    condition["source_quote"] = current_user["content"]
        for reference in raw.get("references", []):
            if isinstance(reference, dict) and reference.get("source_quote"):
                quote = re.sub(r"\s+", "", str(reference["source_quote"]))
                if quote not in user_text:
                    reference["source_quote"] = current_user["content"]
        board_match = re.search(r"科创板|创业板|北交所|主板", current_user["content"])
        if board_match:
            unresolved = raw.setdefault("unresolved", [])
            if not any(
                isinstance(item, dict) and item.get("kind") == "clarification" and item.get("source_quote") == current_user["content"]
                for item in unresolved
            ):
                unresolved.append({
                    "kind": "clarification",
                    "source_quote": current_user["content"],
                    "question": "当前股票范围合同没有可直接执行的板块字段；请改为指定证券或提供可冻结的股票池。",
                    "suggestion": "不会把板块要求静默扩大为全部A股。",
                })
        scope = raw.get("scope") if isinstance(raw.get("scope"), dict) else {}
        explicit_date = re.search(
            r"20\d{2}[-/]\d{1,2}[-/]\d{1,2}|20\d{2}年\d{1,2}月\d{1,2}日",
            current_user["content"],
        )
        relative_date = re.search(
            r"最近|近期|近(?:\d+|[一二三四五六七八九十]+)?(?:个)?(?:交易日|工作日|日|周|月|季度|年)|最新|当前|今天|现在|截至目前|至今",
            current_user["content"],
        )
        if relative_date:
            local_today = datetime.now(news_sources.LOCAL_ZONE).date().isoformat()
            scope["as_of"] = market.latest_market_date(local_today)
        elif not explicit_date:
            if base_revision:
                try:
                    previous = conversation_store.get_task_revision(context.conversation_id, base_revision)
                    scope["as_of"] = previous.scope.as_of.isoformat() if previous.scope.as_of else None
                except conversation_store.ConversationNotFound:
                    scope["as_of"] = None
            else:
                scope["as_of"] = None
        raw["scope"] = scope
        user_messages = [
            item["content"] for item in conversation["messages"] if item["role"] == "user"
        ]
        if current_user["content"] not in user_messages:
            user_messages.append(current_user["content"])
        candidate_data = dict(raw)
        candidate_data["task_id"] = context.conversation_id
        candidate_data["revision"] = base_revision + 1
        candidate_data["original_user_messages"] = user_messages
        candidate = ScreeningTaskRevision.model_validate(candidate_data)
        saved = conversation_store.save_task_revision(
            context.conversation_id,
            base_revision,
            current_user["id"],
            candidate,
            turn_id=context.turn_id,
        )
    except (conversation_store.ConversationNotFound, conversation_store.ConversationConflict,
            conversation_store.ConversationStoreError) as exc:
        raise ToolDispatchError("task_revision_conflict", str(exc)) from exc
    except ValueError as exc:
        raise ToolDispatchError("invalid_task_revision", str(exc)[:1000]) from exc
    return {
        "revision_saved": True,
        "saved_to_library": False,
        "task_revision": saved["revision"],
        "task": saved["task"],
        "execution_authorized": bool(conversation_store.get_pending_execute_message(context.conversation_id)),
        "note": "当前对话条件已更新；尚未存入方案库。用户要求保存方案时请调用 save_screening_plan。",
    }


def _authorize_screening_execution(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    conversation = conversation_store.get_conversation(context.conversation_id, message_limit=20)
    if args.revision != conversation["task_revision"]:
        raise ToolDispatchError("revision_conflict", "执行授权对应的任务版本不是当前版本")
    message = _current_turn_user_message(context)
    # The server checks the user's actual message; the model cannot mint an
    # execution grant from a tool argument alone.
    if not requests_execution(message["content"]):
        raise ToolDispatchError("execution_not_explicit", "当前消息没有明确执行要求，或包含否定执行。请核对要求；用户也可点击确认并开始筛选。")
    task = None
    try:
        task = conversation_store.get_task_revision(context.conversation_id, args.revision)
    except conversation_store.ConversationNotFound as exc:
        raise ToolDispatchError("task_not_found", "当前没有可授权执行的筛选任务") from exc
    conversation_store.set_pending_execute_message(
        context.conversation_id,
        args.revision,
        message["id"],
        turn_id=context.turn_id,
    )
    gap = None
    try:
        validate_executable_task(task)
    except ValueError as exc:
        gap = str(exc)
    return {
        "execution_authorized": True,
        "execution_authorization_message_id": message["id"],
        "task_revision": args.revision,
        "ready_to_execute": gap is None,
        "clarification": gap,
        "note": "授权已经绑定当前用户消息；只有服务端执行接口会创建筛选运行。",
    }


def _revoke_screening_execution(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    conversation = conversation_store.get_conversation(context.conversation_id, message_limit=20)
    if args.revision != conversation["task_revision"]:
        raise ToolDispatchError("revision_conflict", "撤销授权对应的任务版本不是当前版本")
    message = _current_turn_user_message(context)
    if not denies_execution(message["content"]):
        raise ToolDispatchError("revoke_not_explicit", "当前用户消息没有明确撤销执行")
    conversation_store.clear_pending_execute_message(context.conversation_id, args.revision, turn_id=context.turn_id)
    return {"execution_authorized": False, "task_revision": args.revision, "note": "本次执行授权已撤销。"}


def _save_screening_plan(args: ToolArgs, context: ToolContext) -> dict[str, Any]:
    _current_turn_user_message(context)
    task = conversation_store.get_task_revision(context.conversation_id, args.revision)
    try:
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            conversation_store.require_running_turn(connection, context.conversation_id, context.turn_id)
            turn = connection.execute(
                """SELECT t.state,c.task_revision FROM conversation_turns t
                   JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND c.id=? AND c.state='active'""",
                (context.turn_id, context.conversation_id),
            ).fetchone()
            if not turn or turn["state"] != "running" or turn["task_revision"] != args.revision:
                raise ToolDispatchError("revision_conflict", "对话或条件版本已变化，请重新读取后保存")
            saved = saved_screening_tasks.save_task(
                task, name=args.name, request_id=f"codex-save:{context.turn_id}:{args.revision}", _connection=connection,
            )
    except saved_screening_tasks.SavedTaskError as exc:
        raise ToolDispatchError(exc.code, str(exc)) from exc
    return {"saved_to_library": True, "asset_id": saved["id"], "version": saved["version"],
            "name": saved["name"], "idempotent_replay": saved["idempotent_replay"],
            "note": "方案已存入已保存方案列表，可在其他对话或观察池复用；本次保存不会执行筛选。"}


def _list_saved_tasks(args: ToolArgs, _: ToolContext) -> dict[str, Any]:
    return {"items": saved_screening_tasks.list_tasks(limit=args.limit)}


class ToolRegistry:
    def __init__(self, artifact_root=None) -> None:
        self._registrations: dict[str, _Registration] = {}
        self._artifact_root = artifact_root

    def register(
        self,
        name: str,
        description: str,
        argument_model: type[ToolArgs],
        handler: Callable[[ToolArgs, ToolContext], dict[str, Any]],
        capability_id: str | None = None,
        *,
        read_only: bool = True,
        open_world: bool = False,
    ) -> None:
        if name in self._registrations:
            raise ValueError(f"重复注册筛选工具：{name}")
        schema = _schema_for(argument_model)
        self._registrations[name] = _Registration(
            tool=ToolDefinition(name=name, description=description, input_schema=schema,
                                read_only=read_only, open_world=open_world),
            argument_model=argument_model,
            handler=handler,
            capability_id=capability_id,
        )

    def registered_tool_names(self) -> set[str]:
        return set(self._registrations)

    def tools_for_codex(self, context: ToolContext | None = None) -> list[ToolDefinition]:
        from .capability_service import screening_capability_manifest

        manifest = screening_capability_manifest()
        availability = {item["id"]: item["availability"] for item in manifest["capabilities"]}
        return [
            registration.tool
            for registration in self._registrations.values()
            if (context is None or context.workflow_type == "screening" or registration.tool.name not in SCREENING_WORKFLOW_TOOLS)
            and (registration.capability_id is None
                 or availability.get(registration.capability_id, "unavailable") != "unavailable")
        ]

    def dispatch(self, call: ToolCall, context: ToolContext) -> dict[str, Any]:
        if not call.call_id or len(call.call_id) > 200 or not call.name or len(call.name) > 100:
            return self._error("invalid_tool_call", "工具调用ID或名称格式无效")
        try:
            arguments_json = json.dumps(
                _safe_json_value(call.arguments),
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
                allow_nan=False,
            )
        except (TypeError, ValueError):
            return self._error("invalid_tool_arguments", "工具参数不是合法JSON")
        if len(arguments_json.encode("utf-8")) > MAX_TOOL_ARGUMENT_BYTES:
            return self._error("tool_arguments_too_large", "工具参数超过64 KB限制")
        arguments_hash = hashlib.sha256((call.name + "\0" + arguments_json).encode("utf-8")).hexdigest()
        try:
            existing = self._begin_call(call, context, arguments_hash, arguments_json)
        except ToolDispatchError as exc:
            return self._error(exc.code, str(exc))
        if existing is not None:
            return existing

        registration = self._registrations.get(call.name)
        if registration is None:
            return self._finish_call(
                call, context, {"ok": False, "error": {"code": "unknown_tool", "message": "没有注册此工具"}}, failed=True
            )
        if context.workflow_type != "screening" and call.name in SCREENING_WORKFLOW_TOOLS:
            return self._finish_call(call, context, self._error(
                "screening_workflow_required", "此动作属于条件选股。请把研究判断转为独立选股草稿后，在条件选股工作区继续。"), failed=True)
        if registration.capability_id:
            from .capability_service import screening_capability_manifest

            available = {
                item["id"]: item["availability"]
                for item in screening_capability_manifest()["capabilities"]
            }
            if available.get(registration.capability_id) == "unavailable":
                return self._finish_call(
                    call,
                    context,
                    {
                        "ok": False,
                        "error": {
                            "code": "capability_unavailable",
                            "message": "这项服务能力当前不可用，请保留该要求并向用户说明原因",
                        },
                    },
                    failed=True,
                )
        try:
            args = registration.argument_model.model_validate(call.arguments)
        except ValidationError as exc:
            fields = [
                {"field": ".".join(str(part) for part in error["loc"]), "reason": error["type"]}
                for error in exc.errors(include_url=False)
            ]
            return self._finish_call(
                call,
                context,
                {"ok": False, "error": {"code": "invalid_tool_arguments", "fields": fields}},
                failed=True,
            )

        try:
            result = _safe_json_value(registration.handler(args, context))
            if not isinstance(result, dict):
                raise ToolDispatchError("invalid_tool_result", "工具返回值必须是JSON对象")
            result_text = json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            if len(result_text.encode("utf-8")) > screening_artifacts.MAX_ARTIFACT_BYTES:
                raise ToolDispatchError("tool_result_too_large", "工具结果超过产物大小上限")
            if len(result_text.encode("utf-8")) > MAX_INLINE_TOOL_RESULT_BYTES:
                artifact = store_artifact(
                    context.conversation_id,
                    context.turn_id,
                    "tool_output",
                    result_text.encode("utf-8"),
                    root=self._artifact_root,
                )
                wrapped = {
                    "ok": True,
                    "result": {
                        **artifact,
                        "read_tool": "read_artifact_chunk",
                        "description": "通过read_artifact_chunk按字符偏移读取JSON产物。",
                    },
                }
            else:
                wrapped = {"ok": True, "result": result}
            return self._finish_call(call, context, wrapped, failed=False)
        except ToolDispatchError as exc:
            return self._finish_call(
                call, context, {"ok": False, "error": {"code": exc.code, "message": str(exc)}}, failed=True
            )
        except Exception:
            return self._finish_call(
                call,
                context,
                {"ok": False, "error": {"code": "tool_execution_failed", "message": "工具执行失败；可修改参数或提出澄清问题"}},
                failed=True,
            )

    @staticmethod
    def _error(code: str, message: str) -> dict[str, Any]:
        return {"ok": False, "error": {"code": code, "message": message}}

    def _begin_call(
        self,
        call: ToolCall,
        context: ToolContext,
        arguments_sha256: str,
        arguments_json: str,
    ) -> dict[str, Any] | None:
        conversation_store.recover_expired_turns()
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            conversation = connection.execute(
                "SELECT task_revision,state FROM conversations WHERE id=?",
                (context.conversation_id,),
            ).fetchone()
            turn = connection.execute(
                "SELECT conversation_id,state,workflow_type,research_depth,research_scope_revision,research_scope_json FROM conversation_turns WHERE id=?",
                (context.turn_id,),
            ).fetchone()
            if not conversation or not turn or turn["conversation_id"] != context.conversation_id:
                raise ToolDispatchError("conversation_turn_not_found", "找不到此对话回合")
            if conversation["state"] != "active" or turn["state"] not in {"awaiting_agent", "running"}:
                raise ToolDispatchError("conversation_turn_inactive", "此对话回合已结束")
            if turn["state"] == "running":
                try:
                    conversation_store.require_running_turn(connection, context.conversation_id, context.turn_id)
                except conversation_store.ConversationConflict as exc:
                    raise ToolDispatchError("conversation_turn_inactive", str(exc)) from exc
            elif connection.execute("SELECT 1 FROM research_turn_jobs WHERE turn_id=?", (context.turn_id,)).fetchone():
                raise ToolDispatchError("conversation_turn_inactive", "后台研究尚未开始，不能提前调用工具")
            if turn["workflow_type"] != context.workflow_type:
                raise ToolDispatchError("workflow_conflict", "工具上下文与当前回合工作类型不一致")
            if context.workflow_type == "research" and turn["research_scope_revision"] != context.research_scope_revision:
                raise ToolDispatchError("research_scope_conflict", "工具上下文与当前回合的研究范围版本不一致")
            if context.workflow_type == "research":
                pinned = json_load(turn["research_scope_json"])
                codes = frozenset(pinned.get("stock_codes") or []) or None
                if (context.as_of != pinned.get("as_of") or context.stock_codes != codes
                    or context.report_lookback_calendar_days != pinned.get("report_lookback_calendar_days")
                    or context.news_lookback_calendar_days != pinned.get("news_lookback_calendar_days")
                    or context.research_depth != turn["research_depth"]):
                    raise ToolDispatchError("research_scope_conflict", "工具上下文不能改写当前回合冻结的研究范围")
            if context.workflow_type == "screening" and conversation["task_revision"] != context.task_revision:
                raise ToolDispatchError("revision_conflict", "对话条件已更新，请重新读取当前版本")

            existing = connection.execute(
                """SELECT tool_name,task_revision,as_of,arguments_json,arguments_sha256,state,result_json FROM tool_calls
                   WHERE turn_id=? AND call_id=?""",
                (context.turn_id, call.call_id),
            ).fetchone()
            if existing:
                if (
                    existing["tool_name"] != call.name
                    or existing["task_revision"] != context.task_revision
                    or existing["as_of"] != context.as_of
                    or existing["arguments_json"] != arguments_json
                    or existing["arguments_sha256"] != arguments_sha256
                ):
                    raise ToolDispatchError("tool_call_id_reused", "重复工具调用ID不能绑定不同名称或参数")
                if existing["state"] == "running":
                    raise ToolDispatchError("tool_call_in_progress", "相同工具调用仍在执行")
                return json_load(existing["result_json"])

            call_count = connection.execute(
                "SELECT COUNT(*) FROM tool_calls WHERE turn_id=?", (context.turn_id,)
            ).fetchone()[0]
            call_limit = research_settings()["max_tool_calls"]
            if call_limit and call_count >= call_limit:
                raise ToolDispatchError("tool_call_limit", f"本回合达到配置的 {call_limit} 次工具预算；可以在下一回合继续研究")
            connection.execute(
                """INSERT INTO tool_calls(
                       id,conversation_id,turn_id,call_id,tool_name,task_revision,as_of,
                       arguments_json,arguments_sha256,state,created_at
                   ) VALUES(?,?,?,?,?,?,?,?,?, 'running',?)""",
                (
                    str(uuid4()), context.conversation_id, context.turn_id,
                    call.call_id, call.name, context.task_revision, context.as_of,
                    arguments_json, arguments_sha256, utc_now(),
                ),
            )
            if turn["state"] == "awaiting_agent":
                connection.execute(
                    "UPDATE conversation_turns SET state='running',updated_at=? WHERE id=?",
                    (utc_now(), context.turn_id),
                )
        return None

    def _finish_call(
        self,
        call: ToolCall,
        context: ToolContext,
        result: dict[str, Any],
        *,
        failed: bool,
    ) -> dict[str, Any]:
        result_json = json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        status = "failed" if failed else "succeeded"
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            turn = connection.execute(
                """SELECT t.state,t.workflow_type,t.research_scope_revision,c.task_revision,c.state AS conversation_state
                   FROM conversation_turns t JOIN conversations c ON c.id=t.conversation_id
                   WHERE t.id=? AND t.conversation_id=?""",
                (context.turn_id, context.conversation_id),
            ).fetchone()
            revision_is_current = turn and (
                (turn["workflow_type"] == "research" and context.workflow_type == "research"
                 and turn["research_scope_revision"] == context.research_scope_revision)
                or (turn["workflow_type"] == "screening" and context.workflow_type == "screening" and turn["task_revision"] == context.task_revision)
                or (
                    turn["workflow_type"] == "screening" and context.workflow_type == "screening"
                    and
                    call.name in TASK_MUTATION_TOOLS
                    and turn["task_revision"] == context.task_revision + 1
                )
            )
            lease_active = False
            if turn and turn["state"] == "running":
                try:
                    conversation_store.require_running_turn(connection, context.conversation_id, context.turn_id)
                    lease_active = True
                except conversation_store.ConversationConflict:
                    pass
            if (
                not turn or turn["state"] != "running"
                or turn["conversation_state"] != "active"
                or not revision_is_current
                or not lease_active
            ):
                stale = {
                    "ok": False,
                    "error": {"code": "stale_tool_result", "message": "对话状态或条件版本已改变，工具结果未发布"},
                }
                result_json = json.dumps(stale, ensure_ascii=False, separators=(",", ":"))
                status = "failed"
                result = stale
            connection.execute(
                """UPDATE tool_calls SET state=?,result_json=?,finished_at=?
                   WHERE turn_id=? AND call_id=? AND state='running'""",
                (status, result_json, utc_now(), context.turn_id, call.call_id),
            )
        return result


def _make_registry() -> ToolRegistry:
    result = ToolRegistry()
    _register_default_tools(result)
    from .research_tools import register_tools
    register_tools(result)
    return result


def _register_default_tools(registry: ToolRegistry) -> None:
    registry.register("list_news_sources", "List local news within the fixed security and time window.", ListReportSourcesArgs, _list_news_sources, "news.local_search")
    registry.register("read_news_chunk", "Read local news original text with character offsets; page_number is 1.", ReadEvidenceChunkArgs, _read_news_chunk, "news.local_search")
    registry.register("list_report_sources", "List eligible local reports for one security with pagination; listing is not reading.", ListReportSourcesArgs, _list_report_sources, "report.page_search")
    registry.register("read_evidence_chunk", "Read a bounded original-text chunk with character offsets; follow next_offset for long pages.", ReadEvidenceChunkArgs, _read_evidence_chunk, "report.page_search")
    registry.register("describe_capabilities", "List service capabilities, source coverage, units, and unavailable reasons.", DescribeCapabilitiesArgs, _describe_capabilities)
    registry.register("get_market_coverage", "Read the market watermark, fields, units, and source identity.", EmptyToolArgs, _market_coverage)
    registry.register("search_securities", "Search securities within the fixed date and universe context.", SearchSecuritiesArgs, _search_securities, "market.security_search")
    registry.register("read_market_window", "Read up to 500 ordered daily bars for one security inside the fixed task scope.", ReadMarketWindowArgs, _read_market_window, "market.daily_bars")
    registry.register("search_report_pages", "Find local report page text by relevance; smart uses lexical expansion, exact requires all keywords on one page. Read originals to verify claims.", SearchReportPagesArgs, _search_report_pages, "report.page_search")
    registry.register("read_report_page", "Read one page with availability and security-binding status.", ReadReportPageArgs, _read_report_page, "report.page_search")
    registry.register("inspect_saved_conditions", "Read saved immutable conditions, combinations, and patterns.", InspectSavedConditionsArgs, _inspect_saved_conditions, "portfolio.inspect_saved_conditions")
    registry.register("read_artifact_chunk", "Read a bounded JSON artifact chunk by id and character offset.", ReadArtifactChunkArgs, _read_artifact, "runtime.artifact_read")
    registry.register(
        "get_research_state",
        "Read the current task revision, user requirements and execution grant before changing a saved screening plan. Open research can use native workspace tools first.",
        EmptyResearchStateArgs,
        _research_state,
    )
    registry.register(
        "propose_screening_task",
        "Validate and persist the current conversation's complete task revision. This does not save a reusable plan or execute a run.",
        ProposeScreeningTaskArgs,
        _propose_screening_task,
        read_only=False,
    )
    registry.register("save_screening_plan", "Save the current confirmed revision to the reusable plan library when the user asks to save a plan. Returns an asset id and version; never executes screening.",
                      SaveScreeningPlanArgs, _save_screening_plan, read_only=False)
    registry.register("list_saved_screening_tasks", "Read reusable plans from the same saved-plan library shown in the Web UI.",
                      ListSavedTasksArgs, _list_saved_tasks)
    registry.register(
        "authorize_screening_execution",
        "Record an execution grant only when the current user message explicitly requests running the current task.",
        TaskRevisionArgs,
        _authorize_screening_execution,
        read_only=False,
    )
    registry.register(
        "revoke_screening_execution",
        "Revoke a pending execution grant when the current user explicitly says not to run.",
        TaskRevisionArgs,
        _revoke_screening_execution,
        read_only=False,
    )


registry = _make_registry()
