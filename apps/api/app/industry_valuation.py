"""Deterministic screening by Shenwan industry, P/E and daily turnover value."""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from statistics import median
from typing import Any

from . import tushare_screening_data as data, tushare_sync
from .rules import combine
from .screening_contracts import (
    ConditionDecision,
    INDUSTRY_VALUATION_IMPLEMENTATION,
    IndustryValuationRule,
)
from .tushare_client import TushareError


PE = "市盈率（TTM）"
AMOUNT = "日均成交额"
AMOUNT_IN_YI = 100_000  # Tushare daily.amount is quoted in thousands of yuan.


def describe(rule: IndustryValuationRule, industry_name: str | None = None) -> str:
    target = industry_name or rule.industry_code
    relation = "≤" if rule.pe_comparison == "at_most" else "<"
    comparison = (f"0 < 市盈率（TTM） {relation} {rule.max_pe_ttm:g} 倍"
                  if rule.max_pe_ttm is not None else "正市盈率（TTM）低于行业中位数")
    description = f"申万{target}行业，{comparison}"
    if rule.amount_window is not None:
        description += f"，近 {rule.amount_window} 个交易日日均成交额 ≥ {rule.min_daily_amount_yi:g} 亿元"
    return description


@dataclass
class ValuationInputs:
    day: str
    names: dict[str, str] = field(default_factory=dict)
    stock_paths: dict[str, tuple[tuple[str, str], ...]] = field(default_factory=dict)
    ambiguous: set[str] = field(default_factory=set)
    pe: dict[str, float | None] = field(default_factory=dict)
    peer_medians: dict[str, tuple[float | None, int, int]] = field(default_factory=dict)
    open_days: list[str] = field(default_factory=list)
    local_amount_days: set[str] = field(default_factory=set)
    remote_amounts: dict[str, dict[str, float | None]] = field(default_factory=dict)
    issues: dict[str, str] = field(default_factory=dict)
    manifests: list[str] = field(default_factory=list)


def prepare(
    rules: Sequence[IndustryValuationRule],
    day: str,
    codes: Sequence[str],
    *,
    active: Callable[[], bool] = lambda: True,
    progress: Callable[[float, str], None] = lambda *_: None,
) -> ValuationInputs:
    inputs = ValuationInputs(day)
    trade_day = date.fromisoformat(day)
    progress(0, "正在读取申万行业成分")
    try:
        client = tushare_sync.create_client()
        membership = data.industry_memberships(client)
    except TushareError as exc:
        inputs.issues["industry"] = f"申万行业成分暂不可用。{exc}"
        return inputs
    inputs.manifests.append(membership.manifest)
    inputs.names = {item["code"]: item["name"] for item in data.industry_catalog(membership)}
    paths = defaultdict(set)
    for row in membership.rows:
        if row["in_date"] <= day and (row["out_date"] is None or day < row["out_date"]):
            paths[row["stock_code"]].add(tuple(tuple(item) for item in row["path"]))
    inputs.stock_paths = {code: next(iter(options)) for code, options in paths.items() if len(options) == 1}
    inputs.ambiguous = {code for code, options in paths.items() if len(options) > 1}
    rules_by_industry = defaultdict(list)
    for rule in rules:
        rules_by_industry[rule.industry_code].append(rule)
    peers = defaultdict(list)
    for code, path in inputs.stock_paths.items():
        for industry_code, _ in path:
            if industry_code in rules_by_industry:
                peers[industry_code].append(code)
    requested = set(codes)
    rules_in_scope = [
        rule for industry_code, group in rules_by_industry.items()
        if requested.intersection(peers[industry_code]) for rule in group
    ]
    if not rules_in_scope or not active():
        return inputs
    progress(0, f"正在读取 {day} 的市盈率")
    try:
        quotes = data.daily_valuation(client, trade_day)
    except TushareError as exc:
        inputs.issues["valuation"] = f"指定交易日的估值暂不可用。{exc}"
    else:
        inputs.manifests.append(quotes.manifest)
        inputs.pe = {row["stock_code"]: row["pe_ttm"] for row in quotes.rows}
        for industry, stocks in peers.items():
            sample = [inputs.pe[code] for code in stocks if (inputs.pe.get(code) or 0) > 0]
            inputs.peer_medians[industry] = (median(sample) if sample else None, len(sample), len(stocks))

    windows = [rule.amount_window for rule in rules_in_scope if rule.amount_window is not None]
    if not windows or not active():
        return inputs
    required = max(windows)
    try:
        days = [trade_day] if required == 1 else tushare_sync._open_days(
            client, trade_day - timedelta(days=3 * required + 15), trade_day
        )[-required:]
    except TushareError as exc:
        inputs.issues["amount"] = f"暂时无法核对交易日历。{exc}"
        return inputs
    if not days or days[-1] != trade_day:
        inputs.issues["amount"] = "交易日历里没有本次行情日期，无法确认成交额窗口。"
        return inputs
    inputs.open_days = [value.isoformat() for value in days]
    inputs.local_amount_days = set(tushare_sync._market_completion().get("complete_days", []))
    for value, text in zip(days, inputs.open_days, strict=True):
        if not active():
            break
        if text in inputs.local_amount_days:
            continue
        progress(0, f"正在核对 {text} 的成交额")
        try:
            amounts = data.daily_amount(client, value)
        except TushareError as exc:
            inputs.issues[text] = str(exc)
            if exc.kind in {"denied", "not_configured", "rate_limited", "transient_error"}:
                inputs.issues["amount"] = f"成交额暂不可用。{exc}"
                break
        else:
            inputs.manifests.append(amounts.manifest)
            inputs.remote_amounts[text] = {row["stock_code"]: row["amount"] for row in amounts.rows}
    return inputs


def _turnover(window: int, code: str, inputs: ValuationInputs, bars: Sequence[dict]):
    days = inputs.open_days[-window:]
    if len(days) < window:
        return None, inputs.issues.get("amount") or f"交易日历不足 {window} 个交易日。"
    local = {}
    for bar in bars:
        day = bar["trade_date"]
        value = data.verified_amount(bar.get("amount")) if bar.get("quality_valid", True) else None
        local[day] = value if day not in local else None
    amounts = []
    for day in days:
        if day in inputs.local_amount_days:
            value = local.get(day)
        else:
            value = inputs.remote_amounts.get(day, {}).get(code)
        if value is None:
            issue = inputs.issues.get(day) or inputs.issues.get("amount")
            return None, f"{day} 缺少可确认的成交额。" + (issue or "")
        amounts.append(Decimal(str(value)))
    average = sum(amounts) / (len(days) * AMOUNT_IN_YI)
    return average, f"成交额窗口 {days[0]} 至 {days[-1]}（{len(days)} 个交易日）"


def evaluate(
    rule: IndustryValuationRule,
    inputs: ValuationInputs,
    stock_code: str,
    bars: Sequence[dict[str, Any]],
    *,
    condition_id: str,
    reference_id: str,
    condition_version: int | None = None,
) -> ConditionDecision:
    industry = inputs.names.get(rule.industry_code)
    path = dict(inputs.stock_paths.get(stock_code, ()))
    metrics: dict[str, Any] = {}
    thresholds: dict[str, Any] = {}
    if rule.min_daily_amount_yi is not None:
        thresholds[AMOUNT] = rule.min_daily_amount_yi
    if rule.max_pe_ttm is not None:
        thresholds[PE] = rule.max_pe_ttm
    units = {PE: "倍", AMOUNT: "亿元", "行业正市盈率样本": "只", "有行业记录的成分": "只"}
    if inputs.issues.get("industry"):
        state, explanation = "unknown", inputs.issues["industry"]
    elif industry is None:
        state, explanation = "unknown", f"申万行业成分数据里没有行业 {rule.industry_code}。"
    elif not path:
        state = "unknown"
        explanation = ("该股有互相冲突的行业成分记录。" if stock_code in inputs.ambiguous
                       else "该股在所选日期缺少可确认的申万行业成分记录。")
    else:
        metrics["所属行业"] = " / ".join(path.values())
        if rule.industry_code not in path:
            state, explanation = "false", f"所属行业为{metrics['所属行业']}，未命中申万{industry}行业。"
        else:
            pe = inputs.pe.get(stock_code)
            pe_limit = rule.max_pe_ttm
            parts = [f"申万{industry}"]
            if rule.pe_comparison == "below_industry_median":
                pe_limit, sample, total = inputs.peer_medians.get(rule.industry_code, (None, 0, 0))
                metrics.update({"行业正市盈率样本": sample, "有行业记录的成分": total})
                if pe_limit is not None:
                    thresholds[PE] = pe_limit
                    parts.append(f"行业市盈率中位数 {pe_limit:.6g} 倍（{sample}/{total} 只有可比市盈率）")
            if pe is not None:
                metrics[PE] = pe
                parts.append(f"市盈率（TTM）{pe:g} 倍")
            if pe is None or pe <= 0:
                pe_state = "unknown"
                parts.append(inputs.issues.get("valuation") or "缺少可比较的正市盈率")
            elif pe_limit is None:
                pe_state = "unknown"
                parts.append("缺少可比较的行业中位数")
            else:
                meets = pe <= pe_limit if rule.pe_comparison == "at_most" else pe < pe_limit
                pe_state = "true" if meets else "false"
            state = pe_state
            if rule.amount_window is not None:
                amount, amount_note = _turnover(rule.amount_window, stock_code, inputs, bars)
                if amount is not None:
                    metrics[AMOUNT] = float(amount)
                    parts.append(f"日均成交额 {amount:.6g} 亿元")
                minimum = Decimal(str(rule.min_daily_amount_yi))
                amount_state = "unknown" if amount is None else "true" if amount >= minimum else "false"
                parts.append(amount_note)
                state = combine("all", [pe_state, amount_state])
            explanation = " · ".join(parts)
    return ConditionDecision(
        stock_code=stock_code,
        condition_id=condition_id,
        reference_id=reference_id,
        condition_version=condition_version,
        state=state,
        evaluation_status="completed",
        reason_code={"true": "condition_met", "false": "condition_not_met", "unknown": "data_missing"}[state],
        explanation=f"核对日期 {inputs.day} · {explanation}",
        actual_values=metrics,
        thresholds=thresholds,
        units=units,
        data_as_of=inputs.day,
        implementation_id=INDUSTRY_VALUATION_IMPLEMENTATION,
    )
