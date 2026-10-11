"""Versioned numeric indicators, separate from boolean screening conditions.

Generated Python runs through the existing trusted local Python executor. It is
not an OS sandbox. Prefix replays are useful look-ahead evidence, not a proof of
causality or of the financial interpretation of arbitrary source code.
"""
from __future__ import annotations

import ast
import hashlib
import json
import math
import re
from datetime import date
from typing import Any, Callable, Literal
from uuid import uuid4

from pydantic import Field, ValidationError, field_validator, model_validator

from . import market, runtime_executor
from .db import connect, json_dump, json_load, utc_now
from .screening_contracts import ContractModel, CustomProgram, ProgramParameterSpec

CONTRACT_VERSION = "python-indicator-v1"
VALIDATION_VERSION = "numeric-series-validation-v1"
PALETTE = ("#d66755", "#4c7eb1", "#7b62a3", "#6fa274", "#b5793b", "#359b9b", "#bb5a8c", "#77818c")
PRICE_FIELDS = ("open", "high", "low", "close", "volume", "amount")


class IndicatorError(ValueError):
    def __init__(self, message: str, status_code: int = 422, code: str = "dynamic_indicator_error"):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


DynamicIndicatorError = IndicatorError

def _finite_number(value: Any) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class IndicatorProgram(ContractModel):
    contract_version: Literal["python-indicator-v1"] = CONTRACT_VERSION
    source_code: str = Field(min_length=1, max_length=26_000)
    required_fields: list[Literal["open", "high", "low", "close", "volume", "amount"]] = Field(min_length=1, max_length=6)
    required_history_bars: int = Field(ge=1, le=500, strict=True)
    parameters: dict[str, int | float] = Field(default_factory=dict, max_length=32)
    parameter_specs: dict[str, ProgramParameterSpec] = Field(default_factory=dict, max_length=32)

    @field_validator("parameters", mode="before")
    @classmethod
    def numeric_params(cls, value):
        if not isinstance(value, dict) or any(not isinstance(key, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,39}", key) or not _finite_number(item) for key, item in value.items()):
            raise ValueError("指标参数必须是命名的有限数值，不能使用布尔值或数字字符串")
        return value

    @model_validator(mode="after")
    def valid_program(self):
        if len(set(self.required_fields)) != len(self.required_fields):
            raise ValueError("所需行情字段不能重复")
        if set(self.parameters) != set(self.parameter_specs):
            raise ValueError("每个参数必须有且只有一个参数说明")
        for name, value in self.parameters.items():
            spec = self.parameter_specs[name]
            if spec.type == "integer" and type(value) is not int:
                raise ValueError(f"参数 {name} 必须为整数")
            if spec.minimum is not None and value < spec.minimum or spec.maximum is not None and value > spec.maximum:
                raise ValueError(f"参数 {name} 超出允许范围")
        try:
            tree = ast.parse(self.source_code)
        except SyntaxError as exc:
            raise ValueError(f"指标源码语法错误：{exc.msg}") from exc
        if not any(isinstance(node, ast.FunctionDef) and node.name == "compute" for node in tree.body):
            raise ValueError("指标源码必须定义 compute(context, frames, params)")
        return self


class IndicatorOutput(ContractModel):
    name: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{0,39}$")
    label: str = Field(min_length=1, max_length=100)
    unit: str = Field(default="", max_length=40)
    placement: Literal["overlay", "pane"] = "pane"
    kind: Literal["line", "histogram"] = "line"
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")

    @model_validator(mode="after")
    def renderable_placement(self):
        if self.kind == "histogram" and self.placement == "overlay":
            raise ValueError("柱状指标必须位于副图，主图仅支持线条")
        return self


class DynamicIndicatorDefinition(ContractModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=2000)
    formula: str = Field(min_length=1, max_length=4000)
    original_prompt: str = Field(min_length=1, max_length=8000)
    program: IndicatorProgram
    outputs: list[IndicatorOutput] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def consistent_outputs(self):
        if len({output.name for output in self.outputs}) != len(self.outputs):
            raise ValueError("指标输出名称不能重复")
        for placement in ("overlay", "pane"):
            if sum(output.kind == "histogram" and output.placement == placement for output in self.outputs) > 1:
                raise ValueError("每个主图或副图最多包含一组柱状输出")
        return self


class PreviewIndicatorRequest(ContractModel):
    definition: DynamicIndicatorDefinition | None = None
    indicator_id: str | None = Field(default=None, min_length=1, max_length=100)
    version: int | None = Field(default=None, ge=1, strict=True)
    stock_code: str = Field(pattern=r"^\d{4,6}\.(SH|SZ|BJ|HK|KS)$")
    as_of: date
    limit: int = Field(default=500, ge=2, le=500, strict=True)
    parameter_overrides: dict[str, Any] = Field(default_factory=dict, max_length=32)
    conversation_id: str | None = Field(default=None, min_length=1, max_length=100)

    @model_validator(mode="after")
    def one_source(self):
        if (self.definition is None) == (self.indicator_id is None):
            raise ValueError("请提供指标草稿，或已保存指标的固定版本")
        if self.indicator_id and self.version is None or self.definition is not None and self.version is not None:
            raise ValueError("复用指标必须指定版本，草稿不能指定版本")
        return self


class SaveIndicatorRequest(ContractModel):
    trial_id: str = Field(min_length=1, max_length=100)
    request_id: str = Field(min_length=1, max_length=100)
    confirmed: Literal[True]
    name: str | None = Field(default=None, min_length=1, max_length=100)
    indicator_id: str | None = Field(default=None, min_length=1, max_length=100)
    base_version: int | None = Field(default=None, ge=1, strict=True)

    @field_validator("confirmed", mode="before")
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError("需要用户明确确认保存指标")
        return value

    @model_validator(mode="after")
    def version_pair(self):
        if (self.indicator_id is None) != (self.base_version is None):
            raise ValueError("保存新版本需要指标 ID 和当前版本")
        return self


class IndicatorConditionRequest(ContractModel):
    version: int = Field(ge=1, strict=True)
    output: str = Field(min_length=1, max_length=40)
    operator: Literal["gt", "gte", "lt", "lte", "eq", "cross_above", "cross_below"]
    threshold: int | float
    name: str | None = Field(default=None, min_length=1, max_length=100)

    @field_validator("threshold", mode="before")
    @classmethod
    def finite_threshold(cls, value):
        if not _finite_number(value):
            raise ValueError("比较阈值必须是有限数值，不能使用布尔值或数字字符串")
        return value


def _code_hash(definition: DynamicIndicatorDefinition) -> str:
    return hashlib.sha256(definition.program.source_code.encode()).hexdigest()


def _definition_with_parameters(definition: DynamicIndicatorDefinition, overrides: dict[str, Any]) -> DynamicIndicatorDefinition:
    raw = definition.model_dump(mode="json")
    if set(overrides) - set(definition.program.parameters):
        raise IndicatorError("参数覆盖包含未声明的参数")
    raw["program"]["parameters"].update(overrides)
    try:
        return DynamicIndicatorDefinition.model_validate(raw)
    except ValidationError as exc:
        raise IndicatorError("指标参数无效：" + exc.errors()[0]["msg"]) from exc


def _runtime_frames(definition: DynamicIndicatorDefinition, bars_by_stock: dict[str, list[dict]], as_of: str) -> dict[str, list[dict]]:
    output = {}
    for code, bars in bars_by_stock.items():
        previous = ""
        rows = []
        for bar in bars:
            day = bar.get("trade_date")
            try:
                valid_date = isinstance(day, str) and date.fromisoformat(day).isoformat() == day
            except ValueError:
                valid_date = False
            if not valid_date or day <= previous or day > as_of:
                raise IndicatorError("行情日期必须是有序、唯一、不晚于截止日的 YYYY-MM-DD 日期")
            previous = day
            valid = bar.get("quality_valid") is True and all(_finite_number(bar.get(field)) for field in definition.program.required_fields)
            row = {"trade_date": day, "quality_valid": valid}
            # Never expose a rejected row's numeric values to the generated code.
            for field in definition.program.required_fields:
                row[field] = bar.get(field) if valid else None
            rows.append(row)
        output[code] = rows
    return output


def validate_result(result: Any, frames: dict[str, list[dict]], definition: DynamicIndicatorDefinition) -> dict[str, dict[str, list[float | None]]]:
    """Strict numeric, stock, output and date/length contract; no coercion."""
    if not isinstance(result, dict) or set(result) != {"dates", "series"}:
        raise IndicatorError("指标必须且只能返回 dates 和 series")
    dates, series = result["dates"], result["series"]
    if not isinstance(dates, dict) or not isinstance(series, dict) or set(dates) != set(frames) or set(series) != set(frames):
        raise IndicatorError("指标必须返回本次每只证券的日期和完整时序")
    outputs = {item.name for item in definition.outputs}
    normalized = {}
    for code, rows in frames.items():
        expected_dates = [row["trade_date"] for row in rows]
        if not isinstance(dates[code], list) or dates[code] != expected_dates:
            raise IndicatorError("指标输出日期必须与输入行情逐条完全对齐，不能重排、补充或截断")
        if not isinstance(series[code], dict) or set(series[code]) != outputs:
            raise IndicatorError("指标输出名称必须与声明完全一致")
        normalized[code] = {}
        for output, values in series[code].items():
            if not isinstance(values, list) or len(values) != len(rows):
                raise IndicatorError("指标每条时序必须与行情等长")
            if any(value is not None and not _finite_number(value) for value in values):
                raise IndicatorError("指标值只能是有限数字或 null，不能使用布尔值、字符串或非有限数值")
            for index, value in enumerate(values):
                # Warm-up is a declared minimum, and every invalid input row is a gap.
                if value is not None and (index < definition.program.required_history_bars - 1 or not rows[index]["quality_valid"]):
                    raise IndicatorError("预热期与无效行情处必须返回 null，不能填零或延用旧值")
            normalized[code][output] = values
    return normalized


def _execution_context(definition: DynamicIndicatorDefinition, frames: dict[str, list[dict]], as_of: str, effective_market_date: str | None, source_context: dict) -> dict:
    return {
        "contract_version": CONTRACT_VERSION,
        "as_of": as_of,
        "effective_market_date": effective_market_date,
        "stock_codes": list(frames),
        "required_fields": definition.program.required_fields,
        "required_history_bars": definition.program.required_history_bars,
        "data_as_of": {code: rows[-1]["trade_date"] if rows else None for code, rows in frames.items()},
        "price_basis": source_context.get("price_basis", "unknown"),
        "volume_unit": source_context.get("volume_unit", "unknown"),
        "amount_unit": source_context.get("amount_unit", "unknown"),
    }


def _run(definition: DynamicIndicatorDefinition, frames: dict[str, list[dict]], as_of: str, effective_date: str | None, source_context: dict, is_active: Callable[[], bool] = lambda: True) -> dict:
    context = _execution_context(definition, frames, as_of, effective_date, source_context)
    # Reuse the mature runner unchanged: it accepts screen(), while indicator
    # authors implement compute(). The adapter is not a security boundary.
    source = definition.program.source_code + "\n\ndef screen(context, frames, params):\n    return compute(context, frames, params)\n"
    try:
        raw = runtime_executor.execute_program(source_code=source, context=context, frames=frames, params=definition.program.parameters, is_active=is_active)
    except runtime_executor.RuntimeUnavailable as exc:
        raise IndicatorError(str(exc), 503, "indicator_runtime_unavailable") from exc
    except runtime_executor.ProgramExecutionError as exc:
        raise IndicatorError(str(exc), 422, "indicator_execution_failed") from exc
    return validate_result(raw, frames, definition)


def _source_context(profile: dict) -> dict:
    return {
        "source_fingerprint": list(market.source_fingerprint()) if market.source_fingerprint() else None,
        "source_sha256": profile.get("sha256"),
        "latest_market_date": profile.get("last_date"),
        "price_basis": profile.get("price_basis", "unknown"),
        "volume_unit": profile.get("volume_unit", "unknown"),
        "amount_unit": profile.get("amount_unit", "unknown"),
        "quality_status": profile.get("quality_status"),
    }


def _prefix_checks(definition: DynamicIndicatorDefinition, frames: dict[str, list[dict]], baseline: dict, source_context: dict, is_active: Callable[[], bool] = lambda: True) -> list[dict]:
    # Trial is deliberately single-security. Replaying prefixes with an earlier
    # context catches both future array reads and many as_of/length dependencies.
    code, rows = next(iter(frames.items()))
    count = len(rows)
    cuts = sorted({max(1, count // 2), max(1, count * 3 // 4), count - 1})
    checks = []
    for cut in cuts:
        if cut <= 0 or cut >= count:
            continue
        prefix = {code: rows[:cut]}
        day = rows[cut - 1]["trade_date"]
        result = _run(definition, prefix, day, day, source_context, is_active)
        numeric_comparisons = {output: 0 for output in baseline[code]}
        for output in baseline[code]:
            for left, right in zip(baseline[code][output][:cut], result[code][output]):
                if left is None or right is None:
                    matches = left is None and right is None
                else:
                    numeric_comparisons[output] += 1
                    matches = math.isclose(left, right, rel_tol=1e-10, abs_tol=1e-12)
                if not matches:
                    raise IndicatorError(f"前缀复算不一致：{output} 在 {day} 及以前发生变化，可能存在未来数据或全局长度依赖", 422, "indicator_lookahead_detected")
        checks.append({"stock_code": code, "bars": cut, "as_of": day, "passed": True, "numeric_comparisons": numeric_comparisons})
    return checks


def preview_indicator(payload: PreviewIndicatorRequest | dict, *, conversation_id: str | None = None, turn_id: str | None = None, is_active: Callable[[], bool] = lambda: True) -> dict:
    request = PreviewIndicatorRequest.model_validate(payload)
    definition = request.definition
    origin = None
    if request.indicator_id:
        saved = get_indicator(request.indicator_id, request.version)
        definition = DynamicIndicatorDefinition.model_validate(saved["definition"])
        origin = {"indicator_id": saved["id"], "version": saved["version"]}
    definition = _definition_with_parameters(definition, request.parameter_overrides)
    as_of = request.as_of.isoformat()
    profile = market.cached_profile()
    source_context = _source_context(profile)
    if profile.get("last_date") and as_of > profile["last_date"]:
        raise IndicatorError(f"截止日不能晚于行情最新日期 {profile['last_date']}")
    bars = market.get_bars(request.stock_code, as_of, request.limit)
    if not bars:
        raise IndicatorError("找不到该证券在指定日期前的行情", 404, "indicator_bars_not_found")
    frames = _runtime_frames(definition, {request.stock_code: bars}, as_of)
    effective_date = market.latest_market_date(as_of)
    series = _run(definition, frames, as_of, effective_date, source_context, is_active)
    checks = _prefix_checks(definition, frames, series, source_context, is_active)
    if _source_context(market.cached_profile()) != source_context:
        raise IndicatorError("试算期间行情来源发生变化，请重新试算", 409, "indicator_stale_trial")
    actual_date = bars[-1]["trade_date"]
    stale = effective_date is None or actual_date != effective_date
    numeric_count = {output: sum(value is not None for value in values) for output, values in series[request.stock_code].items()}
    comparable_prefixes = all(any(check["numeric_comparisons"].get(output, 0) for check in checks) for output in numeric_count)
    enough_data = len(bars) >= definition.program.required_history_bars and all(numeric_count.values()) and comparable_prefixes
    warnings = ["前缀复算仅提供有限样本的无未来数据证据，不构成因果性或投资有效性证明。", "生成代码在可信本地 Python 子进程执行，不是操作系统安全沙箱。"]
    if not enough_data:
        warnings.append("历史不足、存在全空输出或前缀复算缺少可比较数值，请扩大历史范围或修正预热与缺失值处理。")
    if stale:
        warnings.append("该证券在所选市场交易日没有行情；不能将更早的指标作为当前值。")
    if source_context["price_basis"] == "unknown":
        warnings.append("价格复权口径尚未确认；仅供探索使用。")
    if any(not row["quality_valid"] for row in frames[request.stock_code]):
        warnings.append("无效行情保留为时间轴缺口；对应输出必须为 null。")
    charts = []
    for placement in dict.fromkeys(output.placement for output in definition.outputs):
        lines, histogram = [], None
        for index, output in enumerate(definition.outputs):
            if output.placement != placement:
                continue
            line = {"id": output.name, "label": output.label, "unit": output.unit, "color": output.color or PALETTE[index], "values": series[request.stock_code][output.name]}
            if output.kind == "histogram":
                histogram = line
            else:
                lines.append(line)
        charts.append({
            "placement": placement,
            "lines": lines, "histogram": histogram, "reference_lines": [],
            "bars": [{field: bar.get(field) if _finite_number(bar.get(field)) else None for field in PRICE_FIELDS} | {"trade_date": bar["trade_date"], "quality_valid": frames[request.stock_code][index]["quality_valid"]} for index, bar in enumerate(bars)],
        })
    if not is_active():
        raise runtime_executor.RuntimeCancelled("指标试算已取消")
    trial = {
        "trial_id": str(uuid4()), "created_at": utc_now(),
        "conversation_id": conversation_id or request.conversation_id, "turn_id": turn_id,
        "origin": origin, "indicator_id": request.indicator_id, "version": request.version,
        "definition": definition.model_dump(mode="json"),
        "definition_hash": _hash(definition.model_dump(mode="json")), "code_hash": _code_hash(definition),
        "stock_code": request.stock_code, "as_of": as_of, "actual_date": actual_date,
        "parameters": definition.program.parameters,
        "dates": [bar["trade_date"] for bar in bars], "series": series[request.stock_code], "chart": charts[0], "charts": charts,
        "source_context": {**source_context, "effective_market_date": effective_date, "input_hash": _hash(frames),
                           "requested_limit": request.limit, "input_bars": len(bars)},
        "validation": {"version": VALIDATION_VERSION, "passed": True, "saveable": bool(enough_data and not stale and checks),
                       "checks": ["strict_numeric", "finite_values", "full_date_alignment", "exact_output_names", "warmup_and_gaps", "prefix_replay"],
                       "prefix_checks": checks, "causality_proven": False, "numeric_count": numeric_count,
                       "stale": stale, "warnings": warnings},
    }
    with connect() as connection:
        connection.execute("INSERT INTO dynamic_indicator_trials(id,conversation_id,trial_json,created_at) VALUES(?,?,?,?)",
                           (trial["trial_id"], trial["conversation_id"], json_dump(trial), trial["created_at"]))
    return trial


def get_trial(trial_id: str) -> dict:
    with connect() as connection:
        row = connection.execute("SELECT trial_json FROM dynamic_indicator_trials WHERE id=?", (trial_id,)).fetchone()
    if not row:
        raise IndicatorError("找不到指标试算记录", 404, "indicator_trial_not_found")
    return json_load(row[0])


def list_trials(conversation_id: str | None = None, limit: int = 30) -> list[dict]:
    with connect() as connection:
        rows = connection.execute("SELECT trial_json FROM dynamic_indicator_trials WHERE (? IS NULL OR conversation_id=?) ORDER BY rowid DESC LIMIT ?",
                                  (conversation_id, conversation_id, max(1, min(limit, 100)))).fetchall()
    summaries = []
    for row in rows:
        trial = json_load(row[0])
        summaries.append({key: trial[key] for key in (
            "trial_id", "created_at", "conversation_id", "turn_id", "indicator_id", "version", "origin",
            "definition_hash", "code_hash", "stock_code", "as_of", "actual_date", "validation",
        )} | {"name": trial["definition"]["name"], "point_count": len(trial["dates"])})
    return summaries


def _saved_record(row) -> dict:
    return {"id": row["indicator_id"], "version": row["version"], "name": row["name"],
            "definition": json_load(row["definition_json"]), "definition_hash": row["definition_hash"],
            "code_hash": row["code_hash"], "trial_id": row["trial_id"],
            "validation": json_load(row["validation_json"]), "source_context": json_load(row["source_context_json"]),
            "created_at": row["created_at"]}


def get_indicator(indicator_id: str, version: int | None = None) -> dict:
    with connect() as connection:
        row = connection.execute("SELECT * FROM dynamic_indicator_versions WHERE indicator_id=? AND (? IS NULL OR version=?) ORDER BY version DESC LIMIT 1",
                                 (indicator_id, version, version)).fetchone()
    if not row:
        raise IndicatorError("找不到指定指标版本", 404, "indicator_not_found")
    return _saved_record(row)


def list_indicators(include_history: bool = False, limit: int = 100) -> list[dict]:
    with connect() as connection:
        rows = connection.execute("""SELECT v.* FROM dynamic_indicator_versions v
            WHERE ? OR v.version=(SELECT MAX(x.version) FROM dynamic_indicator_versions x WHERE x.indicator_id=v.indicator_id)
            ORDER BY v.created_at DESC,v.rowid DESC LIMIT ?""", (include_history, max(1, min(limit, 200)))).fetchall()
    return [_saved_record(row) for row in rows]


def list_versions(indicator_id: str) -> list[dict]:
    with connect() as connection:
        rows = connection.execute("SELECT * FROM dynamic_indicator_versions WHERE indicator_id=? ORDER BY version DESC", (indicator_id,)).fetchall()
    if not rows:
        raise IndicatorError("找不到指标", 404, "indicator_not_found")
    return [_saved_record(row) for row in rows]


def save_indicator(payload: SaveIndicatorRequest | dict) -> dict:
    request = SaveIndicatorRequest.model_validate(payload)
    request_json = json_dump(request.model_dump(mode="json"))
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        replay = connection.execute("SELECT request_json,response_json FROM dynamic_indicator_save_requests WHERE request_id=?", (request.request_id,)).fetchone()
        if replay:
            if replay["request_json"] != request_json:
                raise IndicatorError("保存请求 ID 已用于不同内容", 409, "indicator_request_conflict")
            return json_load(replay["response_json"])
        row = connection.execute("SELECT trial_json FROM dynamic_indicator_trials WHERE id=?", (request.trial_id,)).fetchone()
        if not row:
            raise IndicatorError("找不到指标试算记录", 404, "indicator_trial_not_found")
        trial = json_load(row[0])
        if not trial["validation"]["saveable"]:
            raise IndicatorError("必须先完成包含有效输出且行情未过期的指标试算，才能保存")
        if trial["validation"].get("version") != VALIDATION_VERSION:
            raise IndicatorError("指标验证规则已变化，请重新试算", 409, "indicator_stale_trial")
        context = trial["source_context"]
        current = _source_context(market.cached_profile())
        if any(context.get(key) != value for key, value in current.items()):
            raise IndicatorError("行情来源或口径自试算后发生变化，请重新试算再保存", 409, "indicator_stale_trial")
        definition = DynamicIndicatorDefinition.model_validate(trial["definition"])
        current_bars = market.get_bars(trial["stock_code"], trial["as_of"], context["requested_limit"])
        current_frames = _runtime_frames(definition, {trial["stock_code"]: current_bars}, trial["as_of"])
        if _hash(current_frames) != context["input_hash"] or market.latest_market_date(trial["as_of"]) != context["effective_market_date"]:
            raise IndicatorError("试算行情数据已变化，请重新试算再保存", 409, "indicator_stale_trial")
        if _hash(definition.model_dump(mode="json")) != trial["definition_hash"] or _code_hash(definition) != trial["code_hash"]:
            raise IndicatorError("试算与指标定义不匹配，请重新试算", 409)
        indicator_id, version = request.indicator_id or str(uuid4()), 1
        if request.indicator_id:
            latest = connection.execute("SELECT MAX(version) FROM dynamic_indicator_versions WHERE indicator_id=?", (indicator_id,)).fetchone()[0]
            if latest is None:
                raise IndicatorError("找不到要更新的指标", 404)
            if latest != request.base_version:
                raise IndicatorError("指标已有新版本，请刷新后保存", 409, "indicator_version_conflict")
            version = latest + 1
        name, now = request.name or definition.name, utc_now()
        connection.execute("""INSERT INTO dynamic_indicator_versions
            (indicator_id,version,name,definition_json,definition_hash,code_hash,trial_id,validation_json,source_context_json,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (indicator_id, version, name, json_dump(trial["definition"]), trial["definition_hash"], trial["code_hash"], request.trial_id,
             json_dump(trial["validation"]), json_dump(trial["source_context"]), now))
        result = _saved_record(connection.execute("SELECT * FROM dynamic_indicator_versions WHERE indicator_id=? AND version=?", (indicator_id, version)).fetchone())
        connection.execute("INSERT INTO dynamic_indicator_save_requests(request_id,request_json,response_json,created_at) VALUES(?,?,?,?)",
                           (request.request_id, request_json, json_dump(result), now))
    return result


# The frozen screening adapter validates the complete numeric contract again at
# execution time. No call to a mutable indicator catalogue is needed by a run.
_SCREEN_ADAPTER = '''
def screen(context, frames, params):
    import math
    import json
    import hashlib
    import numpy as _np
    parameter_hash = hashlib.sha256(json.dumps(dict(params), sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    if parameter_hash != _indicator_parameter_hash:
        raise ValueError('此条件使用指标固定版本的参数；修改参数必须先重新试算并保存新版本')
    def json_default(value):
        if isinstance(value, _np.ndarray):
            return value.tolist()
        if isinstance(value, _np.generic):
            return value.item()
        raise TypeError('指标返回了无法序列化的类型')
    indicator_context = dict(context)
    indicator_context['contract_version'] = 'python-indicator-v1'
    indicator_context['required_history_bars'] = _indicator_warmup
    if any(context.get(key, 'unknown') != value for key, value in _indicator_data_context.items()):
        raise ValueError('行情复权口径或单位与指标保存版本不一致，请重新试算并保存新版本')
    indicator_context.update(_indicator_data_context)
    result = json.loads(json.dumps(compute(indicator_context, frames, params), allow_nan=False, default=json_default))
    if not isinstance(result, dict) or set(result) != {'dates', 'series'}:
        raise ValueError('指标必须返回 dates 和 series')
    dates, series = result['dates'], result['series']
    codes = set(frames)
    if not isinstance(dates, dict) or not isinstance(series, dict) or set(dates) != codes or set(series) != codes:
        raise ValueError('指标证券范围不一致')
    decisions, metrics = {}, {}
    for code, frame in frames.items():
        expected_dates = list(frame['trade_date'])
        if not isinstance(dates[code], (list, tuple)) or list(dates[code]) != expected_dates:
            raise ValueError('指标输出日期未与行情对齐')
        if not isinstance(series[code], dict) or set(series[code]) != set(_indicator_outputs):
            raise ValueError('指标输出名称不一致')
        for values in series[code].values():
            if hasattr(values, 'tolist'):
                values = values.tolist()
            if not isinstance(values, list) or len(values) != len(expected_dates):
                raise ValueError('指标时序长度不一致')
            for index, value in enumerate(values):
                if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
                    raise ValueError('指标值必须为有限数值或 null')
                if value is not None and (index < _indicator_warmup - 1 or not frame['valid'][index]):
                    raise ValueError('指标预热或无效行情必须返回 null')
        values = series[code][_indicator_output]
        value = values[-1] if len(values) else None
        previous = values[-2] if len(values) > 1 else None
        if hasattr(value, 'item'):
            value = value.item()
        if hasattr(previous, 'item'):
            previous = previous.item()
        # A missing current row/insufficient history never becomes a match.
        current = bool(expected_dates and expected_dates[-1] == context.get('effective_market_date') and len(expected_dates) >= _indicator_warmup and frame['valid'][-1])
        if not current:
            value = None
        metrics[code] = {_indicator_output: value}
        if value is None or (_indicator_operator.startswith('cross_') and previous is None):
            decisions[code] = None
        elif _indicator_operator == 'gt':
            decisions[code] = bool(value > _indicator_threshold)
        elif _indicator_operator == 'gte':
            decisions[code] = bool(value >= _indicator_threshold)
        elif _indicator_operator == 'lt':
            decisions[code] = bool(value < _indicator_threshold)
        elif _indicator_operator == 'lte':
            decisions[code] = bool(value <= _indicator_threshold)
        elif _indicator_operator == 'eq':
            decisions[code] = bool(value == _indicator_threshold)
        elif _indicator_operator == 'cross_above':
            decisions[code] = bool(previous <= _indicator_threshold < value)
        elif _indicator_operator == 'cross_below':
            decisions[code] = bool(previous >= _indicator_threshold > value)
    return {'decisions': decisions, 'metrics': metrics, 'units': {_indicator_output: _indicator_unit}}
'''


def build_condition(indicator_id: str, payload: IndicatorConditionRequest | dict) -> dict:
    request = IndicatorConditionRequest.model_validate(payload)
    saved = get_indicator(indicator_id, request.version)
    definition = DynamicIndicatorDefinition.model_validate(saved["definition"])
    profile = market.cached_profile()
    if any(profile.get(key, "unknown") != saved["source_context"].get(key, "unknown") for key in ("price_basis", "volume_unit", "amount_unit")):
        raise IndicatorError("行情复权口径或单位与指标保存版本不一致，请重新试算并保存新版本", 409, "indicator_data_context_changed")
    output = next((item for item in definition.outputs if item.name == request.output), None)
    if output is None:
        raise IndicatorError("请选择该指标实际声明的数值输出")
    operators = {"gt": ">", "gte": "≥", "lt": "<", "lte": "≤", "eq": "=", "cross_above": "上穿", "cross_below": "下穿"}
    description = request.name or f"{saved['name']} · {output.label} {operators[request.operator]} {request.threshold}{output.unit}"
    constants = {
        "outputs": [item.name for item in definition.outputs], "output": output.name,
        "operator": request.operator, "threshold": request.threshold, "unit": output.unit,
        "warmup": definition.program.required_history_bars, "parameter_hash": _hash(definition.program.parameters),
        "data_context": {key: saved["source_context"].get(key, "unknown") for key in ("price_basis", "volume_unit", "amount_unit")},
    }
    provenance = {"indicator_id": indicator_id, "indicator_version": saved["version"], "code_hash": saved["code_hash"], "definition_hash": saved["definition_hash"], "trial_id": saved["trial_id"], "output": request.output, "operator": request.operator, "threshold": request.threshold}
    source = "# Frozen numeric indicator: " + json.dumps(provenance, ensure_ascii=False, sort_keys=True) + "\n" + definition.program.source_code + "\n" + "\n".join(f"_indicator_{key} = {value!r}" for key, value in constants.items()) + "\n" + _SCREEN_ADAPTER
    # Preserve the exact input-window convention that produced the saved trial.
    # This matters for EMA and arbitrary cumulative/path-dependent indicators.
    # Existing screening marks shorter or invalid windows unknown.
    history = len(get_trial(saved["trial_id"])["dates"])
    if request.operator.startswith("cross_") and history < definition.program.required_history_bars + 1:
        raise IndicatorError("试算历史没有预热后的连续两个指标值，请扩大历史重新试算后再创建穿越条件")
    program = CustomProgram.model_validate({
        "contract_version": "python-screen-v1", "source_code": source,
        "required_fields": definition.program.required_fields, "required_history_bars": history,
        "parameters": definition.program.parameters, "parameter_specs": definition.program.model_dump(mode="json")["parameter_specs"],
    })
    condition = {
        "condition_id": f"indicator-{uuid4().hex}", "library": "technical", "source_quote": description,
        "description": description, "expression": {}, "program": program.model_dump(mode="json"),
        "implementation_id": "llm-python-screen", "implementation_version": "python-screen-v1",
    }
    return {"condition": condition, "provenance": {
        "kind": "numeric_indicator_comparison", "indicator_id": indicator_id, "indicator_version": saved["version"],
        "definition_hash": saved["definition_hash"], "code_hash": saved["code_hash"], "trial_id": saved["trial_id"],
        "output": output.name, "operator": request.operator, "threshold": request.threshold,
        "parameters": definition.program.parameters, "source_context": saved["source_context"],
        "required_input_bars": history,
    }, "execution_authorized": False, "saved": False}
