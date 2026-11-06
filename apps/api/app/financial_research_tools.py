"""Research reads use this turn's immutable SQL inputs, never a fresh provider query."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import date
import json
import re
import sqlite3
from typing import Literal

from pydantic import Field, ValidationError
from . import conversation_store, financial_metrics, financial_evidence, financial_research, research_workspace, documents
from .models import StrictModel as ToolArgs
from .financial_contracts import timestamp, ZONE


def _tool_error(code, message):
    from .screening_tools import ToolDispatchError
    return ToolDispatchError(code, message)


FinancialMetric = Literal[tuple(item["code"] for item in financial_metrics.catalog())]


class FinancialArgs(ToolArgs):
    stock_code: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    as_of: date
    start_year: int | None = Field(None, ge=2000, le=2100)
    basis: Literal["annual", "cumulative", "quarter", "ttm"] = "annual"
    mode: Literal["as_of", "latest"] = "as_of"
    metrics: list[FinancialMetric] = Field(default_factory=lambda: ["revenue", "parent_net_profit", "operating_cashflow"], min_length=1, max_length=8,
        description="Verified metric codes. Revenue: revenue; net profit attributable to parent: parent_net_profit; operating cash flow: operating_cashflow.")
    offset: int = Field(0, ge=0)
    limit: int = Field(6, ge=1, le=12)


class FinancialEvidenceArgs(ToolArgs):
    calculation_id: str | None = Field(None, pattern=r"^[a-f0-9]{64}$")
    metric: str | None = Field(None, min_length=1, max_length=100)
    period: date | None = None
    evidence_id: str | None = Field(None, pattern=r"^[a-f0-9]{64}$")


class CompareArgs(ToolArgs):
    stock_codes: list[str] = Field(min_length=3, max_length=5)
    as_of: date
    start_year: int | None = Field(None, ge=2000, le=2100)
    basis: Literal["annual", "cumulative", "quarter", "ttm"] = "annual"
    mode: Literal["as_of", "latest"] = "as_of"
    metrics: list[FinancialMetric] = Field(default_factory=lambda: ["revenue", "parent_net_profit", "operating_cashflow"], min_length=1, max_length=8)


class SearchDisclosuresArgs(ToolArgs):
    stock_code: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    as_of: date
    report_period: date | None = Field(None, description="Fiscal period END DATE in YYYY-MM-DD form, e.g. 2025-12-31 or 2026-06-30; never a bare year.")
    query: str = Field("", max_length=300, description="One literal phrase to locate in a page, e.g. 营业收入. Do not concatenate unrelated search terms. Empty lists the available reports.")
    offset: int = Field(0, ge=0)
    limit: int = Field(10, ge=1, le=30)
    mode: Literal["as_of", "latest"] = "as_of"


class ReadDisclosureArgs(ToolArgs):
    stock_code: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    as_of: date
    version_id: str = Field(min_length=1, max_length=100)
    page_number: int = Field(ge=1, le=5000)
    offset: int = Field(0, ge=0)
    limit: int = Field(12000, ge=1, le=12000)
    mode: Literal["as_of", "latest"] = "as_of"


def _scope(context, codes, as_of):
    if context.as_of and as_of > context.as_of:
        raise _tool_error("date_outside_research_scope", "请求晚于本回合研究截止日")
    if context.stock_codes is not None and any(code not in context.stock_codes for code in codes):
        raise _tool_error("security_outside_research_scope", "公司不在本回合研究范围内")


@contextmanager
def frozen(context):
    # Verify workspace ownership through the conversation before opening paths.
    conversation_store.get_turn(context.conversation_id, context.turn_id)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", context.turn_id):
        raise _tool_error("invalid_turn", "研究回合标识无效")
    path = research_workspace.directory(context.conversation_id).parent / "inputs" / f"{context.turn_id}.sqlite"
    if not path.is_file():
        research_workspace.prepare(context.conversation_id, context.turn_id)
    if path.is_symlink() or path.parent.is_symlink() or not path.resolve().is_relative_to(research_workspace.directory(context.conversation_id).parent.resolve()):
        raise _tool_error("snapshot_unavailable", "研究快照路径无效")
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    from .report_search import normalize_search_text
    connection.create_function("llmr_search_text", 1, normalize_search_text, deterministic=True)
    try:
        present = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"financial_facts", "financial_evidence_links", "research_data_evidence", "disclosure_pages"} <= present:
            raise _tool_error("snapshot_requires_new_turn", "此旧回合未冻结财务资料，请在新回合读取；不会换用当前数据")
        yield connection
    finally:
        connection.close()


def calculation(connection, query):
    rows = connection.execute("""SELECT DISTINCT s.record_json FROM financial_source_records s
        JOIN financial_facts f ON f.record_id=s.id WHERE f.stock_code=? AND f.normalization_version=?""",
        (query.stock_code, financial_metrics.financial_facts.NORMALIZATION_VERSION)).fetchall()
    facts = {row["id"]: json.loads(row["fact_json"]) for row in connection.execute("SELECT id,fact_json FROM financial_facts WHERE stock_code=? AND normalization_version=?",
             (query.stock_code, financial_metrics.financial_facts.NORMALIZATION_VERSION))}
    return financial_metrics.calculate(query, records=[json.loads(row[0]) for row in rows], facts=facts)


def _tool_evidence(payload):
    # Keep the citation and exact used inputs inline; the full immutable raw
    # source rows remain in the independent evidence endpoint.
    reference = {"kind": payload["kind"], "source_id": payload["id"], "title": payload["title"], "url": payload["citation_url"]}
    result = {"citation_url": payload["citation_url"], "reference": reference, **payload}
    if payload["kind"] == "financial":
        result["inputs"] = [{
            "fact_id": item["fact_id"], "record_id": item["record"]["id"], "family": item["record"]["family"],
            "period": item["record"]["report_period"], "scope": item["record"]["scope"], "field": item["fact"]["source_field"],
            "raw_value": item["fact"]["raw_value"], "raw_unit": item["fact"]["raw_unit"], "value": item["fact"]["value"],
            "unit": item["fact"]["unit"], "currency": item["fact"]["currency"], "public_date": item["record"]["public_date"],
            "first_observed_at": item["record"]["first_observed_at"],
            "response_hashes": sorted({entry["response_hash"] for entry in item["observations"] + item["pilot_observations"]}),
        } for item in payload["inputs"]]
    return result


def get_financials(args, context):
    _scope(context, [args.stock_code], args.as_of.isoformat())
    try:
        query = financial_metrics.FinancialQuery(**args.model_dump(exclude={"offset", "limit"}))
    except ValidationError as exc:
        raise _tool_error("invalid_financial_query", "财务查询参数无效：" + "；".join(error["msg"] for error in exc.errors(include_url=False))) from exc
    with frozen(context) as connection:
        result = calculation(connection, query)
    financial_metrics.store_result(result)
    rows = list(reversed(result["rows"]))
    return {**{key: value for key, value in result.items() if key != "rows"},
            "rows": rows[args.offset:args.offset + args.limit], "total_periods": len(rows),
            "next_offset": args.offset + args.limit if args.offset + args.limit < len(rows) else None,
            "input_scope": "frozen_turn", "citation_instruction": "对答复使用的具体数字调用 read_financial_evidence，再引用其 citation_url；不要把未核对原文标成已核验。"}


def read_financial(args, context):
    if args.evidence_id:
        with frozen(context) as connection:
            row = connection.execute("SELECT payload_json FROM research_data_evidence WHERE id=?", (args.evidence_id,)).fetchone()
        if not row:
            raise _tool_error("evidence_outside_turn", "此依据未在回合开始前保存，请在新回合读取")
        payload = json.loads(row[0])
        _scope(context, [payload["stock_code"]], payload["as_of"])
        return _tool_evidence(financial_evidence.read(args.evidence_id))
    if not args.calculation_id or not args.metric or not args.period:
        raise _tool_error("evidence_arguments_required", "请提供已保存依据标识，或计算标识、指标和报告期")
    result = financial_metrics.read_calculation(args.calculation_id)
    _scope(context, [result["request"]["stock_code"]], result["request"]["as_of"])
    point = next((row["values"].get(args.metric) for row in result["rows"] if row["period"] == args.period.isoformat()), None)
    if point is None:
        raise _tool_error("financial_point_not_found", "计算中没有此数字")
    inputs, captured_links = {}, []
    with frozen(context) as connection:
        expected = calculation(connection, financial_metrics.FinancialQuery(**result["request"]))
        if expected["calculation_id"] != args.calculation_id:
            raise _tool_error("calculation_outside_turn", "计算不是由本回合冻结资料得到，请先读取本回合公司财务")
        for fact_id in point["input_fact_ids"]:
            row = connection.execute("""SELECT f.fact_json,s.record_json FROM financial_facts f JOIN financial_source_records s
                ON s.id=f.record_id WHERE f.id=?""", (fact_id,)).fetchone()
            if not row:
                raise _tool_error("evidence_outside_turn", "数字输入不在此回合快照中，不能以当前版本替代")
            record = json.loads(row["record_json"])
            inputs[fact_id] = {"fact": json.loads(row["fact_json"]), "record": record,
                "observations": [dict(item) for item in connection.execute("SELECT * FROM financial_sync_observations WHERE record_id=?", (record["id"],))],
                "pilot_observations": [dict(item) for item in connection.execute("SELECT * FROM financial_source_observations WHERE record_id=?", (record["id"],))]}
            captured_links.extend(financial_evidence.links(fact_id, connection=connection, as_of=result["request"]["as_of"], mode=result["request"]["mode"]))
    evidence = financial_evidence.financial(args.calculation_id, args.metric, args.period.isoformat(), captured_links=captured_links, captured_inputs=inputs)
    return _tool_evidence(evidence)


def compare(args, context):
    _scope(context, args.stock_codes, args.as_of.isoformat())
    try:
        request = financial_research.ComparisonRequest(**args.model_dump())
    except ValidationError as exc:
        raise _tool_error("invalid_financial_query", "财务比较参数无效：" + "；".join(error["msg"] for error in exc.errors(include_url=False))) from exc
    with frozen(context) as connection:
        results = [calculation(connection, financial_metrics.FinancialQuery(
            stock_code=code, as_of=args.as_of, start_year=args.start_year, basis=args.basis, mode=args.mode, metrics=args.metrics)) for code in args.stock_codes]
    saved = financial_research.store_comparison(financial_research.compare(request, results=results))
    return {"id": saved["id"], "request": saved["request"], "companies": saved["companies"], "metrics": saved["metrics"],
            "calculations": [{"stock_code": item["request"]["stock_code"], "calculation_id": item["calculation_id"], "rows": item["rows"][-6:]} for item in results],
            "note": saved["note"], "input_scope": "frozen_turn", "citation_instruction": "比较值已保存，引用具体数字请调用 read_financial_evidence。"}


def _versions(connection, code, as_of, mode="as_of"):
    rows = connection.execute("""SELECT v.*,m.revision metadata_revision,m.metadata_json,d.pages,d.source_path,d.parse_status
        FROM disclosure_versions v JOIN disclosure_metadata m ON m.version_id=v.id
        AND m.revision=(SELECT MAX(n.revision) FROM disclosure_metadata n WHERE n.version_id=v.id)
        JOIN disclosure_documents d ON d.id=v.document_id
        WHERE json_extract(m.metadata_json,'$.stock_code')=? AND json_extract(m.metadata_json,'$.confirmed')=1
        AND json_extract(m.metadata_json,'$.publication_date') IS NOT NULL AND json_extract(m.metadata_json,'$.publication_date')<=?
        ORDER BY json_extract(m.metadata_json,'$.report_period') DESC,v.version DESC""", (code, as_of)).fetchall()
    return [{**dict(row), "metadata": json.loads(row["metadata_json"])} for row in rows
            if mode == "latest" or timestamp(row["created_at"]).astimezone(ZONE).date().isoformat() <= as_of]


def search_disclosures(args, context):
    _scope(context, [args.stock_code], args.as_of.isoformat())
    with frozen(context) as connection:
        versions = _versions(connection, args.stock_code, args.as_of.isoformat(), args.mode)
        matches = []
        for version in versions:
            if args.report_period and version["metadata"]["report_period"] != args.report_period.isoformat():
                continue
            queries = [args.query]
            if args.query.startswith("合并") and "及公司" not in args.query:
                queries.append(args.query.replace("合并", "合并及公司", 1))
            predicate = " OR ".join("instr(llmr_search_text(text),llmr_search_text(?))>0" for _ in queries)
            pages = [row[0] for row in connection.execute("SELECT page_number FROM disclosure_pages WHERE document_id=? AND (" + predicate + ") ORDER BY page_number LIMIT 12", (version["document_id"], *queries))] if args.query else []
            if args.query and args.query.lower() not in version["metadata"]["title"].lower() and not pages:
                continue
            matches.append({"version_id": version["id"], "stock_code": args.stock_code, "metadata": version["metadata"],
                            "sha256": version["sha256"], "pages": version["pages"], "matched_physical_pages": pages,
                            "first_observed_at": version["created_at"], "read_mode": args.mode,
                            "version": version["version"], "relation_status": "document_related"})
    return {"items": matches[args.offset:args.offset + args.limit], "total": len(matches), "input_scope": "frozen_turn",
            "next_offset": args.offset + args.limit if args.offset + args.limit < len(matches) else None,
            "note": "原文检索独立于最近资讯；页匹配仅用于定位，不证明数值或论点已核验。"}


def read_disclosure(args, context):
    _scope(context, [args.stock_code], args.as_of.isoformat())
    with frozen(context) as connection:
        version = next((item for item in _versions(connection, args.stock_code, args.as_of.isoformat(), args.mode) if item["id"] == args.version_id), None)
        if not version:
            raise _tool_error("disclosure_outside_turn", "披露不在本回合公司、日期或冻结版本范围内")
        if not version["source_path"]:
            raise _tool_error("original_missing", "冻结原件不可用，不能伪称已读原文")
        documents.original_snapshot(version["source_path"], version["sha256"])
        row = connection.execute("SELECT text FROM disclosure_pages WHERE document_id=? AND page_number=?", (version["document_id"], args.page_number)).fetchone()
    if not row or args.offset > len(row[0]):
        raise _tool_error("invalid_disclosure_page", "物理页或读取位置无效")
    text, end = row[0], min(len(row[0]), args.offset + args.limit)
    chunk = {"source_type": "disclosure", "source_id": version["id"], "document_id": version["document_id"], "sha256": version["sha256"],
             "version": version["version"], "metadata_revision": version["metadata_revision"], "classification": version["metadata"],
             "availability_basis": "user_confirmed", "page_number": args.page_number, "page_count": version["pages"],
             "first_observed_at": version["created_at"], "read_mode": args.mode,
             "char_start": args.offset, "char_end": end, "text": text[args.offset:end], "original_characters": len(text),
             "next_offset": end if end < len(text) else None}
    saved = financial_evidence.disclosure_chunk(chunk, args.stock_code, args.as_of.isoformat())
    return _tool_evidence(saved)


def register(registry):
    registry.register("get_company_financials", "Read standardized financials from this turn's frozen inputs. Units, quarters, TTM and revision selection are calculated by the service. Empty values have reasons. Save numeric citations with read_financial_evidence.", FinancialArgs, get_financials)
    registry.register("read_financial_evidence", "Read a saved evidence_id from this turn's frozen evidence table to inspect OLD research, or provide calculation_id/metric/period to freeze a current numeric cell. Returns a standalone citation_url. Only original_verified=true means every input has manually verified original evidence. No fresh provider query.", FinancialEvidenceArgs, read_financial)
    registry.register("compare_company_financials", "Compare 3–5 companies using identical date, basis and units from frozen inputs; preserve gaps and industry inapplicability. Does not rank investments.", CompareArgs, compare)
    registry.register("search_disclosures", "Search archived primary disclosures by company, period and text in frozen inputs, independently of recent news. Returns physical pages, immutable versions and document_related status.", SearchDisclosuresArgs, search_disclosures)
    registry.register("read_disclosure", "Read a frozen primary disclosure physical page; verify original PDF hash and return a standalone citation_url. Page matching alone does not verify numerical values.", ReadDisclosureArgs, read_disclosure)
