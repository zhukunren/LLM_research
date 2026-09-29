from typing import Any
import math

from pydantic import Field

from . import patterns
from .db import connect, json_load
from .screening_contracts import ContractModel, ConditionDecision, ScreeningTaskRevision


class PatternReference(ContractModel):
    pattern_id: str = Field(min_length=1, max_length=100)
    pattern_version: int = Field(ge=1)
    minimum_similarity: float = Field(ge=0, le=100)
    match_mode: str | None = None
    recent_bars: int | None = Field(default=None, ge=1, le=120)


def required_history_bars(condition: dict[str, Any], reference: dict[str, Any], asset: dict[str, Any]) -> int:
    spec = PatternReference.model_validate(condition["expression"])
    overrides = reference.get("parameter_overrides") or {}
    mode = overrides.get("match_mode", spec.match_mode)
    recent = overrides.get("recent_bars", spec.recent_bars)
    params = asset["template"].get("params", {}) if isinstance(asset["template"].get("params"), dict) else {}
    mode = mode or params.get("match_mode", "current")
    recent = recent if recent is not None else params.get("recent_bars", 20)
    if mode not in {"current", "recent"} or type(recent) is not int or not 1 <= recent <= 120:
        raise ValueError("形态匹配窗口参数无效")
    count = asset["template"].get("target_bars")
    if type(count) is not int:
        raise ValueError("已保存形态的行情窗口无效")
    return count if mode == "current" else count + recent - 1


def freeze_for_task(task: ScreeningTaskRevision) -> dict[str, dict[str, Any]]:
    frozen = {}
    with connect() as connection:
        for condition in task.conditions:
            if condition.library != "pattern":
                continue
            spec = PatternReference.model_validate(condition.expression)
            row = connection.execute("SELECT id,name,version,pattern_json FROM patterns WHERE id=? AND version=?",
                                     (spec.pattern_id, spec.pattern_version)).fetchone()
            if not row:
                raise ValueError("指定形态或版本不存在，请重新选择已保存形态")
            template = json_load(row["pattern_json"])
            if type(template.get("target_bars")) is not int or not 2 <= template["target_bars"] <= 500:
                raise ValueError("已保存形态的行情窗口无效")
            frozen[condition.condition_id] = dict(template=template, id=row["id"], version=row["version"], name=row["name"])
    return frozen


def evaluate(condition, reference, stock_code, as_of) -> ConditionDecision:
    spec = PatternReference.model_validate(condition["expression"])
    overrides = reference.get("parameter_overrides") or {}
    if set(overrides) - {"minimum_similarity", "match_mode", "recent_bars"}:
        raise ValueError("形态引用只能覆盖已确认的相似度或匹配窗口参数")
    minimum = overrides.get("minimum_similarity", spec.minimum_similarity)
    if type(minimum) not in (int, float) or not math.isfinite(minimum) or not 0 <= minimum <= 100:
        raise ValueError("形态相似度阈值无效")
    match_mode = overrides.get("match_mode", spec.match_mode)
    recent_bars = overrides.get("recent_bars", spec.recent_bars)
    if match_mode is not None and match_mode not in {"current", "recent"}:
        raise ValueError("形态匹配模式无效")
    if recent_bars is not None and (type(recent_bars) is not int or not 1 <= recent_bars <= 120):
        raise ValueError("近期形态回看交易日数无效")
    asset = reference.get("_pattern_template")
    if not asset or asset["id"] != spec.pattern_id or asset["version"] != spec.pattern_version:
        raise ValueError("运行中缺少对应的已保存形态版本")
    bars = reference.get("_bars") or []
    if any(bar["trade_date"] > as_of for bar in bars):
        raise ValueError("形态计算包含截止日之后的行情")
    target_date = reference.get("_effective_market_date")
    if not bars or target_date and bars[-1]["trade_date"] != target_date:
        raw = dict(state="unknown", reason="缺少目标交易日行情，无法比较形态。")
    else:
        raw = patterns.score_window(asset["template"], bars, match_mode=match_mode, recent_bars=recent_bars)
    state = "unknown" if raw["state"] == "unknown" else "true" if raw["similarity"] >= minimum else "false"
    explanation = raw.get("reason") if state == "unknown" else (
        f"与{asset['name']}的相似度为{raw['similarity']}分，要求至少{minimum:g}分；"
        + ("使用当前窗口。" if raw.get("match_mode", "current") == "current" else f"使用近{recent_bars or asset['template'].get('params', {}).get('recent_bars', 20)}根内最相近窗口，距今{raw.get('match_age_bars', 0)}根。")
        + "相似度不是上涨概率。"
    )
    return ConditionDecision(stock_code=stock_code, condition_id=condition["condition_id"],
        condition_version=reference.get("condition_version"), reference_id=reference["reference_id"],
        state=state, evaluation_status="completed", reason_code="data_missing" if state=="unknown" else "condition_met" if state=="true" else "condition_not_met",
        explanation=explanation, actual_values={**raw, "pattern_name": asset["name"]}, thresholds={"minimum_similarity": minimum},
        units={"similarity": "相似度分"}, data_as_of=bars[-1]["trade_date"] if bars else None,
        implementation_id=condition.get("implementation_id"))
