"""Deterministic Tushare conditions used by both screening execution paths."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from . import tushare_company_features as company
from .screening_contracts import ChipConcentrationRule, ConditionDecision, EarningsRevisionRule, TUSHARE_RULE_IMPLEMENTATIONS
from .tushare_client import TushareError
from .tushare_feature_data import Reader, error_note


TEMPLATES = {
    "earnings_revision": {
        "id": "earnings_revision", "version": 1, "name": "券商盈利预期上调",
        "formula": "近 {window_days} 个自然日，至少 {minimum_brokers} 家券商上调目标财年每股收益预测。",
        "parameters": {
            "year_offset": {"label": "财年偏移（0 为截止日所在年）", "default": 0, "min": -1, "max": 2, "step": 1},
            "window_days": {"label": "回看天数（自然日）", "default": 30, "min": 7, "max": 90, "step": 1},
            "minimum_brokers": {"label": "最少上调券商数", "default": 3, "min": 1, "max": 50, "step": 1},
        },
    },
    "chip_concentration": {
        "id": "chip_concentration", "version": 1, "name": "筹码成本集中度",
        "formula": "覆盖约 90% 筹码的成本带宽 ÷ 中位成本 × 100 ≤ {max_spread_pct}%。",
        "parameters": {
            "max_spread_pct": {"label": "成本区间宽度上限（%）", "default": 20, "min": 0, "max": 500, "step": 0.1},
        },
    },
}


def describe(rule: EarningsRevisionRule | ChipConcentrationRule) -> str:
    if isinstance(rule, EarningsRevisionRule):
        year = "截止日所在财年" if rule.year_offset == 0 else f"截止日所在财年 {rule.year_offset:+d} 年"
        return f"近 {rule.window_days} 个自然日，至少 {rule.minimum_brokers} 家券商上调{year}的每股收益预测"
    return f"约 90% 筹码的成本区间宽度不超过中位成本的 {rule.max_spread_pct:g}%"


@dataclass
class Inputs:
    as_of: date
    chip_date: date | None
    earnings: dict[str, list[company.Estimate]] = field(default_factory=dict)
    chips: dict[str, dict] = field(default_factory=dict)
    issues: dict[str, str] = field(default_factory=dict)
    manifests: list[str] = field(default_factory=list)


def prepare(rules, as_of: str, market_day: str | None, codes, *, active=lambda: True, progress=lambda *_: None) -> Inputs:
    result = Inputs(date.fromisoformat(as_of), date.fromisoformat(market_day) if market_day else None)
    if not rules or not active() or not codes:
        return result
    try:
        reader = Reader()
    except TushareError as exc:
        result.issues = {rule.op: error_note(exc) for rule in rules}
        return result
    earnings_rules = [rule for rule in rules if isinstance(rule, EarningsRevisionRule)]
    if earnings_rules and active():
        progress(0, "正在读取券商盈利预测")
        span = max(rule.window_days for rule in earnings_rules) + company.REVISION_BASELINE_DAYS - 1
        try:
            by_code = defaultdict(list)
            since = result.as_of - timedelta(days=span)
            for row in company.estimates(reader, since, company.end_of_day(result.as_of), set(codes), active=active):
                by_code[row.stock_code].append(row)
            result.earnings = dict(by_code)
        except TushareError as exc:
            result.issues["earnings_revision"] = error_note(exc)
    if any(isinstance(rule, ChipConcentrationRule) for rule in rules) and active() and result.chip_date:
        progress(0, "正在读取目标交易日的筹码成本")
        try:
            code = next(iter(codes)) if len(codes) == 1 else None
            result.chips = company.chip_day(reader, result.chip_date, code)
        except TushareError as exc:
            result.issues["chip_concentration"] = error_note(exc)
    result.manifests = reader.manifests()
    return result


def evaluate(rule, inputs: Inputs, code: str, *, condition_id: str, reference_id: str, condition_version=None) -> ConditionDecision:
    state, metrics = "unknown", {}
    gap = inputs.issues.get(rule.op)
    if isinstance(rule, EarningsRevisionRule):
        summary = company.revisions(inputs.earnings.get(code, []), inputs.as_of.year + rule.year_offset,
                                    inputs.as_of, rule.window_days)
        day = inputs.as_of.isoformat()
        metric = "上调预测的券商"
        thresholds = {metric: rule.minimum_brokers}
        units = {metric: "家", "可比较券商": "家", "预测中位数": "元/股"}
        explanation = gap or f"{summary['fiscal_year']} 财年暂无可核对的同券商前后两次 EPS 预测"
        if summary["comparable_brokers"] and not gap:
            count = summary["up"]
            state = "true" if count >= rule.minimum_brokers else "false"
            metrics = {metric: count, "可比较券商": summary["comparable_brokers"], "预测中位数": summary["consensus_eps"]}
            explanation = (f"{summary['fiscal_year']} 财年 · {summary['window_start']} 至 {day} · "
                           f"{summary['comparable_brokers']} 家有可比预测，其中 {count} 家上调（要求至少 {rule.minimum_brokers} 家）")
    else:
        day = inputs.chip_date.isoformat() if inputs.chip_date else None
        metric = "筹码成本区间宽度"
        thresholds, units = {metric: rule.max_spread_pct}, {metric: "%"}
        spread = company.chip_spread(inputs.chips.get(code, {}))
        explanation = gap or "目标交易日缺少可核对的筹码成本分位数"
        if spread is not None and not gap:
            state = "true" if spread <= rule.max_spread_pct else "false"
            metrics = {metric: spread}
            explanation = f"约 90% 筹码的成本区间宽度为中位成本的 {spread:g}%（要求不超过 {rule.max_spread_pct:g}%）"
    implementation = TUSHARE_RULE_IMPLEMENTATIONS[rule.op]
    return ConditionDecision(
        stock_code=code, condition_id=condition_id, reference_id=reference_id, condition_version=condition_version,
        state=state, evaluation_status="completed",
        reason_code={"true": "condition_met", "false": "condition_not_met", "unknown": "data_missing"}[state],
        explanation=f"{day or '暂无交易日'} · {explanation}", actual_values=metrics, thresholds=thresholds,
        units=units, data_as_of=day, implementation_id=implementation,
    )


def trial(rule, code: str, as_of: str, market_day: str | None) -> ConditionDecision:
    return evaluate(rule, prepare([rule], as_of, market_day, [code]), code, condition_id="starter", reference_id="starter-ref")
