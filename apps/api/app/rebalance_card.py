"""Image and text templates for the same editable rebalance draft."""
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
import re

from PIL import Image, ImageOps
from pydantic import Field

from .client_service_contracts import CardTheme, StrictModel
from .client_service_disclosure import disclosure_lines
from .client_service_images import BODY_TOP, MASTHEAD_HEIGHT, THEMES, WIDTH, CardLayout, _font, _lines, web_asset
from .client_service_text import without_web_links


def _plain(value: str) -> str:
    return without_web_links(value).strip()


def percentage(value: str) -> str:
    value = value.strip().removesuffix("%").removesuffix("％").strip()
    if re.fullmatch(r"[0-9]{1,3}(?:\.[0-9]+)?", value) and Decimal(value) <= 100:
        return value + "%"
    return ""


class RebalanceCard(StrictModel):
    theme: CardTheme = "river"
    product: str = Field(default="", max_length=80)
    code: str = Field(default="", max_length=15)
    name: str = Field(default="", max_length=50)
    direction: str = Field(default="", max_length=30)
    before: str = Field(default="", max_length=12)
    after: str = Field(default="", max_length=12)
    price: str = Field(default="", max_length=18)
    reason: str = Field(default="", max_length=1600)
    basis: str = Field(default="", max_length=650)

    def public_fields(self) -> dict[str, str]:
        fields = {key: _plain(value) for key, value in self.model_dump(exclude={"theme"}).items()}
        fields["before"] = percentage(fields["before"])
        fields["after"] = percentage(fields["after"])
        code = fields["code"].upper()
        fields["code"] = code[:6] if re.fullmatch(r"\d{6}(?:\.(SH|SZ|BJ))?", code) else ""
        price = fields["price"]
        fields["price"] = price if re.fullmatch(r"\d+(?:\.\d+)?", price) and Decimal(price) > 0 else ""
        return fields

    def ready(self) -> bool:
        fields = self.public_fields()
        return all(fields[key] for key in ("product", "code", "name", "direction", "before", "after", "price"))

    def text(self) -> str:
        value = self.public_fields()
        header = "\n".join([
            f"投顾产品：{value['product']}", f"股票名称：{value['name']} {value['code']}".rstrip(),
            f"调仓方向：{value['direction']}", f"仓位变化：{value['before']}—{value['after']}",
            f"参考价格：{value['price']}",
        ])
        return "\n\n".join([
            header,
            *(f"{label}：{value[key]}" for label, key in (("调仓理由", "reason"), ("调仓依据", "basis")) if value[key]),
            "\n".join(disclosure_lines()),
        ])


def rebalance_artwork_path(theme: CardTheme) -> Path:
    return web_asset(f"client-service/rebalance-themes/{theme}.png")


@lru_cache(maxsize=len(THEMES))
def _rebalance_masthead(theme: CardTheme) -> Image.Image | None:
    path = rebalance_artwork_path(theme)
    if not path.is_file():
        return None
    with Image.open(path) as original:
        return ImageOps.fit(original.convert("RGB"), (WIDTH, MASTHEAD_HEIGHT), method=Image.Resampling.LANCZOS)


def render_rebalance_card(card: RebalanceCard, *, regions: list | None = None) -> bytes:
    """Use the shared card layout with a stock-quote row and a position-change band."""
    values = card.public_fields()
    maximum = {key: field.metadata[0].max_length for key, field in type(card).model_fields.items() if key != "theme"}
    label_font, value_font, paragraph_font = _font(23), _font(33, True), _font(29)
    shown = {**values, "price": f"{values['price']} 元" if values["price"] else ""}
    def cells(spec):
        return [(key, label, x, width, _lines(shown[key] or "—", value_font, width))
                for key, label, x, width in spec]

    quote = cells((("name", "股票名称", 72, 360), ("code", "股票代码", 472, 236), ("price", "参考价格", 750, 258)))
    positions = cells((("direction", "调仓方向", 84, 300), ("before", "调仓前仓位", 430, 218), ("after", "调仓后仓位", 748, 248)))
    quote_height = 150 + max(len(lines) for _, _, _, _, lines in quote) * 48
    position_height = 150 + max(len(lines) for _, _, _, _, lines in positions) * 48
    reason = _lines(values["reason"], paragraph_font, 908) if values["reason"] else []
    basis = _lines(values["basis"], paragraph_font, 936) if values["basis"] else []
    reason_height = 114 + len(reason) * 44 if reason else 0
    basis_height = 114 + len(basis) * 44 if basis else 0
    body_end = BODY_TOP + quote_height + reason_height + position_height + basis_height + 40
    layout = CardLayout(card.theme, body_end, regions)
    brand_height = layout.masthead(_rebalance_masthead(card.theme), brand=values["product"] or "填写投顾产品",
                                   title="调仓建议", edition="R E B A L A N C E")
    layout.region("product", "投顾产品", 86, 44, 630, brand_height, maximum["product"], card.product, "#f1f4ef")

    def draw_cells(group, top, height, *, dark=False):
        label_color, text_color = ("#c3d1cf", "#f4f5ef") if dark else (layout.muted, layout.ink)
        line_color = layout.accent if dark else "#cdd8d6"
        layout.draw.line((72, top + 82, 1008, top + 82), fill=line_color, width=1)
        for index, (key, label, x, width, lines) in enumerate(group):
            if index:
                layout.draw.line((x - 18, top + 96, x - 18, top + height - 18), fill=line_color, width=1)
            layout.draw.text((x, top + 102), label, font=label_font, fill=label_color)
            layout.lines_at(lines, x, top + 134, value_font, text_color, 48)
            layout.region(key, label, x, top + 132, width, len(lines) * 48 + 4, maximum[key], getattr(card, key), text_color)

    y = BODY_TOP
    layout.section_label("01", "标的与报价", "SECURITY & PRICE", y + 22)
    draw_cells(quote, y, quote_height)
    y += quote_height
    number = 2
    if reason:
        layout.section_label("02", "调仓理由", "THE VIEW", y + 20)
        layout.draw.line((72, y + 92, 72, y + 88 + len(reason) * 44), fill=layout.accent, width=4)
        layout.region("reason", "调仓理由", 98, y + 89, 908, len(reason) * 44 + 6, maximum["reason"], card.reason)
        layout.lines_at(reason, 98, y + 91, paragraph_font, layout.ink, 44)
        y += reason_height
        number += 1

    layout.action_band(y, position_height)
    layout.section_label(f"{number:02}", "仓位调整", "POSITION CHANGE", y + 23, dark=True)
    draw_cells(positions, y, position_height, dark=True)
    arrow_y = y + 151
    layout.draw.line((665, arrow_y, 708, arrow_y), fill=layout.accent, width=3)
    layout.draw.line((698, arrow_y - 9, 708, arrow_y, 698, arrow_y + 9), fill=layout.accent, width=3)
    y += position_height
    if basis:
        layout.section_label(f"{number + 1:02}", "调仓依据", "RESEARCH NOTES", y + 24)
        layout.region("basis", "调仓依据", 72, y + 89, 936, len(basis) * 44 + 6, maximum["basis"], card.basis)
        layout.lines_at(basis, 72, y + 91, paragraph_font, layout.ink, 44)
    return layout.finish()
