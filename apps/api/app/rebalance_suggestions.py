"""Collect report evidence and draft editable reasons for user-supplied adjustments."""
from __future__ import annotations

from datetime import date, datetime
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import codex_runtime, conversation_store, research_models, research_turn_service
from .client_service import error, now
from .client_service_text import without_web_links
from .codex_store import web_evidence
from .db import connect, json_dump, json_load
from .report_evidence import normalize_quote
from .rebalance_quotes import daily_context
from .screening_contracts import ResearchScope
from .stock_diagnosis import DiagnosisRequest, resolve_stock


PRESETS = {
    "instant": ("gpt-6.2-astra", "low", "fast"),
    "deep": ("gpt-6.2-sol", "max", "default"),
}

INSTRUCTIONS = """自主撰写一段可由投顾编辑的 A 股调仓理由。输入的调仓方向是沟通场景，围绕该场景选择有直接关系的事实、条件和风险。不猜测客户持仓、成本、盈利、成交、仓位或价位，不承诺收益。未证实的判断用条件句。止盈、减仓和止损可从波动、事件变化和风险管理出发，不能把看好公司的报告当作已知卖出动机。
选用最能解释理由的证据。可以用系统提供的带日期日线、本地研报，也可以用原生网页检索后实际打开的公告、财报、监管披露、权威报道或研报。研报不是前提。不要把搜索摘要当原文。将预测、公司披露和自己的推断分开。没有可靠外部事实时，仍可写与该方向相关的条件性理由，只引用真实输入，不编造公司事实。
即时档用一批有针对性的检索，打开少量最匹配原文后成稿。深度档再核对最影响判断的证据及其反面条件。用短句写可转发的理由，正文用纯文字，原文网址单独列为依据。固定风险提示及投顾落款由系统组装。
只返回 JSON：{"reason":"可编辑的调仓理由","uses_local_market":false,"sources":[{"title":"已打开原文的标题","url":"实际打开的原文网址","published_at":"YYYY-MM-DD 或带时区的 ISO 日期时间，可以为 null","quote":"说明事实的原文短句"}],"report":null}。sources 可以为空。未注明发布日期的原文只用于背景事实。使用了输入中的日线才将 uses_local_market 设为 true。若使用输入中的本地研报，可在 report 填 {"document_id":"输入中的ID","quote":"逐字摘录一段约8至40字的连续原文"}，不强制使用。"""


class SuggestionRequest(DiagnosisRequest):
    direction: str = Field(min_length=1, max_length=30, pattern=r"^\S(?:[^\r\n]*\S)?$")
    mode: Literal["instant", "deep"] | None = None
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


class WebSource(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=240)
    url: str = Field(max_length=2048, pattern=r"^https?://\S+$")
    published_at: str | None = Field(default=None, max_length=48)
    quote: str = Field(default="", max_length=600)


class CollectionReply(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    reason: str = Field(max_length=1600)
    report: ReportCitation | None = None
    uses_local_market: bool = False
    sources: list[WebSource] = Field(default_factory=list, max_length=10)


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
            error(503, "AI 暂时不可用，可以手动填写理由。")
        selection, tier = {}, None
        if payload.mode:
            model, effort, tier = PRESETS[payload.mode]
            try:
                selection = research_models.resolve_selection(model, effort)
            except research_models.ResearchModelError as exc:
                error(503, str(exc))
        snapshot = daily_context(stock["stock_code"], cutoff)
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = _find(connection, payload.request_id)
            if row is None:
                conversation = conversation_store.create_conversation("news", workflow_type="research", _connection=connection, **selection)
                conversation_id = conversation["id"]
                connection.execute(
                    "UPDATE conversations SET title=?,research_scope_json=? WHERE id=?",
                    (f"调仓建议 · {stock['name']}", json_dump(ResearchScope(as_of=cutoff.date()).model_dump(mode="json")), conversation_id),
                )
                prompt = json_dump({
                    "股票代码": stock["stock_code"], "股票名称": stock["name"],
                    "调仓场景": payload.direction, "研究截止": cutoff.isoformat(), "本地研报": reports,
                    "日线快照": snapshot, "档位": "即时" if payload.mode == "instant" else "深度",
                })
                message = conversation_store.add_user_message(
                    conversation_id, f"rebalance-suggestion:{payload.request_id}", 0, prompt,
                    research_scope_revision=0, assistant_revision=0, _connection=connection,
                )
                turn_id = message["turn_id"]
                connection.execute("INSERT INTO client_service_turns VALUES(?,?)", (conversation_id, turn_id))
                connection.execute(
                    """INSERT INTO client_rebalance_suggestions
                       (request_id,stock_code,stock_name,direction,cutoff,reports_json,conversation_id,turn_id,mode,service_tier,market_json)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                    (payload.request_id, stock["stock_code"], stock["name"], payload.direction,
                     cutoff.isoformat(), json_dump(reports), conversation_id, turn_id, payload.mode, tier, json_dump(snapshot)),
                )
                row = _find(connection, payload.request_id)

    if (payload.code not in {row["stock_code"], row["stock_code"][:6]} or payload.direction != row["direction"]
            or payload.mode != row["mode"]):
        error(409, "同一生成请求不能更换股票、调仓方向或档位。")
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


def _source_in_time(value: str | None, cutoff: datetime) -> bool:
    if not value:
        return True
    try:
        if len(value) == 10:
            return date.fromisoformat(value) <= cutoff.date()
        published = datetime.fromisoformat(value)
        return published.tzinfo is not None and published <= cutoff
    except ValueError:
        return False


def _status(row) -> dict:
    turn = conversation_store.get_turn(row["conversation_id"], row["turn_id"])
    state = turn["state"]
    result = {
        "request_id": row["request_id"], "code": row["stock_code"], "stock_name": row["stock_name"],
        "direction": row["direction"], "cutoff": row["cutoff"], "state": state,
        "mode": row["mode"], "message": (turn.get("job") or {}).get("message") or "等待生成理由",
    }
    if state == "succeeded":
        text = (turn["response_text"] or "").strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        try:
            reply = CollectionReply.model_validate_json(text)
        except ValidationError:
            return {**result, "state": "failed", "message": "采集结果格式不完整，可以重新采集或手动填写。"}
        reason = without_web_links(reply.reason).strip()
        if not reason:
            return {**result, "state": "no_evidence", "message": "本次没有生成可用理由，可以重新生成或手动填写。"}
        report = _verified_report(reply.report, row) if reply.report else None
        market = json_load(row["market_json"]) if reply.uses_local_market else None
        sources = {}
        if reply.sources:
            searched, opened = web_evidence(row["conversation_id"], row["turn_id"])
            cutoff = datetime.fromisoformat(row["cutoff"])
            for source in reply.sources:
                title = without_web_links(source.title).strip()
                if searched and source.url in opened and title and _source_in_time(source.published_at, cutoff):
                    sources[source.url] = {**source.model_dump(), "title": title, "quote": without_web_links(source.quote).strip()}
        if ((reply.report and report is None) or (reply.uses_local_market and market is None)
                or any(source.url not in sources for source in reply.sources)):
            return {**result, "state": "no_evidence", "message": "理由中的部分来源未能核对，可以重新生成或手动填写。"}
        lines = []
        if report:
            report = {**report, **{key: without_web_links(report[key]).strip() for key in ("title", "broker", "authors")}}
            if not report["title"]:
                return {**result, "state": "no_evidence", "message": "研报标题未能核对，可以手动填写文案。"}
            authors = " ".join(part for part in (report["broker"], report["authors"]) if part)
            report_date = date.fromisoformat(report["publication_date"]).strftime("%Y年%m月%d日")
            byline = f" 研报作者：{authors}，" if authors else " "
            lines.append(f"参考研报：《{report['title'].strip('《》')}》{byline}发布日期 {report_date}。")
        for source in sources.values():
            label = f"参考资料：《{source['title'].strip('《》')}》"
            lines.append(label + (f"（{source['published_at'][:10]}）" if source["published_at"] else ""))
        if market:
            lines.append(f"本地日线 {market['trade_date']} 收盘价 {market['close']} 元（未复权）。")
        basis = []
        for line in lines:
            if len("\n".join([*basis, line])) <= 650:
                basis.append(line)
        return {**result, "reason": reason, "basis": "\n".join(basis), "report": report, "sources": list(sources.values()),
                "market": market, "message": "理由已生成" if lines else "已生成条件性理由，可编辑后使用。"}
    if state == "cancelled":
        return {**result, "message": "已停止采集。"}
    if state in {"failed", "awaiting_user"}:
        failure = str(turn.get("response_text") or "").lower()
        if row["mode"] and any(value in failure for value in ("service_tier", "servicetier", "reasoning effort", "reasoning_effort")):
            return {**result, "state": "failed", "message": "模型服务未接受此档位的速度或推理参数。"}
        return {**result, "state": "failed", "message": "理由生成未完成，可以重试或手动填写。"}
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
