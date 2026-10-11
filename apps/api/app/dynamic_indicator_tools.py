"""Codex tools for numeric indicators, separate from boolean screening plans.

Trials are scoped to their originating conversation. Saving an immutable asset
is an explicit action in My Indicators; a model preview never saves a version.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import Field

from . import conversation_store, dynamic_indicators
from .dynamic_indicators import IndicatorConditionRequest, PreviewIndicatorRequest
from .models import StrictModel

if TYPE_CHECKING:
    from .screening_tools import ToolContext


class ListIndicatorsArgs(StrictModel):
    include_history: bool = False
    limit: int = Field(default=50, ge=1, le=100)


class ReadIndicatorArgs(StrictModel):
    indicator_id: str = Field(min_length=1, max_length=100)
    version: int | None = Field(default=None, ge=1)


class ReadTrialArgs(StrictModel):
    trial_id: str = Field(min_length=1, max_length=100)


class PreviewIndicatorArgs(PreviewIndicatorRequest):
    # Browser callers may tag a trial, but Codex cannot choose another scope.
    conversation_id: None = None


class BuildIndicatorConditionArgs(IndicatorConditionRequest):
    indicator_id: str = Field(min_length=1, max_length=100)


def _service_call(function, *args, **kwargs):
    from .screening_tools import ToolDispatchError
    try:
        return function(*args, **kwargs)
    except dynamic_indicators.DynamicIndicatorError as exc:
        raise ToolDispatchError(exc.code, str(exc)) from exc


def list_indicators(args: ListIndicatorsArgs, _: ToolContext) -> dict:
    return {"items": _service_call(dynamic_indicators.list_indicators,
                                  include_history=args.include_history, limit=args.limit)}


def read_indicator(args: ReadIndicatorArgs, _: ToolContext) -> dict:
    return _service_call(dynamic_indicators.get_indicator, args.indicator_id, args.version)


def read_trial(args: ReadTrialArgs, context: ToolContext) -> dict:
    from .screening_tools import ToolDispatchError
    result = _service_call(dynamic_indicators.get_trial, args.trial_id)
    if result.get("conversation_id") != context.conversation_id:
        raise ToolDispatchError("indicator_trial_scope", "只能读取当前对话的指标试算")
    # Conversation ownership alone is insufficient: an older open-scope turn
    # (or a browser-selected sample) can contain later/out-of-scope prices.
    if context.as_of and result["as_of"] > context.as_of:
        raise ToolDispatchError("indicator_cutoff_conflict", "这份指标试算晚于当前回合截止日，请按当前范围重新试算")
    if context.stock_codes is not None and result["stock_code"] not in context.stock_codes:
        raise ToolDispatchError("security_outside_indicator_scope", "这份指标试算证券不在当前回合范围内")
    return result


def preview_indicator(args: PreviewIndicatorArgs, context: ToolContext) -> dict:
    from .screening_tools import ToolDispatchError
    # A new screening draft can inspect one numeric sample before a formal
    # universe is chosen. Once a scope exists, its dates/securities are binding.
    if context.as_of and args.as_of.isoformat() != context.as_of:
        raise ToolDispatchError("indicator_cutoff_conflict", "指标试算截止日必须与当前回合范围一致")
    if context.stock_codes is not None and args.stock_code not in context.stock_codes:
        raise ToolDispatchError("security_outside_indicator_scope", "指标试算证券不在当前回合范围内")

    def active():
        try:
            return conversation_store.get_turn(context.conversation_id, context.turn_id)["state"] == "running"
        except conversation_store.ConversationNotFound:
            return False

    result = _service_call(dynamic_indicators.preview_indicator, args,
                           conversation_id=context.conversation_id, turn_id=context.turn_id,
                           is_active=active)
    # Keep the model reply bounded without truncating the persisted chart.
    # My Indicators and read_indicator_trial retrieve the full dated series.
    return {
        key: result[key] for key in (
            "trial_id", "definition_hash", "code_hash", "stock_code", "as_of",
            "actual_date", "parameters", "validation", "source_context",
        ) if key in result
    } | {
        "name": result["definition"]["name"],
        "outputs": result["definition"]["outputs"],
        "point_count": len(result.get("dates", [])),
        "saved_to_library": False,
        "note": "完整逐日图表已保存在当前对话的我的指标。试算通过不是公式正确、安全或无前视偏差的证明；请核对方法、样本和假设，再由用户保存。",
    }


def build_condition(args: BuildIndicatorConditionArgs, _: ToolContext) -> dict:
    payload = IndicatorConditionRequest.model_validate(args.model_dump(exclude={"indicator_id"}))
    return _service_call(dynamic_indicators.build_condition, args.indicator_id, payload)


def register_tools(registry) -> None:
    registry.register(
        "list_dynamic_indicators",
        "List saved user-defined numeric indicators and immutable versions. These are separate from boolean screening conditions; the built-in indicator catalog does not limit generation.",
        ListIndicatorsArgs, list_indicators,
    )
    registry.register(
        "read_dynamic_indicator",
        "Read a saved numeric indicator's exact formula, Python source, parameters, output units, data context and validation evidence. Pin a version when reusing it; omission selects the current version for inspection only.",
        ReadIndicatorArgs, read_indicator,
    )
    registry.register(
        "read_indicator_trial",
        "Read the full date-aligned numeric series, chart and validation evidence from a trial in this conversation. Larger results use the normal artifact reader. A trial is not a saved indicator version.",
        ReadTrialArgs, read_trial,
    )
    registry.register(
        "preview_dynamic_indicator",
        "Generate or reuse any numeric daily-bar indicator, then actually execute and validate one sample. Supply a definition with python-indicator-v1 source defining compute(context, frames, params); np is available. Return exactly {dates:{code:list(frames[code]['trade_date'])},series:{code:{output_name:[finite number or null for EACH input date]}}}. Never return boolean decisions here. frames[code] contains read-only NumPy arrays for declared fields plus valid and trade_date. Declare every output's name,label,unit,placement,kind. Use causal calculations, null for warmup/missing data, and no future values. Or pass indicator_id+version to rerun a saved version. Complete chart is persisted to My Indicators, never truncated to screening metrics. No version or screening run is saved. Trial checks are evidence, not proof of formula correctness, security or absence of lookahead. Trusted local Python only.",
        PreviewIndicatorArgs, preview_indicator, read_only=False,
    )
    registry.register(
        "build_indicator_condition",
        "Convert an exact saved numeric indicator version plus an explicit output/comparison/threshold into a frozen python-screen-v1 boolean condition. Use the returned condition unchanged when proposing a screening revision. Does not save or execute a plan. Available only in screening; research uses the explicit My Indicators screening-draft handoff.",
        BuildIndicatorConditionArgs, build_condition,
    )
