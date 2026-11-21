"""Collect dated market evidence for an editable opening plan."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
import re

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import codex_runtime, conversation_store, index_market, research_turn_service
from .client_service import TZ, error, now
from .client_service_market import number
from .client_service_text import without_web_links
from .codex_store import web_evidence
from .db import connect, json_dump, json_load, utc_now
from .opening_plan_card import OpeningPlanContent, PlanDate, SECTION_LABELS, SECTION_LIMIT
from .screening_contracts import ResearchScope


PLAN_SECTIONS = {key: label for key, label in SECTION_LABELS.items() if key not in {"risk_control", "data_note"}}
REQUEST_ID = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$"

INSTRUCTIONS = """起草开盘计划的可编辑资料段落。输入包含计划日期、北京时间信息截止、A 股已完成日线的日期上限、可用的本地上证指数日线，以及可采集的段落。用自然、简明的中文。区分事实、判断和盘中待验证条件，以实际日期表述。
这是盘前速稿。先用一批查询查隔夜海外市场、A 股最近已完成交易日和计划当日新股日程，再同批打开最相关的三至五篇原文。已有可用数据就写稿，缺项留空。只有核心行情缺失时才追加一次聚焦查询和原文打开。当天网页只有日期、没有具体发布时间时，直接跳过，不继续反复寻找时刻。已经公开的计划当日日程可以纳入。用本地日线时标记真实交易日。避免把旧行情称为昨收，把指数成交额写成全市场成交额，或使用集合竞价和当天盘中行情。新股区分申购、上市、询价与缴款，原文确认后才能说没有。
核心判断可以给观察方向、支持证据、失效信号和风险。最多写三个有依据的方向；可写板块和有证据的观察对象，未运行筛选时不声称做过筛选。个股历史行情可注明实际日期，具体参与价位、放弃价位、仓位上限、止损线和账户规则由用户另填。不要照搬历史计划的数字条件。盘中观察写将来要看什么，不编造已经发生的结果。今日不做写与证据相关的观察边界。固定身份、风控和风险提示由应用处理，不放在输出里。
每个段落只用已经打开且在信息截止前发布的网页或输入中已有的本地行情。网页事实要区分事件时点和文章发布时点。网页只显示日期时，该日期必须早于截止当天；截止当天发布的材料需有含时区的时间。标题和正文用纯文字，网址放在来源字段。
只返回 JSON。sections 的键从输入的可采集段落中选，每个值为 {"text":"一段正文","source_urls":["实际打开的原文网址"],"uses_local_market":false}。本地数据支持的事实可将 uses_local_market 设为 true；使用了网页就列出对应网址。sources 为 [{"title":"原文标题","url":"原文网址","published_at":"YYYY-MM-DD 或带时区的 ISO 日期时间"}]。只输出有依据的段落，没有合格资料时返回 {"sections":{},"sources":[]}。"""


class OpeningPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(pattern=REQUEST_ID)
    plan_date: PlanDate


class SaveOpeningTemplate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=0)
    content: OpeningPlanContent


class SaveOpeningPlan(SaveOpeningTemplate):
    collection_request_id: str | None = Field(default=None, pattern=REQUEST_ID)


def _content_record(row) -> dict:
    if row is None:
        return {"revision": 0, "content": OpeningPlanContent().model_dump(mode="json"), "collection_request_id": None}
    return {"revision": row["revision"], "content": json_load(row["content_json"]),
            "collection_request_id": row["collection_request_id"]}


def editor(plan_date: date) -> dict:
    day = plan_date.isoformat()
    with connect() as connection:
        rows = {row["scope"]: row for row in connection.execute(
            "SELECT * FROM client_opening_plan_content WHERE scope IN ('template', ?)", (day,),
        )}
    return {"template": _content_record(rows.get("template")), "saved": _content_record(rows[day]) if day in rows else None}


def save_content(payload: SaveOpeningTemplate | SaveOpeningPlan, *, plan_date: date | None = None) -> dict:
    scope = plan_date.isoformat() if plan_date else "template"
    collection_id = payload.collection_request_id if isinstance(payload, SaveOpeningPlan) else None
    content = payload.content.model_dump(mode="json")
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT revision FROM client_opening_plan_content WHERE scope=?", (scope,)).fetchone()
        if (row["revision"] if row else 0) != payload.revision:
            error(409, "已保存的开盘计划或模板有更新，请刷新保存版本后再试。")
        if collection_id:
            collection = _find(connection, collection_id)
            if collection is None or collection["plan_date"] != scope:
                error(422, "采集资料与计划日期不一致。")
        revision = payload.revision + 1
        connection.execute(
            """INSERT INTO client_opening_plan_content (scope, revision, content_json, collection_request_id, updated_at)
               VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,
               content_json=excluded.content_json, collection_request_id=excluded.collection_request_id, updated_at=excluded.updated_at""",
            (scope, revision, json_dump(content), collection_id, utc_now()),
        )
    return {"revision": revision, "content": content, "collection_request_id": collection_id}


class Section(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    text: str = Field(max_length=SECTION_LIMIT)
    source_urls: list[str] = Field(default_factory=list, max_length=5)
    uses_local_market: bool = False


class Source(BaseModel):
    title: str = Field(max_length=240)
    url: str = Field(max_length=2048, pattern=r"^https?://\S+$")
    published_at: str | None = Field(default=None, max_length=48)


class OpeningPlanReply(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sections: dict[str, Section] = Field(max_length=14)
    sources: list[Source] = Field(default_factory=list, max_length=16)


def _market_snapshot(as_of: date) -> dict | None:
    bars = []
    for row in index_market.cached_bars(as_of.isoformat(), 20):
        close = number(row.get("close"))
        if close is not None and close > 0 and row.get("quality_valid", True):
            bars.append((row, close))
    if not bars:
        return None
    latest, close = bars[-1]
    previous = bars[-2][1] if len(bars) > 1 else None
    return {
        "index": "上证指数",
        "trade_date": latest["trade_date"],
        "close": f"{close:.2f}",
        "previous_trade_date": bars[-2][0]["trade_date"] if previous is not None else None,
        "pct_change": f"{(close / previous - 1) * 100:+.2f}%" if previous is not None else None,
        "ma20": f"{sum(price for _, price in bars) / 20:.2f}" if len(bars) == 20 else None,
        "source": latest.get("source") or "本地上证指数日线",
    }


def _find(connection, request_id: str):
    return connection.execute("SELECT * FROM client_opening_plans WHERE request_id=?", (request_id,)).fetchone()


def start(payload: OpeningPlanRequest) -> dict:
    day = payload.plan_date.isoformat()
    with connect() as connection:
        row = _find(connection, payload.request_id)
    if row is None:
        if not codex_runtime.availability()["available"]:
            error(503, "AI 采集暂时不可用，可以继续手动编辑开盘计划。")
        cutoff = min(now().replace(microsecond=0), datetime.combine(payload.plan_date, time(9, 15), TZ))
        last_closed_day = cutoff.date() if cutoff.time() >= time(15) else cutoff.date() - timedelta(days=1)
        market_day = min(last_closed_day, payload.plan_date - timedelta(days=1))
        snapshot = _market_snapshot(market_day)
        prompt = json_dump({
            "计划日期": day, "信息截止": cutoff.isoformat(), "A股已完成日线日期上限": market_day.isoformat(),
            "本地上证指数": snapshot, "可采集段落": PLAN_SECTIONS,
        })
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = _find(connection, payload.request_id)
            if row is None:
                try:
                    conversation = conversation_store.create_conversation("news", workflow_type="research", _connection=connection)
                except conversation_store.ConversationStoreError as cause:
                    error(503, f"{cause}。可继续手动编辑开盘计划。")
                conversation_id = conversation["id"]
                scope = ResearchScope(as_of=cutoff.date()).model_dump(mode="json")
                connection.execute(
                    "UPDATE conversations SET title=?,research_scope_json=? WHERE id=?",
                    (f"开盘计划 · {day}", json_dump(scope), conversation_id),
                )
                turn_id = conversation_store.add_user_message(
                    conversation_id, f"opening-plan:{payload.request_id}", 0, prompt,
                    research_scope_revision=0, assistant_revision=0, _connection=connection,
                )["turn_id"]
                connection.execute("INSERT INTO client_service_turns VALUES(?,?)", (conversation_id, turn_id))
                connection.execute(
                    """INSERT INTO client_opening_plans
                       (request_id,plan_date,cutoff,market_json,conversation_id,turn_id) VALUES(?,?,?,?,?,?)""",
                    (payload.request_id, day, cutoff.isoformat(), json_dump(snapshot), conversation_id, turn_id),
                )
                row = _find(connection, payload.request_id)
    if row["plan_date"] != day:
        error(409, "同一采集请求不能更换计划日期。")
    try:
        research_turn_service.enqueue_turn(row["conversation_id"], row["turn_id"])
    except codex_runtime.CodexRuntimeError:
        error(503, "暂时无法加入采集队列，请重试。")
    return _status(row)


def _published_before(value: str | None, cutoff: datetime) -> bool:
    if not value:
        return False
    try:
        if len(value) == 10:
            return date.fromisoformat(value) < cutoff.date()
        published = datetime.fromisoformat(value)
        return published.tzinfo is not None and published <= cutoff
    except ValueError:
        return False


def _market_paragraph(snapshot: dict) -> str:
    return f"{snapshot['trade_date']}上证指数收于{snapshot['close']}点。"


def _verified_sections(reply: OpeningPlanReply, row) -> tuple[dict[str, str], list[dict], dict | None]:
    snapshot = json_load(row["market_json"])
    cutoff = datetime.fromisoformat(row["cutoff"])
    searched, opened = web_evidence(row["conversation_id"], row["turn_id"]) if reply.sources else (False, set())
    valid_sources = {
        source.url: {
            "title": without_web_links(source.title).strip() or "公开原文",
            "url": source.url, "published_at": source.published_at,
        }
        for source in reply.sources
        if searched and source.url in opened and _published_before(source.published_at, cutoff)
    }
    sections, used_sources = {}, {}
    used_market = False
    for key in PLAN_SECTIONS:
        section = reply.sections.get(key)
        if section is None or (section.uses_local_market and not snapshot):
            continue
        if not section.source_urls and not section.uses_local_market:
            continue
        if any(url not in valid_sources for url in section.source_urls):
            continue
        text = without_web_links(section.text).strip()
        if text:
            sections[key] = text
            used_sources.update((url, valid_sources[url]) for url in section.source_urls)
            used_market |= section.uses_local_market
    if snapshot and "overnight" not in sections:
        sections["overnight"] = _market_paragraph(snapshot)
        used_market = True
    return sections, list(used_sources.values()), snapshot if used_market else None


def _incomplete(result: dict, row, message: str) -> dict:
    snapshot = json_load(row["market_json"])
    if snapshot:
        return {**result, "state": "partial", "message": message + "已填入可核对的本地日线。",
                "sections": {"overnight": _market_paragraph(snapshot)}, "sources": [], "market": snapshot}
    return {**result, "state": "failed", "message": message}


def _status(row) -> dict:
    turn = conversation_store.get_turn(row["conversation_id"], row["turn_id"])
    state = turn["state"]
    result = {
        "request_id": row["request_id"], "plan_date": row["plan_date"], "cutoff": row["cutoff"],
        "state": state, "message": (turn.get("job") or {}).get("message") or "等待开始采集",
    }
    if state == "succeeded":
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", (turn["response_text"] or "").strip(), flags=re.IGNORECASE)
        try:
            reply = OpeningPlanReply.model_validate_json(text)
        except ValidationError:
            return _incomplete(result, row, "采集结果格式不完整。")
        sections, sources, market = _verified_sections(reply, row)
        if not sections:
            return {**result, "state": "no_evidence", "message": "这次未找到符合截止时点的资料，可继续编辑模板。"}
        return {**result, "sections": sections, "sources": sources, "market": market,
                "message": f"已采集 {len(sections)} 个段落，可编辑后保存或导出。"}
    if state == "cancelled":
        return {**result, "message": "已停止采集。"}
    if state in {"failed", "awaiting_user"}:
        return _incomplete(result, row, "AI 采集未完成，可以重新采集或手动编辑。")
    return result


def get(request_id: str, *, cancel: bool = False) -> dict:
    with connect() as connection:
        row = _find(connection, request_id)
    if row is None:
        error(404, "找不到这次开盘计划采集。")
    if cancel:
        from .conversation_api import cancel_research_turn

        cancel_research_turn(row["conversation_id"], row["turn_id"])
    return _status(row)
