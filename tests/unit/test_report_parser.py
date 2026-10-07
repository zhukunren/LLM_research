from pathlib import Path
from types import SimpleNamespace

import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from apps.api.app import report_parser


def _pdf(path: Path, *, encrypted: bool = False) -> Path:
    writer = PdfWriter()
    page = writer.add_blank_page(width=600, height=800)
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    })
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)}),
    })
    content = DecodedStreamObject()
    # Deliberately write the rightmost item first, as many PDF generators do.
    content.set_data(b"BT /F1 12 Tf 1 0 0 1 300 700 Tm (Right 42.1) Tj ET\n"
                     b"BT /F1 12 Tf 1 0 0 1 40 700 Tm (Left 2026) Tj ET\n")
    page[NameObject("/Contents")] = writer._add_object(content)
    writer.add_blank_page(width=600, height=800)
    if encrypted:
        writer.encrypt("protected")
    writer.write(path)
    return path


def test_default_layout_reorders_spatial_text_and_preserves_blank_page(tmp_path) -> None:
    source = _pdf(tmp_path / "report.pdf")
    before = source.read_bytes()
    assert PdfReader(source).pages[0].extract_text().index("Right") < PdfReader(source).pages[0].extract_text().index("Left")
    parsed = report_parser.parse_report(source)
    assert parsed.page_texts[0].index("Left 2026") < parsed.page_texts[0].index("Right 42.1")
    assert parsed.page_texts[1] == ""
    assert source.read_bytes() == before
    assert parsed.metadata["backend"] == "pypdf"
    assert parsed.metadata["page_count"] == 2
    assert parsed.metadata["extracted_chars"] == sum(map(len, parsed.page_texts))
    assert parsed.metadata["empty_pages"] == [2]
    assert parsed.metadata["fallback_pages"] == []
    assert parsed.metadata["pages"][1]["page_number"] == 2
    assert parsed.metadata["pages"][1]["warnings"]


def test_old_pypdf_compatibility_is_recorded(monkeypatch, tmp_path) -> None:
    class OldPage:
        def extract_text(self, **kwargs):
            assert kwargs == {}
            return "原文保留  12.3%\n第二行"
    monkeypatch.setattr(report_parser, "_pdf_reader", lambda _: SimpleNamespace(pages=[OldPage()]))
    parsed = report_parser.parse_report(_pdf(tmp_path / "report.pdf"))
    assert parsed.page_texts == ["原文保留  12.3%\n第二行"]
    assert parsed.metadata["fallback_pages"] == [1]
    assert parsed.metadata["pages"][0]["extraction_mode"] == "plain"
    assert "不支持" in parsed.metadata["pages"][0]["warnings"][0]


@pytest.mark.parametrize("layout_result", ["", RuntimeError("layout problem")])
def test_layout_failure_or_empty_result_has_explicit_fallback(monkeypatch, tmp_path, layout_result) -> None:
    class Page:
        def extract_text(self, *, extraction_mode="plain", **kwargs):
            if extraction_mode == "layout":
                if isinstance(layout_result, Exception):
                    raise layout_result
                return layout_result
            return "本期收入同比增长 15%。"
    monkeypatch.setattr(report_parser, "_pdf_reader", lambda _: SimpleNamespace(pages=[Page()]))
    parsed = report_parser.parse_report(_pdf(tmp_path / "report.pdf"))
    assert parsed.page_texts == ["本期收入同比增长 15%。"]
    assert parsed.metadata["fallback_pages"] == [1]
    assert parsed.metadata["pages"][0]["warnings"]


def test_all_extraction_errors_fail_instead_of_returning_blank_evidence(monkeypatch, tmp_path) -> None:
    class Page:
        def extract_text(self, *, extraction_mode="plain", **kwargs):
            raise RuntimeError("damaged content")
    monkeypatch.setattr(report_parser, "_pdf_reader", lambda _: SimpleNamespace(pages=[Page()]))
    with pytest.raises(report_parser.ReportParserError, match="第 1 页解析失败"):
        report_parser.parse_report(_pdf(tmp_path / "report.pdf"))


def test_password_protected_pdf_has_actionable_error(tmp_path) -> None:
    with pytest.raises(report_parser.ReportParserError, match="已加密"):
        report_parser.parse_report(_pdf(tmp_path / "report.pdf", encrypted=True))


def test_corrupt_pdf_has_actionable_error(tmp_path) -> None:
    source = tmp_path / "invalid.pdf"
    source.write_text("not a PDF")
    with pytest.raises(report_parser.ReportParserError, match="无法读取"):
        report_parser.parse_report(source)


def test_unknown_backend_is_rejected(tmp_path) -> None:
    with pytest.raises(report_parser.ReportParserError, match="仅支持"):
        report_parser.parse_report(tmp_path / "report.pdf", backend="automatic")


def test_docling_missing_dependency_never_falls_back(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(report_parser, "_package_version", lambda _: "unknown")
    monkeypatch.setattr(report_parser, "_parse_pypdf", lambda _: pytest.fail("unexpected fallback"))
    with pytest.raises(report_parser.ReportParserError, match="Docling 未安装"):
        report_parser.parse_report(_pdf(tmp_path / "report.pdf"), backend="docling")


def test_docling_artifacts_must_be_explicit_and_complete(tmp_path) -> None:
    with pytest.raises(report_parser.ReportParserError, match="必须指定"):
        report_parser._docling_artifacts(None)
    with pytest.raises(report_parser.ReportParserError, match="目录不存在"):
        report_parser._docling_artifacts(tmp_path / "not-created")
    with pytest.raises(report_parser.ReportParserError, match="本地模型不完整"):
        report_parser._docling_artifacts(tmp_path)


def _fake_docling(monkeypatch, *, status="success", page_numbers=(1, 2), items=()):
    captured = {}
    class Table:
        def __init__(self, cells, page):
            self.data = SimpleNamespace(table_cells=cells)
            self.prov = [SimpleNamespace(page_no=page)]
    class Document:
        pages = dict.fromkeys(page_numbers)
        def iterate_items(self, **kwargs):
            captured["iteration_options"] = kwargs
            return [(item, 0) for item in items]
    class Converter:
        def __init__(self, **kwargs):
            captured["converter_options"] = kwargs
        def convert(self, source, **kwargs):
            captured["conversion_options"] = kwargs
            return SimpleNamespace(status=status, document=Document())
    def options(**kwargs):
        return SimpleNamespace(**kwargs)
    apis = (
        SimpleNamespace(DocumentConverter=Converter, PdfFormatOption=options),
        SimpleNamespace(PdfPipelineOptions=options, EasyOcrOptions=options,
                        LayoutObjectDetectionOptions=SimpleNamespace(from_preset=lambda value: value)),
        SimpleNamespace(InputFormat=SimpleNamespace(PDF="pdf"),
                        ConversionStatus=SimpleNamespace(SUCCESS="success")),
        SimpleNamespace(TableItem=Table, ContentLayer=SimpleNamespace(BODY="body", FURNITURE="furniture")),
    )
    monkeypatch.setattr(report_parser, "_load_docling", lambda: apis)
    monkeypatch.setattr(report_parser, "_docling_artifacts", lambda _: Path("C:/local/models"))
    return captured, Table


def test_docling_configures_offline_chinese_ocr_and_preserves_source_pages(monkeypatch, tmp_path) -> None:
    item = SimpleNamespace(orig="原文 12.3%", text="格式化文本", prov=[SimpleNamespace(page_no=2)])
    captured, _ = _fake_docling(monkeypatch, items=[item])
    parsed = report_parser.parse_report(_pdf(tmp_path / "report.pdf"), backend="docling", docling_artifacts_path="local")
    assert parsed.page_texts == ["", "原文 12.3%"]
    options = captured["converter_options"]["format_options"]["pdf"].pipeline_options
    assert options.enable_remote_services is False
    assert options.allow_external_plugins is False
    assert options.ocr_options.download_enabled is False
    assert options.ocr_options.lang == ["ch_sim", "en"]
    assert options.artifacts_path == Path("C:/local/models")
    assert options.do_code_enrichment is False
    assert captured["conversion_options"] == {"raises_on_error": True}
    assert captured["iteration_options"]["traverse_pictures"] is True
    assert parsed.metadata["backend"] == "docling"
    assert parsed.metadata["remote_services"] is False


@pytest.mark.parametrize("status,page_numbers,reason", [
    ("partial_success", (1, 2), "未完整解析"),
    ("success", (1,), "页码与源 PDF 不一致"),
])
def test_docling_incomplete_conversion_is_rejected(monkeypatch, tmp_path, status, page_numbers, reason) -> None:
    _fake_docling(monkeypatch, status=status, page_numbers=page_numbers)
    monkeypatch.setattr(report_parser, "_parse_pypdf", lambda _: pytest.fail("unexpected fallback"))
    with pytest.raises(report_parser.ReportParserError, match=reason):
        report_parser.parse_report(_pdf(tmp_path / "report.pdf"), backend="docling", docling_artifacts_path="local")


def test_docling_table_cells_have_source_text_without_markdown(monkeypatch) -> None:
    _, Table = _fake_docling(monkeypatch)
    cells = [SimpleNamespace(start_row_offset_idx=0, start_col_offset_idx=1, text="12.3%"),
             SimpleNamespace(start_row_offset_idx=0, start_col_offset_idx=0, text="毛利率")]
    table = Table(cells, 1)
    apis = report_parser._load_docling()
    document = SimpleNamespace(iterate_items=lambda **_: [(table, 0)])
    assert report_parser._docling_page_texts(document, 2, apis[3]) == ["毛利率\t12.3%", ""]


def test_docling_ambiguous_page_provenance_is_rejected(monkeypatch) -> None:
    _fake_docling(monkeypatch)
    item = SimpleNamespace(orig="不能分辨页码", prov=[SimpleNamespace(page_no=1), SimpleNamespace(page_no=2)])
    document = SimpleNamespace(iterate_items=lambda **_: [(item, 0)])
    with pytest.raises(report_parser.ReportParserError, match="唯一的来源页码"):
        report_parser._docling_page_texts(document, 2, report_parser._load_docling()[3])
