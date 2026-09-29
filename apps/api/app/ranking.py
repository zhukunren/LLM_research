"""Rank a declared metric over an explicit, complete comparison population."""
from __future__ import annotations

import math
from decimal import Decimal, ROUND_CEILING

from .screening_contracts import (
    ConditionDecision, ConditionDefinition, ConditionReference, RankingSpec,
)


def evaluate_ranking(
    spec: RankingSpec,
    condition: ConditionDefinition,
    reference: ConditionReference,
    codes: list[str],
    metrics: dict[str, ConditionDecision],
    population_states: dict[str, str],
) -> dict[str, ConditionDecision]:
    if len(codes) != len(set(codes)) or set(metrics) != set(codes) or set(population_states) != set(codes):
        raise ValueError("排名输入必须完整覆盖冻结证券范围")
    if any(state not in {"true", "false", "unknown"} for state in population_states.values()):
        raise ValueError("排名比较范围状态无效")
    if spec.metric_name is None:
        raise ValueError("排名没有绑定指标名称")
    scores: dict[str, int | float] = {}
    for code in codes:
        value = metrics[code].actual_values.get(spec.metric_name)
        if metrics[code].evaluation_status == "completed" and type(value) in (int, float):
            try:
                if math.isfinite(value):
                    scores[code] = value
            except OverflowError:
                pass
    candidates = [code for code in codes if population_states[code] == "true"]
    uncertain_population = [code for code in codes if population_states[code] == "unknown"]
    missing = [code for code in candidates if code not in scores]
    comparable = [code for code in candidates if code in scores]
    units = {metrics[code].units.get(spec.metric_name, "unknown") for code in comparable}
    mixed_units = len(units) > 1
    incomplete = bool(missing or uncertain_population)
    strict_unknown = incomplete and spec.missing_policy == "unknown"
    ordered = sorted(comparable, key=lambda code: (
        -scores[code] if spec.direction == "descending" else scores[code], code
    ))
    limit = spec.top_n if spec.top_n is not None else int(
        (Decimal(len(ordered)) * Decimal(str(spec.top_fraction))).to_integral_value(rounding=ROUND_CEILING)
    )
    limit = min(limit, len(ordered))
    selected = set(ordered[:limit])
    if limit and spec.ties_policy == "include_all":
        boundary = scores[ordered[limit - 1]]
        selected.update(code for code in ordered if scores[code] == boundary)
    ranks = {}
    last_score = None
    tie_rank = 0
    for index, code in enumerate(ordered, 1):
        if index == 1 or scores[code] != last_score:
            tie_rank = index
        ranks[code] = tie_rank if spec.ties_policy == "include_all" else index
        last_score = scores[code]
    output = {}
    for code in codes:
        status = "completed"
        if population_states[code] == "false":
            state, reason, explanation = "false", "condition_not_met", "此证券不在已确认的过滤后排名范围内。"
        elif mixed_units:
            state, status, reason = "unknown", "failed", "execution_failed"
            explanation = "同一排名指标出现不同单位，未混合比较。"
        elif strict_unknown:
            state, reason = "unknown", "data_missing"
            explanation = f"比较范围存在{len(missing)}只指标缺失及{len(uncertain_population)}只范围待定证券，未缩小范围排名。"
        elif code not in comparable:
            state, reason = "false", "condition_not_met"
            explanation = "按已确认的缺失排除口径，此证券未参加排名；此排除不代表指标值为零。"
        else:
            state = "true" if code in selected else "false"
            reason = "condition_met" if state == "true" else "condition_not_met"
            explanation = f"在{len(ordered)}只可比较证券中排名第{ranks[code]}；" + ("符合排名条件。" if state == "true" else "不符合排名条件。")
            if incomplete:
                explanation += f"已按确认口径排除{len(missing) + len(uncertain_population)}只缺失或范围待定证券。"
        actual = {
            "score": scores.get(code),
            "rank": ranks.get(code) if not strict_unknown and not mixed_units else None,
            "population_size": len(candidates),
            "comparable_size": len(comparable),
            "missing_score_count": len(missing),
            "uncertain_population_count": len(uncertain_population),
            "selected_count": len(selected) if not strict_unknown and not mixed_units else None,
        }
        output[code] = ConditionDecision(
            stock_code=code, condition_id=condition.condition_id,
            condition_version=reference.condition_version, reference_id=reference.reference_id,
            state=state, evaluation_status=status, reason_code=reason,
            explanation=explanation, actual_values=actual,
            thresholds=spec.model_dump(mode="json", exclude={"population_logic_tree"}),
            units={"score": metrics[code].units.get(spec.metric_name, "unknown")},
            data_as_of=metrics[code].data_as_of, implementation_id=condition.implementation_id,
        )
    return output
