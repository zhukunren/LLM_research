"""Business inputs and validated deliverables for the intelligence desk."""
from datetime import datetime
from typing import Literal

from pydantic import Field, ValidationInfo, field_validator, model_validator

from .models import StrictModel
from .advisor_contracts import AdvisorScope, AdvisorReport, STOCK_KINDS, ADVISOR_KINDS

BriefKind = Literal["market", "policy", "industry", "closing", "stock-analysis", "stock-rationale"]
KIND_DEFINITIONS = {
    "market": {"name": "市场简报", "assistant": "daily-hotspots", "description": "核对市场事件，整理影响、证据与待验证事项。"},
    "policy": {"name": "政策追踪", "assistant": "policy-tracker", "description": "核对政策原文、发布阶段及影响范围。"},
    "industry": {"name": "产业跟踪", "assistant": "industry-updates", "description": "核对供需、价格、订单和产能的实际变化。"},
    "closing": {"name": "收评", "assistant": "general", "description": "复盘指定交易日，形成盘面要点、次日观察与每日股评稿。"},
    "stock-analysis": {"name": "个股分析", "assistant": "general", "description": "围绕买入咨询或持仓问题，核对经营、估值、走势与风险。"},
    "stock-rationale": {"name": "个股推荐理由", "assistant": "general", "description": "为选定股票整理有证据的推荐逻辑、反方依据和客户沟通稿。"},
}
MARKETS = {"CN": "中国内地", "HK": "中国香港", "US": "美国", "GLOBAL": "全球"}


class BriefScope(StrictModel):
    markets: list[Literal["CN", "HK", "US", "GLOBAL"]] = Field(default_factory=lambda: ["CN"], min_length=1, max_length=4)
    lookback_hours: Literal[24, 72, 168] = 24
    industries: list[str] = Field(default_factory=list, max_length=8)
    source_preference: Literal["primary", "broad"] = "primary"
    max_items: Literal[5, 10, 15] = 10
    focus: str = Field(default="", max_length=600)
    advisor: AdvisorScope | None = None

    def business_payload(self):
        """Keep pre-adviser scope hashes and idempotent retries compatible."""
        value = self.model_dump(mode="json")
        if self.advisor is None:
            value.pop("advisor", None)
        return value

    @field_validator("markets")
    @classmethod
    def unique_markets(cls, values):
        return sorted(set(values))

    @field_validator("industries")
    @classmethod
    def industry_names(cls, values):
        values = sorted(set(value.strip() for value in values if value.strip()))
        if any(len(value) > 40 for value in values):
            raise ValueError("行业名称不能超过40字")
        return values

    @field_validator("focus")
    @classmethod
    def trimmed(cls, value):
        return value.strip()


class StartBrief(StrictModel):
    request_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
    kind: BriefKind = "market"
    scope: BriefScope = Field(default_factory=BriefScope)
    cutoff_at: datetime | None = None
    retry_of: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def task_inputs(self):
        if self.kind in STOCK_KINDS and not (self.scope.advisor and self.scope.advisor.stock_code):
            raise ValueError("请先选择要研究的股票")
        if self.kind in ADVISOR_KINDS and self.scope.markets != ["CN"]:
            raise ValueError("当前投顾任务使用中国内地A股范围")
        if self.kind == "closing" and self.scope.advisor and self.scope.advisor.stock_code:
            raise ValueError("收评按市场复盘，不绑定单只股票")
        return self

    @field_validator("cutoff_at")
    @classmethod
    def aware_cutoff(cls, value):
        if value is not None and value.utcoffset() is None:
            raise ValueError("截止时间须包含时区")
        return value


class CaptureBriefSource(StrictModel):
    url: str = Field(min_length=8, max_length=4000)
    retry: bool = Field(default=False, description="Retry a temporary connection/timeout failure once. Do not retry HTTP 4xx, blocked pages or invalid sources; switch source instead.")


class ReadBriefSource(StrictModel):
    source_id: str = Field(min_length=1, max_length=100)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=12000, ge=100, le=20000)


class BriefCitation(StrictModel):
    source_id: str = Field(min_length=1, max_length=100)
    quote: str = Field(min_length=12, max_length=1200, description="One continuous, uniquely locatable passage copied from the frozen source. Do not join separate table rows or omit intervening text. Use separate citations for separate passages.")
    published_at: str | None = Field(default=None, max_length=40, description="ISO date or timezone-aware datetime; null if not found. Never guess a time.")
    publication_quote: str = Field(default="", max_length=400, description="Exact source text supporting the publication date. Empty when unknown.")
    source_type: Literal["primary", "reporting", "market_data"] = "primary"

    @field_validator("published_at")
    @classmethod
    def publication_time(cls, value):
        if value is None:
            return None
        from datetime import date
        if len(value) == 10:
            return date.fromisoformat(value).isoformat()
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.utcoffset() is None:
            raise ValueError("来源时间必须包含时区，只有日期时使用 YYYY-MM-DD")
        return parsed.isoformat()


class BriefItem(StrictModel):
    event_key: str = Field(min_length=3, max_length=120, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$", description="Stable event identity. Reuse the previous version's key for the same event.")
    title: str = Field(min_length=3, max_length=160)
    event_date: str = Field(max_length=100, description="Actual event date/time or an explicit 'unknown'; distinct from publication time.")
    facts: str = Field(min_length=10, max_length=1800)
    analysis: str = Field(min_length=10, max_length=1800)
    importance: Literal["high", "medium", "low"] = "medium"
    ranking_reason: str = Field(min_length=5, max_length=500)
    affected: list[str] = Field(default_factory=list, max_length=12)
    uncertainties: list[str] = Field(default_factory=list, max_length=6)
    next_check: str = Field(min_length=3, max_length=600)
    policy_stage: str | None = Field(default=None, max_length=120)
    industry_dimension: str | None = Field(default=None, max_length=120)
    analysis_dimension: Literal["market", "business", "financial", "valuation", "technical", "catalyst", "risk"] | None = None
    evidence: list[BriefCitation] = Field(min_length=1, max_length=4, description="Each topic allows 1–4 exact continuous source quotes. Split different topics into separate items if more evidence is needed.")

    @field_validator("affected", "uncertainties")
    @classmethod
    def bounded_list(cls, values):
        if any(not value.strip() or len(value) > 400 for value in values):
            raise ValueError("条目不能为空或超过400字")
        return values


class PublishBrief(StrictModel):
    title: str = Field(min_length=3, max_length=160)
    summary: str = Field(min_length=10, max_length=2400)
    items: list[BriefItem] = Field(default_factory=list, max_length=15)
    coverage: str = Field(min_length=10, max_length=1800, description="What was actually searched/read, including gaps. Do not claim exhaustive market coverage.")
    limitations: list[str] = Field(default_factory=list, max_length=10)
    no_updates_reason: str = Field(default="", max_length=800)
    advisor_report: AdvisorReport | None = None

    @field_validator("no_updates_reason", mode="before")
    @classmethod
    def unused_reason_for_nonempty_report(cls, value, info: ValidationInfo):
        # No-update explanations are inapplicable when actual topics exist.
        # Normalize only that null; empty reports still require a real reason.
        return "" if value is None and info.data.get("items") else value

    @model_validator(mode="after")
    def valid_items(self):
        if not self.items and len(self.no_updates_reason.strip()) < 10:
            raise ValueError("无更新时须说明检索范围与未发现可靠更新的原因")
        if len({item.event_key for item in self.items}) != len(self.items):
            raise ValueError("同一事件不能重复列入简报")
        if len({item.title.strip().casefold() for item in self.items}) != len(self.items):
            raise ValueError("重复标题需要合并")
        if any(not value.strip() or len(value) > 800 for value in self.limitations):
            raise ValueError("资料限制不能为空或超过800字")
        return self
