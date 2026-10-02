from __future__ import annotations

from collections.abc import Callable
from typing import Any

from . import market, program_conditions, runtime_executor, ranking, report_adapter, news_adapter, pattern_adapter
from .evidence_analysis import EvidenceAnalysisCancelled
from .screening_contracts import (
    ConditionDecision,
    CustomProgram,
    ScreeningRunResult,
    ScreeningTaskRevision,
    StockDecision,
    RunCoverage,
    combine_logic_tree,
    validate_run_for_task,
    validate_stock_decision,
    validate_executable_task,
    validate_logic_tree,
)

EXECUTION_VERSION = "screening-task-v1"


def evaluate_reference(
    condition: dict[str, Any],
    reference: dict[str, Any],
    stock_code: str,
    as_of: str,
) -> ConditionDecision:
    if condition.get("library") == "pattern":
        return pattern_adapter.evaluate(condition, reference, stock_code, as_of)
    if condition.get("library") == "news":
        return news_adapter.evaluate(condition, reference, stock_code, as_of,
            lookback_days=reference.get("_news_lookback_days"), active=reference.get("_active", lambda: True))
    if condition.get("library") == "report":
        return report_adapter.evaluate(
            condition, reference, stock_code, as_of,
            lookback_days=reference.get("_report_lookback_days"), active=reference.get("_active", lambda: True),
        )
    return ConditionDecision(
        stock_code=stock_code,
        condition_id=condition["condition_id"],
        condition_version=reference.get("condition_version"),
        reference_id=reference["reference_id"],
        state="unknown",
        evaluation_status="not_evaluated",
        reason_code="unsupported_capability",
        explanation="当前没有接入此条件类型的执行适配器。",
        data_as_of=as_of,
        implementation_id=condition.get("implementation_id"),
    )


def _program_decision(
    condition: dict[str, Any],
    reference: dict[str, Any],
    stock_code: str,
    result: dict[str, Any],
    as_of: str,
) -> ConditionDecision:
    metrics = result.get("metrics") or {}
    state = result.get("state", "unknown")
    explanation = result.get("explanation") or condition["description"]
    summary = program_conditions.metrics_summary(metrics, result.get("units"))
    if summary:
        explanation = f"{condition['description']}；本次计算值：{summary}；" + (
            "符合条件。" if state == "true" else "不符合条件。" if state == "false" else "所需数值不足，无法判断。"
        )
    elif state in {"true", "false"}:
        explanation = f"{condition['description']}；" + ("符合条件。" if state == "true" else "不符合条件。")
    return ConditionDecision(
        stock_code=stock_code,
        condition_id=condition["condition_id"],
        condition_version=reference.get("condition_version"),
        reference_id=reference["reference_id"],
        state=state,
        evaluation_status=result.get("evaluation_status", "completed"),
        reason_code=result.get("reason_code", "data_missing"),
        explanation=explanation[:4000],
        actual_values=metrics,
        thresholds=result.get("thresholds") or {},
        units=result.get("units") or {},
        data_as_of=result.get("data_as_of"),
        implementation_id=condition.get("implementation_id"),
    )


def _failed_decision(
    condition: dict[str, Any], reference: dict[str, Any], stock_code: str, as_of: str
) -> ConditionDecision:
    return ConditionDecision(
        stock_code=stock_code,
        condition_id=condition["condition_id"],
        condition_version=reference.get("condition_version"),
        reference_id=reference["reference_id"],
        state="unknown",
        evaluation_status="failed",
        reason_code="execution_failed",
        explanation="此条件的计算失败；没有将失败解释为不符合。",
        data_as_of=as_of,
        implementation_id=condition.get("implementation_id"),
    )


def _not_evaluated_decision(
    condition: dict[str, Any], reference: dict[str, Any], stock_code: str, as_of: str
) -> ConditionDecision:
    return ConditionDecision(
        stock_code=stock_code,
        condition_id=condition["condition_id"],
        condition_version=reference.get("condition_version"),
        reference_id=reference["reference_id"],
        state="unknown",
        evaluation_status="not_evaluated",
        reason_code="not_processed",
        explanation="运行已取消，此证券未处理。",
        data_as_of=as_of,
        implementation_id=condition.get("implementation_id"),
    )


def _stock_decision(
    task: ScreeningTaskRevision,
    stock_code: str,
    condition_decisions: list[ConditionDecision],
) -> StockDecision:
    state = combine_logic_tree(
        task.logic_tree,  # type: ignore[arg-type]
        {item.reference_id: item.state for item in condition_decisions},
    )
    if state != "unknown":
        status = "completed"
        reason = "condition_met" if state == "true" else "condition_not_met"
    elif any(item.evaluation_status == "failed" for item in condition_decisions):
        status, reason = "failed", "execution_failed"
    elif any(item.evaluation_status == "not_evaluated" for item in condition_decisions):
        status, reason = "not_evaluated", "not_processed"
    else:
        status, reason = "completed", "data_missing"
    decision = StockDecision(
        stock_code=stock_code,
        state=state,
        evaluation_status=status,
        reason_code=reason,
        condition_decisions=condition_decisions,
    )
    validate_stock_decision(task, decision)
    return decision


def execute_snapshot(
    snapshot: dict[str, Any],
    *,
    run_id: str,
    active: Callable[[], bool],
    progress: Callable[[float, str], None],
) -> ScreeningRunResult:
    task = ScreeningTaskRevision.model_validate(snapshot["task"])
    validate_executable_task(task)
    request = snapshot["execution_request"]
    codes = snapshot["universe"]["codes"]
    as_of = snapshot["as_of"]
    definitions = {item.condition_id: item.model_dump(mode="json") for item in task.conditions}
    references = [item.model_dump(mode="json") for item in task.references]
    decisions: list[StockDecision] = []
    cancelled = False
    programs = [
        CustomProgram.model_validate(condition["program"])
        for condition in definitions.values()
        if condition.get("program") is not None
    ]
    bars_by_stock: dict[str, list[dict[str, Any]]] = {code: [] for code in codes}
    pattern_assets = snapshot.get("pattern_assets", {})
    history_requirements = [program.required_history_bars for program in programs]
    history_requirements.extend(
        pattern_adapter.required_history_bars(
            definitions[reference["condition_id"]], reference,
            pattern_assets[reference["condition_id"]],
        )
        for reference in references
        if definitions[reference["condition_id"]].get("library") == "pattern"
    )
    if history_requirements:
        history_limit = max(history_requirements)
        for code, bars in market.iter_recent_bars(as_of, history_limit, list(codes)) or ():
            if code in bars_by_stock:
                bars_by_stock[code] = bars

    program_results: dict[str, dict[str, dict[str, Any]]] = {}
    for reference in references:
        if not active():
            cancelled = True
            break
        condition = definitions[reference["condition_id"]]
        if condition.get("program") is None:
            continue
        try:
            program_results[reference["reference_id"]] = program_conditions.evaluate_batch(
                condition,
                reference,
                list(codes),
                bars_by_stock,
                as_of=as_of,
                effective_market_date=snapshot.get("effective_market_date"),
                is_active=active,
            )
        except runtime_executor.RuntimeCancelled:
            cancelled = True
            break
        except runtime_executor.RuntimeUnavailable as exc:
            program_results[reference["reference_id"]] = {
                code: {
                    "state": "unknown",
                    "evaluation_status": "not_evaluated",
                    "reason_code": "unsupported_capability",
                    "explanation": f"本地 Python 运行时不可用：{str(exc)[:300]}",
                    "metrics": {},
                    "units": {},
                    "thresholds": {},
                    "data_as_of": None,
                }
                for code in codes
            }
        except Exception as exc:
            program_results[reference["reference_id"]] = {
                code: {
                    "state": "unknown",
                    "evaluation_status": "failed",
                    "reason_code": "execution_failed",
                    "explanation": f"自定义计算程序运行失败：{type(exc).__name__}: {str(exc)[:1500]}",
                    "metrics": {},
                    "units": {},
                    "thresholds": {},
                    "data_as_of": None,
                }
                for code in codes
            }
            if not active():
                cancelled = True
                break

    for index, stock_code in enumerate(codes):
        should_process = active()
        cancelled = cancelled or not should_process
        condition_decisions = []
        for reference in references:
            condition = definitions[reference["condition_id"]]
            if cancelled:
                decision = _not_evaluated_decision(condition, reference, stock_code, as_of)
            elif condition.get("program") is not None:
                result = program_results.get(reference["reference_id"], {}).get(stock_code)
                if result is None:
                    decision = _not_evaluated_decision(condition, reference, stock_code, as_of)
                else:
                    try:
                        decision = _program_decision(condition, reference, stock_code, result, as_of)
                    except Exception:
                        decision = _failed_decision(condition, reference, stock_code, as_of)
            else:
                try:
                    runtime_reference = {**reference, "_report_lookback_days": task.scope.report_lookback_calendar_days,
                                         "_news_lookback_days": task.scope.news_lookback_calendar_days,
                                         "_active": active} if condition["library"] in {"report", "news"} else reference
                    if condition["library"] == "pattern":
                        runtime_reference = {**reference, "_pattern_template": pattern_assets.get(condition["condition_id"]),
                                             "_bars": bars_by_stock[stock_code], "_effective_market_date": snapshot.get("effective_market_date")}
                    decision = evaluate_reference(condition, runtime_reference, stock_code, as_of)
                    if not isinstance(decision, ConditionDecision):
                        decision = ConditionDecision.model_validate(decision)
                    if decision.stock_code != stock_code or decision.reference_id != reference["reference_id"]:
                        raise ValueError("条件结果与当前证券或引用不匹配")
                except EvidenceAnalysisCancelled:
                    cancelled = True
                    decision = _not_evaluated_decision(condition, reference, stock_code, as_of)
                except Exception:
                    decision = _failed_decision(condition, reference, stock_code, as_of)
            condition_decisions.append(decision)
        decisions.append(_stock_decision(task, stock_code, condition_decisions))
        if index % 100 == 0:
            progress((index + 1) / max(1, len(codes)), f"已处理 {index + 1}/{len(codes)} 只证券")

    if task.scope.ranking is not None:
        spec = task.scope.ranking
        rank_condition = next(item for item in task.conditions if item.library == "ranking")
        rank_reference = next(item for item in task.references if item.condition_id == rank_condition.condition_id)
        by_stock = {
            item.stock_code: {value.reference_id: value for value in item.condition_decisions}
            for item in decisions
        }
        if not active():
            cancelled = True
        if cancelled:
            rank_results = {
                code: _not_evaluated_decision(
                    rank_condition.model_dump(mode="json"), rank_reference.model_dump(mode="json"), code, as_of
                ) for code in codes
            }
        else:
            population_refs = validate_logic_tree(spec.population_logic_tree)
            population = {
                code: combine_logic_tree(
                    spec.population_logic_tree,
                    {ref: by_stock[code][ref].state for ref in population_refs},
                ) if spec.population_logic_tree is not None else "true"
                for code in codes
            }
            rank_results = ranking.evaluate_ranking(
                spec, rank_condition, rank_reference, list(codes),
                {code: by_stock[code][spec.metric_reference_id] for code in codes}, population,
            )
        decisions = [
            _stock_decision(task, item.stock_code, [
                rank_results[item.stock_code] if value.reference_id == rank_reference.reference_id else value
                for value in item.condition_decisions
            ]) for item in decisions
        ]

    counts = {state: sum(item.state == state for item in decisions) for state in ("true", "false", "unknown")}
    failed_count = sum(item.evaluation_status == "failed" for item in decisions)
    not_evaluated_count = sum(item.evaluation_status == "not_evaluated" for item in decisions)
    coverage = RunCoverage(
        target_total=len(codes),
        true_count=counts["true"],
        false_count=counts["false"],
        unknown_count=counts["unknown"],
        failed_count=failed_count,
        not_evaluated_count=not_evaluated_count,
    )
    status = "cancelled" if cancelled else "partial" if counts["unknown"] else "succeeded"
    result = ScreeningRunResult(
        run_id=run_id,
        task_id=task.task_id,
        revision=task.revision,
        status=status,
        execution_version=EXECUTION_VERSION,
        coverage=coverage,
        stock_decisions=decisions,
        execution_request_id=request["request_id"],
        source_manifests=snapshot["source_manifests"],
        tool_call_ids=snapshot["tool_call_ids"],
        model_metadata=snapshot["model_metadata"],
    )
    validate_run_for_task(task, result, codes)
    return result
