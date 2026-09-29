from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any
from typing import Callable

from .screening_contracts import CustomProgram, METRIC_NAME_PATTERN

PROGRAM_IMPLEMENTATION_ID = "llm-python-screen"
PROGRAM_CONTRACT_VERSION = "python-screen-v1"
METRIC_NAME = re.compile(METRIC_NAME_PATTERN)


class ProgramConditionError(ValueError):
    pass


def source_sha256(program: CustomProgram) -> str:
    return hashlib.sha256(program.source_code.encode("utf-8")).hexdigest()


def merged_parameters(program: CustomProgram, overrides: dict[str, Any]) -> dict[str, int | float]:
    if set(overrides) - set(program.parameters):
        raise ProgramConditionError("条件引用包含未声明的程序参数")
    values = dict(program.parameters)
    for name, value in overrides.items():
        if type(value) not in (int, float) or not math.isfinite(float(value)):
            raise ProgramConditionError(f"程序参数{name}必须是有限数值")
        spec = program.parameter_specs[name]
        if spec.type == "integer" and type(value) is not int:
            raise ProgramConditionError(f"程序参数{spec.label}必须是整数")
        if spec.minimum is not None and value < spec.minimum:
            raise ProgramConditionError(f"程序参数{spec.label}低于允许下限")
        if spec.maximum is not None and value > spec.maximum:
            raise ProgramConditionError(f"程序参数{spec.label}高于允许上限")
        values[name] = value
    return values


def _valid_metric_value(value: Any) -> bool:
    if value is None:
        return True
    if type(value) in (int, float):
        return math.isfinite(float(value))
    if isinstance(value, list) and len(value) <= 20:
        return all(item is None or (type(item) in (int, float) and math.isfinite(float(item))) for item in value)
    return False


def validate_result(
    result: Any, stock_codes: list[str]
) -> tuple[dict[str, bool | None], dict[str, dict[str, Any]], dict[str, str]]:
    if not isinstance(result, dict) or set(result) - {"decisions", "metrics", "units"}:
        raise ProgramConditionError("自定义程序返回值字段不符合固定合同")
    decisions = result.get("decisions")
    metrics = result.get("metrics", {})
    if not isinstance(decisions, dict) or set(decisions) != set(stock_codes):
        raise ProgramConditionError("自定义程序必须且只能返回冻结范围内每只证券的判断")
    if any(value is not None and type(value) is not bool for value in decisions.values()):
        raise ProgramConditionError("逐股判断只能是 true、false 或 null（数据不足）")
    if not isinstance(metrics, dict) or set(metrics) - set(stock_codes):
        raise ProgramConditionError("计算指标只能对应本次冻结证券范围")
    units = result.get("units", {})
    if not isinstance(units, dict) or any(
        not isinstance(name, str)
        or not METRIC_NAME.fullmatch(name)
        or not isinstance(unit, str)
        or len(unit) > 40
        for name, unit in units.items()
    ):
        raise ProgramConditionError("计算指标单位必须是名称对应的短文本")
    normalized: dict[str, dict[str, Any]] = {}
    for stock_code, stock_metrics in metrics.items():
        if not isinstance(stock_metrics, dict) or len(stock_metrics) > 12:
            raise ProgramConditionError("每只证券最多返回12项命名计算指标")
        if any(
            not isinstance(name, str)
            or not METRIC_NAME.fullmatch(name)
            or not _valid_metric_value(value)
            for name, value in stock_metrics.items()
        ):
            raise ProgramConditionError("计算指标只允许有限数值、null或最多20个值的时序")
        normalized[stock_code] = stock_metrics
    if set(units) - {name for values in normalized.values() for name in values}:
        raise ProgramConditionError("计算指标单位只能说明实际返回的指标")
    return decisions, normalized, units


def _json_number(value: Any) -> int | float | None:
    if value is None:
        return None
    if type(value) in (int, float):
        return value if math.isfinite(float(value)) else None
    return None


def _runtime_frames(
    program: CustomProgram,
    stock_codes: list[str],
    bars_by_stock: dict[str, list[dict[str, Any]]],
    as_of: str,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, str | None]]:
    fields = set(program.required_fields)
    frames: dict[str, list[dict[str, Any]]] = {}
    data_dates: dict[str, str | None] = {}
    for stock_code in stock_codes:
        bars = bars_by_stock.get(stock_code, [])[-program.required_history_bars :]
        rows = []
        previous_date = ""
        for bar in bars:
            trade_date = bar.get("trade_date")
            if not isinstance(trade_date, str) or trade_date <= previous_date or trade_date > as_of:
                raise ProgramConditionError("冻结行情存在日期乱序或超出截止日的数据")
            previous_date = trade_date
            row = {"trade_date": trade_date, "quality_valid": bool(bar.get("quality_valid"))}
            if "quality_reason" in bar:
                row["quality_reason"] = bar.get("quality_reason")
            for field in fields:
                row[field] = _json_number(bar.get(field))
            rows.append(row)
        frames[stock_code] = rows
        data_dates[stock_code] = rows[-1]["trade_date"] if rows else None
    return frames, data_dates


def evaluate_batch(
    condition: dict[str, Any],
    reference: dict[str, Any],
    stock_codes: list[str],
    bars_by_stock: dict[str, list[dict[str, Any]]],
    *,
    as_of: str,
    effective_market_date: str | None,
    is_active: Callable[[], bool] = lambda: True,
) -> dict[str, dict[str, Any]]:
    raw_program = condition.get("program")
    if not isinstance(raw_program, dict):
        raise ProgramConditionError("技术条件没有自定义程序")
    program = CustomProgram.model_validate(raw_program)
    parameters = merged_parameters(program, reference.get("parameter_overrides") or {})
    frames, data_dates = _runtime_frames(program, stock_codes, bars_by_stock, as_of)
    context = {
        "contract_version": program.contract_version,
        "as_of": as_of,
        "effective_market_date": effective_market_date,
        "stock_codes": stock_codes,
        "required_fields": program.required_fields,
        "required_history_bars": program.required_history_bars,
        "data_as_of": data_dates,
    }
    from . import runtime_executor

    raw_result = runtime_executor.execute_program(
        source_code=program.source_code,
        context=context,
        frames=frames,
        params=parameters,
        is_active=is_active,
    )
    decisions, metrics, units = validate_result(raw_result, stock_codes)
    output: dict[str, dict[str, Any]] = {}
    for stock_code in stock_codes:
        rows = frames[stock_code]
        data_as_of = data_dates[stock_code]
        if (
            len(rows) < program.required_history_bars
            or any(row["quality_valid"] is not True for row in rows)
            or (effective_market_date is not None and data_as_of != effective_market_date)
        ):
            output[stock_code] = {
                "state": "unknown",
                "evaluation_status": "completed",
                "reason_code": "data_missing",
                "metrics": {},
                "units": {},
                "thresholds": parameters,
                "data_as_of": data_as_of,
                "explanation": "所需历史行情不足、质量异常或未覆盖目标交易日，无法判断。",
            }
            continue
        value = decisions[stock_code]
        state = "unknown" if value is None else "true" if value else "false"
        reason_code = "data_missing" if value is None else "condition_met" if value else "condition_not_met"
        output[stock_code] = {
            "state": state,
            "evaluation_status": "completed",
            "reason_code": reason_code,
            "metrics": metrics.get(stock_code, {}),
            "units": units,
            "thresholds": parameters,
            "data_as_of": data_as_of,
        }
    return output


def metrics_summary(metrics: dict[str, Any], units: dict[str, str] | None = None) -> str:
    units = units or {}
    parts = []
    for name, value in metrics.items():
        label = name.replace("_", " ")
        if isinstance(value, list):
            rendered = "、".join("缺失" if item is None else f"{item:.6g}" if type(item) is float else str(item) for item in value[-5:])
            label += "近值"
        else:
            rendered = "缺失" if value is None else f"{value:.6g}" if type(value) is float else str(value)
        parts.append(f"{label} {rendered}{units.get(name, '')}")
    return "；".join(parts)


def payload_json(value: dict[str, Any]) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ProgramConditionError("自定义程序输入不符合 JSON 数据合同") from exc
