"""Editable service templates; Codex owns only the market snapshot."""
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
import re

from .client_service_disclosure import FIXED_DISCLOSURE, with_fixed_disclosure

SLOTS = {
    'preopen': ('盘前简报', '08:45'),
    'opening': ('开盘观察', '09:45'),
    'checkpoint': ('关键时点', '10:30'),
    'midday': ('午间观察', '11:35'),
    'late': ('尾盘观察', '14:30'),
    'close': ('收盘总结', '15:30'),
}


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


CardTheme = Literal['river', 'jade', 'gold', 'cosmos', 'cinnabar', 'ocean', 'platinum']


class CardContent(StrictModel):
    theme: CardTheme = 'river'
    market_overrides: dict[str, str] = Field(default_factory=dict, max_length=13)
    brand: str = Field(default='锦绣成长', min_length=1, max_length=20)
    headline: str = Field(default='', max_length=20)
    conclusion: str = Field(default='', max_length=160)
    action: str = Field(default='', max_length=180)
    focus: str = Field(default='', max_length=140)
    service: str = Field(default='个别持仓与调仓问题，请联系您的投顾。', max_length=80)
    risk: str = Field(default=FIXED_DISCLOSURE['risk'], max_length=300)
    adviser: str = Field(default=FIXED_DISCLOSURE['adviser'], max_length=30)
    license: str = Field(default=FIXED_DISCLOSURE['license'], max_length=30)
    institution: str = Field(default=FIXED_DISCLOSURE['institution'], max_length=80)

    @model_validator(mode='before')
    @classmethod
    def fixed_disclosure(cls, value):
        return with_fixed_disclosure(value) if isinstance(value, dict) else value


    @field_validator('market_overrides')
    @classmethod
    def valid_market_overrides(cls, value):
        for key, text in value.items():
            if key == 'summary':
                limit = 600
            elif re.fullmatch(r'metric\.[0-5]\.(?:label|value)', key):
                limit = 30 if key.endswith('.label') else 80
            else:
                raise ValueError('市场展示字段无效')
            if not text.strip() or len(text) > limit:
                raise ValueError('市场展示文字为空或超过长度限制')
        return value


class CardTemplate(StrictModel):
    id: str = Field(pattern=r'^(?:preopen|opening|checkpoint|midday|late|close|live-[a-f0-9]{32})$')
    title: str = Field(min_length=1, max_length=20)
    time: str = Field(pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$')
    enabled: bool = True
    content: CardContent = Field(default_factory=CardContent)


class ServiceSettings(StrictModel):
    revision: int = Field(default=0, ge=0)
    enabled: bool = False
    timezone: Literal['Asia/Shanghai'] = 'Asia/Shanghai'
    weekdays: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4], min_length=1, max_length=7)
    templates: list[CardTemplate] = Field(min_length=6, max_length=6)

    @model_validator(mode='after')
    def unique_slots(self):
        if {item.id for item in self.templates} != set(SLOTS):
            raise ValueError('每个时点需且只能配置一个模板')
        if len(set(self.weekdays)) != len(self.weekdays) or any(day < 0 or day > 6 for day in self.weekdays):
            raise ValueError('生成日期需为不重复的周一至周日')
        return self


def default_settings() -> ServiceSettings:
    return ServiceSettings(templates=[CardTemplate(id=key, title=title, time=time) for key, (title, time) in SLOTS.items()])


class GenerateCard(StrictModel):
    request_id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$')
    slot_id: Literal['preopen', 'opening', 'checkpoint', 'midday', 'late', 'close']
    date: date
    regenerate: bool = False


class SaveCard(StrictModel):
    revision: int = Field(ge=0)
    content: CardContent


class PreviewCard(StrictModel):
    template: CardTemplate
    date: date
    content: CardContent
    card_id: str | None = Field(default=None, pattern=r'^[a-f0-9-]{36}$')


class InstantBrief(StrictModel):
    theme: CardTheme | None = None
    request_id: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$')
