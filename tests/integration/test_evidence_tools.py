from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from apps.api.app import db, main, evidence_sources
from apps.api.app.tool_protocol import ToolCall
from apps.api.app.screening_tools import ToolContext, registry


@pytest.fixture
def context(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "evidence.db")
    with TestClient(main.app) as client:
        conversation = client.post("/api/v1/conversations", json={"entry_scope": "report"}).json()
        message = client.post(f"/api/v1/conversations/{conversation['id']}/messages", json=dict(
            client_message_id="evidence-read", base_revision=0, content="读取公司研报",
        )).json()
        with db.connect() as connection:
            for name, available, status in [("long", "2026-09-12", "confirmed"),
                                             ("short", "2026-09-10", "confirmed"),
                                             ("future", "2026-09-15", "confirmed"),
                                             ("old", "2025-01-01", "confirmed"),
                                             ("unknown", "2026-09-10", "filename_candidate")]:
                text = "A" * 12000 + "订单\n  同比增长20%。" if name == "long" else "本期订单增长。"
                connection.execute("""INSERT INTO documents(
                    id,sha256,filename,title,stock_code,pages,extracted_chars,parse_status,source_path,
                    imported_at,stock_code_status,available_at,available_at_status)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (name, name, name + ".pdf", name, "600000.SH", 1, len(text), "indexed", "synthetic",
                     db.utc_now(), "confirmed", available, status))
                connection.execute("INSERT INTO document_pages(document_id,page_number,text) VALUES(?,1,?)", (name, text))
        yield ToolContext(conversation_id=conversation["id"], turn_id=message["turn_id"], task_revision=0,
                          as_of="2026-09-14", universe_kind="explicit", stock_codes=frozenset({"600000.SH"}),
                          report_lookback_calendar_days=30)


def read(context, call_id, source="long", offset=0, page=1, stock="600000.SH"):
    return registry.dispatch(ToolCall(call_id, "read_evidence_chunk", dict(
        source_id=source, page_number=page, stock_code=stock, offset=offset, limit=12000,
    )), context)


def test_long_page_can_be_read_to_the_end_without_claiming_full_corpus(context):
    first = read(context, "first")["result"]
    second = read(context, "second", offset=first["next_offset"])["result"]
    assert first["next_offset"] == 12000 and first["coverage"]["page_complete"] is False
    assert second["next_offset"] is None and second["char_start"] == 12000
    assert second["coverage"]["corpus_read_complete"] is False
    citation = evidence_sources.locate_quote(second, "订单 同比增长20%")
    assert citation["char_start"] == 12000
    assert citation["quote"] == "订单\n  同比增长20%"


def test_source_listing_is_scoped_paginated_and_does_not_count_as_reading(context):
    def listing(call_id, offset, selected_context=context):
        return registry.dispatch(ToolCall(call_id, "list_report_sources", dict(
            stock_code="600000.SH", offset=offset, limit=1)), selected_context)["result"]
    first = listing("list-1", 0)
    second = listing("list-2", first["next_offset"])
    assert first["total"] == 2 and first["items"][0]["source_id"] == "long"
    assert second["items"][0]["source_id"] == "short" and second["next_offset"] is None
    assert first["coverage"]["read_pages"] == 0
    selected = listing("selected", 0, replace(context, allowed_document_ids=frozenset({"short"})))
    assert selected["total"] == 1 and selected["items"][0]["source_id"] == "short"


@pytest.mark.parametrize("source,code", [("future", "source_ineligible"), ("unknown", "source_ineligible"),
                                        ("old", "source_outside_lookback")])
def test_ineligible_dates_are_rejected_without_returning_text(context, source, code):
    result = read(context, source, source=source)
    assert result["ok"] is False and result["error"]["code"] == code
    assert "text" not in result


def test_cross_security_document_scope_and_invalid_page_are_rejected(context):
    both = replace(context, stock_codes=frozenset({"600000.SH", "600001.SH"}))
    assert read(both, "wrong-stock", stock="600001.SH")["error"]["code"] == "source_ineligible"
    limited = replace(context, allowed_document_ids=frozenset({"short"}))
    assert read(limited, "wrong-doc")["error"]["code"] == "document_outside_scope"
    assert read(context, "wrong-page", page=2)["error"]["code"] == "source_page_not_found"
    assert read(context, "wrong-offset", offset=99999)["error"]["code"] == "offset_out_of_range"


def test_changed_text_does_not_validate_a_quote_that_is_no_longer_present(context):
    with db.connect() as connection:
        connection.execute("UPDATE document_pages SET text='新资料只有预测。' WHERE document_id='short'")
    current = read(context, "changed", source="short")["result"]
    with pytest.raises(evidence_sources.EvidenceSourceError):
        evidence_sources.locate_quote(current, "本期订单增长")


def test_existing_page_tool_also_respects_lookback(context):
    result = registry.dispatch(ToolCall("legacy-lookback", "read_report_page", dict(
        document_id="old", page_number=1, stock_code="600000.SH")), context)
    assert result["ok"] is True
    assert result["result"]["text"] is None
    assert result["result"]["eligible_for_historical_screening"] is False
