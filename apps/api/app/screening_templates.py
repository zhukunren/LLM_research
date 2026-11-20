"""Versioned deterministic starters, compiled to the existing rule contract."""
from datetime import date
import math

from fastapi import APIRouter, HTTPException
from pydantic import Field, field_validator

from . import conversation_store, industry_valuation, market, runtime_executor, tushare_screening_data
from .db import connect, json_load
from .execution_policy import WORKBENCH_MARKER, match_threshold_change, match_trend_request, message_requests_execution
from .rules import combine, evaluate_filter, validate_filter
from .indicators import values
from .screening_contracts import (
    ContractModel, INDUSTRY_VALUATION_IMPLEMENTATION, IndustryValuationRule, IndustryValuationSelection,
    ScreeningTaskRevision, UniverseScope, validate_executable_task,
)
from .tushare_client import TushareError

router = APIRouter()

INDUSTRY_TEMPLATE_ID = "industry_valuation"
TEMPLATES = [
    {"id": "above_sma", "version": 1, "name": "收盘价在均线上方", "formula": "收盘价 > 最近 N 个交易日收盘价的简单平均值（含当日）", "parameters": {"window": {"label": "均线周期 N", "default": 20, "min": 2, "max": 250, "step": 1}}},
    {"id": "return_above", "version": 1, "name": "区间涨幅超过阈值", "formula": "(当日收盘价 ÷ N 个交易日前收盘价 − 1) × 100 > 涨幅阈值 %", "parameters": {"window": {"label": "回看交易日 N", "default": 5, "min": 1, "max": 250, "step": 1}, "threshold": {"label": "涨幅阈值 %", "default": 3, "min": -100, "max": 1000, "step": 0.1}}},
    {"id": "ma_cross", "version": 1, "name": "短均线上穿长均线", "formula": "当日 SMA(短) > SMA(长)，且前一交易日 SMA(短) ≤ SMA(长)", "parameters": {"fast": {"label": "短均线周期", "default": 5, "min": 2, "max": 249, "step": 1}, "slow": {"label": "长均线周期", "default": 20, "min": 3, "max": 250, "step": 1}}},
]

INDUSTRY_TEMPLATE = {
    "id": INDUSTRY_TEMPLATE_ID, "version": 1, "name": "行业估值与成交额",
    "formula": "在所选申万行业内，比较同日正市盈率（TTM），并核对近 {amount_window} 个交易日的日均成交额是否达到 {min_daily_amount_yi} 亿元。",
    "requires_industry": True,
    "parameters": {
        "amount_window": {"label": "成交额窗口（交易日）", "default": 20, "min": 1, "max": 60, "step": 1},
        "min_daily_amount_yi": {"label": "日均成交额下限（亿元）", "default": 0.5, "min": 0, "max": 1000000, "step": 0.01},
    },
}

# Keep old versions resolvable for saved requests; the catalogue exposes combinations.
COMBINATIONS = {
    "trend_momentum": [("above_sma", {"window": "ma_window"}), ("return_above", {"window": "return_window", "threshold": "threshold"})],
    "cross_confirm": [("ma_cross", {"fast": "fast", "slow": "slow"}), ("above_sma", {"window": "slow"})],
    "cross_momentum": [("ma_cross", {"fast": "fast", "slow": "slow"}), ("return_above", {"window": "return_window", "threshold": "threshold"})],
}
for template_id, name, rules in [
    ("trend_momentum", "趋势走强", ["收盘价高于{ma_window}日均线", "近{return_window}日涨幅大于{threshold}%"]),
    ("cross_confirm", "均线上穿确认", ["{fast}日均线上穿{slow}日均线", "收盘价高于{slow}日均线"]),
    ("cross_momentum", "上穿并加速", ["{fast}日均线上穿{slow}日均线", "近{return_window}日涨幅大于{threshold}%"]),
]:
    parameters = {}
    for component_id, mapping in COMBINATIONS[template_id]:
        component = next(item for item in TEMPLATES if item["id"] == component_id)
        for source, target in mapping.items():
            parameters.setdefault(target, dict(component["parameters"][source]))
    TEMPLATES.append({"id": template_id, "version": 1, "name": name, "rules": rules,
                      "formula": " 且 ".join(rules), "parameters": parameters})


class ApplyTemplateRequest(ContractModel):
    base_revision: int = Field(ge=0)
    client_message_id: str = Field(min_length=1, max_length=100)
    version: int = Field(ge=1)
    parameters: dict[str, int | float]
    as_of: date
    universe: UniverseScope
    industry: IndustryValuationSelection | None = None

    @field_validator("parameters", mode="before")
    @classmethod
    def numeric_parameters(cls, value):
        if not isinstance(value, dict) or any(type(item) not in (int, float) for item in value.values()):
            raise ValueError("模板参数必须为数值，不能使用布尔值或文本。")
        return value


def compile_template(template_id: str, version: int, parameters: dict, industry: IndustryValuationSelection | None = None):
    template = next((item for item in [*TEMPLATES, INDUSTRY_TEMPLATE]
                     if item["id"] == template_id and item["version"] == version), None)
    if not template:
        raise ValueError("模板或版本不存在，请刷新模板列表。")
    if (template_id == INDUSTRY_TEMPLATE_ID) != (industry is not None):
        raise ValueError("请选择此规则对应的申万行业和估值条件。")
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
    if industry is not None:
        rule = IndustryValuationRule(**industry.model_dump(), **p)
        return template, rule.model_dump(exclude_none=True), industry_valuation.describe(rule)
    if template_id in COMBINATIONS:
        parts = [compile_template(component_id, 1, {key: p[value] for key, value in mapping.items()})
                 for component_id, mapping in COMBINATIONS[template_id]]
        return template, {"op": "all", "children": [part[1] for part in parts]}, " 且 ".join(f"（{part[2]}）" for part in parts)
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
        units = {"close": "元/股", "sma": "元/股"}
        calculation = "mean = float(np.mean(close[-params['window']:]))\n        metrics[code] = {'close': float(close[-1]), 'sma': mean}\n        decisions[code] = bool(close[-1] > mean)"
    elif template["id"] == "return_above":
        history = expression["window"] + 1
        needed = "params['window'] + 1"
        units = {"return_pct": "%", "base_close": "元/股"}
        calculation = "baseline = float(close[-params['window'] - 1])\n        if baseline <= 0:\n            continue\n        change = (float(close[-1]) / baseline - 1) * 100\n        metrics[code] = {'return_pct': change, 'base_close': baseline}\n        decisions[code] = bool(change > params['threshold'])"
    else:
        history = expression["slow_window"] + 1
        needed = "params['slow'] + 1"
        units = {"fast_sma": "元/股", "slow_sma": "元/股", "previous_fast": "元/股", "previous_slow": "元/股"}
        calculation = "fast = float(np.mean(close[-params['fast']:]))\n        slow = float(np.mean(close[-params['slow']:]))\n        previous_fast = float(np.mean(close[-params['fast']-1:-1]))\n        previous_slow = float(np.mean(close[-params['slow']-1:-1]))\n        metrics[code] = {'fast_sma': fast, 'slow_sma': slow, 'previous_fast': previous_fast, 'previous_slow': previous_slow}\n        decisions[code] = bool(fast > slow and previous_fast <= previous_slow)"
    source = """def screen(context, frames, params):
    decisions = {code: None for code in context['stock_codes']}
    metrics = {}
    for code in context['stock_codes']:
        frame = frames[code]
        close = frame['close']
        if len(close) < REQUIRED_HISTORY or not np.all(frame['valid']) or not np.all(np.isfinite(close)):
            continue
        """ + calculation + f"\n    return {{'decisions': decisions, 'metrics': metrics, 'units': {units!r}}}\n"
    source = source.replace("REQUIRED_HISTORY", needed)
    return {"contract_version": "python-screen-v1", "source_code": source,
            "required_fields": ["close"], "required_history_bars": history,
            "parameters": {key: int(value) if template["parameters"][key]["step"] == 1 else value for key, value in parameters.items()},
            "parameter_specs": {key: {"label": spec["label"], "type": "integer" if spec["step"] == 1 else "number", "minimum": spec["min"], "maximum": spec["max"]} for key, spec in template["parameters"].items()}}


@router.get("/screening-templates")
def list_templates(include_singles: bool = False, singles_only: bool = False, include_industry: bool = False):
    items = [item for item in TEMPLATES if (item["id"] not in COMBINATIONS if singles_only else include_singles or item["id"] in COMBINATIONS)]
    return {"items": [*items, INDUSTRY_TEMPLATE] if include_industry else items}


@router.get("/screening-industries")
def list_industries():
    try:
        return {"items": tushare_screening_data.list_industries()}
    except TushareError as exc:
        raise HTTPException(503, {"code": "industry_data_unavailable", "message": f"暂时无法读取申万行业。{exc}"}) from exc


def _template_task(conversation_id, base_revision, template, expression, description, parameters, messages, scope, quotes=None):
    components = COMBINATIONS.get(template["id"])
    parts = []
    if components:
        for component_id, mapping in components:
            component_parameters = {key: parameters[value] for key, value in mapping.items()}
            component, leaf, detail = compile_template(component_id, 1, component_parameters)
            parts.append((component, leaf, detail, component_parameters))
    else:
        parts.append((template, expression, description, parameters))
    conditions, references = [], []
    for index, (component, leaf, detail, component_parameters) in enumerate(parts):
        condition_id = f"starter-{index + 1}" if components else "starter"
        reference_id = f"starter-ref-{index + 1}" if components else "starter-ref"
        condition = {"condition_id": condition_id, "source_quote": quotes[index] if quotes else messages[-1], "description": detail}
        if component["id"] == INDUSTRY_TEMPLATE_ID:
            condition.update(library="fundamentals", expression=leaf, implementation_id=INDUSTRY_VALUATION_IMPLEMENTATION,
                             implementation_version=INDUSTRY_VALUATION_IMPLEMENTATION)
        else:
            condition.update(library="technical", expression={}, program=template_program(component, leaf, component_parameters),
                             implementation_id="llm-python-screen", implementation_version="python-screen-v1")
        conditions.append(condition)
        references.append({"reference_id": reference_id, "condition_id": condition_id})
    nodes = [{"op": "condition", "reference_id": item["reference_id"]} for item in references]
    return ScreeningTaskRevision.model_validate({
        "task_id": conversation_id, "revision": base_revision + 1, "original_user_messages": messages,
        "conditions": conditions, "references": references,
        "logic_tree": {"op": "all", "children": nodes} if components else nodes[0],
        "scope": scope, "unresolved": [],
    })


def _prior_trend_parameters(conversation_id: str, revision: int) -> dict | None:
    with connect() as connection:
        source = connection.execute(
            """SELECT t.result_json FROM screening_task_revisions r
               JOIN conversation_turns t ON t.user_message_id=r.source_message_id AND t.conversation_id=r.conversation_id
               WHERE r.conversation_id=? AND r.revision=? AND t.state='succeeded'""",
            (conversation_id, revision),
        ).fetchone()
    result = json_load(source[0]) if source else {}
    if (result.get("task_revision") == revision and result.get("template_id") == "trend_momentum"
            and result.get("template_version") == 1):
        return result.get("template_parameters")
    return None


def apply_message_template(conversation_id: str, turn: dict) -> dict | None:
    if turn["state"] != "awaiting_agent" or turn["workflow_type"] != "screening":
        return None
    message = conversation_store.get_user_message(conversation_id, turn["user_message_id"])
    if message["source_refs"] or message["attachments"] or not message_requests_execution(message):
        return None
    base_revision = turn["base_revision"]
    content, _, workbench = message["content"].partition(WORKBENCH_MARKER)
    if "以界面设置为准" in workbench:
        return None
    quotes = None
    if base_revision:
        prior_parameters = _prior_trend_parameters(conversation_id, base_revision)
        if not prior_parameters:
            return None
        threshold = match_threshold_change(content, prior_parameters)
        if threshold is None:
            return None
        parameters = {**prior_parameters, "threshold": threshold}
        previous = conversation_store.get_task_revision(conversation_id, base_revision)
        scope = previous.scope
        history = previous.original_user_messages
        quotes = [previous.conditions[0].source_quote, content]
    else:
        parameters = match_trend_request(content)
        if not parameters:
            return None
        profile = market.cached_profile()
        if not profile.get("available") or not profile.get("last_date"):
            return None
        scope = {"as_of": profile["last_date"], "universe": {"kind": "all_a_shares"}, "price_basis": market.PRICE_BASIS}
        history = []
    try:
        template, expression, description = compile_template("trend_momentum", 1, parameters)
        task = _template_task(conversation_id, base_revision, template, expression, description, parameters, [*history, content], scope, quotes)
        if task.scope.as_of is None or not runtime_executor.readiness()["ready"]:
            return None
        validate_executable_task(task)
    except ValueError:
        return None
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            """SELECT t.state, EXISTS (SELECT 1 FROM research_turn_jobs j WHERE j.turn_id=t.id) AS queued
               FROM conversation_turns t WHERE t.id=? AND t.conversation_id=?""",
            (turn["id"], conversation_id),
        ).fetchone()
        if not row or row["queued"]:
            return None
        if row["state"] not in {"awaiting_agent", "succeeded"}:
            return None
        if row["state"] == "awaiting_agent":
            conversation_store.save_task_revision(conversation_id, base_revision, message["id"], task, _connection=connection)
            conversation_store.finish_turn(
                conversation_id, turn["id"], task.revision, "succeeded",
                f"已整理两条筛选规则：{description}。使用截至 {task.scope.as_of.isoformat()} 的日线，筛选结果会在本对话显示。",
                {"intent": "template", "template_id": template["id"], "template_version": template["version"],
                 "template_parameters": parameters, "task_revision": task.revision, "execution_authorized": True,
                 "ready_to_execute": True, "execution_authorization_message_id": message["id"]},
                pending_execute_message_id=message["id"], _connection=connection,
            )
    return conversation_store.get_turn(conversation_id, turn["id"])


class TemplatePreviewRequest(ContractModel):
    version: int = Field(ge=1)
    parameters: dict[str, int | float]
    stock_code: str = Field(pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    as_of: date
    industry: IndustryValuationSelection | None = None

    @field_validator("parameters", mode="before")
    @classmethod
    def numeric_parameters(cls, value):
        return ApplyTemplateRequest.numeric_parameters(value)


@router.post("/screening-templates/{template_id}/preview")
def preview_template(template_id: str, payload: TemplatePreviewRequest):
    """Read-only single-security calculation; never publishes a task or starts a run."""
    try:
        template, expression, description = compile_template(template_id, payload.version, payload.parameters, payload.industry)
        as_of = payload.as_of.isoformat()
        profile = market.cached_profile()
        if profile.get("last_date") and as_of > profile["last_date"]:
            raise ValueError(f"行情只更新到 {profile['last_date']}。")
        if template_id == INDUSTRY_TEMPLATE_ID:
            rule = IndustryValuationRule.model_validate(expression)
            expected_date = market.latest_market_date(as_of)
            if not expected_date:
                raise ValueError("截止日前没有可用于试算的本地行情日期。")
            bars = market.get_bars(payload.stock_code, expected_date, rule.amount_window)
            inputs = industry_valuation.prepare([rule], expected_date, [payload.stock_code])
            decision = industry_valuation.evaluate(rule, inputs, payload.stock_code, bars,
                                                   condition_id="starter", reference_id="starter-ref")
            return {"stock_code": payload.stock_code, "requested_as_of": as_of, "actual_date": expected_date,
                    "state": decision.state, "description": description, "price_basis": market.PRICE_BASIS,
                    "details": [{"name": template["name"], "state": decision.state, "note": decision.explanation,
                                 "actual_values": decision.actual_values, "thresholds": decision.thresholds,
                                 "units": decision.units, "data_as_of": decision.data_as_of}],
                    "chart": {"placement": "overlay", "histogram": None, "reference_lines": [], "bars": [], "lines": []}}
        bars = market.get_bars(payload.stock_code, as_of, 500)
        expected_date = profile.get("last_date") if as_of == profile.get("last_date") else market.latest_market_date(as_of)
        stale = bool(bars and expected_date and bars[-1]["trade_date"] != expected_date)
        specifications = COMBINATIONS.get(template_id, [(template_id, {key: key for key in payload.parameters})])
        details, windows = [], set()
        for component_id, mapping in specifications:
            params = {key: payload.parameters[value] for key, value in mapping.items()}
            component, leaf, label = compile_template(component_id, 1, params)
            required = template_program(component, leaf, params)["required_history_bars"]
            span = bars[-required:]
            if len(span) < required:
                result = {"state": "unknown", "reason": f"需要 {required} 根日线，当前只有 {len(span)} 根。"}
            elif stale:
                result = {"state": "unknown", "reason": "该证券在所选市场交易日没有行情，不能用更早的价格代替判断。"}
            elif any(not bar.get("quality_valid", True) or type(bar.get("close")) not in (int, float) or not math.isfinite(bar["close"]) or bar["close"] <= 0 for bar in span):
                result = {"state": "unknown", "reason": "计算窗口内行情缺失或异常。"}
            else:
                result = evaluate_filter(leaf, span)
            details.append({"name": label, "required_history_bars": required, **result})
            if component_id == "above_sma":
                windows.add(int(params["window"]))
            elif component_id == "ma_cross":
                windows.update([int(params["fast"]), int(params["slow"])])
        colors = ["#0079c2", "#bc8241", "#208575"]
        chart = {"placement": "overlay", "histogram": None, "reference_lines": [], "bars": bars[-120:],
                 "lines": [{"id": f"sma-{window}", "label": f"SMA {window}", "color": colors[index % len(colors)],
                            "values": values(bars, "sma", window)[-120:]} for index, window in enumerate(sorted(windows))]}

        def safe(value):
            if isinstance(value, dict):
                return {key: safe(item) for key, item in value.items()}
            if isinstance(value, list):
                return [safe(item) for item in value]
            return None if isinstance(value, float) and not math.isfinite(value) else value

        return safe({"stock_code": payload.stock_code, "requested_as_of": as_of,
                     "actual_date": bars[-1]["trade_date"] if bars else None,
                     "state": combine("all", [item["state"] for item in details]), "details": details,
                     "description": description, "chart": chart, "price_basis": market.PRICE_BASIS})
    except ValueError as exc:
        raise HTTPException(422, {"code": "invalid_template_preview", "message": str(exc)}) from exc


@router.post("/conversations/{conversation_id}/screening-templates/{template_id}", status_code=201)
def apply_template(conversation_id: str, template_id: str, payload: ApplyTemplateRequest):
    try:
        template, expression, description = compile_template(template_id, payload.version, payload.parameters, payload.industry)
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
        content = f"使用基础方案“{template['name']}”：{description}。生成方案后自动开始筛选。"
        task = _template_task(conversation_id, payload.base_revision, template, expression, description, payload.parameters,
                              [content], {"as_of": payload.as_of, "universe": payload.universe, "price_basis": market.PRICE_BASIS})
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
                f"已生成基础方案“{template['name']}”：{description}。正在自动筛选。",
                {"intent": "template", "template_id": template_id, "template_version": payload.version,
                 "task_revision": task.revision, "execution_authorized": True, "ready_to_execute": True,
                 "execution_authorization_message_id": source_message_id},
                pending_execute_message_id=source_message_id, _connection=connection)
        return {**result, "turn_id": turn["id"], "source_message_id": source_message_id}
    except conversation_store.ConversationNotFound as exc:
        raise HTTPException(404, {"code": "conversation_not_found", "message": "找不到对话或消息。"}) from exc
    except (conversation_store.ConversationConflict, conversation_store.ConversationStoreError) as exc:
        raise HTTPException(409, {"code": "conversation_conflict", "message": str(exc)}) from exc
    except ValueError as exc:
        raise HTTPException(422, {"code": "invalid_template", "message": str(exc)}) from exc
