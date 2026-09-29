from __future__ import annotations

import copy

import pytest
from pydantic import ValidationError

from apps.api.app import market, program_conditions, screening_execution
from apps.api.app.screening_contracts import ScreeningTaskRevision, validate_executable_task


CODES = ["600000.SH", "600001.SH", "600002.SH"]


def task_payload(after_filters=False):
    quote = "按自定义强度排名并且放量"
    def technical(name):
        return dict(
            condition_id=name, library="technical", source_quote=quote, description=name,
            implementation_id="llm-python-screen", implementation_version="python-screen-v1",
            program=dict(contract_version="python-screen-v1", source_code="def screen(context, frames, params):\n    return {}",
                         required_fields=["close"], required_history_bars=1, parameters={}, parameter_specs={}),
        )
    return dict(
        task_id="ranking-task", revision=1, original_user_messages=[quote],
        conditions=[technical("strength"), technical("volume"), dict(
            condition_id="rank", library="ranking", source_quote=quote, description="强度前一名",
            implementation_id="ranking-v1", implementation_version="ranking-v1",
        )],
        # Deliberately put ranking first: execution order must not affect its population.
        references=[dict(reference_id="r-rank", condition_id="rank"),
                    dict(reference_id="r-volume", condition_id="volume"),
                    dict(reference_id="r-strength", condition_id="strength")],
        logic_tree={"op": "all", "children": [
            {"op": "condition", "reference_id": name} for name in ("r-rank", "r-volume", "r-strength")
        ]},
        scope=dict(universe={"kind": "all_a_shares"}, as_of="2026-09-14", ranking=dict(
            ranking_universe="after_filters" if after_filters else "all_a_shares",
            metric_reference_id="r-strength", metric_name="strength", direction="descending",
            top_n=1, ties_policy="stable_code", missing_policy="unknown", rank_after_filters=after_filters,
            population_logic_tree={"op": "condition", "reference_id": "r-volume"} if after_filters else None,
        )),
    )


def execute(payload, monkeypatch):
    monkeypatch.setattr(market, "iter_recent_bars", lambda *args: iter(()))
    def evaluate(condition, reference, codes, bars, **kwargs):
        return {code: dict(
            state="false" if condition["condition_id"] == "volume" and index == 0 else "true",
            evaluation_status="completed", reason_code="condition_met",
            metrics={"strength": 100 - index * 10} if condition["condition_id"] == "strength" else {},
            units={"strength": "%"} if condition["condition_id"] == "strength" else {},
            data_as_of="2026-09-14",
        ) for index, code in enumerate(codes)}
    monkeypatch.setattr(program_conditions, "evaluate_batch", evaluate)
    return screening_execution.execute_snapshot(dict(
        task=payload, universe={"codes": CODES}, as_of="2026-09-14", effective_market_date="2026-09-14",
        execution_request={"request_id": "request"}, source_manifests=[], tool_call_ids=[], model_metadata={},
    ), run_id="run", active=lambda: True, progress=lambda *args: None)


def test_full_market_then_filter_does_not_equal_filter_then_rank(monkeypatch):
    full = execute(task_payload(False), monkeypatch)
    filtered = execute(task_payload(True), monkeypatch)
    assert full.coverage.true_count == 0
    assert [item.stock_code for item in filtered.stock_decisions if item.state == "true"] == ["600001.SH"]
    rank = next(item for item in filtered.stock_decisions[1].condition_decisions if item.reference_id == "r-rank")
    assert rank.actual_values["population_size"] == 2
    assert rank.actual_values["score"] == 90


def test_ranking_combines_with_or_and_not_using_three_valued_logic(monkeypatch):
    payload = task_payload(False)
    payload["logic_tree"] = {"op": "all", "children": [
        {"op": "condition", "reference_id": "r-strength"},
        {"op": "any", "children": [
            {"op": "condition", "reference_id": "r-volume"},
            {"op": "not", "children": [{"op": "condition", "reference_id": "r-rank"}]},
        ]},
    ]}
    result = execute(payload, monkeypatch)
    assert [item.state for item in result.stock_decisions] == ["false", "true", "true"]


def test_ranking_population_cannot_depend_on_itself_or_an_unknown_reference():
    for ref in ("r-rank", "missing"):
        payload = task_payload(True)
        payload["scope"]["ranking"]["population_logic_tree"]["reference_id"] = ref
        with pytest.raises(ValidationError, match="不能循环依赖"):
            ScreeningTaskRevision.model_validate(payload)


def test_industry_and_wrong_universe_are_rejected_without_executing_programs():
    payload = task_payload()
    payload["scope"]["ranking"]["ranking_universe"] = "industry"
    with pytest.raises(ValueError, match="行业"):
        validate_executable_task(ScreeningTaskRevision.model_validate(payload))
    payload = task_payload()
    payload["scope"]["universe"] = {"kind": "explicit", "stock_codes": CODES}
    with pytest.raises(ValueError, match="完整的A股"):
        validate_executable_task(ScreeningTaskRevision.model_validate(payload))
