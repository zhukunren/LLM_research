"""One renderer for live previews, scheduled images and downloaded PNGs."""
from __future__ import annotations

from functools import lru_cache
from datetime import datetime
from io import BytesIO
import os
from copy import deepcopy
import re
from pathlib import Path
import tempfile
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont

from .client_service_disclosure import FIXED_DISCLOSURE, disclosure_lines
from .client_service_text import card_copy_content, without_web_links
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
                   f"C:/Windows/Fonts/{'msyhbd' if bold else 'msyh'}.ttc", '/System/Library/Fonts/PingFang.ttc']
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    raise OSError('缺少中文图片字体，请安装 Noto Sans CJK 或配置 LLMR_CLIENT_CARD_FONT。')


def _lines(text: str, font, width: int):
    """Wrap Chinese text while keeping dates, times and numeric tokens intact."""
    lines = []
    for paragraph in str(text).split('\n'):
        line = []
        tokens = re.findall(r'[+-]?\d+(?:[.,:/-]\d+)*(?:年\d{1,2}月\d{1,2}日(?:\d{1,2}时(?:\d{1,2}分)?)?)?[%％]?|[A-Za-z]+|.', paragraph)
        for token in tokens:
            if font.getlength(token) > width:
                if line: lines.append(''.join(line)); line=[]
                # A pathological token wider than a column still needs bounded
                # wrapping; ordinary dates and quoted prices never reach here.
                for character in token:
                    if line and font.getlength(''.join(line)+character)>width:
                        lines.append(''.join(line));line=[]
                    line.append(character)
            elif line and font.getlength(''.join(line)+token)>width:
                carry=[]
                if len(line)>1 and (token[0] in '，。；：！？、）》】』」…' or line[-1] in '（《【『「'):
                    carry=[line.pop()]
                lines.append(''.join(line));line=carry+[token]
            else:line.append(token)
        lines.append(''.join(line))
    return lines or ['']


def _metric_lines(text, font, width):
    """Keep a quoted number and its percent sign together when wrapping narrow columns."""
    index_value=re.fullmatch(r'([0-9,.]+点)\s+([+\-]\d+(?:\.\d+)?%)',str(text).strip())
    if index_value and all(font.getlength(value)<=width for value in index_value.groups()):return [index_value[1],index_value[2]]
    return _lines(text, font, width)


# The legacy jade identifier now renders the technology collection, preserving saved choices.
THEMES = {
    'river': {'ink': '#153c60', 'muted': '#61778a', 'paper': '#f1f5fa', 'action': '#e8f0f8', 'accent': '#b69868'},
    'jade': {'ink': '#12345b', 'muted': '#61788f', 'paper': '#f2f6fc', 'action': '#e5effa', 'accent': '#53b7e7'},
    'gold': {'ink': '#493d2f', 'muted': '#857969', 'paper': '#f7f4ee', 'action': '#efe7d9', 'accent': '#b79150'},
    'cosmos': {'ink': '#24213f', 'muted': '#78758d', 'paper': '#f5f3f9', 'action': '#ece8f5', 'accent': '#afa0d2'},
    'cinnabar': {'ink': '#562832', 'muted': '#8d6d6b', 'paper': '#fcf4ee', 'action': '#f5e5df', 'accent': '#ce8b6c'},
    'ocean': {'ink': '#123c51', 'muted': '#607e8e', 'paper': '#f0f6f8', 'action': '#e3f0f4', 'accent': '#78aebe'},
    'platinum': {'ink': '#333f4e', 'muted': '#748190', 'paper': '#f4f6f8', 'action': '#e9edf2', 'accent': '#a7b4c4'},
}
ART_SLOTS = ('preopen', 'opening', 'checkpoint', 'midday', 'late', 'close')


def artwork_index(slot_id: str) -> int:
    return ART_SLOTS.index(slot_id) if slot_id in ART_SLOTS else 6


def artwork_path(theme: str) -> Path:
    return PROJECT_ROOT / 'apps/web/public/client-service/themes' / f"{theme if theme in THEMES else 'river'}-logo-safe.png"


@lru_cache(maxsize=49)
def _masthead(theme: str, index: int):
    # Each generated atlas holds one coherent collection with distinct scenes per slot.
    with Image.open(artwork_path(theme)) as art:
        w, h = art.size
        col, row = index % 2, index // 2
        return art.convert('RGB').crop((round(col * w / 2), round(row * h / 4),
                                       round((col + 1) * w / 2), round((row + 1) * h / 4))).resize((WIDTH, 400))


def display_market(card):
    market = deepcopy(card.get('market') or {})
    for key, value in card['content'].get('market_overrides', {}).items():
        if key == 'summary':
            market['summary'] = value
        elif (match := re.fullmatch(r'metric\.([0-5])\.(label|value)', key)):
            index, field = int(match[1]), match[2]
            if index < len(market.get('metrics', [])):
                market['metrics'][index][field] = value
    for field in ('summary', 'data_note'):
        if isinstance(market.get(field), str):
            market[field] = without_web_links(market[field])
    for metric in market.get('metrics', []):
        for field in ('label', 'value'):
            metric[field] = without_web_links(metric[field])
    if market.get('limitations'):
        market['limitations'] = [line for value in market['limitations'] if (line := without_web_links(value))]
    return market


def render_card(card: dict, *, regions: list | None = None, draft: bool = False) -> bytes:
    """An editorial composition: art-led masthead, lead view, ruled data and a full-bleed action band."""
    content, template = card_copy_content(card['content']), card['template']
    template_title = without_web_links(template['title'])
    market = display_market(card)
    theme = content.get('theme', 'river')
    if theme not in THEMES:
        theme = 'river'
    palette = THEMES[theme]
    ink, muted, accent, paper = (palette[key] for key in ('ink', 'muted', 'accent', 'paper'))
    body, small = _font(29), _font(21)
    conclusion = _lines(content.get('conclusion', '').strip() or '等待补充今日判断', _font(35, True), 908)
    summary = _lines(market.get('summary') or '市场快照尚未采集，核实信息后更新。', body, 936)
    action = _lines(content.get('action', '').strip() or '等待补充行动安排', _font(30), 884)
    focus = _lines(content.get('focus', '').strip() or '等待补充观察重点', body, 936)
    metrics = market.get('metrics', [])[:6]
    rows = []
    for offset in range(0, len(metrics), 3):
        group = [(_lines(item['label'], small, 270), _metric_lines(item['value'], _font(29, True), 270), item)
                 for item in metrics[offset:offset + 3]]
        row_height = max(128, *(24 + len(labels) * 29 + len(values) * 38 + (36 if item.get('observed_at') else 18)
                                for labels, values, item in group))
        rows.append((group, row_height))
    from .client_service_quality import publication_notes, publisher
    notes=publication_notes(market)
    if content.get('market_overrides'):notes.append('市场展示文字含手工编辑，原始记录见来源面板。')
    footer_font = _font(24)
    limits = _lines('数据 / ' + '；'.join(notes), footer_font, 936) if notes else []
    service = _lines(content.get('service', ''), footer_font, 936) if content.get('service') else []
    risk = _lines(FIXED_DISCLOSURE['risk'], _font(26), 936)
    identity = [line for text in disclosure_lines()[1:] for line in _lines(text, _font(25), 936)]
    source_names = list(dict.fromkeys(filter(None, map(publisher, market.get('sources', [])))))[:4]
    sources = _lines('来源 / ' + ' · '.join(source_names), _font(23), 936) if source_names else []
    conclusion_height = 114 + len(conclusion) * 53
    market_height = 116 + len(summary) * 43 + sum(height for _, height in rows)
    action_height = 124 + len(action) * 47
    focus_height = 115 + len(focus) * 44
    disclosure_height = 76 + len(risk) * 42 + 38 + len(identity) * 39 + 24
    footer_height = 159 + len(limits) * 38 + len(service) * 37 + len(sources) * 35 + disclosure_height
    height = max(1660, 422 + conclusion_height + market_height + action_height + focus_height + footer_height)
    def region(key, label, x, y, width, block_height, max_length, value, color=ink):
        if regions is not None:
            regions.append({'key': key, 'label': label, 'x': x, 'y': y, 'width': width,
                            'height': max(32, block_height), 'max': max_length, 'value': value, 'color': color})

    image = Image.new('RGB', (WIDTH, height), paper)
    if artwork_path(theme).is_file():
        image.paste(_masthead(theme, artwork_index(template['id'])), (0, 0))
    draw = ImageDraw.Draw(image)
    if not artwork_path(theme).is_file():
        draw.rectangle((0, 0, WIDTH, 400), fill=ink)
    # The paper edge meets the artwork as an angled editorial cut, not a boxed header.
    draw.polygon(((0, 390), (WIDTH, 355), (WIDTH, 414), (0, 414)), fill=paper)
    draw.line((0, 389, WIDTH, 354), fill=accent, width=3)
    draw.rectangle((64, 55, 70, 88), fill=accent)
    brand_size = 27
    while brand_size > 18 and _font(brand_size, True).getlength(content['brand']) > 630:
        brand_size -= 1
    region('brand', '服务名称', 86, 44, 630, 50, 20, content['brand'], '#f1f4ef')
    draw.text((86, 50), content['brand'], font=_font(brand_size, True), fill='#f1f4ef')
    logo = PROJECT_ROOT / 'apps/web/public/brand/soochow-white.png'
    if logo.is_file():
        with Image.open(logo) as original:
            mark = original.convert('RGBA'); mark.thumbnail((220, 50))
            image.paste(mark, (WIDTH - 64 - mark.width, 52), mark)
    edition = artwork_index(template['id']) + 1
    draw.text((64, 128), f'M A R K E T   N O T E S   /   {edition:02}', font=_font(17), fill='#d9dcd1')
    if draft:
        draft_label = '草稿 · 待核对'
        draft_font = _font(22, True)
        right = WIDTH - 64
        left = right - round(draft_font.getlength(draft_label)) - 28
        draw.rounded_rectangle((left, 107, right, 146), radius=6, fill='#fff1d5')
        draw.text(((left + right) / 2, 126), draft_label, font=draft_font, fill=INK, anchor='mm')
    title = content.get('headline') or template_title
    size = 62
    while size > 30 and _font(size, True).getlength(title) > 640:
        size -= 2
    region('headline', '卡片标题', 62, 150, 650, 80, 20, content.get('headline', ''), 'white')
    draw.text((62, 155), title, font=_font(size, True), fill='white')
    draw.line((64, 246, 123, 246), fill=accent, width=3)
    draw.ellipse((132, 243, 138, 249), fill=accent)
    draw.text((64, 268), template['time'], font=_font(54, True), fill='white')
    draw.line((254, 278, 254, 322), fill=accent, width=2)
    draw.text((278, 273), card['service_date'].replace('-', ' / '), font=_font(23), fill='#f1f4ef')
    draw.text((278, 308), '北京时间  /  ' + template_title, font=_font(18), fill='#d9e0e1')

    def lines_at(lines, x, y, font, color, step):
        for line in lines:
            draw.text((x, y), line, font=font, fill=color)
            y += step
        return y

    def section_label(number, label, english, y, color=ink):
        draw.line((365, y + 16, 615, y + 16), fill=accent, width=1)
        draw.ellipse((624, y + 13, 630, y + 19), fill=accent)
        draw.text((72, y), number, font=_font(23, True), fill=accent)
        draw.text((120, y - 3), label, font=_font(27, True), fill=color)
        draw.text((120, y + 36), english, font=_font(14), fill=muted if color == ink else '#c3d1cf')

    y = 422
    section_label('01', '今日判断', 'THE VIEW', y)
    draw.line((72, y + 88, 72, y + 88 + len(conclusion) * 53 - 8), fill=accent, width=4)
    region('conclusion', '今日判断', 98, y + 76, 908, len(conclusion) * 53 + 6, 160, content.get('conclusion', ''))
    lines_at(conclusion, 98, y + 78, _font(35, True), ink if content.get('conclusion', '').strip() else muted, 53)
    y += conclusion_height
    draw.line((72, y - 8, 1000, y - 8), fill='#cdd8d6', width=1)
    draw.polygon(((1000, y - 8), (1005, y - 13), (1010, y - 8), (1005, y - 3)), fill=accent)
    section_label('02', '市场速览', 'MARKET PULSE', y + 19)
    if market.get('cutoff'):
        cutoff = datetime.fromisoformat(market['cutoff'].replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Shanghai'))
        draw.text((710, y + 24), '截至 ' + cutoff.strftime('%m-%d %H:%M'), font=_font(19), fill=muted)
    region('market.summary', '市场摘要', 72, y + 98, 936, len(summary) * 43 + 6, 600, market.get('summary', ''))
    cursor = lines_at(summary, 72, y + 100, body, ink, 43) + 16
    metric_index = 0
    for group, row_height in rows:
        draw.line((72, cursor, 1008, cursor), fill='#cdd8d6', width=1)
        for index, (labels, values, metric) in enumerate(group):
            x = 72 + index * 324
            if index:
                draw.line((x - 18, cursor + 20, x - 18, cursor + row_height - 18), fill='#d9e0dc', width=1)
            region(f'market.metric.{metric_index}.label', '指标名称', x, cursor + 12, 270, len(labels) * 29, 30, metric['label'])
            top = lines_at(labels, x, cursor + 15, small, muted, 29) + 4
            tone = '#ae454d' if '+' in metric['value'] else '#2a7c66' if '-' in metric['value'] else ink
            region(f'market.metric.{metric_index}.value', metric['label'], x, top - 2, 270, len(values) * 38, 80, metric['value'])
            metric_index += 1
            lines_at(values, x, top, _font(29, True), tone, 38)
            if metric.get('observed_at'):
                observed = datetime.fromisoformat(metric['observed_at'].replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Shanghai'))
                draw.text((x, cursor + row_height - 29), observed.strftime('%m-%d %H:%M'), font=_font(17), fill=muted)
        cursor += row_height
    y += market_height
    # A full-bleed band creates a strong focal point for the practical takeaway.
    draw.rectangle((0, y, WIDTH, y + action_height), fill=ink)
    draw.rectangle((0, y, 12, y + action_height), fill=accent)
    section_label('03', '盘面主线' if template['id'].startswith('live-') else '行动安排', 'MARKET DRIVERS' if template['id'].startswith('live-') else 'NEXT STEPS', y + 25, 'white')
    draw.text((940, y + 16), '”', font=_font(82), fill=accent)
    region('action', '盘面主线' if template['id'].startswith('live-') else '行动安排', 92, y + 96, 884, len(action) * 47 + 6, 180, content.get('action', ''), '#f4f5ef')
    lines_at(action, 92, y + 98, _font(30), '#f4f5ef', 47)
    y += action_height
    section_label('04', '观察重点', 'ON THE RADAR', y + 30)
    region('focus', '观察重点', 72, y + 103, 936, len(focus) * 44 + 6, 140, content.get('focus', ''))
    lines_at(focus, 72, y + 105, body, ink if content.get('focus', '').strip() else muted, 44)
    y += focus_height
    draw.line((72, y + 8, 1008, y + 8), fill=accent, width=2)
    y += 33
    region('service', '服务说明', 72, y, 936, max(1, len(service)) * 37, 80, content.get('service', ''))
    y = lines_at(service, 72, y, footer_font, ink, 37)
    y += 18
    y = lines_at(limits, 72, y, footer_font, ink, 38)
    y += 12
    y = lines_at(sources, 72, y, _font(23), ink, 35)
    y += 24
    # Reserve a measured, read-only disclosure panel on every theme and every slot.
    # Never take these strings from legacy card content or editable image regions.
    draw.rectangle((48, y, 1032, y + disclosure_height), fill=palette['action'])
    draw.rectangle((48, y, 1032, y + 3), fill=accent)
    draw.text((72, y + 22), '风险提示', font=_font(28, True), fill=ink)
    audience = 'R4 · 仅供已签约客户参考'
    draw.text((1008 - _font(23, True).getlength(audience), y + 26), audience, font=_font(23, True), fill=ink)
    y = lines_at(risk, 72, y + 76, _font(26), ink, 42)
    y += 20
    draw.line((72, y, 1008, y), fill=accent, width=1)
    lines_at(identity, 72, y + 18, _font(25), ink, 39)
    draw.text((72, height - 47), 'S E R V I C E   N O T E S', font=_font(14), fill=muted)
    draw.text((795, height - 47), card['service_date'].replace('-', '.') + f'  /  {edition:02}', font=_font(14), fill=muted)
    draw.rectangle((0, height - 8, WIDTH, height), fill=ink)
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
