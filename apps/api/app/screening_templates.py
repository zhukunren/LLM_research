"""Versioned deterministic starters, compiled to the existing rule contract."""
from datetime import date
import math

from fastapi import APIRouter, HTTPException
from pydantic import Field, field_validator

from . import conversation_store, market
from .db import connect, json_load
from .rules import validate_filter
from .screening_contracts import ContractModel, ScreeningTaskRevision, UniverseScope, validate_executable_task

router = APIRouter()

TEMPLATES = [
    {"id": "above_sma", "version": 1, "name": "收盘价在均线上方", "formula": "收盘价 > 最近 N 个交易日收盘价的简单平均值（含当日）", "parameters": {"window": {"label": "均线周期 N", "default": 20, "min": 2, "max": 250, "step": 1}}},
    {"id": "return_above", "version": 1, "name": "区间涨幅超过阈值", "formula": "(当日收盘价 ÷ N 个交易日前收盘价 − 1) × 100 > 涨幅阈值 %", "parameters": {"window": {"label": "回看交易日 N", "default": 5, "min": 1, "max": 250, "step": 1}, "threshold": {"label": "涨幅阈值 %", "default": 3, "min": -100, "max": 1000, "step": 0.1}}},
    {"id": "ma_cross", "version": 1, "name": "短均线上穿长均线", "formula": "当日 SMA(短) > SMA(长)，且前一交易日 SMA(短) ≤ SMA(长)", "parameters": {"fast": {"label": "短均线周期", "default": 5, "min": 2, "max": 249, "step": 1}, "slow": {"label": "长均线周期", "default": 20, "min": 3, "max": 250, "step": 1}}},
]


class ApplyTemplateRequest(ContractModel):
    base_revision: int = Field(ge=0)
    client_message_id: str = Field(min_length=1, max_length=100)
    version: int = Field(ge=1)
    parameters: dict[str, int | float]
    as_of: date
    universe: UniverseScope

    @field_validator("parameters", mode="before")
    @classmethod
    def numeric_parameters(cls, value):
        if not isinstance(value, dict) or any(type(item) not in (int, float) for item in value.values()):
            raise ValueError("模板参数必须为数值，不能使用布尔值或文本。")
        return value


def compile_template(template_id: str, version: int, parameters: dict):
    template = next((item for item in TEMPLATES if item["id"] == template_id and item["version"] == version), None)
    if not template:
        raise ValueError("模板或版本不存在，请刷新模板列表。")
    specs = template["parameters"]
    if set(parameters) != set(specs):
        raise ValueError("模板参数不完整或包含未知参数。")
    p = {}
    for key, spec in specs.items():
        value = parameters[key]
        if type(value) not in (int, float) or not spec["min"] <= value <= spec["max"] or not math.isfinite(value):
            raise ValueError(f"{spec['label']}超出允许范围。")
        if spec["step"] == 1:
            if int(value) != value:
                raise ValueError(f"{spec['label']}必须是整数。")
            value = int(value)
        p[key] = value
    if template_id == "above_sma":
        expression = {"op": "indicator_compare", "indicator": "sma", "field": "close", "window": p["window"], "operator": "lt", "compare_field": "close"}
        description = f"收盘价 > SMA({p['window']})（含当日）"
    elif template_id == "return_above":
        expression = {"op": "metric_compare", "metric": "return_pct", "window": p["window"], "operator": "gt", "value": p["threshold"]}
        description = f"(收盘价 / {p['window']}个交易日前收盘价 - 1) × 100 > {p['threshold']}%"
    else:
        expression = {"op": "ma_cross", "fast_window": p["fast"], "slow_window": p["slow"], "direction": "up"}
        description = f"当日SMA({p['fast']}) > SMA({p['slow']})，前一交易日SMA({p['fast']}) ≤ SMA({p['slow']})"
    errors = validate_filter("technical", expression)
    if errors:
        raise ValueError("；".join(errors))
    return template, expression, description


def template_program(template, expression, parameters):
    # Server-owned source; no LLM and no new execution path. The existing runtime
    # validates stock coverage, dates, missing values, quality and cancellation.
    if template["id"] == "above_sma":
        history = expression["window"]
        needed = "params['window']"
        calculation = "mean = float(np.mean(close[-params['window']:]))\n        metrics[code] = {'close': float(close[-1]), 'sma': mean}\n        decisions[code] = bool(close[-1] > mean)"
    elif template["id"] == "return_above":
        history = expression["window"] + 1
        needed = "params['window'] + 1"
        calculation = "baseline = float(close[-params['window'] - 1])\n        if baseline <= 0:\n            continue\n        change = (float(close[-1]) / baseline - 1) * 100\n        metrics[code] = {'return_pct': change}\n        decisions[code] = bool(change > params['threshold'])"
    else:
        history = expression["slow_window"] + 1
        needed = "params['slow'] + 1"
        calculation = "fast = float(np.mean(close[-params['fast']:]))\n        slow = float(np.mean(close[-params['slow']:]))\n        previous_fast = float(np.mean(close[-params['fast']-1:-1]))\n        previous_slow = float(np.mean(close[-params['slow']-1:-1]))\n        metrics[code] = {'fast_sma': fast, 'slow_sma': slow, 'previous_fast': previous_fast, 'previous_slow': previous_slow}\n        decisions[code] = bool(fast > slow and previous_fast <= previous_slow)"
    source = """def screen(context, frames, params):
    decisions = {code: None for code in context['stock_codes']}
    metrics = {}
    for code in context['stock_codes']:
        frame = frames[code]
        close = frame['close']
        if len(close) < REQUIRED_HISTORY or not np.all(frame['valid']) or not np.all(np.isfinite(close)):
            continue
        """ + calculation + "\n    return {'decisions': decisions, 'metrics': metrics, 'units': {}}\n"
    source = source.replace("REQUIRED_HISTORY", needed)
    return {"contract_version": "python-screen-v1", "source_code": source,
            "required_fields": ["close"], "required_history_bars": history,
            "parameters": {key: int(value) if template["parameters"][key]["step"] == 1 else value for key, value in parameters.items()},
            "parameter_specs": {key: {"label": spec["label"], "type": "integer" if spec["step"] == 1 else "number", "minimum": spec["min"], "maximum": spec["max"]} for key, spec in template["parameters"].items()}}


@router.get("/screening-templates")
def list_templates():
    return {"items": TEMPLATES}


@router.post("/conversations/{conversation_id}/screening-templates/{template_id}", status_code=201)
def apply_template(conversation_id: str, template_id: str, payload: ApplyTemplateRequest):
    try:
        template, expression, description = compile_template(template_id, payload.version, payload.parameters)
        latest = market.cached_profile().get("last_date")
        if latest and payload.as_of.isoformat() > latest:
            raise ValueError(f"行情只更新到 {latest}。")
        if payload.universe.kind == "explicit" and any(code.rsplit(".", 1)[-1] not in {"SH", "SZ", "BJ"} for code in payload.universe.stock_codes):
            raise ValueError("基础方案仅支持沪深北 A 股日线。")
        if payload.universe.kind == "watchlist":
            with connect() as connection:
                exists = connection.execute("SELECT 1 FROM watchlists WHERE id=?", (payload.universe.watchlist_id,)).fetchone()
                if not exists:
                    raise ValueError("找不到指定的自选股票池。")
                if not connection.execute("SELECT 1 FROM watchlist_items WHERE watchlist_id=? LIMIT 1", (payload.universe.watchlist_id,)).fetchone():
                    raise ValueError("指定的自选股票池为空。")
        content = f"使用基础方案“{template['name']}”：{description}。仅生成方案，确认后执行。"
        task = ScreeningTaskRevision.model_validate({
            "task_id": conversation_id, "revision": payload.base_revision + 1,
            "original_user_messages": [content],
            "conditions": [{"condition_id": "starter", "library": "technical", "source_quote": content, "description": description, "expression": {}, "program": template_program(template, expression, payload.parameters), "implementation_id": "llm-python-screen", "implementation_version": "python-screen-v1"}],
            "references": [{"reference_id": "starter-ref", "condition_id": "starter"}],
            "logic_tree": {"op": "condition", "reference_id": "starter-ref"},
            "scope": {"as_of": payload.as_of, "universe": payload.universe, "price_basis": "unknown"}, "unresolved": [],
        })
        validate_executable_task(task)
        # Atomic publication uses the same revision/turn guards as saved-plan reuse.
        # A message id + identical snapshot is the idempotency boundary.
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            message = conversation_store.add_user_message(conversation_id, payload.client_message_id, payload.base_revision, content, _connection=connection)
            source_message_id = message["message_id"]
            turn = connection.execute("SELECT id,state,base_revision,result_json FROM conversation_turns WHERE conversation_id=? AND user_message_id=?", (conversation_id, source_message_id)).fetchone()
            if not turn or turn["base_revision"] != payload.base_revision:
                raise conversation_store.ConversationConflict("请基于当前对话重新选择模板。")
            replay = turn["state"] == "succeeded" and json_load(turn["result_json"]).get("intent") == "template"
            if turn["state"] != "awaiting_agent" and not replay:
                raise conversation_store.ConversationConflict("这条消息已经在处理或已结束，请重新选择模板。")
            result = conversation_store.save_task_revision(conversation_id, payload.base_revision, source_message_id, task, _connection=connection)
            conversation_store.finish_turn(conversation_id, turn["id"], task.revision, "succeeded",
                f"已生成基础方案“{template['name']}”：{description}。请核对参数、股票范围和截止日，再确认开始筛选。尚未执行筛选。",
                {"intent": "template", "template_id": template_id, "template_version": payload.version, "task_revision": task.revision, "execution_authorized": False, "ready_to_execute": False}, _connection=connection)
        return {**result, "turn_id": turn["id"], "source_message_id": source_message_id}
    except conversation_store.ConversationNotFound as exc:
        raise HTTPException(404, {"code": "conversation_not_found", "message": "找不到对话或消息。"}) from exc
    except (conversation_store.ConversationConflict, conversation_store.ConversationStoreError) as exc:
        raise HTTPException(409, {"code": "conversation_conflict", "message": str(exc)}) from exc
    except ValueError as exc:
        raise HTTPException(422, {"code": "invalid_template", "message": str(exc)}) from exc
