"""Codex -> numeric chart -> explicit save -> frozen screening condition."""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from apps.api.app import (
    codex_context, codex_runtime, conversation_store, db, dynamic_indicators,
    main, market, program_conditions, screening_tools,
)
from apps.api.app.screening_contracts import ResearchScope
from apps.api.app.tool_protocol import ToolCall


def definition():
    return {
        "name": "自定义波幅价差", "description": "价差乘可调系数", "formula": "(high-low)*scale",
        "original_prompt": "画出每日最高最低价差的两倍，供我看图后决定是否保存。",
        "program": {
            "contract_version": "python-indicator-v1", "required_fields": ["high", "low"],
            "required_history_bars": 1, "parameters": {"scale": 2},
            "parameter_specs": {"scale": {"label": "系数", "type": "number", "minimum": 0, "maximum": 10}},
            "source_code": """def compute(context, frames, params):
    dates, series = {}, {}
    for code in context['stock_codes']:
        f = frames[code]
        dates[code] = list(f['trade_date'])
        series[code] = {'spread': [float((h-l)*params['scale']) if valid else None
                                  for h,l,valid in zip(f['high'],f['low'],f['valid'])]}
    return {'dates': dates, 'series': series}
""",
        },
        "outputs": [{"name": "spread", "label": "价差", "unit": "元", "placement": "pane", "kind": "line"}],
    }


@pytest.fixture
def indicator_context(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "indicators.db")
    bars = [{"trade_date": (date(2026, 1, 1) + timedelta(days=i)).isoformat(),
             "open": 10., "high": 12. + i, "low": 10., "close": 11. + i,
             "volume": 100., "amount": 1000., "quality_valid": True} for i in range(40)]
    cutoff = bars[-1]["trade_date"]
    monkeypatch.setattr(market, "cached_profile", lambda: {
        "available": True, "last_date": cutoff, "sha256": "a" * 64,
        "price_basis": "unadjusted", "volume_unit": "shares", "amount_unit": "CNY", "quality_status": "valid",
    })
    monkeypatch.setattr(market, "get_bars", lambda code, as_of, limit: [bar for bar in bars if bar["trade_date"] <= as_of][-limit:])
    monkeypatch.setattr(market, "latest_market_date", lambda as_of: as_of)
    monkeypatch.setattr(market, "source_fingerprint", lambda: ("fixture", 40, 1))
    db.init_db()

    def begin(workflow="research", scoped=True):
        cid = conversation_store.create_conversation("screening", workflow_type=workflow)["id"]
        if scoped and workflow == "research":
            conversation_store.update_research_scope(cid, 0, ResearchScope(as_of=cutoff, stock_codes=["600000.SH"]))
        message = conversation_store.add_user_message(cid, "numeric", 0, f"截至{cutoff}生成每日价差的两倍，先试算看图，不执行选股。",
                                                      research_scope_revision=int(scoped and workflow == "research"))
        conversation_store.start_turn(cid, message["turn_id"])
        return codex_context.task_tool_context(cid, message["turn_id"], 0, None, [])

    return begin, bars, cutoff


def call(context, name, arguments, call_id=None):
    return screening_tools.registry.dispatch(ToolCall(call_id or name, name, arguments), context)


def test_numeric_tool_trial_full_chart_save_and_boolean_adapter_round_trip(indicator_context, monkeypatch):
    begin, bars, cutoff = indicator_context
    research = begin()
    args = {"definition": definition(), "stock_code": "600000.SH", "as_of": cutoff, "limit": 40}
    result = call(research, "preview_dynamic_indicator", args)
    assert result["ok"], result
    assert result["result"]["point_count"] == 40
    assert result["result"]["saved_to_library"] is False
    trial_id = result["result"]["trial_id"]
    assert call(research, "preview_dynamic_indicator", args) == result  # Tool-call replay does not execute again.
    assert len(dynamic_indicators.list_trials(research.conversation_id)) == 1
    trial = call(research, "read_indicator_trial", {"trial_id": trial_id})["result"]
    assert len(trial["series"]["spread"]) == 40 > 20
    assert trial["series"]["spread"][-1] == 82.
    assert trial["source_context"]["input_bars"] == len(trial["dates"]) == 40
    assert trial["chart"]["lines"][0]["values"] == trial["series"]["spread"]
    assert trial["validation"]["causality_proven"] is False
    assert call(research, "list_dynamic_indicators", {})["result"] == {"items": []}

    # The browser's deliberate Save action creates the asset; generation did not.
    with TestClient(main.app) as client:
        body = {"trial_id": trial_id, "request_id": "explicit-save", "confirmed": True}
        saved_reply = client.post("/api/v1/dynamic-indicators/save", json=body)
        assert saved_reply.status_code == 201, saved_reply.text
        saved = saved_reply.json()
        assert client.post("/api/v1/dynamic-indicators/save", json=body).json() == saved
    assert saved["version"] == 1
    assert saved["source_context"]["input_bars"] == 40
    assert saved["definition"]["program"]["source_code"] == trial["definition"]["program"]["source_code"]
    compare_args = {"indicator_id": saved["id"], "version": 1, "output": "spread", "operator": "gt", "threshold": 80}
    denied = call(research, "build_indicator_condition", compare_args)
    assert denied["error"]["code"] == "screening_workflow_required"

    screening = begin("screening", False)
    converted = call(screening, "build_indicator_condition", compare_args)
    assert converted["ok"], converted
    condition = converted["result"]["condition"]
    assert converted["result"]["execution_authorized"] is False
    reference = {"reference_id": "spread", "condition_id": condition["condition_id"], "parameter_overrides": {}}
    task = {
        "task_id": screening.conversation_id, "revision": 1,
        "original_user_messages": ["用指标生成条件草稿，不执行"], "conditions": [condition], "references": [reference],
        "logic_tree": {"op": "condition", "reference_id": "spread"},
        "scope": {"as_of": cutoff, "universe": {"kind": "explicit", "stock_codes": ["600000.SH"]}},
        "unresolved": [],
    }
    proposed = call(screening, "propose_screening_task", {"task": task})
    assert proposed["ok"], proposed
    frozen = conversation_store.get_task_revision(screening.conversation_id, 1)
    output = program_conditions.evaluate_batch(
        frozen.conditions[0].model_dump(mode="json"), frozen.references[0].model_dump(mode="json"),
        ["600000.SH"], {"600000.SH": bars}, as_of=cutoff, effective_market_date=cutoff,
    )["600000.SH"]
    assert output["state"] == "true"

    # The UI's saved-indicator handoff asks to preserve the existing plan's
    # historical scope. Avoid the legacy date parser's broad "当前" trigger.
    conversation_store.finish_turn(screening.conversation_id, screening.turn_id, 1, "succeeded", "条件草稿已准备。", {})
    handoff = (
        f'请将我已保存的指标 "近5日涨幅" 的固定版本加入选股草稿：\nindicator_id={saved["id"]}\nversion=1\n'
        "output=spread\noperator=gt\nthreshold=80\n"
        "数值输出“当前波动”大于阈值 80 才构成布尔条件。"
        "请调用 build_indicator_condition，使用此版本冻结的公式和参数。"
        "沿用已有选股方案的股票范围与截止日期；如未设定则请明确说明并让我确认。"
        "保留草稿，等待我确认后再执行选股，不要自动运行。"
    )
    next_turn = conversation_store.add_user_message(screening.conversation_id, "saved-handoff", 1, handoff)
    conversation_store.start_turn(screening.conversation_id, next_turn["turn_id"])
    reused_context = codex_context.task_tool_context(screening.conversation_id, next_turn["turn_id"], 1, frozen, [])
    proposed_again = call(reused_context, "propose_screening_task", {"task": frozen.model_dump(mode="json")}, "preserve-cutoff")
    assert proposed_again["ok"], proposed_again
    reused = conversation_store.get_task_revision(screening.conversation_id, 2)
    assert reused.scope.as_of.isoformat() == cutoff
    assert reused.scope.universe == frozen.scope.universe

    # User additions remain actionable even though quoted indicator metadata
    # is excluded from cutoff interpretation.
    for index, (addition, requested, expected) in enumerate([
        ("截止日期改为2026-01-20。", "2026-01-20", "2026-01-20"),
        ("改为最新交易日。", "2026-01-20", cutoff),
    ]):
        if index == 1:
            monkeypatch.setattr(market, "latest_market_date", lambda _: cutoff)
        current = conversation_store.get_task_revision(screening.conversation_id, 2 + index)
        previous_turn = next_turn["turn_id"] if index == 0 else changed_turn["turn_id"]
        conversation_store.finish_turn(screening.conversation_id, previous_turn, current.revision, "succeeded", "已保留日期。", {})
        changed_turn = conversation_store.add_user_message(screening.conversation_id, f"changed-date-{index}", current.revision, handoff + "\n" + addition)
        conversation_store.start_turn(screening.conversation_id, changed_turn["turn_id"])
        changed_context = codex_context.task_tool_context(screening.conversation_id, changed_turn["turn_id"], current.revision, current, [])
        candidate = current.model_dump(mode="json")
        candidate["scope"]["as_of"] = requested
        result = call(changed_context, "propose_screening_task", {"task": candidate}, f"change-date-{index}")
        assert result["ok"], result
        assert conversation_store.get_task_revision(screening.conversation_id, current.revision + 1).scope.as_of.isoformat() == expected
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM screening_task_runs").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM execution_requests").fetchone()[0] == 0


def test_indicator_tools_enforce_cutoff_security_trial_and_conversation_scope(indicator_context):
    begin, _, cutoff = indicator_context
    context = begin()
    args = {"definition": definition(), "stock_code": "600000.SH", "as_of": cutoff, "limit": 40}
    wrong_date = call(context, "preview_dynamic_indicator", {**args, "as_of": "2026-01-05"}, "date")
    assert wrong_date["error"]["code"] == "indicator_cutoff_conflict"
    wrong_security = call(context, "preview_dynamic_indicator", {**args, "stock_code": "600001.SH"}, "security")
    assert wrong_security["error"]["code"] == "security_outside_indicator_scope"
    forged = call(context, "preview_dynamic_indicator", {**args, "conversation_id": "someone-else"}, "forged")
    assert forged["error"]["code"] == "invalid_tool_arguments"
    trial = call(context, "preview_dynamic_indicator", args, "valid")["result"]
    other = begin()
    cross_read = call(other, "read_indicator_trial", {"trial_id": trial["trial_id"]})
    assert cross_read["error"]["code"] == "indicator_trial_scope"


def test_codex_instructions_keep_numeric_generation_independent_of_fixed_catalog():
    prompt = codex_runtime.CODEX_DEVELOPER_INSTRUCTIONS
    assert "python-indicator-v1" in prompt and "preview_dynamic_indicator" in prompt
    assert "不把底层内置公式当作生成边界" in prompt
    assert "不证明公式正确" in prompt and "build_indicator_condition" in prompt
    assert "save_dynamic_indicator" not in screening_tools.registry.registered_tool_names()


def test_same_conversation_trial_read_cannot_bypass_frozen_current_scope(indicator_context):
    begin, _, cutoff = indicator_context
    context = begin()
    # Browser trials are explicit user-selected inspections, but cannot become
    # historical Codex evidence merely by carrying the same conversation ID.
    outside = dynamic_indicators.preview_indicator({
        "definition": definition(), "stock_code": "600001.SH", "as_of": cutoff,
    }, conversation_id=context.conversation_id)
    rejected = call(context, "read_indicator_trial", {"trial_id": outside["trial_id"]}, "outside-read")
    assert rejected["error"]["code"] == "security_outside_indicator_scope"

    future = dynamic_indicators.preview_indicator({
        "definition": definition(), "stock_code": "600000.SH", "as_of": cutoff,
    }, conversation_id=context.conversation_id)
    conversation_store.finish_turn(context.conversation_id, context.turn_id, 0, "succeeded", "图表已生成。", {})
    conversation_store.update_research_scope(context.conversation_id, 1, ResearchScope(as_of="2026-01-20", stock_codes=["600000.SH"]))
    message = conversation_store.add_user_message(context.conversation_id, "historical", 0, "只研究截至2026-01-20的已知数据。", research_scope_revision=2)
    conversation_store.start_turn(context.conversation_id, message["turn_id"])
    historical = codex_context.task_tool_context(context.conversation_id, message["turn_id"], 0, None, [])
    rejected = call(historical, "read_indicator_trial", {"trial_id": future["trial_id"]}, "future-read")
    assert rejected["error"]["code"] == "indicator_cutoff_conflict"
