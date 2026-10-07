"""Page-preserving PDF extraction, with an explicitly selected offline Docling backend.

This module never reads application settings or writes an index. Existing page text
is therefore unaffected by a parser upgrade; callers choose when to import a file.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from importlib import import_module
from importlib.metadata import PackageNotFoundError, version
from inspect import signature
from pathlib import Path
from typing import Any

from pypdf import PdfReader


DOCLING_VERSION = "2.133.0"
_EMPTY_PAGE_WARNING = "未提取到文本：可能为空白页或扫描页，请检查原 PDF。"


class ReportParserError(ValueError):
    """A report could not be extracted with the selected parser."""


@dataclass(frozen=True)
class ParsedReport:
    # List position + 1 always equals the original PDF page number.
    page_texts: list[str]
    metadata: dict[str, Any]


def parse_report(
    path: str | Path,
    *,
    backend: str = "pypdf",
    docling_artifacts_path: str | Path | None = None,
) -> ParsedReport:
    """Extract all pages without dropping blank pages or synthesizing source text.

    The default backend attempts spatial layout extraction; a page-level plain
    extraction fallback is recorded explicitly. Selecting Docling never falls
    back to pypdf. Its local layout, table and Chinese/English OCR models must
    already exist: no model download is performed by this module.
    """
    if backend not in {"pypdf", "docling"}:
        raise ReportParserError("研报解析器仅支持 pypdf 或 docling")
    source = Path(path)
    if not source.is_file():
        raise ReportParserError("研报 PDF 文件不存在")
    if backend == "docling":
        return _parse_docling(source, docling_artifacts_path)
    return _parse_pypdf(source)


def _package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "unknown"


def _pdf_reader(source: Path) -> Any:
    try:
        reader = PdfReader(source, strict=False)
        if reader.is_encrypted and not reader.decrypt(""):
            raise ReportParserError("研报 PDF 已加密，需提供未加密的副本")
        if not len(reader.pages):
            raise ReportParserError("研报 PDF 没有页面")
        return reader
    except ReportParserError:
        raise
    except Exception as exc:
        raise ReportParserError(f"无法读取研报 PDF：{str(exc)[:200]}") from exc


def _metadata(
    backend: str, page_texts: list[str], pages: list[dict[str, Any]], **extra: Any
) -> dict[str, Any]:
    backend_version = _package_version(backend)
    if backend == "docling" and backend_version == "unknown":
        backend_version = _package_version("docling-slim")
    return {
        "schema_version": 1,
        "backend": backend,
        "backend_version": backend_version,
        "page_count": len(page_texts),
        "extracted_chars": sum(map(len, page_texts)),
        "empty_pages": [i for i, text in enumerate(page_texts, 1) if not text],
        "fallback_pages": [page["page_number"] for page in pages if page.get("fallback")],
        "pages": pages,
        **extra,
    }


def _parse_pypdf(source: Path) -> ParsedReport:
    reader = _pdf_reader(source)
    texts: list[str] = []
    pages: list[dict[str, Any]] = []
    for number, page in enumerate(reader.pages, 1):
        page_warnings: list[str] = []
        mode = "layout"
        fallback = False
        # Older pypdf releases can accept **kwargs while ignoring extraction_mode.
        # Inspect the explicit parameter instead of assuming that call acceptance
        # means the requested layout mode was applied.
        supports_layout = "extraction_mode" in signature(page.extract_text).parameters
        has_content = not isinstance(page, Mapping) or bool(page.get("/Contents"))
        text = ""
        if supports_layout and has_content:
            try:
                text = (page.extract_text(
                    extraction_mode="layout",
                    layout_mode_space_vertically=False,
                    layout_mode_strip_rotated=False,
                ) or "").strip()
            except Exception as exc:
                fallback = True
                page_warnings.append(f"版面解析失败，改用普通文本：{str(exc)[:180]}")
        elif not supports_layout:
            fallback = True
            page_warnings.append("当前 pypdf 不支持版面模式，改用普通文本。")
        if has_content and (fallback or not text):
            try:
                plain_text = (page.extract_text() or "").strip()
            except Exception as exc:
                raise ReportParserError(f"研报第 {number} 页解析失败：{str(exc)[:180]}") from exc
            if fallback or plain_text:
                if not fallback:
                    page_warnings.append("版面模式未读取到文本，改用普通文本。")
                mode, fallback, text = "plain", True, plain_text
        if not text:
            page_warnings.append(_EMPTY_PAGE_WARNING)
        texts.append(text)
        pages.append({
            "page_number": number, "extraction_mode": mode,
            "extracted_chars": len(text), "fallback": fallback,
            "warnings": page_warnings,
        })
    return ParsedReport(texts, _metadata("pypdf", texts, pages, requested_mode="layout", ocr=False))


def _load_docling() -> tuple[Any, Any, Any, Any]:
    installed = _package_version("docling")
    if installed == "unknown":
        installed = _package_version("docling-slim")
    if installed != DOCLING_VERSION:
        raise ReportParserError(
            f"Docling 未安装或版本不兼容（当前 {installed}）。"
            f"请安装可选依赖 docling[easyocr]=={DOCLING_VERSION}，并准备本地模型。"
        )
    try:
        return (
            import_module("docling.document_converter"),
            import_module("docling.datamodel.pipeline_options"),
            import_module("docling.datamodel.base_models"),
            import_module("docling_core.types.doc"),
        )
    except ImportError as exc:
        raise ReportParserError("Docling 可选依赖不完整，请安装 docling[easyocr] 及 PDF 解析依赖。") from exc


def _docling_artifacts(value: str | Path | None) -> Path:
    if not value:
        raise ReportParserError("选择 Docling 时必须指定已准备好的本地模型目录；不自动下载模型。")
    artifacts = Path(value).resolve()
    if not artifacts.is_dir():
        raise ReportParserError("Docling 本地模型目录不存在；不自动下载模型。")
    # Required by the explicitly configured Heron/accurate/EasyOCR pipeline.
    required = [
        "docling-project--docling-layout-heron/config.json",
        "docling-project--docling-layout-heron/preprocessor_config.json",
        "docling-project--docling-layout-heron/model.safetensors",
        "docling-project--docling-models/model_artifacts/tableformer/accurate/tm_config.json",
        "docling-project--docling-models/model_artifacts/tableformer/accurate/tableformer_accurate.safetensors",
        "EasyOcr/craft_mlt_25k.pth",
        "EasyOcr/zh_sim_g2.pth",
    ]
    missing = [name for name in required if not (artifacts / name).is_file()]
    if missing:
        raise ReportParserError(
            f"Docling 本地模型不完整，缺少 {missing[0]}"
            f"（共 {len(missing)} 个文件）；请预先准备模型，不自动下载。"
        )
    return artifacts


def _parse_docling(source: Path, artifacts_path: str | Path | None) -> ParsedReport:
    converter_api, options_api, models_api, doc_types = _load_docling()
    artifacts = _docling_artifacts(artifacts_path)
    page_count = len(_pdf_reader(source).pages)
    try:
        # The selected Docling version resolves Heron/table models from the
        # supplied artifacts path and fails if they are absent. EasyOCR has its
        # own explicit download switch. Remote services alone do not block
        # model downloads, so both local artifacts and this switch are required.
        options = options_api.PdfPipelineOptions(
            artifacts_path=artifacts,
            enable_remote_services=False,
            allow_external_plugins=False,
            do_ocr=True,
            do_table_structure=True,
            do_code_enrichment=False,
            do_formula_enrichment=False,
            do_picture_classification=False,
            do_picture_description=False,
            do_chart_extraction=False,
            document_timeout=120,
            layout_options=options_api.LayoutObjectDetectionOptions.from_preset("layout_heron_default"),
            ocr_options=options_api.EasyOcrOptions(
                lang=["ch_sim", "en"], download_enabled=False,
                model_storage_directory=str(artifacts / "EasyOcr"),
            ),
        )
        converter = converter_api.DocumentConverter(
            allowed_formats=[models_api.InputFormat.PDF],
            format_options={
                models_api.InputFormat.PDF: converter_api.PdfFormatOption(pipeline_options=options),
            },
        )
        result = converter.convert(source, raises_on_error=True)
        if result.status != models_api.ConversionStatus.SUCCESS:
            raise ReportParserError("Docling 未完整解析全部页面；未建立索引，请检查 PDF 或本地模型。")
        if set(result.document.pages) != set(range(1, page_count + 1)):
            raise ReportParserError("Docling 返回的页码与源 PDF 不一致；未建立索引。")
        texts = _docling_page_texts(result.document, page_count, doc_types)
    except ReportParserError:
        raise
    except Exception as exc:
        raise ReportParserError(f"Docling 离线解析失败（不会切换解析器）：{str(exc)[:200]}") from exc
    pages = [
        {"page_number": number, "extraction_mode": "layout_ocr",
         "extracted_chars": len(text), "fallback": False,
         "warnings": [] if text else [_EMPTY_PAGE_WARNING]}
        for number, text in enumerate(texts, 1)
    ]
    return ParsedReport(texts, _metadata(
        "docling", texts, pages, ocr=True, ocr_languages=["ch_sim", "en"],
        layout_model="layout_heron_default", table_structure=True,
        model_downloads=False, remote_services=False, text_format="source_blocks",
    ))


def _docling_page_texts(document: Any, page_count: int, doc_types: Any) -> list[str]:
    blocks: list[list[str]] = [[] for _ in range(page_count)]
    # Include headers/footers and OCR children of pictures. Render source text
    # and table cells directly; Markdown decoration is not quoted as evidence.
    for item, _ in document.iterate_items(
        traverse_pictures=True,
        included_content_layers={doc_types.ContentLayer.BODY, doc_types.ContentLayer.FURNITURE},
    ):
        text = getattr(item, "orig", None) or getattr(item, "text", None)
        if isinstance(item, doc_types.TableItem):
            cells = sorted(item.data.table_cells, key=lambda c: (c.start_row_offset_idx, c.start_col_offset_idx))
            rows: dict[int, list[str]] = {}
            for cell in cells:
                rows.setdefault(cell.start_row_offset_idx, []).append(cell.text)
            text = "\n".join("\t".join(cells) for cells in rows.values())
        if not isinstance(text, str) or not text.strip():
            continue
        page_numbers = {provenance.page_no for provenance in item.prov}
        if len(page_numbers) != 1:
            raise ReportParserError("Docling 文本缺少唯一的来源页码，无法作为页级证据保存。")
        number = page_numbers.pop()
        if number < 1 or number > page_count:
            raise ReportParserError("Docling 文本的来源页码超出源 PDF。")
        blocks[number - 1].append(text.strip())
    return ["\n\n".join(page) for page in blocks]
