from __future__ import annotations

from typing import Any, Callable

from . import evidence_sources
from .evidence_analysis import EvidenceProvider, EvidenceRequest, analyze
from .screening_contracts import ConditionDecision
from .settings import llm_settings


def evaluate(
    condition: dict[str, Any], reference: dict[str, Any], stock_code: str, as_of: str, *,
    lookback_days: int | None = None, active: Callable[[], bool] = lambda: True,
) -> ConditionDecision:
    request = EvidenceRequest.model_validate(condition["expression"])
    if reference.get("parameter_overrides"):
        raise ValueError("资料问题修改须保存新的自然语言口径，不接受隐式数值覆盖")
    identity = dict(stock_code=stock_code, condition_id=condition["condition_id"],
                    condition_version=reference.get("condition_version"), reference_id=reference["reference_id"],
                    implementation_id=condition.get("implementation_id"), data_as_of=as_of)
    if not llm_settings()["configured"]:
        return ConditionDecision(**identity, state="unknown", evaluation_status="not_evaluated",
                                 reason_code="unsupported_capability", explanation="尚未配置资料分析模型。")
    allowed = frozenset(request.source_ids) if request.source_ids is not None else None

    def list_sources(**arguments):
        return evidence_sources.list_report_sources(stock_code, as_of, lookback_days=lookback_days,
                                                    allowed_source_ids=allowed, **arguments)

    def read_chunk(source_id, **arguments):
        if allowed is not None and source_id not in allowed:
            raise evidence_sources.EvidenceSourceError("source_outside_scope", "资料不属于本条件指定的来源")
        return evidence_sources.read_report_chunk(source_id, stock_code=stock_code, as_of=as_of,
                                                  lookback_days=lookback_days, **arguments)

    result = analyze(request, stock_code, as_of, EvidenceProvider(list_sources, read_chunk), active=active)
    return ConditionDecision(
        **identity, state=result["state"], evaluation_status="completed", reason_code=result["reason_code"],
        explanation=result["explanation"],
        actual_values={"evidence": result["evidence"], "coverage": result["coverage"]},
        evidence_refs=[f"report:{item['source_id']}:page:{item['page_number']}:{item['char_start']}:{item['char_end']}"
                       for item in result["evidence"]],
    )
