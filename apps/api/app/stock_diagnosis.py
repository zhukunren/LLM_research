"""Client-facing, two-sided stock reasons backed by frozen daily bars."""
from __future__ import annotations

from datetime import date, datetime, timedelta
import re
from typing import Annotated

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, field_validator

from . import codex_runtime, conversation_store, market, research_turn_service
from .client_service import error, now
from .client_service_disclosure import FIXED_DISCLOSURE
from .codex_store import web_evidence
from .db import connect, json_dump, json_load
from .model_modes import DEFAULT_MODEL_MODE, MODEL_PRESETS
from .screening_contracts import ResearchScope
from .trade_explanations import technical_snapshot


INSTRUCTIONS = """你负责为已签约客户撰写一只 A 股的简短诊股文案。分开说明买入和止损，各给出支持和反对立即操作的理由。用日常语言写短句，每条理由说明依据或成立条件。买入部分以考虑建立仓位为前提，止损部分以已有持仓为前提。遇到证据不足的方向，可用可核验的条件说明何时该方向才成立。
优先用输入中的已冻结日线。使用行情的实际日期和未复权口径，不把较早日线写成实时价格。不猜测持仓、成本、风险承受能力、资金流、新公告或公司业绩。若可用网页检索，可补充一两条与判断直接相关且在截止前发布的公开原文。使用了网页事实就列出实际打开的 URL 和发布时间。只有日期的来源必须早于截止日，当天来源需给出含时区的发布时间。无法核实的外部事实应省略。
说明情形和风险，给出可观察的条件。不要提供交易指令、具体买入价或止损价，也不要承诺收益。固定风险提示由系统附加。只返回任务指定的 JSON，不加标题、代码围栏、落款或文件。"""


class DiagnosisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
    code: str = Field(pattern=r"^[0-9]{6}(?:\.(SH|SZ|BJ))?$")

    @field_validator("code", mode="before")
    @classmethod
    def normalize_code(cls, value):
        return value.strip().upper() if isinstance(value, str) else value


Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class Direction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    support: list[Reason] = Field(min_length=1, max_length=3)
    oppose: list[Reason] = Field(min_length=1, max_length=3)


class Source(BaseModel):
    title: Reason
    url: str = Field(max_length=2048, pattern=r"^https?://\S+$")
    published_at: str = Field(min_length=10, max_length=40)


class DiagnosisDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    buy: Direction
    stop_loss: Direction
    sources: list[Source] = Field(default_factory=list, max_length=5)
    limitations: list[Reason] = Field(default_factory=list, max_length=4)


def resolve_stock(connection, code: str):
    codes = (code,) if "." in code else tuple(f"{code}.{market}" for market in ("SH", "SZ", "BJ"))
    matches = connection.execute(
        f"""SELECT stock_code,name FROM security_catalog
            WHERE stock_code IN ({','.join('?' for _ in codes)}) AND market<>'指数'""",
        codes,
    ).fetchall()
    if not matches:
        error(404, "股票目录里找不到这只 A 股。请核对代码或更新股票目录。")
    if len(matches) > 1:
        error(422, "有多只股票使用这组六位数字。请加上 .SH、.SZ 或 .BJ 后缀。")
    return matches[0]


def _snapshot(code: str, cutoff: datetime) -> dict:
    # Only completed trading days can supply a closing price.
    day = cutoff.date() - timedelta(days=int(cutoff.hour < 15))
    bars = [bar for bar in market.get_bars(code, day.isoformat(), 180)
            if bar["quality_valid"] and bar["trade_date"] <= day.isoformat()]
    if bars:
        history = {"items": bars, "source": "本地日线", "volume_unit": "原文件单位", "price_basis": "未复权"}
    else:
        from .daily_signals_api import chart_history

        try:
            history = chart_history(code, day)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            error(404, "这只股票暂无可用的收盘行情，无法生成有依据的诊股。")
    return technical_snapshot(history)


def _prompt(stock, cutoff: datetime, snapshot: dict) -> str:
    return """为指定股票撰写买入和止损的正反理由。每个方向最多三条，直接写可读的理由。
只返回 JSON，使用以下字段：
{"buy":{"support":["支持买入的理由"],"oppose":["反对立即买入的理由"]},"stop_loss":{"support":["支持止损的理由"],"oppose":["反对立即止损的理由"]},"sources":[{"title":"已打开的原文标题","url":"原文链接","published_at":"公开时间"}],"limitations":["影响判断的资料缺口"]}
只用日线时，sources 为 []。limitations 可为空。
""" + json_dump({
        "股票代码": stock["stock_code"], "股票名称": stock["name"],
        "研究截止": cutoff.isoformat(), "日线数据": snapshot,
    })


def _find(connection, request_id: str):
    return connection.execute("SELECT * FROM client_stock_diagnoses WHERE request_id=?", (request_id,)).fetchone()


def start(payload: DiagnosisRequest) -> dict:
    with connect() as connection:
        row = _find(connection, payload.request_id)
        stock = resolve_stock(connection, payload.code) if row is None else None
    if row is None:
        if not codex_runtime.availability()["available"]:
            error(503, "AI 诊股暂时不可用，请检查模型连接后重试。")
        cutoff = now().replace(microsecond=0)
        snapshot = _snapshot(stock["stock_code"], cutoff)
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = _find(connection, payload.request_id)
            if row is None:
                try:
                    conversation = conversation_store.create_conversation(
                        "news", workflow_type="research", _connection=connection, **MODEL_PRESETS[DEFAULT_MODEL_MODE].selection())
                except conversation_store.ConversationStoreError as exc:
                    error(503, str(exc))
                conversation_id = conversation["id"]
                scope = ResearchScope(as_of=cutoff.date()).model_dump(mode="json")
                connection.execute(
                    "UPDATE conversations SET title=?,research_scope_json=? WHERE id=?",
                    (f"AI 诊股 · {stock['name']}", json_dump(scope), conversation_id),
                )
                message = conversation_store.add_user_message(
                    conversation_id, f"stock-diagnosis:{payload.request_id}", 0, _prompt(stock, cutoff, snapshot),
                    research_scope_revision=0, assistant_revision=0, _connection=connection,
                )
                turn_id = message["turn_id"]
                connection.execute("INSERT INTO client_service_turns VALUES(?,?)", (conversation_id, turn_id))
                connection.execute(
                    """INSERT INTO client_stock_diagnoses(request_id,stock_code,stock_name,cutoff,market_json,conversation_id,turn_id)
                       VALUES(?,?,?,?,?,?,?)""",
                    (payload.request_id, stock["stock_code"], stock["name"], cutoff.isoformat(),
                     json_dump(snapshot), conversation_id, turn_id),
                )
                row = _find(connection, payload.request_id)

    if payload.code not in {row["stock_code"], row["stock_code"][:6]}:
        error(409, "同一诊股请求不能更换股票。")
    try:
        research_turn_service.enqueue_turn(row["conversation_id"], row["turn_id"])
    except codex_runtime.CodexRuntimeError:
        error(503, "AI 诊股暂时无法加入队列，请重试。")
    return _status(row)


def _published_before(value: str, cutoff: datetime) -> bool:
    try:
        if len(value) == 10:
            return date.fromisoformat(value) < cutoff.date()
        published = datetime.fromisoformat(value)
        return published.tzinfo is not None and published <= cutoff
    except ValueError:
        return False


def _status(row) -> dict:
    turn = conversation_store.get_turn(row["conversation_id"], row["turn_id"])
    snapshot = json_load(row["market_json"])
    state = turn["state"]
    result = {
        "request_id": row["request_id"], "code": row["stock_code"], "stock_name": row["stock_name"],
        "cutoff": row["cutoff"], "data_date": snapshot["data_end"], "market_source": snapshot["source"],
        "state": state, "message": (turn.get("job") or {}).get("message") or "等待开始诊股",
        "risk_disclosure": FIXED_DISCLOSURE["risk"],
    }
    if state == "succeeded":
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", (turn["response_text"] or "").strip(), flags=re.IGNORECASE)
        try:
            draft = DiagnosisDraft.model_validate_json(text)
        except ValidationError:
            return {**result, "state": "failed", "message": "诊股未生成完整的正反理由，请重新生成。"}
        if draft.sources:
            searched, opened = web_evidence(row["conversation_id"], row["turn_id"])
            cutoff = datetime.fromisoformat(row["cutoff"])
            if not searched or any(source.url not in opened or not _published_before(source.published_at, cutoff) for source in draft.sources):
                return {**result, "state": "failed", "message": "诊股引用的原文或发布时间未能核实，请重新生成。"}
        return {**result, **draft.model_dump(), "message": "诊股已完成"}
    if state == "cancelled":
        return {**result, "message": "已停止诊股。"}
    if state in {"failed", "awaiting_user"}:
        return {**result, "state": "failed", "message": "诊股未完成，请重新生成。"}
    return result


def get(request_id: str, *, cancel: bool = False) -> dict:
    with connect() as connection:
        row = _find(connection, request_id)
    if row is None:
        error(404, "找不到这次诊股。")
    if cancel:
        from .conversation_api import cancel_research_turn

        cancel_research_turn(row["conversation_id"], row["turn_id"])
    return _status(row)
