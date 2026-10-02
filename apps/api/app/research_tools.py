"""Business tools used alongside Codex's native research workspace."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
import json
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
    "report_type", "type", "market", "year", "month",
})


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
    if args.api_name not in {"trade_cal", "stock_basic", "index_basic"} and not any(
        args.params.get(key) for key in ("ts_code", "trade_date", "start_date", "ann_date", "period")
    ):
        raise ToolDispatchError("tushare_scope_required", "请提供证券代码或查询日期，避免无范围的外部查询")
    try:
        rows = tushare_sync._query(tushare_sync.create_client(), args.api_name, **args.params)
    except Exception as exc:
        raise ToolDispatchError("tushare_query_failed", f"{args.api_name} 查询失败：{type(exc).__name__}") from exc
    queried_at = utc_now()
    artifact = None
    if args.save_to_file:
        payload = json.dumps({"api_name": args.api_name, "params": args.params, "source": "tushare_relay",
                              "queried_at": queried_at, "items": rows}, ensure_ascii=False, allow_nan=False, default=str)
        from .settings import research_mode_settings
        mode = conversation_store.get_conversation(context.conversation_id, message_limit=1)["research_mode"]
        if len(payload.encode("utf-8")) > int(research_mode_settings(mode)["max_output_file_bytes"]):
            raise ToolDispatchError("tushare_page_too_large", "查询结果超过单文件预算，请缩小范围或按接口分页")
        with connect() as connection:
            conversation_store.require_running_turn(connection, context.conversation_id, context.turn_id)
        artifact = research_workspace.write_output(context.conversation_id, f"tushare/{args.api_name}-{uuid4().hex}.json", payload)
    return {"api_name": args.api_name, "params": args.params, "items": rows[:args.limit],
            "returned": len(rows[:args.limit]), "received": len(rows), "truncated": len(rows) > args.limit,
            "source": "tushare_relay", "queried_at": queried_at, "artifact": artifact,
            "note": "items 是提示词预览；artifact 包含本次接口返回的整页数据。接口可能仍有下一页，请按接口的 offset/limit 分页，不把本页视作完整覆盖。外部数据只用于研究；正式筛选仍使用冻结的本地数据。核对单位、复权与可得日期。"}


def discover_research_data(_: DiscoverResearchDataArgs, context: ToolContext) -> dict:
    return research_workspace.describe_inputs(context.conversation_id, context.turn_id)


def search_sources(args: SearchSourcesArgs, _: ToolContext) -> dict:
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
        clause = " AND ".join(predicates)
        with connect() as connection:
            total = connection.execute(f"SELECT COUNT(*) FROM news_records n WHERE {clause}", params).fetchone()[0]
            rows = connection.execute(
                f"SELECT n.id,n.root_id,n.version,n.title,n.source,n.published_at,n.available_at,n.stock_codes_json,substr(n.body,1,240) AS snippet FROM news_records n WHERE {clause} ORDER BY n.available_at DESC,n.id LIMIT ? OFFSET ?",
                (*params, args.limit, args.offset)).fetchall()
        return {"items": [dict(row) for row in rows], "total": total, "offset": args.offset,
                "as_of": args.as_of.isoformat() if args.as_of else None}
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


def read_source(args: ReadSourceArgs, _: ToolContext) -> dict:
    from .screening_tools import ToolDispatchError
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
