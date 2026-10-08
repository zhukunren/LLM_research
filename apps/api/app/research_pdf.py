"""Fixed, branded PDF delivery for research answers, files and scan results."""
from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from html import escape
from io import BytesIO, StringIO
import json
import os
from pathlib import Path
import re
import threading
from typing import Any, Callable
from urllib.parse import unquote, urlsplit
from uuid import uuid4

import mistune
from PIL import Image as PILImage
from pypdf import PdfReader, PdfWriter, Transformation
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    BaseDocTemplate, Frame, Image, LongTable, NextPageTemplate,
    PageBreak, PageTemplate, Paragraph, Spacer, TableStyle,
)

from . import conversation_store, db, research_workspace
from .settings import PROJECT_ROOT, research_mode_settings

TEMPLATE_VERSION = "soochow-zhangjiagang-research-v1.1"
ASSETS = PROJECT_ROOT / "apps" / "api" / "assets" / "research-pdf"
LOGO = ASSETS / "soochow-blue.png"
BRANCH = "张家港营业部"
BLUE = colors.HexColor("#174F78")
INK = colors.HexColor("#203249")
MUTED = colors.HexColor("#66768C")
LINE = colors.HexColor("#DCE5EE")
PALE = colors.HexColor("#F3F6FA")
_lock = threading.RLock()
_fonts_ready = False
_markdown = mistune.create_markdown(renderer="ast", plugins=["table", "strikethrough"])


class PDFError(ValueError):
    pass


def _fonts() -> None:
    global _fonts_ready
    with _lock:
        if not _fonts_ready:
            for name, filename in [("ResearchSans", "NotoSansSC-regular.ttf"), ("ResearchSansBold", "NotoSansSC-bold.ttf")]:
                pdfmetrics.registerFont(TTFont(name, str(ASSETS / filename)))
            pdfmetrics.registerFontFamily("ResearchSans", normal="ResearchSans", bold="ResearchSansBold", italic="ResearchSans", boldItalic="ResearchSansBold")
            _fonts_ready = True


def _style(name: str, **kwargs) -> ParagraphStyle:
    options = dict(fontName="ResearchSans", fontSize=10, leading=16,
                   textColor=INK, wordWrap="CJK", spaceAfter=7)
    options.update(kwargs)
    return ParagraphStyle(name, **options)


def _header(c: canvas.Canvas, size=A4) -> None:
    width, height = size
    c.saveState()
    c.drawImage(str(LOGO), 20 * mm, height - 24 * mm, width=43 * mm, height=10 * mm, preserveAspectRatio=True, anchor="sw", mask="auto")
    c.setFont("ResearchSansBold", 10)
    c.setFillColor(BLUE)
    c.drawRightString(width - 20 * mm, height - 19 * mm, BRANCH)
    c.setStrokeColor(LINE)
    c.setLineWidth(.6)
    c.line(20 * mm, height - 29 * mm, width - 20 * mm, height - 29 * mm)
    c.restoreState()


def _footer(c: canvas.Canvas, number: int, total: int, size=A4) -> None:
    width, _ = size
    c.saveState()
    c.setStrokeColor(LINE)
    c.line(20 * mm, 20 * mm, width - 20 * mm, 20 * mm)
    c.setFillColor(MUTED)
    c.setFont("ResearchSans", 7.5)
    c.drawString(20 * mm, 14 * mm, f"{BRANCH} · 研究成果   |   模板 v1.0")
    c.drawRightString(width - 20 * mm, 14 * mm, f"第 {number} 页 / 共 {total} 页")
    c.restoreState()


class _NumberedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.pages = []

    def showPage(self):
        self.pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self.pages)
        for state in self.pages:
            self.__dict__.update(state)
            _footer(self, self._pageNumber, total, self._pagesize)
            super().showPage()
        super().save()


def _text(value: Any) -> str:
    return escape(str(value)).replace("\n", "<br/>")


def _beijing_stamp(value: str) -> str:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return value


def _table(rows: list[list[str]], *, header=True, widths=None):
    if not rows:
        return Spacer(1, 1)
    count = max(len(row) for row in rows)
    widths = widths or [170 * mm / count] * count
    cell_style = _style("cell", fontSize=8 if count < 7 else 6.7, leading=12, spaceAfter=0)
    data = [[Paragraph(_text(value), cell_style) for value in (row + [""] * (count - len(row)))] for row in rows]
    table = LongTable(data, colWidths=widths, repeatRows=1 if header else 0, splitByRow=1, splitInRow=1, hAlign="LEFT")
    commands = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7), ("LINEBELOW", (0, 0), (-1, -1), .35, LINE)]
    if header:
        commands += [("BACKGROUND", (0, 0), (-1, 0), PALE), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAFBFC")])]
    table.setStyle(TableStyle(commands))
    return table


def _plain(nodes: list[dict]) -> str:
    return "".join(node.get("raw", "") or _plain(node.get("children", [])) for node in nodes)


class _Content:
    def __init__(self, image_resolver: Callable[[str], Path | None] | None = None):
        self.image_resolver = image_resolver
        self.sources: list[str] = []

    def inline(self, nodes: list[dict]) -> str:
        result = []
        for node in nodes:
            kind = node["type"]
            children = node.get("children", [])
            text = self.inline(children) if children else _text(node.get("raw", ""))
            if kind == "strong":
                text = f"<b>{text}</b>"
            elif kind == "emphasis":
                text = f"<i>{text}</i>"
            elif kind == "strikethrough":
                text = f"<strike>{text}</strike>"
            elif kind == "codespan":
                text = f'<font color="#174F78">{text}</font>'
            elif kind == "link":
                url = node.get("attrs", {}).get("url", "")
                if urlsplit(url).scheme in {"https", "http"}:
                    if url not in self.sources:
                        self.sources.append(url)
                    text = f'<a href="{escape(url, quote=True)}" color="#174F78">{text}</a> [{self.sources.index(url) + 1}]'
                elif url:
                    text += f"（{_text(url)}）"
            elif kind == "image":
                text = f"图：{text}"
            elif kind in {"linebreak", "softbreak"}:
                text = "<br/>" if kind == "linebreak" else " "
            result.append(text)
        return "".join(result)

    def image(self, node: dict):
        url = node.get("attrs", {}).get("url", "")
        label = _plain(node.get("children", [])) or "研究图表"
        path = self.image_resolver(url) if self.image_resolver else None
        if path:
            try:
                with PILImage.open(path) as original:
                    original.load()
                    width, height = original.size
                    clean = BytesIO()
                    rgba = original.convert("RGBA")
                    background = PILImage.new("RGB", rgba.size, "white")
                    background.paste(rgba, mask=rgba.getchannel("A"))
                    background.save(clean, format="PNG")
                clean.seek(0)
                scale = min(170 * mm / width, 190 * mm / height)
                return [Image(clean, width=width * scale, height=height * scale), Paragraph(_text(label), _style("caption", fontSize=8, leading=12, textColor=MUTED))]
            except (OSError, ValueError, PILImage.DecompressionBombError):
                pass
        return [Paragraph(f"图表未能嵌入：{_text(label)}。引用位置：{_text(url)}", _style("missing_image", fontSize=9, leading=14))]

    def paragraph(self, children: list[dict], *, prefix: str = "") -> list:
        """Render text and images identically in prose and list paragraphs."""
        story = []
        text_nodes = []
        pending_prefix = prefix

        def flush(*, before_image=False):
            nonlocal text_nodes, pending_prefix
            if not text_nodes and not pending_prefix:
                return
            style = (_style("list", leftIndent=10, firstLineIndent=-9 if pending_prefix else 0,
                            keepWithNext=before_image)
                     if prefix else _style("body"))
            story.append(Paragraph(_text(pending_prefix) + self.inline(text_nodes), style))
            text_nodes = []
            pending_prefix = ""

        for child in children:
            if child["type"] == "image":
                flush(before_image=True)
                story.extend(self.image(child))
            else:
                text_nodes.append(child)
        flush()
        return story

    def blocks(self, nodes: list[dict]) -> list:
        story = []
        for node in nodes:
            kind = node["type"]
            children = node.get("children", [])
            if kind in {"paragraph", "block_text"}:
                story.extend(self.paragraph(children))
            elif kind == "heading":
                level = node.get("attrs", {}).get("level", 2)
                story.append(Paragraph(self.inline(children), _style("heading", fontName="ResearchSansBold", fontSize=16 if level <= 2 else 12, leading=23 if level <= 2 else 19, textColor=BLUE, spaceBefore=14, keepWithNext=True)))
            elif kind == "list":
                start = node.get("attrs", {}).get("start", 1)
                for index, child in enumerate(children):
                    prefix = f"{start + index}. " if node.get("attrs", {}).get("ordered") else "• "
                    parts = child.get("children", [])
                    if parts and parts[0]["type"] in {"paragraph", "block_text"}:
                        story.extend(self.paragraph(parts[0].get("children", []), prefix=prefix))
                        story.extend(self.blocks(parts[1:]))
                    else:
                        story.extend(self.blocks(parts))
            elif kind == "table":
                rows = []
                for section in children:
                    if section["type"] == "table_head":
                        rows.append([_plain(cell.get("children", [])) for cell in section["children"]])
                    else:
                        rows.extend([_plain(cell.get("children", [])) for cell in row["children"]] for row in section.get("children", []))
                story.extend([_table(rows), Spacer(1, 10)])
            elif kind == "block_code":
                code = node.get("raw", "").rstrip()
                story.append(Paragraph(_text(code).replace(" ", "&#160;"), _style("code", fontSize=7.5, leading=11, spaceBefore=7, spaceAfter=14, backColor=PALE, borderPadding=5)))
            elif kind == "block_quote":
                story.extend(self.blocks(children))
            elif kind == "thematic_break":
                story.append(Spacer(1, 12))
            elif kind not in {"blank_line"}:
                raw = node.get("raw", "")
                if raw:
                    story.append(Paragraph(_text(raw), _style("literal")))
                elif children:
                    story.extend(self.blocks(children))
        return story


def render_document(target: Path, *, title: str, content: str, metadata: dict[str, str], image_resolver=None, cover_only=False, include_footer=True) -> None:
    """A4 cover, running brand header, embedded Chinese fonts and numbered body."""
    _fonts()
    target.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(str(target), pagesize=A4, title=title, author=f"东吴证券 · {BRANCH}", subject=f"研究成果 · {TEMPLATE_VERSION}", creator="投研工作台", leftMargin=20 * mm, rightMargin=20 * mm)
    frame = Frame(20 * mm, 26 * mm, 170 * mm, 236 * mm, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="cover", frames=frame, onPage=lambda c, _: _header(c)), PageTemplate(id="body", frames=frame, onPage=lambda c, _: _header(c))])
    parsed = _markdown(content)
    summary = next((_plain(node.get("children", [])) for node in parsed if node["type"] == "paragraph" and _plain(node.get("children", []))), "")
    story = [Spacer(1, 22 * mm), Paragraph("研 究 成 果", _style("eyebrow", fontSize=10, leading=16, textColor=BLUE, spaceAfter=18)), Paragraph(_text(title[:240]), _style("title", fontName="ResearchSansBold", fontSize=25, leading=36, textColor=BLUE, spaceAfter=22))]
    rows = [[key, value] for key, value in metadata.items() if value]
    if rows:
        story.extend([_table(rows, header=False, widths=[31 * mm, 139 * mm]), Spacer(1, 16 * mm)])
    if summary:
        story.extend([Paragraph("内容摘要", _style("summary_head", fontName="ResearchSansBold", fontSize=11, leading=18, textColor=BLUE)), Paragraph(_text(summary[:400] + ("…（全文见正文）" if len(summary) > 400 else "")), _style("summary", fontSize=10, leading=18))])
    if cover_only:
        doc.build(story, canvasmaker=_NumberedCanvas if include_footer else canvas.Canvas)
        return
    story.extend([NextPageTemplate("body"), PageBreak()])
    formatter = _Content(image_resolver)
    story.extend(formatter.blocks(parsed))
    if formatter.sources:
        story.append(Paragraph("引用来源", _style("sources_head", fontName="ResearchSansBold", fontSize=12, leading=18, textColor=BLUE, keepWithNext=True, spaceBefore=8)))
        story.extend(Paragraph(f"[{index}] {_text(url)}", _style("source", fontSize=8, leading=13)) for index, url in enumerate(formatter.sources, 1))
    doc.build(story, canvasmaker=_NumberedCanvas if include_footer else canvas.Canvas)


def _metadata(conversation_id: str, *, turn: dict | None = None, created_at: str = "") -> dict[str, str]:
    conversation = conversation_store.get_conversation(conversation_id, message_limit=1)
    scope = (turn or {}).get("research_scope") or {}
    stamp = created_at or (turn or {}).get("created_at") or conversation["created_at"]
    timestamp = _beijing_stamp(stamp)
    codes = scope.get("stock_codes") or []
    return {"研究截止日": str(scope.get("as_of") or "未指定"), "研究范围": "、".join(codes) if codes else "未限定股票", "记录时间": timestamp + "（北京时间）", "成果来源": f"研究对话 {conversation_id[:8]}", "模板版本": "v1.0"}


def _root(conversation_id: str, *, project=False, create=True) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", conversation_id):
        raise PDFError("成果归属标识无效")
    root = db.DB_PATH.parent.resolve() / "research-project-pdfs" / conversation_id if project else research_workspace.directory(conversation_id).parent / "deliverables"
    for part in (root, *root.parents):
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise PDFError("PDF 成果目录不能使用链接")
        if part == db.DB_PATH.parent.resolve():
            break
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return root


def _image_resolver(conversation_id: str, relative_to: str = "", *, read_only=False):
    def resolve(url: str):
        value = unquote(url).replace("\\", "/").replace("/research-assets/", "/research-files/")
        prefix = f"/api/v1/conversations/{conversation_id}/research-files/"
        workspace_prefix = f"/research/{conversation_id}/work/outputs/"
        if value.startswith(prefix):
            value = value[len(prefix):]
        elif value.startswith("outputs/"):
            value = value[8:]
        elif value.startswith("./outputs/"):
            value = value[10:]
        elif workspace_prefix in value:
            value = value.split(workspace_prefix, 1)[1]
        elif urlsplit(value).scheme or value.startswith("/"):
            return None
        elif relative_to:
            value = (Path(relative_to).parent / value).as_posix()
        try:
            if read_only:
                # Snapshotting runs inside a save transaction: never recover turns or open another writer.
                root = research_workspace.directory(conversation_id) / "outputs"
                path = root / value
                if not value or not path.resolve().is_relative_to(root.resolve()) or not path.is_file() or path.stat().st_nlink != 1:
                    return None
                for part in (path, *path.parents):
                    if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
                        return None
                    if part == db.DB_PATH.parent.resolve():
                        break
            else:
                path = research_workspace.output_path(conversation_id, value)
            return path if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif"} else None
        except research_workspace.WorkspaceError:
            return None
    return resolve


def _frozen_image_resolver(conversation_id: str, images: dict):
    def resolve(url: str):
        if images.get("__error__"):
            raise PDFError(f"图表输入保存失败：{images['__error__']}")
        saved = images.get(url)
        if not saved:
            return None
        root = _root(conversation_id, create=False) / "inputs"
        path = root / saved["input"]
        if root.is_symlink() or (hasattr(root, "is_junction") and root.is_junction()) or path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1 or sha256(path.read_bytes()).hexdigest() != saved["sha256"]:
            raise PDFError("保存的图表输入校验失败")
        return path
    return resolve


def _cached(conversation_id: str, name: str, signature: bytes, build: Callable[[Path], None], *, modified_at: float | None = None, project=False) -> dict:
    fingerprint = sha256(TEMPLATE_VERSION.encode() + signature).hexdigest()
    with _lock:
        root = _root(conversation_id, project=project)
        path = root / f"{fingerprint}.pdf"
        if path.is_symlink() or (path.exists() and path.stat().st_nlink != 1):
            raise PDFError("PDF 成果文件不能使用链接")
        if not path.exists():
            temporary = root / f"{fingerprint}-{uuid4().hex}.partial"
            try:
                build(temporary)
                if not temporary.read_bytes().startswith(b"%PDF-"):
                    raise PDFError("PDF 生成结果无效")
                conversation = conversation_store.get_conversation(conversation_id, message_limit=1) if not project else {}
                limit = research_mode_settings(conversation.get("research_mode", "research"), conversation.get("research_depth"))["max_output_file_bytes"]
                if temporary.stat().st_size > limit:
                    raise PDFError("PDF 超过当前研究深度的成果大小限制")
                os.replace(temporary, path)
            except Exception as exc:
                raise PDFError(f"PDF 生成失败：{str(exc)[:250]}") from exc
            finally:
                temporary.unlink(missing_ok=True)
        stat = path.stat()
        prefix = "research-projects" if project else "conversations"
        item = {"name": name, "bytes": stat.st_size, "modified_at": modified_at or stat.st_mtime, "media_type": "application/pdf", "template_version": TEMPLATE_VERSION, "url": f"/api/v1/{prefix}/{conversation_id}/research-pdfs/{fingerprint}.pdf"}
        manifest = root / f"{fingerprint}.json"
        if manifest.is_symlink() or (manifest.exists() and manifest.stat().st_nlink != 1):
            raise PDFError("PDF 成果索引不能使用链接")
        if not manifest.exists():
            temp_manifest = root / f"{fingerprint}-{uuid4().hex}.json.partial"
            try:
                temp_manifest.write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8")
                os.replace(temp_manifest, manifest)
            finally:
                temp_manifest.unlink(missing_ok=True)
        return item


def pdf_path(conversation_id: str, filename: str, *, project=False) -> tuple[Path, str]:
    if not re.fullmatch(r"[a-f0-9]{64}\.pdf", filename):
        raise PDFError("PDF 成果标识无效")
    root = _root(conversation_id, project=project, create=False)
    path = root / filename
    manifest = path.with_suffix(".json")
    if any(not p.is_file() or p.is_symlink() or p.stat().st_nlink != 1 for p in (path, manifest)):
        raise PDFError("PDF 成果不存在")
    item = json.loads(manifest.read_text(encoding="utf-8"))
    return path, item["name"]


def export_turn(conversation_id: str, turn_id: str, *, response_text: str | None = None, source_snapshot: dict | None = None) -> dict:
    turn = source_snapshot or conversation_store.get_turn(conversation_id, turn_id)
    if turn.get("workflow_type") != "research":
        raise PDFError("此回合不属于研究工作流")
    if response_text is None and turn["state"] not in {"succeeded", "awaiting_user"}:
        raise PDFError("研究回合尚未完成")
    content = response_text if response_text is not None else turn.get("response_text", "")
    if not content.strip():
        raise PDFError("研究答复为空")
    identity = sha256((TEMPLATE_VERSION + content).encode()).hexdigest()
    memo = _root(conversation_id) / f"turn-{turn_id}.json"
    with _lock:
        if memo.is_symlink() or (memo.exists() and memo.stat().st_nlink != 1):
            raise PDFError("研究报告索引不能使用链接")
        if memo.exists():
            previous = json.loads(memo.read_text(encoding="utf-8"))
            if previous["identity"] == identity:
                try:
                    pdf_path(conversation_id, previous["item"]["url"].rsplit("/", 1)[-1])
                    return previous["item"]
                except PDFError:
                    pass
    with db.connect() as connection:
        question = connection.execute("SELECT content FROM conversation_messages WHERE id=?", (turn["user_message_id"],)).fetchone()
    heading = next((_plain(node.get("children", [])) for node in _markdown(content) if node["type"] == "heading"), "")
    title = heading or (question[0].strip().splitlines()[0][:120] if question else "研究报告")
    meta = _metadata(conversation_id, turn=turn)
    meta["成果编号"] = turn_id[:8]
    name = f"研究报告-{_beijing_stamp(turn['created_at'])[:10].replace('-', '')}-{turn_id[:8]}.pdf"
    signature = json.dumps({"turn": turn_id, "content": content, "metadata": meta}, ensure_ascii=False).encode()
    with _lock:
        resolver = _frozen_image_resolver(conversation_id, source_snapshot.get("images", {})) if source_snapshot else _image_resolver(conversation_id)
        item = _cached(conversation_id, name, signature, lambda path: render_document(path, title=title, content=content, metadata=meta, image_resolver=resolver))
        temporary = memo.with_name(f"{memo.name}.{uuid4().hex}.partial")
        try:
            temporary.write_text(json.dumps({"identity": identity, "item": item}, ensure_ascii=False), encoding="utf-8")
            os.replace(temporary, memo)
        finally:
            temporary.unlink(missing_ok=True)
        return item


def _wrap_pdf(target: Path, data: bytes, *, title: str, metadata: dict) -> None:
    _fonts()
    original = PdfReader(BytesIO(data))
    if original.is_encrypted:
        raise PDFError("加密 PDF 无法套用固定模板，请提供可读取的文件")
    writer = PdfWriter()
    cover_path = target.with_name(f"cover-{uuid4().hex}.partial")
    try:
        render_document(cover_path, title=title, content="原始 PDF 内容保留在后续页面。本成果采用统一封面、标识、营业部名称和页码，原件信息及校验值记录于封面。", metadata=metadata, cover_only=True, include_footer=False)
        for page in PdfReader(cover_path).pages:
            writer.add_page(page)
    finally:
        cover_path.unlink(missing_ok=True)
    covers = len(writer.pages)
    total = covers + len(original.pages)
    for index, page in enumerate(writer.pages, 1):
        overlay = BytesIO()
        c = canvas.Canvas(overlay, pagesize=A4)
        _footer(c, index, total)
        c.save()
        page.merge_page(PdfReader(overlay).pages[0])
    for index, source in enumerate(original.pages, covers + 1):
        source.transfer_rotation_to_content()
        size = landscape(A4) if source.mediabox.width > source.mediabox.height else A4
        width, height = size
        page = writer.add_blank_page(width=width, height=height)
        factor = min((width - 40 * mm) / float(source.mediabox.width), (height - 62 * mm) / float(source.mediabox.height))
        source.annotations = None
        transform = Transformation().scale(factor).translate(20 * mm - float(source.mediabox.left) * factor, 26 * mm - float(source.mediabox.bottom) * factor)
        page.merge_transformed_page(source, transform)
        overlay = BytesIO()
        c = canvas.Canvas(overlay, pagesize=size)
        _header(c, size)
        _footer(c, index, total, size)
        c.save()
        page.merge_page(PdfReader(overlay).pages[0])
    writer.add_metadata({"/Title": title, "/Author": f"东吴证券 · {BRANCH}", "/Subject": TEMPLATE_VERSION})
    with target.open("wb") as output:
        writer.write(output)


def export_file(conversation_id: str, relative: str) -> dict:
    source = research_workspace.output_path(conversation_id, relative)
    return export_file_snapshot(conversation_id, relative, source.read_bytes(), modified_at=source.stat().st_mtime)


def export_file_snapshot(conversation_id: str, relative: str, data: bytes, *, modified_at: float, image_path: Path | None = None, images: dict | None = None) -> dict:
    suffix = Path(relative).suffix.lower()
    title = Path(relative).stem
    meta = _metadata(conversation_id, created_at=datetime.fromtimestamp(modified_at, timezone.utc).isoformat())
    meta.update({"原始文件": relative, "原件校验": sha256(data).hexdigest()})
    name = str(Path(relative).with_suffix(Path(relative).suffix + ".pdf")) if suffix != ".pdf" else relative
    def build(target):
        if suffix == ".pdf":
            _wrap_pdf(target, data, title=title, metadata=meta)
            return
        if suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
            content = f"# {title}\n\n![{title}](outputs/{relative})"
        elif suffix in {".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".html", ".htm"}:
            text = data.decode("utf-8-sig")
            if suffix in {".csv", ".tsv"}:
                rows = list(csv.reader(StringIO(text), delimiter="\t" if suffix == ".tsv" else ","))
                # JSON cells preserve pipes/newlines without corrupting Markdown tables.
                content = f"# {title}\n\n原始表格共 {max(0, len(rows) - 1)} 行数据。\n\n"
                for row_index, row in enumerate(rows):
                    content += "| " + " | ".join(value.replace("|", "\\|").replace("\n", " ") for value in row) + " |\n"
                    if row_index == 0:
                        content += "| " + " | ".join("---" for _ in row) + " |\n"
            elif suffix == ".json":
                content = f"# {title}\n\n```json\n{json.dumps(json.loads(text), ensure_ascii=False, indent=2)}\n```"
            elif suffix in {".html", ".htm"}:
                # Display HTML as source text; never execute imported document content.
                content = f"# {title}\n\n```html\n{text}\n```"
            else:
                content = text
        else:
            raise PDFError(f"暂不支持把 {suffix or '此格式'} 转成 PDF；原件已保留")
        resolver = (lambda _: image_path) if image_path is not None and suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp"} else _frozen_image_resolver(conversation_id, images) if images is not None else _image_resolver(conversation_id, relative)
        render_document(target, title=title, content=content, metadata=meta, image_resolver=resolver)
    return _cached(conversation_id, name, relative.encode() + data + (json.dumps(images, sort_keys=True).encode() if images else b""), build, modified_at=modified_at)


def cached_deliverables(owner_id: str, *, project=False) -> list[dict]:
    """Read existing PDF manifests only; browsing never creates directories or renders."""
    root = _root(owner_id, project=project, create=False)
    items = []
    for manifest in root.glob("*.json"):
        if not re.fullmatch(r"[a-f0-9]{64}\.json", manifest.name):
            continue
        try:
            if manifest.is_symlink() or manifest.stat().st_nlink != 1:
                continue
            item = json.loads(manifest.read_text(encoding="utf-8"))
            pdf_path(owner_id, manifest.with_suffix(".pdf").name, project=project)
            items.append({**item, "status": "succeeded"})
        except (OSError, ValueError, KeyError, PDFError):
            continue
    return items


def list_deliverables(conversation_id: str) -> list[dict]:
    from . import research_pdf_service
    return research_pdf_service.list_exports("conversation", conversation_id)


def export_scan(conversation_id: str, scan_id: str, *, source_snapshot: dict | None = None) -> dict:
    from . import research_scan_service
    scan = source_snapshot["scan"] if source_snapshot else research_scan_service.get_scan(conversation_id, scan_id)
    if scan["status"] in {"queued", "running"}:
        raise research_scan_service.ResearchScanError("scan_not_finished", "研究扫描仍在运行，请完成后导出。", 409)
    if source_snapshot:
        decisions = source_snapshot["decisions"]
    else:
        with db.connect() as connection:
            rows = connection.execute("SELECT decision_json FROM research_scan_decisions WHERE scan_id=? ORDER BY stock_code", (scan_id,)).fetchall()
        decisions = [db.json_load(row[0]) for row in rows]
    title = scan["name"]
    meta = {"研究截止日": scan["as_of"], "扫描编号": scan_id, "执行方式": scan["execution_mode"], "扫描状态": scan["status"], "结果有效": "是" if scan["result"].get("result_valid") else "否", "源数据校验": scan["program"]["source_sha256"]}
    content = f"# {title}\n\n本成果记录只读研究实验及其指标，未创建正式选股批次。\n\n## 逐股实验记录\n\n"
    for item in decisions:
        content += f"### {item['stock_code']}\n\n实验判据：{item['state']}；计算状态：{item['evaluation_status']}；原因代码：{item['reason_code']}；实际数据日期：{item.get('data_as_of') or '未记录'}。\n\n{item['explanation']}\n\n"
        if item.get("metrics"):
            content += "| 指标 | 数值 | 单位 |\n| --- | --- | --- |\n"
            for key, value in item["metrics"].items():
                content += f"| {key} | {value} | {item.get('units', {}).get(key, '')} |\n"
        content += "\n"
    signature = json.dumps({"scan": scan, "decisions": decisions}, ensure_ascii=False, sort_keys=True).encode()
    return _cached(conversation_id, f"研究扫描-{scan_id[:8]}.pdf", signature, lambda path: render_document(path, title=title, content=content, metadata=meta))


def export_note(project_id: str, note_id: str, *, revision: int | None = None, source_snapshot: dict | None = None) -> dict:
    from . import research_projects
    project = {"name": source_snapshot["project_name"]} if source_snapshot else research_projects.get_project(project_id)
    note = source_snapshot["note"] if source_snapshot else next((item for item in project["notes"] if item["id"] == note_id), None)
    if note is None:
        raise research_projects.ProjectError("找不到此研究笔记", 404)
    if revision is not None and note["revision"] != revision:
        note = next((item for item in research_projects.note_history(project_id, note_id) if item["revision"] == revision), None)
        if note is None:
            raise research_projects.ProjectError("找不到此笔记版本", 404)
    note = {key: value for key, value in note.items() if key not in {"pdf", "pdf_error", "claim_stock_codes"}}
    statuses = {"watching": "待验证", "supported": "得到支持", "challenged": "存在反证", "invalidated": "判断失效"}
    meta = {"研究项目": project["name"], "关联公司": note.get("stock_code") or "整个研究项目", "笔记版本": f"第 {note['revision']} 版", "人工观点状态": statuses[note["status"]], "记录时间": _beijing_stamp(note.get("updated_at", "")) + "（北京时间）", "来源对话": note.get("source_conversation_id") or "手工研究笔记", "来源消息": note.get("source_message_id") or ""}
    body = note["body"]
    if source_snapshot:
        claims = source_snapshot["claims"]
    else:
        with db.connect() as connection:
            rows = connection.execute("SELECT statement,kind,as_of,evidence_json FROM research_claims WHERE note_id=? AND note_revision=? ORDER BY rowid", (note_id, note["revision"])).fetchall()
        claims = [dict(row) for row in rows]
    if claims:
        kinds = {"fact": "事实陈述", "forecast": "预测", "inference": "推断"}
        stances = {"supports": "支持", "contradicts": "反方", "context": "背景", "support": "支持", "counter": "反方", "background": "背景"}
        body += "\n\n## 判断与原文依据\n\n分类及证据关系由用户标记；原文定位不等同于自动证实判断。\n\n"
        for claim in claims:
            body += f"### {kinds[claim['kind']]} · 截至 {claim['as_of']}\n\n{claim['statement']}\n\n"
            for evidence in db.json_load(claim["evidence_json"]):
                location = f"第 {evidence['page_number']} 页" if evidence.get("page_number") else f"原文位置 {evidence.get('quote_start', '')}–{evidence.get('quote_end', '')}"
                body += f"{stances.get(evidence.get('stance'), evidence.get('stance', ''))}：{evidence.get('title', '')} · {evidence.get('source_id', '')} · {location}\n\n> {evidence.get('quote', '')}\n\n"
    for label, key in [("接下来验证", "validation_plan"), ("判断失效条件", "invalidation_condition")]:
        if note.get(key):
            body += f"\n\n## {label}\n\n{note[key]}"
    cid = note.get("source_conversation_id")
    signature = json.dumps({"note": note, "metadata": meta, "claims": claims}, ensure_ascii=False, sort_keys=True).encode()
    resolver = _frozen_image_resolver(cid, source_snapshot.get("images", {})) if cid and source_snapshot else _image_resolver(cid) if cid else None
    return _cached(project_id, f"研究笔记-{note_id[:8]}-v{note['revision']}.pdf", signature, lambda path: render_document(path, title=note["title"], content=body, metadata=meta, image_resolver=resolver), project=True)
