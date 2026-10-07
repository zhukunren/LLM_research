"""Business tools used alongside Codex's native research workspace."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
import json
import re
import time as clock
from typing import Any, Literal, TYPE_CHECKING
from uuid import uuid4

from pydantic import Field

from . import conversation_store, documents, market, news_sources, program_conditions, screening_service, tushare_sync, research_scan_service, research_workspace
from .db import connect, utc_now
from .models import StrictModel as ToolArgs
from .screening_contracts import CustomProgram

if TYPE_CHECKING:
    from .screening_tools import ToolContext


class ExecuteTaskArgs(ToolArgs):
    revision: int = Field(ge=1)


class SearchSourcesArgs(ToolArgs):
    kind: Literal["report", "news"]
    query: str = Field(max_length=300)
    stock_code: str | None
    as_of: date | None
    offset: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)


class ReadSourceArgs(ToolArgs):
    kind: Literal["report", "news"]
    source_id: str
    page_number: int = Field(ge=1)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1, le=30000)
    as_of: date | None


class ReadProjectCompanyArgs(ToolArgs):
    stock_code: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    as_of: date


class ReadSavedEvidenceArgs(ToolArgs):
    claim_id: str = Field(min_length=1, max_length=100)
    evidence_index: int = Field(default=0, ge=0, le=3)


def _research_project_id(context) -> str:
    from .screening_tools import ToolDispatchError
    project_id = conversation_store.get_conversation(context.conversation_id, message_limit=1).get("project_id")
    if not project_id:
        raise ToolDispatchError("project_required", "此对话尚未归入研究项目。可以继续使用普通资料研究工具。")
    return project_id


def read_project_company(args: ReadProjectCompanyArgs, context) -> dict:
    from . import company_research, research_projects
    from .screening_tools import ToolDispatchError
    try:
        result = company_research.dossier(_research_project_id(context), args.stock_code, args.as_of.isoformat())
        result["bars_window_total"] = len(result["bars"])
        result["bars"] = result["bars"][-30:]
        for key in ("news", "reports"):
            result[key]["items"] = result[key]["items"][:5]
            result[key]["next_offset"] = 5 if result[key]["total"] > 5 else None
            result[key]["preview_limit"] = 5
        result["preview_only"] = True
        return result
    except research_projects.ProjectError as exc:
        raise ToolDispatchError("company_research_error", str(exc)) from exc


def read_saved_research_evidence(args: ReadSavedEvidenceArgs, context) -> dict:
    from . import company_research, research_projects
    from .screening_tools import ToolDispatchError
    try:
        result = company_research.saved_evidence(_research_project_id(context), args.claim_id, args.evidence_index)
        relative = result["quote_start"] - result["char_start"]
        begin = max(0, relative - 500)
        end = min(len(result["text"]), max(begin + 4000, result["quote_end"] - result["char_start"]))
        return {**result, "text": result["text"][begin:end], "char_start": result["char_start"] + begin,
                "char_end": result["char_start"] + end, "original_snapshot_characters": len(result["text"]),
                "next_offset": None, "snapshot_excerpt": True}
    except research_projects.ProjectError as exc:
        raise ToolDispatchError("saved_evidence_error", str(exc)) from exc


class PreviewProgramArgs(ToolArgs):
    revision: int = Field(ge=1)
    reference_id: str
    stock_codes: list[str] = Field(min_length=1, max_length=20)


class ReadRunArgs(ToolArgs):
    run_id: str | None
    wait_seconds: int = Field(ge=0, le=20)
    state: Literal["", "true", "false", "unknown"]
    query: str = Field(max_length=32)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)


class StartResearchScanArgs(ToolArgs):
    name: str = Field(min_length=1, max_length=200)
    program: CustomProgram
    as_of: date | None = None
    universe: Literal["all_a_shares", "explicit"] = "all_a_shares"
    stock_codes: list[str] = Field(default_factory=list, max_length=20000)
    execution_mode: Literal["cross_sectional", "per_stock"] = "cross_sectional"


class DiscoverResearchDataArgs(ToolArgs):
    pass


class ReadResearchScanArgs(ToolArgs):
    scan_id: str | None = None
    wait_seconds: int = Field(default=0, ge=0, le=20)
    state: Literal["", "true", "false", "unknown"] = ""
    query: str = Field(default="", max_length=32)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=100, ge=1, le=200)


class CancelResearchScanArgs(ToolArgs):
    scan_id: str = Field(min_length=1, max_length=100)


TUSHARE_RESEARCH_APIS = frozenset({
    "trade_cal", "stock_basic", "daily", "weekly", "monthly", "adj_factor",
    "daily_basic", "moneyflow", "index_daily", "index_basic", "income",
    "balancesheet", "cashflow", "fina_indicator", "forecast", "express",
    "dividend", "news", "major_news",
})
TUSHARE_RESEARCH_PARAMS = frozenset({
    "ts_code", "trade_date", "start_date", "end_date", "ann_date", "period",
    "exchange", "fields", "source", "offset", "limit", "is_open", "list_status",
    "report_type", "type", "market", "year", "month", "src",
})

# Official Tushare input semantics: document/2 doc_ids 27/144/145/28/32/170/95
# use trading dates; 33/36/44/45/46 use announcement-date ranges. Doc_id 79
# uses reporting periods for start/end, and 103 (dividend) has no end_date
# input. These two must be checked using returned announcement dates instead.
TUSHARE_DIRECTORY_APIS = frozenset({"trade_cal", "stock_basic", "index_basic"})
TUSHARE_MARKET_DATE_APIS = frozenset({"daily", "weekly", "monthly", "adj_factor", "daily_basic", "moneyflow", "index_daily"})
TUSHARE_ANNOUNCEMENT_RANGE_APIS = frozenset({"income", "balancesheet", "cashflow", "forecast", "express"})
TUSHARE_NEWS_APIS = frozenset({"news", "major_news"})


def _tushare_record_date(value) -> date | None:
    if value is None or value == "":
        return None
    text = str(value).strip()
    try:
        if re.fullmatch(r"\d{8}", text):
            return datetime.strptime(text, "%Y%m%d").date()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            return date.fromisoformat(text)
        parsed = datetime.fromisoformat(text)
        return parsed.astimezone(news_sources.LOCAL_ZONE).date() if parsed.tzinfo else parsed.date()
    except (TypeError, ValueError):
        return None


def _tushare_scoped_params(args, context):
    from .screening_tools import ToolDispatchError
    params = dict(args.params)
    directory = args.api_name in TUSHARE_DIRECTORY_APIS
    scoped = context is not None and context.workflow_type == "research" and not directory
    cutoff = date.fromisoformat(context.as_of) if scoped and context.as_of else None
    codes = context.stock_codes if scoped else None
    if args.api_name in TUSHARE_NEWS_APIS and "source" in params and "src" not in params:
        params["src"] = params.pop("source")
    if codes is not None and params.get("ts_code"):
        supplied = {code.upper() for code in re.split(r"[,，\s]+", str(params["ts_code"]).strip()) if code}
        if not supplied or not supplied <= codes:
            raise ToolDispatchError("security_outside_research_scope", "Tushare 查询证券超出当前研究范围")
        params["ts_code"] = ",".join(sorted(supplied))
    if codes is not None and args.api_name in TUSHARE_NEWS_APIS:
        raise ToolDispatchError("tushare_security_scope_unverifiable", "该新闻接口不提供证券归属，无法核验当前研究范围；请读取已关联的本地资讯")
    if cutoff:
        # fina_indicator start/end describe reporting periods, not availability.
        date_keys = {"trade_date", "ann_date"}
        if args.api_name != "fina_indicator":
            date_keys.update({"start_date", "end_date"})
        for key in date_keys:
            if params.get(key):
                value = _tushare_record_date(params[key])
                if value is None:
                    raise ToolDispatchError("invalid_tushare_date", f"Tushare {key} 必须是有效日期")
                if value > cutoff:
                    raise ToolDispatchError("date_outside_research_scope", "Tushare 查询日期晚于当前研究截止日")
        if args.api_name in TUSHARE_MARKET_DATE_APIS | TUSHARE_ANNOUNCEMENT_RANGE_APIS and not params.get("end_date"):
            params["end_date"] = cutoff.strftime("%Y%m%d")
        elif args.api_name in TUSHARE_NEWS_APIS and not params.get("end_date"):
            params["end_date"] = cutoff.isoformat() + " 23:59:59"
        elif args.api_name == "dividend" and any(params.get(key) for key in ("start_date", "end_date")):
            raise ToolDispatchError("unsupported_tushare_date_filter", "分红接口不支持公告日期范围；请按证券或公告日期查询并核验返回日期")
    return params, cutoff, codes, directory


def _tushare_scoped_rows(rows, api_name, cutoff, codes, directory):
    excluded = {"security_outside_scope": 0, "missing_security": 0,
                "date_after_cutoff": 0, "missing_date": 0, "invalid_date": 0}
    kept = []
    for row in rows:
        if codes is not None:
            code = str(row.get("ts_code") or "").strip().upper()
            if not code or code not in codes:
                excluded["missing_security" if not code else "security_outside_scope"] += 1
                continue
        if cutoff:
            fields = ("trade_date",) if api_name in TUSHARE_MARKET_DATE_APIS else ("datetime",) if api_name == "news" else ("pub_time",) if api_name == "major_news" else ("ann_date", "imp_ann_date") if api_name == "dividend" else ("ann_date", "f_ann_date")
            values = [row.get(field) for field in fields if row.get(field) not in (None, "")]
            dates = [_tushare_record_date(value) for value in values]
            reason = "missing_date" if not values else "invalid_date" if any(value is None for value in dates) else "date_after_cutoff" if any(value > cutoff for value in dates) else None
            if reason:
                excluded[reason] += 1
                continue
        kept.append(row)
    status = "directory_only" if directory else "not_requested" if cutoff is None and codes is None else "verified_page" if kept else "no_verified_rows"
    return kept, {"status": status, "as_of": cutoff.isoformat() if cutoff else None,
                  "stock_codes": sorted(codes) if codes is not None else None,
                  "excluded_scope_counts": excluded, "excluded_total": sum(excluded.values()),
                  "record_dates_verified": bool(cutoff and kept), "historical_revision_verified": False,
                  "coverage": "returned_page_only"}


class TushareQueryArgs(ToolArgs):
    api_name: str = Field(min_length=1, max_length=40, description="Supported endpoints: " + ", ".join(sorted(TUSHARE_RESEARCH_APIS)))
    params: dict[str, str | int]
    limit: int = Field(default=100, ge=1, le=200)
    save_to_file: bool = True


def query_tushare(args: TushareQueryArgs, context: ToolContext) -> dict[str, Any]:
    from .screening_tools import ToolDispatchError

    if args.api_name not in TUSHARE_RESEARCH_APIS:
        raise ToolDispatchError("unsupported_tushare_api", "该 Tushare 接口未开放给研究查询")
    if len(args.params) > 12 or any(key not in TUSHARE_RESEARCH_PARAMS for key in args.params):
        raise ToolDispatchError("invalid_tushare_params", "Tushare 查询参数不受支持")
    if any(len(str(value)) > 500 for value in args.params.values()):
        raise ToolDispatchError("invalid_tushare_params", "Tushare 查询参数过长")
    params, cutoff, codes, directory = _tushare_scoped_params(args, context)
    if not directory and not any(
        params.get(key) for key in ("ts_code", "trade_date", "start_date", "end_date", "ann_date", "period")
    ):
        raise ToolDispatchError("tushare_scope_required", "请提供证券代码或查询日期，避免无范围的外部查询")
    try:
        raw_rows = tushare_sync._query(tushare_sync.create_client(), args.api_name, **params)
    except Exception as exc:
        raise ToolDispatchError("tushare_query_failed", f"{args.api_name} 查询失败：{type(exc).__name__}") from exc
    queried_at = utc_now()
    rows, scope_validation = _tushare_scoped_rows(raw_rows, args.api_name, cutoff, codes, directory)
    received = len(raw_rows)
    artifact = None
    if args.save_to_file:
        payload = json.dumps({"api_name": args.api_name, "params": params, "source": "tushare_relay",
                              "queried_at": queried_at, "items": rows, "received": received,
                              "scope_validation": scope_validation}, ensure_ascii=False, allow_nan=False, default=str)
        from .settings import research_mode_settings
        conversation = conversation_store.get_conversation(context.conversation_id, message_limit=1)
        if len(payload.encode("utf-8")) > int(research_mode_settings(conversation["research_mode"], context.research_depth)["max_output_file_bytes"]):
            raise ToolDispatchError("tushare_page_too_large", "查询结果超过单文件预算，请缩小范围或按接口分页")
        with connect() as connection:
            conversation_store.require_running_turn(connection, context.conversation_id, context.turn_id)
        artifact = research_workspace.write_output(context.conversation_id, f"tushare/{args.api_name}-{uuid4().hex}.json", payload)
    return {"api_name": args.api_name, "params": params, "items": rows[:args.limit],
            "returned": len(rows[:args.limit]), "received": received, "matched": len(rows), "truncated": len(rows) > args.limit,
            "scope_validation": scope_validation,
            "source": "tushare_relay", "queried_at": queried_at, "artifact": artifact,
            "note": "items 是提示词预览；artifact 保存同一范围内的整页数据，received 是过滤前页行数；排除原因见 scope_validation。缺证券或日期字段的记录不会伪称已核验。目录只供发现，不能证明历史资格；日期核验也不证明财报历史版本。接口可能仍有下一页，请按 offset/limit 分页。外部数据只用于研究，核对单位与复权；正式筛选仍使用冻结的本地数据。"}


def discover_research_data(_: DiscoverResearchDataArgs, context: ToolContext) -> dict:
    return research_workspace.describe_inputs(context.conversation_id, context.turn_id)


def _source_request(args, context):
    """Apply the independently frozen research scope to convenient read tools."""
    if context is None or context.workflow_type != "research":
        return args
    updates = {}
    if context.as_of:
        if args.as_of and args.as_of.isoformat() > context.as_of:
            from .screening_tools import ToolDispatchError
            raise ToolDispatchError("date_outside_research_scope", "资料查询晚于当前回合的研究截止日")
        if args.as_of is None:
            updates["as_of"] = date.fromisoformat(context.as_of)
    if getattr(args, "stock_code", None) and context.stock_codes is not None and args.stock_code not in context.stock_codes:
        from .screening_tools import ToolDispatchError
        raise ToolDispatchError("security_outside_research_scope", "证券不在当前回合的研究范围内")
    return args.model_copy(update=updates) if updates else args


def search_sources(args: SearchSourcesArgs, context: ToolContext) -> dict:
    args = _source_request(args, context)
    research_codes = context.stock_codes if context is not None and context.workflow_type == "research" else None
    report_earliest = None
    if context is not None and args.as_of and context.report_lookback_calendar_days:
        report_earliest = (args.as_of - timedelta(days=context.report_lookback_calendar_days)).isoformat()
    if args.kind == "news":
        predicates, params = [], []
        if args.as_of:
            from datetime import timezone
            cutoff = datetime.combine(args.as_of + timedelta(days=1), time.min, news_sources.LOCAL_ZONE).astimezone(timezone.utc).isoformat()
            predicates.append("n.version=(SELECT MAX(v.version) FROM news_records v WHERE v.root_id=n.root_id AND v.available_at IS NOT NULL AND v.available_at<?)")
            params.append(cutoff)
        else:
            predicates.append("n.version=(SELECT MAX(v.version) FROM news_records v WHERE v.root_id=n.root_id)")
        if args.query:
            predicates.append("(instr(n.title,?)>0 OR instr(n.body,?)>0)")
            params += [args.query, args.query]
        if args.stock_code:
            predicates.append("EXISTS(SELECT 1 FROM json_each(n.stock_codes_json) WHERE value=?)")
            params.append(args.stock_code)
        if research_codes is not None:
            predicates.append("EXISTS(SELECT 1 FROM json_each(n.stock_codes_json) WHERE value IN (" + ",".join("?" for _ in research_codes) + "))" if research_codes else "0")
            params.extend(sorted(research_codes))
        if context is not None and args.as_of and context.news_lookback_calendar_days:
            earliest = datetime.combine(args.as_of - timedelta(days=context.news_lookback_calendar_days), time.min, news_sources.LOCAL_ZONE).astimezone(timezone.utc).isoformat()
            predicates.append("n.available_at>=?")
            params.append(earliest)
        clause = " AND ".join(predicates)
        with connect() as connection:
            total = connection.execute(f"SELECT COUNT(*) FROM news_records n WHERE {clause}", params).fetchone()[0]
            rows = connection.execute(
                f"SELECT n.id,n.root_id,n.version,n.title,n.source,n.published_at,n.available_at,n.stock_codes_json,substr(n.body,1,240) AS snippet FROM news_records n WHERE {clause} ORDER BY n.available_at DESC,n.id LIMIT ? OFFSET ?",
                (*params, args.limit, args.offset)).fetchall()
        return {"items": [dict(row) for row in rows], "total": total, "offset": args.offset,
                "as_of": args.as_of.isoformat() if args.as_of else None}
    if args.query:
        result = documents.search_source_catalog(args.query, args.as_of.isoformat() if args.as_of else None,
                                                 args.stock_code, offset=args.offset, limit=args.limit,
                                                 stock_codes=research_codes, available_after=report_earliest)
        return {**result, "as_of": args.as_of.isoformat() if args.as_of else None,
                "note": "资料发现结果仅供定位；须读取原文、核对证券与首次可得日期后才能用于研究判断。"}
    predicates, params = ["1=1"], []
    if args.query:
        predicates.append("(instr(d.title,?)>0 OR EXISTS(SELECT 1 FROM document_pages p WHERE p.document_id=d.id AND instr(p.text,?)>0))")
        params += [args.query, args.query]
    if args.stock_code:
        predicates.append("d.stock_code=?")
        params.append(args.stock_code)
    if args.as_of:
        predicates.append("d.available_at_status='confirmed' AND d.available_at<=?")
        params.append(args.as_of.isoformat())
    if report_earliest:
        predicates.append("d.available_at>=?")
        params.append(report_earliest)
    if research_codes is not None:
        predicates.append("d.stock_code IN (" + ",".join("?" for _ in research_codes) + ")" if research_codes else "0")
        params.extend(sorted(research_codes))
    clause = " AND ".join(predicates)
    with connect() as connection:
        total = connection.execute(f"SELECT COUNT(*) FROM documents d WHERE {clause}", params).fetchone()[0]
        rows = connection.execute(
            f"SELECT d.id,d.title,d.filename,d.stock_code,d.stock_code_status,d.pages,d.publication_date,d.available_at,d.available_at_status FROM documents d WHERE {clause} ORDER BY d.publication_date DESC,d.id LIMIT ? OFFSET ?",
            (*params, args.limit, args.offset),
        ).fetchall()
    return {"items": [dict(row) for row in rows], "total": total, "offset": args.offset,
            "as_of": args.as_of.isoformat() if args.as_of else None,
            "note": "开放研究目录；未指定截止日时可阅读未确认日期资料，但不能用来证明历史筛选结论。"}


def read_source(args: ReadSourceArgs, context: ToolContext) -> dict:
    from .screening_tools import ToolDispatchError
    args = _source_request(args, context)
    if args.kind == "report":
        result = documents.read_page(args.source_id, args.page_number,
                                     as_of=args.as_of.isoformat() if args.as_of else None, max_chars=None)
        text = result.get("text")
        if text is None:
            return result
    else:
        if args.page_number != 1:
            raise ToolDispatchError("invalid_page", "资讯页码为1")
        result = news_sources.get_item(args.source_id)
        if args.as_of:
            cutoff = datetime.combine(args.as_of + timedelta(days=1), time.min, news_sources.LOCAL_ZONE)
            available = result.get("available_at")
            if not available or datetime.fromisoformat(available) >= cutoff:
                raise ToolDispatchError("source_after_cutoff", "资讯日期未确认或晚于截止日")
        text = result.pop("body")
    if context is not None and context.workflow_type == "research":
        if context.stock_codes is not None:
            codes = {result.get("stock_code")} if args.kind == "report" else set(result.get("stock_codes") or [])
            if not codes.intersection(context.stock_codes):
                raise ToolDispatchError("security_outside_research_scope", "资料证券归属不在当前回合的研究范围内")
        lookback = context.report_lookback_calendar_days if args.kind == "report" else context.news_lookback_calendar_days
        available = result.get("available_at")
        if lookback and args.as_of and available and str(available)[:10] < (args.as_of - timedelta(days=lookback)).isoformat():
            raise ToolDispatchError("source_outside_research_lookback", "资料早于当前研究回溯范围")
    if args.offset > len(text):
        raise ToolDispatchError("invalid_offset", "读取位置超出原文")
    end = min(len(text), args.offset + args.limit)
    return {**result, "source_id": args.source_id, "page_number": args.page_number,
            "text": text[args.offset:end], "char_start": args.offset, "char_end": end,
            "original_characters": len(text), "next_offset": end if end < len(text) else None}


def preview_program(args: PreviewProgramArgs, context: ToolContext) -> dict:
    from .screening_tools import ToolDispatchError
    task = conversation_store.get_task_revision(context.conversation_id, args.revision)
    if args.revision != context.task_revision:
        raise ToolDispatchError("revision_conflict", "请试算当前条件修订")
    reference = next((ref for ref in task.references if ref.reference_id == args.reference_id), None)
    if reference is None:
        raise ToolDispatchError("reference_not_found", "找不到此程序条件")
    condition = next(item for item in task.conditions if item.condition_id == reference.condition_id)
    if condition.program is None or task.scope.as_of is None:
        raise ToolDispatchError("program_not_ready", "试算需要 Python 条件和截止日")
    codes = list(dict.fromkeys(args.stock_codes))
    from .screening_tools import _check_market_scope
    for code in codes:
        _check_market_scope(context, code)
    as_of = task.scope.as_of.isoformat()
    bars = {code: market.get_bars(code, as_of, condition.program.required_history_bars) for code in codes}
    try:
        result = program_conditions.evaluate_batch(
            condition.model_dump(mode="json"), reference.model_dump(mode="json"), codes, bars,
            as_of=as_of, effective_market_date=market.latest_market_date(as_of),
            is_active=lambda: conversation_store.get_turn(context.conversation_id, context.turn_id)["state"] == "running",
        )
    except Exception as exc:
        raise ToolDispatchError("program_preview_failed", f"{type(exc).__name__}: {str(exc)[:2000]}") from exc
    return {"preview": True, "revision": args.revision, "reference_id": args.reference_id,
            "results": result, "note": "试算只验证样本；未创建正式筛选或观察池记录。"}


def execute_task(args: ExecuteTaskArgs, context: ToolContext) -> dict:
    from .screening_tools import ToolDispatchError, _authorize_screening_execution
    if args.revision != context.task_revision:
        raise ToolDispatchError("revision_conflict", "请执行当前条件修订")
    existing = screening_service._existing_request(
        context.conversation_id, f"conversation-turn:{context.turn_id}:revision:{args.revision}")
    if existing:
        return existing
    grant = _authorize_screening_execution(args, context)
    if not grant["ready_to_execute"]:
        return grant
    try:
        return screening_service.enqueue_turn(context.conversation_id, context.turn_id, agent_active=True)
    except screening_service.ScreeningServiceError as exc:
        raise ToolDispatchError(exc.code, str(exc)) from exc


def read_run(args: ReadRunArgs, context: ToolContext) -> dict:
    from .screening_tools import ToolDispatchError
    runs = screening_service.list_task_runs(context.conversation_id)
    run_id = args.run_id or (runs[0]["id"] if runs else None)
    if run_id is None:
        return {"runs": [], "note": "当前研究尚无正式筛选运行"}
    deadline = clock.monotonic() + args.wait_seconds
    try:
        while True:
            run = screening_service.get_task_run(context.conversation_id, run_id)
            if run["status"] not in {"queued", "running"} or clock.monotonic() >= deadline:
                break
            if conversation_store.get_turn(context.conversation_id, context.turn_id)["state"] != "running":
                raise ToolDispatchError("research_stopped", "研究已停止")
            clock.sleep(min(0.5, max(0, deadline - clock.monotonic())))
        return {"run": run, "decisions": screening_service.list_task_decisions(
            context.conversation_id, run_id, state=args.state, query=args.query, offset=args.offset, limit=args.limit),
            "recent_runs": runs, "uses_current_data": False}
    except screening_service.ScreeningServiceError as exc:
        raise ToolDispatchError(exc.code, str(exc)) from exc


def start_research_scan(args: StartResearchScanArgs, context: ToolContext) -> dict:
    from .screening_tools import ToolDispatchError
    args = _source_request(args, context)
    if context.workflow_type == "research" and context.stock_codes is not None:
        if args.stock_codes and not set(args.stock_codes) <= context.stock_codes:
            raise ToolDispatchError("security_outside_research_scope", "研究扫描超出当前回合的证券范围")
        args = args.model_copy(update={"universe": "explicit", "stock_codes": args.stock_codes or sorted(context.stock_codes)})
    try:
        return research_scan_service.enqueue_scan(
            context.conversation_id,
            context.turn_id,
            name=args.name,
            program=args.program,
            as_of=args.as_of,
            universe=args.universe,
            stock_codes=args.stock_codes,
            execution_mode=args.execution_mode,
        )
    except research_scan_service.ResearchScanError as exc:
        raise ToolDispatchError(exc.code, str(exc)) from exc


def read_research_scan(args: ReadResearchScanArgs, context: ToolContext) -> dict:
    from .screening_tools import ToolDispatchError
    scans = research_scan_service.list_scans(context.conversation_id)
    scan_id = args.scan_id or (scans[0]["id"] if scans else None)
    if scan_id is None:
        return {"scans": [], "note": "当前对话尚无只读研究扫描"}
    deadline = clock.monotonic() + args.wait_seconds
    try:
        while True:
            scan = research_scan_service.get_scan(context.conversation_id, scan_id)
            if scan["status"] not in {"queued", "running"} or clock.monotonic() >= deadline:
                break
            if conversation_store.get_turn(context.conversation_id, context.turn_id)["state"] != "running":
                raise ToolDispatchError("research_stopped", "研究回合已停止")
            clock.sleep(min(0.5, max(0, deadline - clock.monotonic())))
        return {
            "scan": scan,
            "decisions": research_scan_service.list_decisions(
                context.conversation_id,
                scan_id,
                state=args.state,
                query=args.query,
                offset=args.offset,
                limit=args.limit,
            ),
            "recent_scans": scans,
            "read_only_research": True,
        }
    except research_scan_service.ResearchScanError as exc:
        raise ToolDispatchError(exc.code, str(exc)) from exc


def cancel_research_scan(args: CancelResearchScanArgs, context: ToolContext) -> dict:
    from .screening_tools import ToolDispatchError
    try:
        return research_scan_service.cancel_scan(context.conversation_id, args.scan_id)
    except research_scan_service.ResearchScanError as exc:
        raise ToolDispatchError(exc.code, str(exc)) from exc


def register_tools(registry) -> None:
    from .research_external import register_tools as register_external_tools
    register_external_tools(registry)
    registry.register("read_project_company", "Read this conversation's project company dossier as of an explicit date. Includes actual price dates, unknown units, source counts and bounded previews. No screening task or run is created. Use normal source/data tools for full analysis.", ReadProjectCompanyArgs, read_project_company)
    registry.register("read_saved_research_evidence", "Read the immutable original-text snapshot attached to a research claim in this conversation's project. Claim IDs are in project context. Quote location is verified; semantic support and claim kind are user annotations, not established facts.", ReadSavedEvidenceArgs, read_saved_research_evidence)
    registry.register("discover_research_data", "Inspect this turn's actual Parquet columns and types, units, date range, SQLite snapshot schemas and source paths. No screening task is required. Use native Python/DuckDB for arbitrary exploratory queries; unknown units must be verified.", DiscoverResearchDataArgs, discover_research_data)
    registry.register("query_tushare", "Read market, calendar, financial or news data through the configured Tushare relay. params is a structured object with endpoint parameters (ts_code, trade_date, start_date, end_date, ann_date, period, exchange, fields, source, offset, limit, is_open, list_status, report_type, type, market, year, month). Query a stock/date scope and inspect pagination; credentials are never returned.", TushareQueryArgs, query_tushare, open_world=True)
    registry.register("search_research_sources", "Discover reports or news across the library before defining any screening task. Optional date filters; return source metadata and pagination.", SearchSourcesArgs, search_sources)
    registry.register("read_research_source", "Read original research text and provenance without requiring a screening task. Follow next_offset for long pages; optional historical cutoff is enforced.", ReadSourceArgs, read_source)
    registry.register("preview_screening_program", "Run a current Python condition on up to 20 sample securities and return actual metrics or the program error for repair. Does not create a formal run.", PreviewProgramArgs, preview_program, read_only=False)
    registry.register("execute_screening_task", "Check the user's explicit execution request and enqueue the current task during research. Use read_screening_run to inspect progress and results. Saving/discussion alone never authorizes execution.", ExecuteTaskArgs, execute_task, read_only=False)
    registry.register("read_screening_run", "Read this research's saved run, errors, coverage and paginated decisions; optionally wait up to 20 seconds. Null run_id selects the latest run. No rerun or current-data substitution.", ReadRunArgs, read_run)
    registry.register("start_research_scan", "Autonomously run a read-only Python research scan over the full local A-share universe or explicit securities. Default cross_sectional mode passes the entire frozen universe together for ranking; choose per_stock only for independent calculations to checkpoint and resume batches. No screening task revision, formal execution grant or observation record is created. Results persist for later turns. General research scripts can use native Python without this contract.", StartResearchScanArgs, start_research_scan, read_only=False)
    registry.register("read_research_scan", "Read this conversation's persisted research scan, progress, errors and paginated per-stock metrics. Optionally wait up to 20 seconds. Null scan_id selects the latest research scan; reading never reruns with current data.", ReadResearchScanArgs, read_research_scan)
    registry.register("cancel_research_scan", "Cancel this conversation's queued or running read-only research scan. Completed results remain available.", CancelResearchScanArgs, cancel_research_scan, read_only=False)
