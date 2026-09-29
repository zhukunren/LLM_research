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
