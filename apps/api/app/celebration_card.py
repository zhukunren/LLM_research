"""Render the date and quote captured by the celebration service as a portrait PNG."""
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

from .celebration import Theme
from .client_service_images import WIDTH, _lines, _png, web_asset
from .settings import PROJECT_ROOT


CENTER = WIDTH // 2
FONT_DIR = PROJECT_ROOT / 'apps/api/assets/research-pdf'


@dataclass(frozen=True)
class TextPlacement:
    y: int
    size: int
    color: str
    bold: bool = False
    width: int | None = None
    outline: str | None = None


@dataclass(frozen=True)
class PosterLayout:
    filename: str
    portfolio: TextPlacement
    portfolio_spacing: int
    stock: TextPlacement
    code: TextPlacement
    heading: TextPlacement
    percentage: TextPlacement
    close_detail: TextPlacement
    observed_at: TextPlacement
    source: TextPlacement


LAYOUTS: dict[Theme, PosterLayout] = {
    'red_gold': PosterLayout(
        filename='soochow-red-title.png',
        portfolio=TextPlacement(818, 76, '#ffe6a1', bold=True, width=868),
        portfolio_spacing=12,
        stock=TextPlacement(1000, 69, '#751719', bold=True, width=674),
        code=TextPlacement(1065, 31, '#963634', bold=True),
        heading=TextPlacement(1208, 53, '#ffe6a1', bold=True),
        percentage=TextPlacement(1396, 218, '#ffdf8d', bold=True, width=880, outline='#ffecb9'),
        close_detail=TextPlacement(1551, 32, '#f9dcaa'),
        observed_at=TextPlacement(1638, 30, '#f9dcaa'),
        source=TextPlacement(1695, 27, '#f9dcaa'),
    ),
    'blue_gold': PosterLayout(
        filename='soochow-blue-gold.png',
        portfolio=TextPlacement(1292, 67, '#f5e5bf', bold=True, width=848),
        portfolio_spacing=7,
        stock=TextPlacement(1413, 56, '#153557', bold=True, width=632),
        code=TextPlacement(1464, 27, '#50647d', bold=True),
        heading=TextPlacement(1540, 38, '#ecd6a6', bold=True),
        percentage=TextPlacement(1637, 151, '#ffe4a8', bold=True, width=834),
        close_detail=TextPlacement(1721, 23, '#c3cfe0'),
        observed_at=TextPlacement(1765, 27, '#cdd9ea'),
        source=TextPlacement(1802, 24, '#b6c8df'),
    ),
}


@lru_cache(maxsize=len(LAYOUTS))
def _background(theme: Theme = 'red_gold') -> Image.Image:
    with Image.open(web_asset(f'client-service/celebrations/{LAYOUTS[theme].filename}')) as artwork:
        return artwork.convert('RGB')


@lru_cache(maxsize=32)
def _font(size: int, bold: bool = False):
    filename = 'NotoSansSC-bold.ttf' if bold else 'NotoSansSC-regular.ttf'
    return ImageFont.truetype(FONT_DIR / filename, size)


def _fit(text: str, size: int, width: int, bold: bool):
    font = _font(size, bold)
    while size > 28 and font.getlength(text) > width:
        size -= 2
        font = _font(size, bold)
    return font


def _draw_text(draw: ImageDraw.ImageDraw, text: str, placement: TextPlacement):
    font = _font(placement.size, placement.bold) if placement.width is None else _fit(
        text, placement.size, placement.width, placement.bold,
    )
    draw.text((CENTER, placement.y), text, font=font, anchor='mm', fill=placement.color,
              stroke_width=2 if placement.outline else 0, stroke_fill=placement.outline)


def render_poster(report: dict) -> bytes:
    theme = report.get('theme', 'red_gold')
    layout = LAYOUTS[theme]
    image = _background(theme).copy()
    draw = ImageDraw.Draw(image)

    portfolio = layout.portfolio
    portfolio_width = portfolio.width or WIDTH
    portfolio_font = _font(portfolio.size, portfolio.bold)
    lines = _lines(report['portfolio_name'], portfolio_font, portfolio_width)
    while len(lines) > 2:
        portfolio_font = _font(portfolio_font.size - 2, portfolio.bold)
        lines = _lines(report['portfolio_name'], portfolio_font, portfolio_width)
    line_step = portfolio_font.size + layout.portfolio_spacing
    for index, line in enumerate(lines):
        y = portfolio.y + (index - (len(lines) - 1) / 2) * line_step
        draw.text((CENTER, y), line, font=portfolio_font, anchor='mm', fill=portfolio.color)

    _draw_text(draw, report['stock_name'], layout.stock)
    _draw_text(draw, report['code'], layout.code)
    threshold = report['closing_threshold']
    heading = f'收盘涨超 {threshold}' if threshold else report['mode_label']
    _draw_text(draw, heading, layout.heading)
    _draw_text(draw, report['change_percent'], layout.percentage)
    if threshold:
        _draw_text(draw, '实际收盘涨幅', layout.close_detail)

    observed = datetime.fromisoformat(report['observed_at'])
    stamp = observed.strftime('%Y-%m-%d %H:%M')
    _draw_text(draw, f'行情时点 {stamp}（北京时间）', layout.observed_at)
    _draw_text(draw, f'数据来源 {report["source"]}', layout.source)
    return _png(image)
