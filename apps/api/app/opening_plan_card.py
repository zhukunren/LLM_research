"""Editable opening-plan content and its PNG layout."""
from datetime import date
import json
from pathlib import Path
from typing import Annotated

from pydantic import Field, field_validator

from .client_service_contracts import CardTheme, StrictModel
from .client_service_images import BODY_TOP, CardLayout, _font, _lines, themed_masthead
from .client_service_text import without_web_links


STYLE = json.loads((Path(__file__).parent / 'assets/client-service/opening-plan.json').read_text(encoding='utf-8'))
SECTION_LABELS = {field['key']: field['label'] for group in STYLE['groups'] for field in group['fields']}
SECTION_LABELS['data_note'] = STYLE['data_note']['label']
SECTION_LIMIT = 1800
PlanDate = Annotated[date, Field(gt=date.min)]


class OpeningPlanContent(StrictModel):
    theme: CardTheme = 'river'
    sections: dict[str, Annotated[str, Field(max_length=SECTION_LIMIT)]] = Field(default_factory=dict, max_length=len(SECTION_LABELS))

    @field_validator('sections')
    @classmethod
    def validate_sections(cls, value):
        if value.keys() - SECTION_LABELS.keys():
            raise ValueError('开盘计划包含未知段落。')
        return value


class OpeningPlanPreview(OpeningPlanContent):
    plan_date: PlanDate


def render_opening_plan(card: OpeningPlanPreview, *, regions: list | None = None, draft: bool = False) -> bytes:
    content = {key: without_web_links(body).strip() for key, body in card.sections.items()}
    has_body = any(content.values())
    groups = []
    for group in STYLE['groups']:
        dark = group.get('band', False)
        fields = []
        for index, field in enumerate(group['fields']):
            key = field['key']
            body = content.get(key, '')
            if not body and (has_body or index > 0):
                continue
            lead = key in {'lead', 'judgment'}
            x = 98 if lead else 92 if dark else 72
            font = _font(32, True) if lead else _font(29)
            step = 48 if lead else 44
            lines = _lines(body or '待填写', font, 1008 - x)
            fields.append((key, field['label'], x, font, step, lines))
        if fields:
            height = 89 + sum(59 + len(lines) * step for _, _, _, _, step, lines in fields)
            groups.append((group['label'], group['caption'], dark, height, fields))

    date_label = card.plan_date.isoformat()
    note = content.get('data_note')
    note_lines = _lines(f'数据说明 / {note}', _font(24), 936) if note else []
    body_end = BODY_TOP + sum(height for _, _, _, height, _ in groups) + len(note_lines) * 38 + 54
    layout = CardLayout(card.theme, body_end, regions, risk=STYLE['risk'])
    layout.masthead(themed_masthead(card.theme, 'opening-plan'), brand='对客服务', title='开盘计划',
                    edition='O P E N I N G   P L A N', time='盘前', date=date_label, caption='北京时间', draft=draft)
    y = BODY_TOP
    for number, (label, caption, dark, height, fields) in enumerate(groups, start=1):
        if dark:
            layout.action_band(y, height)
        elif number > 1:
            layout.draw.line((72, y + 6, 1008, y + 6), fill=layout.accent, width=1)
        layout.section_label(f'{number:02}', label, caption, y + 24, dark=dark)
        cursor = y + 82
        for key, name, x, font, step, lines in fields:
            tone = ('#f4f5ef' if content.get(key) else '#c3d1cf') if dark else (layout.ink if content.get(key) else layout.muted)
            layout.draw.text((x, cursor), name, font=_font(22, True), fill='#c3d1cf' if dark else layout.muted)
            if x == 98:
                layout.draw.line((72, cursor + 34, 72, cursor + 30 + len(lines) * step), fill=layout.accent, width=4)
            layout.region(key, name, x, cursor + 33, 1008 - x, len(lines) * step + 4, SECTION_LIMIT,
                          card.sections.get(key, ''), tone)
            cursor = layout.lines_at(lines, x, cursor + 35, font, tone, step) + 24
        y += height
    if note_lines:
        layout.region('data_note', SECTION_LABELS['data_note'], 72, y + 18, 936, len(note_lines) * 38, SECTION_LIMIT,
                      card.sections['data_note'])
        layout.lines_at(note_lines, 72, y + 18, _font(24), layout.ink, 38)
    return layout.finish(reference=date_label.replace('-', '.'))
