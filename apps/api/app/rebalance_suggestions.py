"""Collect report evidence and draft editable reasons for user-supplied adjustments."""
from __future__ import annotations

from datetime import date, datetime
import re

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import codex_runtime, conversation_store, research_turn_service
from .client_service import error, now
from .client_service_text import without_web_links
from .codex_store import web_evidence
from .db import connect, json_dump, json_load
from .report_evidence import normalize_quote
from .screening_contracts import ResearchScope
from .stock_diagnosis import DiagnosisRequest, resolve_stock


INSTRUCTIONS = """你负责起草一段可由投顾编辑的 A 股调仓理由。输入的调仓方向只是沟通场景。围绕该场景选择有直接关系的事实，说明数据、期间和判断条件。分析师预测、评级和公司指引要明确是谁的观点。不要猜测投顾决策、持仓、仓位变化或参考价格，不要建议具体仓位、价格或承诺收益。对于止盈、减仓和止损，只写原文支持的风险或观察依据，不能把看好公司的研报当作已知卖出动机。
输入的本地研报包含系统已定位的原文页摘录。摘录与股票、截止时间和调仓场景匹配时，可直接从这些原文页取证。若本地没有能支持文案的研报，使用可用的原生网页搜索，并实际打开一份相关研报原文或可核对正文、券商、作者与日期的转载。搜索摘要、只有标题的页面和与该股票无关的报告不能作依据。找到可用研报后停止扩展。标题、作者、券商、日期和数字务必据实，有缺口就留空或报告没有可核对的研报。
中文用词直接。理由写成一个可转发的短段落，说明对判断最重要的两三个事实和限制。理由正文只写文字，网址只放在 report.url 中。误导性判断和原文未支持的数字应省略。来源、固定风险提示及投顾落款由系统组装。
只返回 JSON。找到研报时的格式为 {"reason":"可编辑的调仓理由","report":{"document_id":null,"url":null,"title":"","broker":"","authors":"","publication_date":null,"quote":"支持理由的原文连续摘录"}}。本地研报填写输入中的 document_id，线上研报填写实际打开的 url 和完整报告元数据。本地已提供的元数据可留空。quote 从同一份研报逐字复制一处约 8 至 40 字的连续片段，保留原标点。表格和正文交错时选择一处完整的短句，避免把几个句子拼成引文。若没有可核对且能提供依据的研报，返回 {"reason":"","report":null}。"""


class SuggestionRequest(DiagnosisRequest):
    direction: str = Field(min_length=1, max_length=30, pattern=r"^\S(?:[^\r\n]*\S)?$")
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ReportCitation(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    document_id: str | None = Field(default=None, max_length=100)
    url: str | None = Field(default=None, max_length=2048, pattern=r"^https?://\S+$")
    title: str = Field(default="", max_length=300)
    broker: str = Field(default="", max_length=80)
    authors: str = Field(default="", max_length=160)
    publication_date: date | None = None
    quote: str = Field(min_length=8, max_length=600)


class CollectionReply(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    reason: str = Field(max_length=1600)
    report: ReportCitation | None


def _local_reports(connection, code: str, cutoff: date) -> list[dict]:
    rows = connection.execute(
        """SELECT id,title,publication_date,metadata_json,metadata_status FROM documents
           WHERE stock_code=? AND stock_code_status='confirmed' AND material_kind='report'
             AND parse_status='indexed' AND available_at_status='confirmed' AND available_at<=?
             AND publication_date<=?
           ORDER BY publication_date DESC,available_at DESC,id LIMIT 3""",
        (code, cutoff.isoformat(), cutoff.isoformat()),
    ).fetchall()
    reports = []
    for row in rows:
        try:
            date.fromisoformat(row["publication_date"])
        except ValueError:
            continue
        pages = [dict(page) for page in connection.execute(
            """SELECT page_number,substr(text,1,5000) AS text FROM document_pages
               WHERE document_id=? AND trim(text)<>'' ORDER BY page_number LIMIT 2""",
            (row["id"],),
        )]
        if not pages:
            continue
        fields = json_load(row["metadata_json"]).get("fields", {}) if row["metadata_status"] == "ready" else {}
        reports.append({
            "document_id": row["id"],
            "title": fields.get("title", {}).get("value") or row["title"],
            "broker": fields.get("broker", {}).get("value") or "",
            "authors": fields.get("analysts", {}).get("value") or "",
            "publication_date": row["publication_date"],
            "pages": pages,
        })
    return reports


def _find(connection, request_id: str):
    return connection.execute("SELECT * FROM client_rebalance_suggestions WHERE request_id=?", (request_id,)).fetchone()


def start(payload: SuggestionRequest) -> dict:
    with connect() as connection:
        row = _find(connection, payload.request_id)
        stock = resolve_stock(connection, payload.code) if row is None else None
        cutoff = now().replace(microsecond=0) if row is None else None
        reports = _local_reports(connection, stock["stock_code"], cutoff.date()) if stock is not None else []
    if row is None:
        if not codex_runtime.availability()["available"]:
            error(503, "AI 采集暂时不可用，模板仍可手动填写。")
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = _find(connection, payload.request_id)
            if row is None:
                conversation = conversation_store.create_conversation("news", workflow_type="research", _connection=connection)
                conversation_id = conversation["id"]
                connection.execute(
                    "UPDATE conversations SET title=?,research_scope_json=? WHERE id=?",
                    (f"生成建议 · {stock['name']}", json_dump(ResearchScope(as_of=cutoff.date()).model_dump(mode="json")), conversation_id),
                )
                prompt = json_dump({
                    "股票代码": stock["stock_code"], "股票名称": stock["name"],
                    "调仓场景": payload.direction, "研究截止": cutoff.isoformat(), "本地研报": reports,
                })
                message = conversation_store.add_user_message(
                    conversation_id, f"rebalance-suggestion:{payload.request_id}", 0, prompt,
                    research_scope_revision=0, assistant_revision=0, _connection=connection,
                )
                turn_id = message["turn_id"]
                connection.execute("INSERT INTO client_service_turns VALUES(?,?)", (conversation_id, turn_id))
                connection.execute(
                    """INSERT INTO client_rebalance_suggestions
                       (request_id,stock_code,stock_name,direction,cutoff,reports_json,conversation_id,turn_id)
                       VALUES(?,?,?,?,?,?,?,?)""",
                    (payload.request_id, stock["stock_code"], stock["name"], payload.direction,
                     cutoff.isoformat(), json_dump(reports), conversation_id, turn_id),
                )
                row = _find(connection, payload.request_id)

    if payload.code not in {row["stock_code"], row["stock_code"][:6]} or payload.direction != row["direction"]:
        error(409, "同一采集请求不能更换股票或调仓方向。")
    try:
        research_turn_service.enqueue_turn(row["conversation_id"], row["turn_id"])
    except codex_runtime.CodexRuntimeError:
        error(503, "暂时无法加入采集队列，请重试。")
    return _status(row)


def _verified_report(citation: ReportCitation, row) -> dict | None:
    cutoff = datetime.fromisoformat(row["cutoff"]).date()
    if citation.document_id and not citation.url:
        local = next((r for r in json_load(row["reports_json"]) if r["document_id"] == citation.document_id), None)
        if local is None or not any(normalize_quote(citation.quote) in normalize_quote(page["text"]) for page in local["pages"]):
            return None
        full_text = normalize_quote(" ".join(page["text"] for page in local["pages"]))
        names = re.split(r"[,，、；;]+", citation.authors)
        authors = local["authors"] or "、".join(name.strip() for name in names if name.strip() and normalize_quote(name.strip()) in full_text)
        broker = local["broker"] or (citation.broker if citation.broker and normalize_quote(citation.broker) in full_text else "")
        return {**{key: local[key] for key in ("document_id", "title", "publication_date")}, "broker": broker, "authors": authors}
    if citation.document_id or not all((citation.url, citation.title, citation.broker, citation.authors, citation.publication_date)):
        return None
    searched, opened = web_evidence(row["conversation_id"], row["turn_id"])
    if not searched or citation.url not in opened or citation.publication_date > cutoff:
        return None
    return citation.model_dump(mode="json", exclude={"quote", "document_id"})


def _status(row) -> dict:
    turn = conversation_store.get_turn(row["conversation_id"], row["turn_id"])
    state = turn["state"]
    result = {
        "request_id": row["request_id"], "code": row["stock_code"], "stock_name": row["stock_name"],
        "direction": row["direction"], "cutoff": row["cutoff"], "state": state,
        "message": (turn.get("job") or {}).get("message") or "等待开始采集",
    }
    if state == "succeeded":
        text = (turn["response_text"] or "").strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        try:
            reply = CollectionReply.model_validate_json(text)
        except ValidationError:
            return {**result, "state": "failed", "message": "采集结果格式不完整，可以重新采集或手动填写。"}
        reason = without_web_links(reply.reason).strip()
        report = _verified_report(reply.report, row) if reason and reply.report else None
        if report is None:
            return {**result, "state": "no_evidence", "message": "这次未找到可核对的研报依据，可以手动填写文案。"}
        report = {**report, **{key: without_web_links(report[key]).strip() for key in ("title", "broker", "authors")}}
        if not report["title"]:
            return {**result, "state": "no_evidence", "message": "研报标题未能核对，可以手动填写文案。"}
        authors = " ".join(part for part in (report["broker"], report["authors"]) if part)
        report_date = date.fromisoformat(report["publication_date"]).strftime("%Y年%m月%d日")
        byline = f" 研报作者：{authors}，" if authors else " "
        basis = f"参考研报：《{report['title'].strip('《》')}》{byline}发布日期 {report_date}。"
        return {**result, "reason": reason, "basis": basis, "report": report, "message": "采集完成"}
    if state == "cancelled":
        return {**result, "message": "已停止采集。"}
    if state in {"failed", "awaiting_user"}:
        return {**result, "state": "failed", "message": "采集未完成，可以重新采集或手动填写。"}
    return result


def get(request_id: str, *, cancel: bool = False) -> dict:
    with connect() as connection:
        row = _find(connection, request_id)
    if row is None:
        error(404, "找不到这次资料采集。")
    if cancel:
        from .conversation_api import cancel_research_turn

        cancel_research_turn(row["conversation_id"], row["turn_id"])
    return _status(row)
