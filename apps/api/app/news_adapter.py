from typing import Any, Callable

from . import news_sources
from .evidence_sources import EvidenceSourceError
from .evidence_analysis import EvidenceProvider, EvidenceRequest, analyze
from .screening_contracts import ConditionDecision
from .settings import llm_settings


def evaluate(condition: dict[str, Any], reference: dict[str, Any], stock_code: str, as_of: str, *,
             lookback_days: int | None = None, active: Callable[[], bool] = lambda: True) -> ConditionDecision:
    request = EvidenceRequest.model_validate(condition["expression"])
    if reference.get("parameter_overrides"):
        raise ValueError("资讯条件修改必须形成明确的新问题")
    identity = dict(stock_code=stock_code, condition_id=condition["condition_id"],
                    condition_version=reference.get("condition_version"), reference_id=reference["reference_id"],
                    implementation_id=condition.get("implementation_id"), data_as_of=as_of)
    if not llm_settings()["configured"]:
        return ConditionDecision(**identity, state="unknown", evaluation_status="not_evaluated",
                                 reason_code="unsupported_capability", explanation="尚未配置资料分析模型。")
    allowed = frozenset(request.source_ids) if request.source_ids is not None else None
    def listing(**args):
        return news_sources.list_news_sources(stock_code, as_of, lookback_days=lookback_days,
                                             allowed_source_ids=allowed, **args)
    def reading(source_id, **args):
        if allowed is not None and source_id not in allowed:
            raise EvidenceSourceError("source_outside_scope", "资讯不属于本条件指定范围")
        return news_sources.read_news_chunk(source_id, stock_code=stock_code, as_of=as_of,
                                            lookback_days=lookback_days, **args)
    result = analyze(request, stock_code, as_of, EvidenceProvider(listing, reading), active=active)
    return ConditionDecision(**identity, state=result["state"], evaluation_status="completed",
        reason_code=result["reason_code"], explanation=result["explanation"],
        actual_values=dict(evidence=result["evidence"], coverage=result["coverage"],
                           independent_event_count=result.get("independent_event_count", 0)),
        evidence_refs=[f"news:{item['source_id']}:{item['char_start']}:{item['char_end']}" for item in result["evidence"]])
