from __future__ import annotations

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FilterInput(StrictModel):
    id: str | None = None
    base_version: int | None = Field(default=None, ge=1)
    library: Literal["news", "technical", "report"]
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=1000)
    expression: dict[str, Any]


class DraftInput(StrictModel):
    library: Literal["news", "technical", "report"]
    prompt: str = Field(min_length=1, max_length=4000)
    context_code: str | None = None


class PreviewInput(StrictModel):
    stock_code: str | None = Field(default=None, min_length=4, max_length=16)
    as_of: str | None = None


class IndicatorPreviewInput(StrictModel):
    stock_code: str = Field(min_length=4, max_length=16)
    indicator: Literal["sma", "ema", "rsi", "bollinger", "macd_dif", "macd_dea", "macd_hist", "kdj_k", "kdj_d", "kdj_j", "atr"]
    window: int = Field(ge=2, le=250)
    field: Literal["close", "volume"] = "close"
    as_of: str | None = None


class StrategyInput(StrictModel):
    id: str | None = None
    request_id: str | None = Field(default=None, min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    tree: dict[str, Any]
    top_n: int = Field(default=30, ge=1, le=500)


class StrategyValidationInput(StrictModel):
    tree: dict[str, Any]


class ScreenInput(StrictModel):
    request_id: str | None = Field(default=None, min_length=1, max_length=100)
    strategy_id: str
    strategy_version: int = Field(ge=1)
    as_of: str
    mode: Literal["formal", "exploratory"] = "formal"
    watchlist_id: str | None = None

    @field_validator("as_of")
    @classmethod
    def valid_date(cls, value: str) -> str:
        try:
            if date.fromisoformat(value).isoformat() != value:
                raise ValueError()
        except ValueError as exc:
            raise ValueError("筛选日期必须是有效的 YYYY-MM-DD 日期") from exc
        return value


class PatternInput(StrictModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=100)
    input_type: Literal["drawing", "screenshot", "market_window", "natural_language"]
    source_draft_id: str | None = None
    representation: Literal["price_path", "ohlc_sequence"]
    target_bars: int = Field(ge=10, le=250)
    points: list[float] = Field(min_length=10, max_length=250)
    candlesticks: list[dict[str, float]] = Field(default_factory=list, max_length=250)
    params: dict[str, Any] = Field(default_factory=dict)
    source_image_base64: str | None = Field(default=None, max_length=14_000_000)
    source_image_mime: Literal["image/png", "image/jpeg", "image/webp"] | None = None
    source_image_filename: str | None = Field(default=None, max_length=200)

    @field_validator("points")
    @classmethod
    def finite_points(cls, value: list[float]) -> list[float]:
        if any(not (-1e6 < item < 1e6) for item in value):
            raise ValueError("形态点包含无效数值")
        return value


class PatternExtractionInput(StrictModel):
    filename: str = Field(max_length=200)
    mime_type: Literal["image/png", "image/jpeg", "image/webp"]
    image_base64: str = Field(min_length=32, max_length=14_000_000)
    crop: dict[str, float] = Field(default_factory=lambda: {"x": 0, "y": 0, "width": 1, "height": 1})


class PatternPreviewInput(StrictModel):
    stock_code: str = Field(min_length=4, max_length=16)
    as_of: str | None = None
    pattern_id: str
    pattern_version: int = Field(ge=1)
    match_mode: Literal["current", "recent"] | None = None
    recent_bars: int | None = Field(default=None, ge=1, le=120)


class WatchlistInput(StrictModel):
    name: str = Field(min_length=1, max_length=100)


class WatchlistItemInput(StrictModel):
    stock_code: str = Field(min_length=4, max_length=16)
    note: str = Field(default="", max_length=2000)
    replace_note: bool = True


class ReportSearchInput(StrictModel):
    query: str = Field(min_length=1, max_length=300)
    as_of: date | None = None
    stock_code: str | None = Field(default=None, pattern=r"^\d{4,6}\.(SH|SZ|BJ|HK|KS)$")
    mode: Literal["smart", "exact"] = "smart"
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=30, ge=1, le=100)


class ReportEvaluationInput(StrictModel):
    as_of: str = Field(pattern=r"^20\d{2}-\d{2}-\d{2}$")

    @field_validator("as_of")
    @classmethod
    def valid_date(cls, value: str) -> str:
        try:
            date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("报告截止日不是有效日期") from exc
        return value


class ConfirmSecurityBindingInput(StrictModel):
    stock_code: str = Field(pattern=r"^\d{4,6}\.(SH|SZ|BJ|HK|KS)$")


class ConfirmAvailabilityInput(StrictModel):
    available_at: str = Field(pattern=r"^20\d{2}-\d{2}-\d{2}$")

    @field_validator("available_at")
    @classmethod
    def valid_date(cls, value: str) -> str:
        try:
            date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("研报可用日期不是有效日期") from exc
        return value
