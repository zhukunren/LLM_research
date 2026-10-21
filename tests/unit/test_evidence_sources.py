import pytest

from apps.api.app.evidence_sources import EvidenceSourceError, locate_quote, normalize_with_offsets


def test_normalization_maps_whitespace_back_to_exact_original_characters():
    text = "前言：订单\n  同比增长  20%。"
    normalized, spans = normalize_with_offsets(text)
    assert normalized == "前言：订单 同比增长 20%。"
    assert len(normalized) == len(spans)
    chunk = dict(source_type="report", source_id="doc", stock_code="600000.SH", page_number=2,
                 char_start=100, text=text)
    citation = locate_quote(chunk, "订单 同比增长 20%")
    assert citation["quote"] == "订单\n  同比增长  20%"
    assert text[citation["char_start"] - 100:citation["char_end"] - 100] == citation["quote"]


def test_duplicate_quote_needs_an_explicit_location_and_missing_quote_fails():
    chunk = dict(source_type="report", source_id="doc", stock_code="600000.SH", page_number=1,
                 char_start=20, text="订单增长；订单增长")
    with pytest.raises(EvidenceSourceError, match="唯一定位"):
        locate_quote(chunk, "订单增长")
    assert locate_quote(chunk, "订单增长", start_hint=25)["char_start"] == 25
    with pytest.raises(EvidenceSourceError):
        locate_quote(chunk, "收入增长")


def test_pdf_han_line_wrapping_preserves_exact_source_spans_when_locating_a_quote():
    text = "摘要：实现归\n属于上市公司股东的净利润   318.53亿元、同比增长 5.44%。"
    chunk = dict(source_type="report", source_id="annual", stock_code="000858.SZ", page_number=12, char_start=100, text=text)
    located = locate_quote(chunk, "实现归属于上市公司股东的净利润 318.53亿元、同比增长 5.44%。")
    assert located["char_start"] == 103
    assert located["quote"] == text[3:]
    assert text[located["char_start"] - 100:located["char_end"] - 100] == located["quote"]


def test_han_wrapping_does_not_resolve_ambiguous_or_rephrased_quotes():
    chunk = dict(source_type="report", source_id="annual", stock_code="000858.SZ", page_number=12, char_start=0,
                 text="归母净利润318亿元；归母净\n利润318亿元")
    with pytest.raises(EvidenceSourceError, match="唯一定位"):
        locate_quote(chunk, "归母净利润318亿元")
    assert locate_quote(chunk, "归母净利润318亿元", start_hint=len("归母净利润318亿元；"))["quote"] == "归母净\n利润318亿元"
    with pytest.raises(EvidenceSourceError):
        locate_quote({**chunk, "text": "营业收入 审计程序说明\n发生额为100万元"}, "营业收入发生额为100万元")
