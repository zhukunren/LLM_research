"""Natural language -> a reviewable shape template, never an inferred market fact."""
from __future__ import annotations

import re
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter
from pydantic import Field, ValidationError, field_validator

from .db import connect, json_dump, utc_now
from .models import StrictModel
from .model_client import ModelRequestError, complete_json
from .settings import llm_settings

router = APIRouter(prefix="/api/v1/patterns", tags=["形态描述"])

SHAPES = {
    "v_bottom": ("V 形反转", [0.9, 0.1, 0.9]),
    "double_bottom": ("双底", [0.9, 0.15, 0.65, 0.15, 0.85]),
    "round_bottom": ("圆弧底", [0.9, 0.58, 0.33, 0.16, 0.1, 0.16, 0.33, 0.58, 0.9]),
    "rise_pullback": ("上涨后回调", [0.15, 0.35, 0.6, 0.9, 0.72, 0.6]),
}


class PatternDraftRequest(StrictModel):
    prompt: str = Field(min_length=1, max_length=2000)

    @field_validator("prompt")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("先描述希望看到的走势")
        return value.strip()


class ShapePlan(StrictModel):
    shape: Literal["v_bottom", "double_bottom", "round_bottom", "rise_pullback"] | None
    target_bars: int = Field(ge=10, le=250, strict=True)
    min_similarity: float = Field(ge=0, le=100, allow_inf_nan=False, strict=True)
    assumptions: list[str] = Field(default_factory=list, max_length=10)
    issues: list[str] = Field(default_factory=list, max_length=10)


def compile_pattern(prompt: str) -> dict:
    source, model = "local_template", None
    text = re.sub(r"\s+", "", prompt)
    match = re.fullmatch(r"(?:近|最近)?(\d+)(?:个)?交易日(?:的)?(V形反转|V型反转|双底|W底|圆弧底|先上涨再回调|上涨后回调)(?:走势|形态)?(?:[，,]相似度(?:不低于|至少)(\d+(?:\.\d+)?)%)?[。！]?", text, re.I)
    if match:
        shape = {"v形反转": "v_bottom", "v型反转": "v_bottom", "双底": "double_bottom", "w底": "double_bottom", "圆弧底": "round_bottom", "先上涨再回调": "rise_pullback", "上涨后回调": "rise_pullback"}[match[2].lower()]
        candidate = {"shape": shape, "target_bars": int(match[1]), "min_similarity": float(match[3] or 80), "assumptions": [] if match[3] else ["最低相似度采用 80 分，可在保存前调整。"], "issues": []}
    elif llm_settings()["configured"]:
        source, model = "configured_llm", llm_settings()["model"]
        try:
            candidate = complete_json(
                '把用户的走势描述整理成可编辑模板，只输出 JSON：{shape,target_bars,min_similarity,assumptions,issues}。'
                'shape 只允许 v_bottom（V形反转）、double_bottom（双底）、round_bottom（圆弧底）、rise_pullback（上涨后回调）或 null。'
                'target_bars 是10..250个有行情交易日，未给周期默认40并在assumptions说明；min_similarity是0..100相似度分数，未给默认80并说明。'
                '不要将圆弧底称作V形，不支持的形态如头肩顶、三重底必须shape=null且issues给出问题。'
                '成交量、精确涨跌幅、突破颈线、保证上涨、区间内曾经发生等要求不能由归一化路径模板表达，必须issues说明，不能遗漏。'
                '本接口生成目标模板，不推断真实行情，不声明已匹配，也不输出代码。', prompt,
                max_output_tokens=1500,
            )
        except ModelRequestError:
            candidate = {"shape": None, "target_bars": 40, "min_similarity": 80, "issues": ["本次解析未完成，请重试；原描述已保留。"], "assumptions": []}
    else:
        candidate = {"shape": None, "target_bars": 40, "min_similarity": 80, "issues": ["请描述周期和目标形状，例如：近30个交易日的双底形态。更自由的表达需要配置文本模型。"], "assumptions": []}
    try:
        plan = ShapePlan.model_validate(candidate).model_dump()
    except (ValidationError, TypeError):
        plan = {"shape": None, "target_bars": 40, "min_similarity": 80, "issues": ["形态参数超出可支持范围，请使用10至250个交易日和0至100分相似度。"], "assumptions": []}
    if re.search(r"成交量|放量|缩量|涨幅|跌幅|市值|保证|必涨|颈线|突破前高", prompt):
        plan["issues"].append("当前形态模板只比较归一化走势；量价幅度、突破或收益要求不能省略，请分别建立相应条件。")
    points = []
    if plan["shape"] and not plan["issues"]:
        anchors = SHAPES[plan["shape"]][1]
        for index in range(plan["target_bars"]):
            position = index * (len(anchors) - 1) / (plan["target_bars"] - 1)
            left = min(int(position), len(anchors) - 2)
            points.append(round(anchors[left] + (anchors[left + 1] - anchors[left]) * (position - left), 6))
    return {**plan, "status": "ready" if points else "needs_clarification", "points": points,
            "name": f"{plan['target_bars']} 日{SHAPES[plan['shape']][0]}" if plan["shape"] else "待补充形态",
            "description": "比较指定交易日窗口内的收盘走势形状；纵轴归一化，不代表精确涨跌幅，也不预测后续收益。",
            "source": source, "model": model, "compiler_version": "shape-plan-v1"}


@router.post("/draft")
def pattern_draft(payload: PatternDraftRequest):
    plan = compile_pattern(payload.prompt)
    draft_id, now = str(uuid4()), utc_now()
    with connect() as connection:
        connection.execute("INSERT INTO pattern_drafts VALUES(?,?,?,?)", (draft_id, payload.prompt, json_dump(plan), now))
    return {"id": draft_id, "prompt": payload.prompt, "created_at": now, **plan}
