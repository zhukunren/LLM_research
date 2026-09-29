from __future__ import annotations

from apps.api.app import market, program_conditions, screening_execution, screening_contracts
import pytest


def _task():
    prompt = "收盘价高于自定义趋势线"
    program = screening_contracts.CustomProgram(
        contract_version="python-screen-v1",
        source_code="def screen(context, frames, params):\n    return {}\n",
        required_fields=["close"],
        required_history_bars=3,
        parameters={"window": 3},
        parameter_specs={"window": {"label": "观察周期", "type": "integer", "minimum": 2, "maximum": 20}},
    )
    return screening_contracts.ScreeningTaskRevision(
        task_id="conversation-1",
        revision=1,
        original_user_messages=[prompt],
        conditions=[
            screening_contracts.ConditionDefinition(
                condition_id="custom-trend",
                library="technical",
                source_quote=prompt,
                description="收盘价高于自定义趋势线",
                program=program,
                implementation_id="llm-python-screen",
                implementation_version="python-screen-v1",
            )
        ],
        references=[
            screening_contracts.ConditionReference(
                reference_id="trend-1",
                condition_id="custom-trend",
                parameter_overrides={"window": 5},
            )
        ],
        logic_tree={"op": "condition", "reference_id": "trend-1"},
        scope=screening_contracts.TaskScope(
            universe=screening_contracts.UniverseScope(kind="explicit", stock_codes=["600000.SH", "600001.SH"]),
            as_of="2026-01-03",
        ),
    )


def test_frozen_program_batch_returns_per_security_metrics_and_keeps_missing_data_unknown(monkeypatch):
    bars = {
        "600000.SH": [
            {"trade_date": f"2026-01-0{day}", "close": float(day), "quality_valid": True}
            for day in range(1, 4)
        ],
        "600001.SH": [
            {"trade_date": f"2026-01-0{day}", "close": float(day), "quality_valid": True}
            for day in range(1, 3)
        ],
    }
    monkeypatch.setattr(market, "iter_recent_bars", lambda *_args, **_kwargs: iter(bars.items()))
    observed = {}

    def execute_program(*, source_code, context, frames, params, is_active):
        observed.update({"source": source_code, "context": context, "frames": frames, "params": params})
        return {
            "decisions": {"600000.SH": True, "600001.SH": False},
            "metrics": {"600000.SH": {"custom_value": 4.25}, "600001.SH": {"custom_value": 2.0}},
            "units": {"custom_value": "%"},
        }

    monkeypatch.setattr("apps.api.app.runtime_executor.execute_program", execute_program)
    task = _task()
    snapshot = {
        "task": task.model_dump(mode="json"),
        "execution_request": {"request_id": "request-1"},
        "universe": {"codes": ["600000.SH", "600001.SH"]},
        "as_of": "2026-01-03",
        "effective_market_date": "2026-01-03",
        "source_manifests": ["daily-bars:test"],
        "tool_call_ids": [],
        "model_metadata": {},
    }

    result = screening_execution.execute_snapshot(
        snapshot,
        run_id="run-1",
        active=lambda: True,
        progress=lambda *_args: None,
    )

    assert observed["params"] == {"window": 5}
    assert observed["context"]["stock_codes"] == ["600000.SH", "600001.SH"]
    assert [item["trade_date"] for item in observed["frames"]["600000.SH"]] == [
        "2026-01-01", "2026-01-02", "2026-01-03"
    ]
    assert [(item.stock_code, item.state) for item in result.stock_decisions] == [
        ("600000.SH", "true"), ("600001.SH", "unknown")
    ]
    condition_result = result.stock_decisions[0].condition_decisions[0]
    assert condition_result.actual_values == {"custom_value": 4.25}
    assert condition_result.thresholds == {"window": 5}
    assert condition_result.units == {"custom_value": "%"}
    assert result.coverage.unknown_count == 1
    assert result.source_manifests[0] == "daily-bars:test"
    assert result.source_manifests == ["daily-bars:test"]


def test_worker_executes_real_local_program_and_applies_reference_parameters(monkeypatch):
    task = _task().model_dump(mode="json")
    prompt = "近3日回归斜率大于0.5"
    task["original_user_messages"] = [prompt]
    condition = task["conditions"][0]
    condition.update(source_quote=prompt, description=prompt)
    condition["program"].update(
        source_code='''
def screen(context, frames, params):
    decisions, metrics = {}, {}
    for code in context["stock_codes"]:
        close = frames[code]["close"]
        if len(close) < 3 or not np.all(np.isfinite(close)):
            decisions[code] = None
            continue
        slope = float(np.polyfit(np.arange(len(close)), close, 1)[0])
        decisions[code] = slope > params["min_slope"]
        metrics[code] = {"slope": slope}
    return {"decisions": decisions, "metrics": metrics, "units": {"slope": "价格/交易日"}}
''',
        parameters={"min_slope": 0.5},
        parameter_specs={"min_slope": {"label": "斜率下限", "type": "number", "minimum": 0, "maximum": 10}},
    )
    task["references"][0]["parameter_overrides"] = {"min_slope": 1.5}
    bars = {code: [dict(trade_date=f"2026-01-0{i + 1}", close=value, quality_valid=True)
                   for i, value in enumerate(values)]
            for code, values in [("600000.SH", [1, 2, 3]), ("600001.SH", [1, 3, 5])]}
    monkeypatch.setattr(market, "iter_recent_bars", lambda *a: iter(bars.items()))
    result = screening_execution.execute_snapshot(dict(
        task=task, execution_request={"request_id": "real-local"}, universe={"codes": list(bars)},
        as_of="2026-01-03", effective_market_date="2026-01-03",
        source_manifests=[], tool_call_ids=[], model_metadata={},
    ), run_id="real-local", active=lambda: True, progress=lambda *a: None)
    assert [item.state for item in result.stock_decisions] == ["false", "true"]
    assert result.stock_decisions[0].condition_decisions[0].actual_values["slope"] == pytest.approx(1)
    assert result.stock_decisions[1].condition_decisions[0].actual_values["slope"] == pytest.approx(2)
    assert result.stock_decisions[1].condition_decisions[0].thresholds == {"min_slope": 1.5}
