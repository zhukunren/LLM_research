"""One renderer for live previews, scheduled images and downloaded PNGs."""
from __future__ import annotations

from functools import lru_cache
from datetime import datetime
from io import BytesIO
import os
from pathlib import Path
import tempfile
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont

from .settings import PROJECT_ROOT
from .storage import application_paths

WIDTH = 1080
NAVY = '#10395d'
BLUE = '#0968aa'
INK = '#213d55'
MUTED = '#61778a'


@lru_cache(maxsize=24)
def _font(size: int, bold: bool = False):
    configured = os.environ.get('LLMR_CLIENT_CARD_FONT')
    candidates = [configured] if configured else []
    candidates += [f"/usr/share/fonts/opentype/noto/NotoSansCJK-{'Bold' if bold else 'Regular'}.ttc",
                   'C:/Windows/Fonts/msyh.ttc', '/System/Library/Fonts/PingFang.ttc']
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    raise OSError('缺少中文图片字体，请安装 Noto Sans CJK 或配置 LLMR_CLIENT_CARD_FONT。')


def _lines(text: str, font, width: int):
    lines = []
    for paragraph in str(text).split('\n'):
        line = ''
        for character in paragraph:
            if line and font.getlength(line + character) > width:
                lines.append(line)
                line = ''
            line += character
        lines.append(line)
    return lines or ['']


def render_card(card: dict) -> bytes:
    content, template = card['content'], card['template']
    market = card.get('market') or {}
    body_font, small = _font(30), _font(23)
    summary_lines = _lines(market.get('summary') or '市场状态尚未采集。', body_font, 900)
    metrics = market.get('metrics', [])[:6]
    metric_layout, metric_heights = [], []
    for offset in range(0, len(metrics), 2):
        group = [(metric, _lines(metric['label'], small, 416), _lines(metric['value'], _font(28, True), 416)) for metric in metrics[offset:offset + 2]]
        metric_layout.append(group)
        metric_heights.append(max(128, *(40 + len(labels) * 29 + len(values) * 38 + 28 for _, labels, values in group)))
    metric_height = sum(height + 12 for height in metric_heights)
    sections = []
    for key, label in [('conclusion', '今日判断'), ('action', '行动安排'), ('focus', '观察重点')]:
        text = content.get(key, '').strip()
        lines = _lines(text or '待填写', body_font, 900)
        sections.append((label, lines, bool(text)))
    limits = market.get('limitations', [])
    limit_lines = _lines('；'.join(limits), small, 900) if limits else []
    service_lines = _lines(content.get('service', ''), small, 920) if content.get('service') else []
    risk_lines = _lines(content.get('risk', ''), small, 920) if content.get('risk') else []
    adviser = '  '.join(value for value in [content.get('adviser'), content.get('license')] if value)
    adviser_lines = _lines(adviser, _font(24, True), 920) if adviser else []
    source_text = '来源：' + '、'.join(source['title'][:28] + ('…' if len(source['title']) > 28 else '') for source in market.get('sources', [])[:3])
    source_lines = _lines(source_text, _font(20), 920) if market.get('sources') else []
    height = max(1440, 340 + 85 + len(summary_lines) * 45 + metric_height
                 + sum(100 + len(lines) * 43 for _, lines, _ in sections)
                 + len(limit_lines) * 34 + 80 + len(service_lines) * 34 + len(risk_lines) * 34
                 + len(adviser_lines) * 40 + len(source_lines) * 30 + 145)
    image = Image.new('RGB', (WIDTH, height), '#f0f5fa')
    background = PROJECT_ROOT / 'apps/web/public/client-service/market-card-background.png'
    if background.is_file():
        with Image.open(background) as original:
            image.paste(original.convert('RGB').resize((WIDTH, height)), (0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((28, 28, 1052, 320), radius=28, fill=NAVY)
    logo = PROJECT_ROOT / 'apps/web/public/brand/soochow-white.png'
    if logo.is_file():
        with Image.open(logo) as original:
            mark = original.convert('RGBA')
            mark.thumbnail((245, 58))
            image.paste(mark, (72, 64), mark)
    draw.text((72, 140), content['brand'], font=_font(31), fill='#b9dafa')
    title_size = 56
    title = content.get('headline') or template['title']
    while title_size > 30 and _font(title_size, True).getlength(title) > 900:
        title_size -= 2
    draw.text((70, 190), title, font=_font(title_size, True), fill='white')
    draw.text((72, 274), f"{card['service_date']}   {template['time']}  ·  北京时间", font=small, fill='#d5e7f7')
    y = 348
    draw.rounded_rectangle((48, y, 1032, y + 85 + len(summary_lines) * 45 + metric_height), radius=20, fill='white')
    draw.text((80, y + 22), '市场状态', font=_font(30, True), fill=BLUE)
    if market.get('cutoff'):
        cutoff = datetime.fromisoformat(market['cutoff']).astimezone(ZoneInfo('Asia/Shanghai'))
        draw.text((580, y + 27), '截至 ' + cutoff.strftime('%m-%d %H:%M'), font=_font(21), fill=MUTED)
    y += 78
    for line in summary_lines:
        draw.text((80, y), line, font=body_font, fill=INK)
        y += 45
    y += 15
    for group, row_height in zip(metric_layout, metric_heights):
        for index, (metric, labels, values) in enumerate(group):
            x, top = 80 + index * 470, y
            draw.rounded_rectangle((x - 10, top, x + 440, top + row_height), radius=12, fill='#f1f6fb')
            position = top + 10
            for line in labels:
                draw.text((x + 6, position), line, font=small, fill=MUTED)
                position += 29
            position += 6
            tone = '#ab343d' if '+' in metric['value'] else '#227760' if '-' in metric['value'] else INK
            for line in values:
                draw.text((x + 6, position), line, font=_font(28, True), fill=tone)
                position += 38
            if metric.get('observed_at'):
                observed = datetime.fromisoformat(metric['observed_at'].replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Shanghai'))
                draw.text((x + 6, top + row_height - 28), '数据 ' + observed.strftime('%Y-%m-%d %H:%M'), font=_font(18), fill=MUTED)
        y += row_height + 12
    y += 28
    for label, lines, filled in sections:
        section_height = 80 + len(lines) * 43
        draw.rounded_rectangle((48, y, 1032, y + section_height), radius=18, fill='white')
        draw.rounded_rectangle((77, y + 23, 83, y + 56), radius=3, fill=BLUE)
        draw.text((98, y + 18), label, font=_font(29, True), fill=NAVY)
        top = y + 70
        for line in lines:
            draw.text((80, top), line, font=body_font, fill=INK if filled else '#91a1af')
            top += 43
        y += section_height + 20
    if limit_lines:
        draw.text((80, y), '数据说明', font=_font(23, True), fill=MUTED)
        y += 36
        for line in limit_lines:
            draw.text((80, y), line, font=small, fill=MUTED)
            y += 34
        y += 20
    for line in service_lines:
        draw.text((80, y), line, font=small, fill=MUTED)
        y += 34
    y += 18
    for line in adviser_lines:
        draw.text((80, y), line, font=_font(24, True), fill=NAVY)
        y += 40
    for line in risk_lines:
        draw.text((80, y), line, font=small, fill=MUTED)
        y += 34
    y += 12
    for line in source_lines:
        draw.text((80, y), line, font=_font(20), fill=MUTED)
        y += 30
    return _png(image)


def _png(image):
    output = BytesIO()
    image.save(output, format='PNG', compress_level=5)
    return output.getvalue()


def image_path(card_id):
    return application_paths().artifact_root / 'client-service' / f'{card_id}.png'


def save_card_image(card):
    data = render_card(card)
    path = image_path(card['id'])
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.png', delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(data)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return path
