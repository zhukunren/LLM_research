import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from apps.api.app.screening_contracts import (
    ConditionDecision,
    ConditionDefinition,
    ConditionReference,
    ExecutionRequest,
    IntentProposal,
    RankingSpec,
    RunCoverage,
    ScreeningRunResult,
    ScreeningTaskRevision,
    StockDecision,
    TaskScope,
    UniverseScope,
    UnresolvedRequirement,
    combine_logic_tree,
    validate_executable_task,
    validate_intent_source,
    validate_run_for_task,
    validate_stock_decision,
)


FIXTURE = Path(__file__).parents[1] / "fixtures" / "conversation_cases.json"


def valid_task(**changes):
    values = {
        "task_id": "task-1",
        "revision": 1,
        "original_user_messages": ["收盘价高于20日均线"],
        "conditions": [
            ConditionDefinition(
                condition_id="ma",
                library="technical",
                source_quote="收盘价高于20日均线",
                expression={"op": "indicator_compare", "window": 20},
                description="收盘价高于20日均线",
            )
        ],
        "references": [ConditionReference(reference_id="r1", condition_id="ma")],
        "logic_tree": {"op": "condition", "reference_id": "r1"},
        "scope": TaskScope(
            universe=UniverseScope(kind="explicit", stock_codes=["600000.SH"]),
            as_of="2026-09-14",
        ),
    }
    values.update(changes)
    return ScreeningTaskRevision(**values)


def test_fixture_contains_all_thirty_acceptance_cases_and_required_fields():
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert [item["id"] for item in cases] == [f"C{i:02}" for i in range(1, 31)]
    assert all({"messages", "initial_context", "expected", "must_preserve"} <= item.keys() for item in cases)


def test_task_revision_keeps_source_condition_and_reference_identity():
    task = valid_task()
    assert task.revision == 1
    assert task.references[0].reference_id == "r1"
    assert task.conditions[0].source_quote == "收盘价高于20日均线"


def test_source_quotes_must_exist_in_original_user_messages():
    with pytest.raises(ValidationError, match="用户原始消息"):
        valid_task(original_user_messages=[])
    with pytest.raises(ValidationError, match="来源片段"):
        valid_task(
            original_user_messages=["收盘价低于20日均线"],
            conditions=[
                ConditionDefinition(
                    condition_id="ma",
                    library="technical",
                    source_quote="收盘价高于20日均线",
                    expression={"op": "indicator_compare", "window": 20},
                    description="收盘价高于20日均线",
                )
            ],
        )


def test_reference_parameter_change_can_keep_its_own_source_quote():
    changed = valid_task(
        original_user_messages=["收盘价高于20日均线；把第二个条件周期改成10日"],
        references=[
            ConditionReference(
                reference_id="r1",
                condition_id="ma",
                source_quote="把第二个条件周期改成10日",
            )
        ],
        logic_tree={"op": "condition", "reference_id": "r1"},
    )
    assert changed.references[0].source_quote == "把第二个条件周期改成10日"

    with pytest.raises(ValidationError, match="来源片段"):
        valid_task(
            references=[
                ConditionReference(
                    reference_id="r1",
                    condition_id="ma",
                    source_quote="把成交量周期改成10日",
                )
            ]
        )


def test_scope_validates_real_calendar_dates():
    with pytest.raises(ValidationError):
        TaskScope(as_of="2026-02-30")
    assert TaskScope(as_of="2026-09-14").as_of.isoformat() == "2026-09-14"


def test_incomplete_conditions_and_invalid_references_are_rejected():
    with pytest.raises(ValidationError, match="每个条件定义"):
        valid_task(references=[], logic_tree=None)
    with pytest.raises(ValidationError, match="不存在的条件定义"):
        valid_task(references=[ConditionReference(reference_id="r1", condition_id="missing")])
    with pytest.raises(ValidationError, match="必须完整"):
        valid_task(logic_tree={"op": "condition", "reference_id": "other"})


def test_logic_tree_requires_explicit_operators_and_not_arity():
    with pytest.raises(ValidationError, match="组合节点只允许"):
        valid_task(logic_tree={"op": "xor", "children": []})
    with pytest.raises(ValidationError, match="子项数量"):
        valid_task(logic_tree={"op": "not", "children": [
            {"op": "condition", "reference_id": "r1"},
            {"op": "condition", "reference_id": "r1"},
        ]})


def test_scope_rejects_duplicates_and_inconsistent_universe_references():
    with pytest.raises(ValidationError, match="重复"):
        UniverseScope(kind="explicit", stock_codes=["600000.SH", "600000.SH"])
    with pytest.raises(ValidationError, match="观察池范围"):
        UniverseScope(kind="watchlist", watchlist_id="wl-1", stock_codes=["600000.SH"])
    with pytest.raises(ValidationError, match="指定证券范围"):
        UniverseScope(kind="explicit")


def test_ranking_requires_explicit_universe_order_and_one_limit():
    metric = {"metric_reference_id": "r1", "metric_name": "score"}
    with pytest.raises(ValidationError, match="只能指定"):
        RankingSpec(**metric, ranking_universe="all_a_shares", direction="descending", ties_policy="stable_code", missing_policy="unknown")
    with pytest.raises(ValidationError, match="过滤后排名"):
        RankingSpec(**metric, ranking_universe="after_filters", direction="descending", top_n=10, ties_policy="stable_code", missing_policy="unknown")
    with pytest.raises(ValidationError, match="取整方式"):
        RankingSpec(**metric, ranking_universe="all_a_shares", direction="descending", top_fraction=0.1, ties_policy="stable_code", missing_policy="unknown")
    RankingSpec(**metric, ranking_universe="all_a_shares", direction="descending", top_fraction=0.1, top_fraction_rounding="ceil", ties_policy="stable_code", missing_policy="unknown")


def test_execution_records_are_server_owned_and_message_requests_are_bound():
    with pytest.raises(ValidationError, match="绑定用户原始消息"):
        ExecutionRequest(request_id="exec-1", task_id="task-1", revision=1, action="explicit_user_message", idempotency_key="key")
    request = ExecutionRequest(request_id="exec-1", task_id="task-1", revision=1, action="button", idempotency_key="key")
    assert "authorized" not in ExecutionRequest.model_fields
    assert request.action == "button"
    with pytest.raises(ValidationError):
        ExecutionRequest(request_id="exec-1", task_id="task-1", revision=1, action="button", idempotency_key="key", authorized=True)


def test_intent_proposal_must_reference_the_current_user_message():
    with pytest.raises(ValidationError):
        IntentProposal(intent="edit")
    proposal = IntentProposal(intent="edit", message_id="msg-1")
    validate_intent_source(proposal, {"msg-1"})
    with pytest.raises(ValueError, match="当前回合"):
        validate_intent_source(proposal, {"msg-other"})


def test_historical_explanation_must_bind_a_run_and_missing_data_stays_unknown():
    with pytest.raises(ValidationError, match="绑定指定运行"):
        IntentProposal(intent="explain_run", message_id="msg-1")
    unresolved = UnresolvedRequirement(kind="missing_data", source_quote="市值", question="缺少市值数据")
    task = valid_task(
        original_user_messages=["收盘价高于20日均线，市值小于100亿"],
        unresolved=[unresolved],
    )
    with pytest.raises(ValueError, match="待澄清"):
        validate_executable_task(task)
    decision = ConditionDecision(
        stock_code="600000.SH", condition_id="ma", reference_id="r1", state="unknown",
        evaluation_status="completed", reason_code="data_missing", explanation="行情历史不足",
    )
    assert decision.state == "unknown"
    with pytest.raises(ValidationError, match="必须保留为 unknown"):
        ConditionDecision(
            stock_code="600000.SH", condition_id="ma", reference_id="r1", state="false",
            evaluation_status="failed", reason_code="execution_failed", explanation="执行失败",
        )


def condition_decision(reference_id: str, state: str, *, condition_id: str = "ma") -> ConditionDecision:
    return ConditionDecision(
        stock_code="600000.SH",
        condition_id=condition_id,
        reference_id=reference_id,
        state=state,
        evaluation_status="completed",
        reason_code="condition_met" if state == "true" else "condition_not_met" if state == "false" else "data_missing",
        explanation="合成夹具判断",
    )


def test_saved_logic_tree_owns_three_valued_combination():
    tree = {
        "op": "all",
        "children": [
            {"op": "condition", "reference_id": "r1"},
            {"op": "any", "children": [
                {"op": "condition", "reference_id": "r2"},
                {"op": "not", "children": [{"op": "condition", "reference_id": "r3"}]},
            ]},
        ],
    }
    assert combine_logic_tree(tree, {"r1": "true", "r2": "false", "r3": "false"}) == "true"
    assert combine_logic_tree(tree, {"r1": "unknown", "r2": "false", "r3": "false"}) == "unknown"
    with pytest.raises(ValueError, match="完全一致"):
        combine_logic_tree(tree, {"r1": "true", "r2": "false"})


def test_stock_result_must_include_each_reference_and_match_framework_logic():
    task = valid_task()
    decision = StockDecision(
        stock_code="600000.SH",
        state="true",
        evaluation_status="completed",
        reason_code="condition_met",
        condition_decisions=[condition_decision("r1", "true")],
    )
    validate_stock_decision(task, decision)

    with pytest.raises(ValidationError):
        StockDecision(stock_code="600000.SH", state="true", evaluation_status="completed", reason_code="condition_met")
    with pytest.raises(ValueError, match="总状态必须"):
        validate_stock_decision(task, decision.model_copy(update={"state": "false"}))


def test_coverage_and_persisted_stock_decisions_must_match():
    with pytest.raises(ValidationError, match="完整拆分"):
        RunCoverage(target_total=2, true_count=1, false_count=0, unknown_count=0)
    with pytest.raises(ValidationError, match="不能超过 unknown"):
        RunCoverage(target_total=1, true_count=0, false_count=1, unknown_count=0, failed_count=1)
    with pytest.raises(ValidationError, match="覆盖计数不一致"):
        ScreeningRunResult(
            run_id="run-1", task_id="task-1", revision=1, status="succeeded",
            execution_version="v1", execution_request_id="request-1",
            coverage=RunCoverage(target_total=1, true_count=1, false_count=0, unknown_count=0),
            stock_decisions=[
                StockDecision(
                    stock_code="600000.SH",
                    state="false",
                    evaluation_status="completed",
                    reason_code="condition_not_met",
                    condition_decisions=[condition_decision("r1", "false")],
                )
            ],
        )


def test_nonempty_universe_cannot_return_only_aggregate_counts():
    with pytest.raises(ValidationError, match="逐股包含目标证券"):
        ScreeningRunResult(
            run_id="run-1", task_id="task-1", revision=1, status="partial",
            execution_version="v1", execution_request_id="request-1",
            coverage=RunCoverage(target_total=1, true_count=0, false_count=0, unknown_count=1),
            stock_decisions=[],
        )


def test_succeeded_run_cannot_hide_unknown_results():
    with pytest.raises(ValidationError, match="必须标记为 partial"):
        ScreeningRunResult(
            run_id="run-1", task_id="task-1", revision=1, status="succeeded",
            execution_version="v1", execution_request_id="request-1",
            coverage=RunCoverage(target_total=1, true_count=0, false_count=0, unknown_count=1),
            stock_decisions=[
                StockDecision(
                    stock_code="600000.SH",
                    state="unknown",
                    evaluation_status="completed",
                    reason_code="data_missing",
                    condition_decisions=[condition_decision("r1", "unknown")],
                )
            ],
        )


def test_execution_failure_and_not_evaluated_are_separate_subcounts():
    coverage = RunCoverage(target_total=2, true_count=0, false_count=0, unknown_count=2, failed_count=1, not_evaluated_count=1)
    assert coverage.unknown_count == 2
