"""Inputs and deliverables for investment-adviser writing and stock diagnosis."""
from datetime import date
from typing import Literal

from pydantic import Field, field_validator, model_validator

from .models import StrictModel
from .closing_review import ClosingReview

ADVISOR_KINDS = frozenset({"closing", "stock-analysis", "stock-rationale"})
STOCK_KINDS = frozenset({"stock-analysis", "stock-rationale"})


class AdvisorScope(StrictModel):
    stock_code: str | None = Field(default=None, pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    trade_date: date | None = None
    horizon: Literal["short", "medium", "long"] = "medium"
    position: Literal["watching", "holding"] = "watching"
    holding_cost: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    risk_preference: Literal["unspecified", "cautious", "balanced", "growth"] = "unspecified"
    question: str = Field(default="", max_length=600)
    recommendation_background: str = Field(default="", max_length=1200)
    audience: Literal["client", "internal"] = "client"

    @field_validator("question", "recommendation_background")
    @classmethod
    def trim_input(cls, value):
        return value.strip()

    @model_validator(mode="after")
    def cost_matches_position(self):
        if self.holding_cost is not None and self.position != "holding":
            raise ValueError("只有已持有股票时才填写持仓成本")
        return self


class AdvisorPoint(StrictModel):
    title: str = Field(min_length=3, max_length=120)
    explanation: str = Field(min_length=10, max_length=1200)
    evidence_keys: list[str] = Field(min_length=1, max_length=6, description="event_key values of this run's evidence-backed items; never invent references.")


class AdvisorReport(StrictModel):
    stock_code: str | None = Field(default=None, pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    verdict: Literal["review", "support", "conditional", "watch", "insufficient", "against"]
    conclusion: str = Field(min_length=10, max_length=1400)
    effective_date: date
    session_status: Literal["closed", "not_closed", "data_missing"] | None = None
    supporting_points: list[AdvisorPoint] = Field(default_factory=list, max_length=6)
    contrary_points: list[AdvisorPoint] = Field(default_factory=list, max_length=6)
    risks: list[str] = Field(min_length=1, max_length=8)
    invalidation_conditions: list[str] = Field(min_length=1, max_length=6)
    action_conditions: list[str] = Field(min_length=1, max_length=6, description="Observable entry/holding/review conditions, or next-session checks for a closing review. No invented prices or guaranteed returns.")
    suitability: str = Field(min_length=5, max_length=700, description="Applicable horizon and risk assumptions; missing customer information stays unspecified.")
    client_copy: str = Field(min_length=20, max_length=1600, description="Concise client-facing draft, faithful to the verdict, including material risks. Do not force a positive recommendation.")
    full_copy: str = Field(min_length=30, max_length=6000, description="Complete adviser draft suitable for editing and copying, with source-backed reasoning, opposing facts and invalidation conditions.")
    closing_review: ClosingReview | None = Field(default=None, description="Required for new closing tasks. Frozen turnover universe/comparison, event local times and evidence references; omit for stock tasks.")

    @field_validator("risks", "invalidation_conditions", "action_conditions")
    @classmethod
    def bounded_lines(cls, values):
        if any(not value.strip() or len(value) > 700 for value in values):
            raise ValueError("核验事项不能为空或超过700字")
        return values

    @model_validator(mode="after")
    def substantive_verdict(self):
        if self.verdict == "support" and len(self.supporting_points) < 2:
            raise ValueError("支持推荐至少需要两条有证据的独立理由")
        if self.verdict == "against" and not self.contrary_points:
            raise ValueError("不支持推荐须列出有证据的反方判断")
        return self
