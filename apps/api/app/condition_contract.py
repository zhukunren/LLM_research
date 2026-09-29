"""Human-readable contracts shared by authoring, execution and audit views."""
from __future__ import annotations

from typing import Any

OPERATORS = {"gt": "大于", "gte": "不低于", "lt": "小于", "lte": "不高于", "eq": "等于"}
FIELDS = {"close": "收盘价", "open": "开盘价", "high": "最高价", "low": "最低价", "volume": "成交量", "amount": "成交额"}
INDICATOR_NAMES = {"sma": "日均线", "ema": "日指数均线", "rsi": "日 RSI", "macd_hist": "MACD 柱", "macd_dif": "MACD DIF", "macd_dea": "MACD DEA", "kdj_k": "KDJ K", "kdj_d": "KDJ D", "kdj_j": "KDJ J", "atr": "ATR", "bollinger": "布林带上轨"}


def _parameter_summary(summary: str, parameters: dict[str, Any], specs: dict[str, Any]) -> str:
    details = []
    for key, value in parameters.items():
        spec = specs.get(key)
        if not isinstance(spec, dict) or not spec.get("label"):
            continue
        formatted = f"{value:g}" if isinstance(value, (int, float)) else str(value)
        if formatted not in summary:
            details.append(f"{spec['label']} {formatted}")
    return summary + (f" · {' · '.join(details)}" if details else "")


def describe_filter(library: str, expression: dict[str, Any]) -> dict[str, Any]:
    op = expression.get("op")
    comparator = OPERATORS.get(expression.get("operator"), "比较")
    window = expression.get("window", 0)
    value = expression.get("value", "")
    if isinstance(value, (float, int)):
        value = f"{value:g}"
    notes = []
    if library == "technical":
        notes = ["使用截止日及之前的日线；周期按该证券有记录的交易日计数。", "数据缺失、异常或历史不足时，记为“数据不足”。"]
        if op == "timeseries_filter":
            from .time_series import minimum_history, summary as formula_summary
            formula = expression["formula"]
            base = expression.get("summary") or formula_summary(formula)
            label = base
            return {"summary": label, "notes": [*notes, "按受限时序公式逐交易日计算；缺少预热历史、数据异常或除数为零时保留为数据不足。"], "minimum_bars": minimum_history(formula), "availability": "market", "availability_label": "可用日线试算"}
        if op == "generated_timeseries_filter":
            parameters = expression.get("parameters", {})
            specs = expression.get("parameter_specs", {})
            label = _parameter_summary(expression["summary"], parameters, specs)
            return {"summary": label, "notes": [*notes, "计算函数由模型生成，行情输入、公式语法和结果格式经过校验；公式来源与代码摘要随条件版本留存。", "结果只使用截止日及之前最多500根日线；预热不足、所需字段缺失或计算未定义时保留为数据不足。"], "availability": "market", "availability_label": "可用日线试算"}
        if op == "metric_compare":
            metric = expression.get("metric")
            if metric == "return_pct":
                days = expression.get("consecutive_days")
                label = f"{f'连续 {days} 个交易日，每日' if days else ''}{window} 日涨幅{comparator} {value}%"
                notes.append(f"每日涨幅 =（当日收盘价 ÷ 该日前 {window} 个有行情交易日收盘价 − 1）× 100%。（如指定连续周期，逐个交易日分别比较。）")
            elif metric == "volume_ratio":
                days = expression.get("consecutive_days")
                label = f"{f'连续 {days} 个交易日，每日' if days else '当日'}成交量{comparator}此前 {window} 日均量的 {value} 倍"
                notes.append(f"每个比较日的均量使用该日前 {window} 个有行情交易日；不含比较日成交量。此口径不是盘中量比。")
            else:
                label = f"收盘价{comparator} {value} 元"
            minimum = window + 1 if metric != "close" else 1
        elif op == "ma_cross":
            direction = "上穿" if expression.get("direction", "up") == "up" else "下穿"
            label = f"{expression.get('fast_window')} 日均线当日{direction} {expression.get('slow_window')} 日均线"
            minimum = expression.get("slow_window", 0) + 1
            notes.append("同时核对前一交易日与当日的位置；仅已处于均线上方不算上穿。")
        else:
            indicator = expression.get("indicator", "")
            indicator_name = INDICATOR_NAMES.get(indicator, indicator)
            subject = f"{window} {indicator_name}" if not indicator.startswith("macd_") else indicator_name
            if expression.get("field") == "volume":
                subject = f"{window} 日平均成交量"
            target = FIELDS.get(expression.get("compare_field"), value)
            label = f"{subject}{comparator} {target}"
            if indicator == "sma" and expression.get("compare_field") == "close" and expression.get("field", "close") == "close":
                inverse = {"gt": "小于", "gte": "不高于", "lt": "大于", "lte": "不低于", "eq": "等于"}
                label = f"收盘价{inverse.get(expression.get('operator'), comparator)} {window} 日均线"
            minimum = 34 if indicator.startswith("macd_") else window + (1 if indicator in {"rsi", "atr"} else 0)
        return {"summary": label, "notes": notes, "minimum_bars": minimum, "availability": "market", "availability_label": "可用日线试算"}
    if library == "report":
        labels = [item.get("label", "研究判断") for item in expression.get("criteria", [])]
        label = ("，且" if expression.get("combine") == "all" else "，或").join(labels) or "研报关键词检索"
        return {"summary": label, "notes": [f"回看 {expression.get('lookback_calendar_days', 365)} 个自然日内的本地研报。", "须先完成对应截止日的研报评估；判断附带原文页码，未覆盖时记为数据不足。"], "availability": "report_evaluation", "availability_label": "需先评估研报"}
    return {"summary": f"近 {expression.get('lookback_calendar_days', 30)} 个自然日资讯包含：" + "、".join(expression.get("terms", [])), "notes": ["在同一篇资讯正文中核对关键词，不把文本提及当作事实已经核实。", "资讯数据源尚未接入，当前无法判断。"], "availability": "unavailable", "availability_label": "缺少资讯数据"}


def filter_object(row) -> dict[str, Any]:
    from .db import json_load
    from .rules import filter_parameters
    payload = json_load(row["dsl_json"])
    return {**payload, "id": row["id"], "library": row["library"], "name": row["name"],
            "description": row["description"], "version": row["version"], "created_at": row["created_at"],
            "parameters": filter_parameters(row["library"], payload["expression"]),
            "contract": describe_filter(row["library"], payload["expression"])}
