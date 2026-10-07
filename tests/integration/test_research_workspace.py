from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3

import pytest
from fastapi.testclient import TestClient

from apps.api.app import conversation_store, db, main, market, research_workspace, screening_tools, worker
from apps.api.app.tool_protocol import ToolCall
from apps.api.app.news_sources import NewsImport, import_items


@pytest.fixture
def research(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "research.db")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "missing.parquet")
    db.init_db()
    cid = conversation_store.create_conversation("screening")["id"]
    msg = conversation_store.add_user_message(cid, "request", 0, "比较资料并实际计算，不创建正式筛选。")
    conversation_store.start_turn(cid, msg["turn_id"])
    return cid, msg["turn_id"]


def test_workspace_exports_originals_without_application_tables_and_keeps_outputs(research):
    cid, tid = research
    import_items(NewsImport.model_validate({"request_id": "news", "items": [{
        "title": "原始资讯", "body": "完成投产，保留完整正文。", "source": "合成",
        "available_at": "2026-09-10T10:00:00+08:00", "stock_codes": []}]}))
    manifest = research_workspace.prepare(cid, tid)
    with closing(sqlite3.connect(manifest["sources"]["sqlite"])) as connection:
        names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert names == {"reports", "report_pages", "news"}
        assert connection.execute("SELECT body FROM news").fetchone()[0] == "完成投产，保留完整正文。"
    output = Path(manifest["outputs"]) / "result.csv"
    output.write_text("return\n0.2\n", encoding="utf-8")
    repeated = research_workspace.prepare(cid, tid)
    assert repeated["workspace"] == manifest["workspace"]
    assert output.read_text() == "return\n0.2\n"
    assert research_workspace.list_outputs(cid)[0]["name"] == "result.csv"
    assert conversation_store.get_conversation(cid)["task_revision"] == 0


def test_downloads_enforce_workspace_boundary_and_never_serve_executable_html_inline(research, tmp_path):
    cid, tid = research
    manifest = research_workspace.prepare(cid, tid)
    output = Path(manifest["outputs"]) / "result.html"
    output.write_text("<script>test()</script>", encoding="utf-8")
    conversation_store.finish_turn(cid, tid, 0, "succeeded", "研究完成", {})
    other = conversation_store.create_conversation("screening")["id"]
    with TestClient(main.app) as client:
        listing = client.get(f"/api/v1/conversations/{cid}/research-files").json()
        assert not any(item["name"] == "result.html.pdf" for item in listing["items"])
        # Reading the list does not perform rendering. An explicit generation
        # request discovers the old source and its worker creates the PDF.
        requested = client.post(f"/api/v1/conversations/{cid}/research-pdf-jobs", json={"request_id": "generate-existing"})
        assert requested.status_code == 200
        for _ in range(10):
            if not worker.execute_job(kinds=("research_pdf",)):
                break
        listing = client.get(f"/api/v1/conversations/{cid}/research-files").json()
        item = next(item for item in listing["items"] if item["name"] == "result.html.pdf")
        response = client.get(item["url"])
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pdf"
        assert response.content.startswith(b"%PDF-")
        assert response.headers["content-disposition"].startswith("attachment")
        assert response.headers["x-content-type-options"] == "nosniff"
        assert client.get(f"/api/v1/conversations/{other}/research-files/result.html").status_code == 404
    with pytest.raises(research_workspace.WorkspaceError):
        research_workspace.output_path(cid, "../../research.db")
    outside = tmp_path / "outside.txt"
    outside.write_text("private")
    link = Path(manifest["outputs"]) / "hardlink.txt"
    os.link(outside, link)
    with pytest.raises(research_workspace.WorkspaceError):
        research_workspace.output_path(cid, "hardlink.txt")
    assert [item["name"] for item in research_workspace.list_outputs(cid)] == ["result.html"]


def test_advanced_mode_allows_larger_outputs_and_exposes_its_budget(research, monkeypatch):
    from apps.api.app import codex_runtime
    from apps.api.app.settings import research_mode_settings
    cid, tid = research
    monkeypatch.setenv("LLMR_RESEARCH_MAX_OUTPUT_FILE_BYTES", "1024")
    manifest = research_workspace.prepare(cid, tid)
    output = Path(manifest["outputs"]) / "result.csv"
    output.write_bytes(b"x" * 2048)
    with pytest.raises(research_workspace.WorkspaceError, match="大小限制"):
        research_workspace.output_path(cid, "result.csv")
    conversation_store.finish_turn(cid, tid, 0, "succeeded", "普通研究完成", {})
    conversation_store.update_workflow(cid, research_depth="deep")
    # The completed ordinary turn keeps its frozen depth; a new turn receives
    # the independently selected deeper budget.
    assert json.loads(codex_runtime._prompt(cid, tid, manifest))["research_depth"] == "standard"
    message = conversation_store.add_user_message(cid, "deep-request", 0, "继续深入研究。")
    tid = message["turn_id"]
    conversation_store.start_turn(cid, tid)
    manifest = research_workspace.prepare(cid, tid)
    assert research_workspace.output_path(cid, "result.csv") == output.resolve()
    prompt = json.loads(codex_runtime._prompt(cid, tid, manifest))
    assert prompt["research_mode"] == "advanced"
    assert prompt["research_budget"]["turn_timeout_seconds"] >= 3600
    assert research_mode_settings("advanced")["max_output_file_bytes"] >= 200 * 1024 * 1024


def test_open_research_reads_sources_without_screening_revision_and_enforces_requested_cutoff(research):
    cid, tid = research
    item = import_items(NewsImport.model_validate({"request_id": "news", "items": [{
        "title": "投产消息", "body": "已投产", "source": "合成",
        "available_at": "2026-09-15T10:00:00+08:00", "stock_codes": []}]}))["items"][0]
    context = screening_tools.ToolContext(cid, tid, 0, workflow_type="research")
    args = dict(kind="news", source_id=item["id"], page_number=1, offset=0, limit=100, as_of=None)
    result = screening_tools.registry.dispatch(ToolCall("read", "read_research_source", args), context)
    assert result["ok"] and result["result"]["text"] == "已投产"
    past = screening_tools.registry.dispatch(ToolCall("past", "read_research_source", {**args, "as_of": "2026-09-14"}), context)
    assert past["error"]["code"] == "source_after_cutoff"
    assert conversation_store.get_conversation(cid)["task_revision"] == 0


def test_research_can_exceed_twelve_calls_and_respects_explicit_budget(research, monkeypatch):
    cid, tid = research
    monkeypatch.setenv("LLMR_RESEARCH_MAX_TOOL_CALLS", "0")
    context = screening_tools.ToolContext(cid, tid, 0, workflow_type="research")
    for index in range(15):
        result = screening_tools.registry.dispatch(ToolCall(f"call-{index}", "get_research_state", {}), context)
        assert result["ok"], result
    monkeypatch.setenv("LLMR_RESEARCH_MAX_TOOL_CALLS", "15")
    result = screening_tools.registry.dispatch(ToolCall("over-budget", "get_research_state", {}), context)
    assert result["error"]["code"] == "tool_call_limit"


def test_historical_source_discovery_uses_the_revision_available_at_the_cutoff(research):
    cid, tid = research
    first = {"title": "投产消息", "body": "计划投产", "source": "合成",
             "available_at": "2026-09-10T10:00:00+08:00", "stock_codes": []}
    original = import_items(NewsImport.model_validate({"request_id": "v1", "items": [first]}))["items"][0]
    later = {**first, "body": "已经投产", "available_at": "2026-09-20T10:00:00+08:00"}
    import_items(NewsImport.model_validate({"request_id": "v2", "items": [later]}), base_id=original["id"])
    context = screening_tools.ToolContext(cid, tid, 0, workflow_type="research")
    result = screening_tools.registry.dispatch(ToolCall("search-history", "search_research_sources", {
        "kind": "news", "query": "投产", "stock_code": None, "as_of": "2026-09-14", "offset": 0, "limit": 20,
    }), context)
    assert result["ok"] and result["result"]["total"] == 1
    assert result["result"]["items"][0]["id"] == original["id"]


def test_cancel_retains_files_rejects_late_results_and_allows_followup(research):
    cid, tid = research
    manifest = research_workspace.prepare(cid, tid)
    (Path(manifest["outputs"]) / "partial.md").write_text("研究笔记", encoding="utf-8")
    with TestClient(main.app) as client:
        url = f"/api/v1/conversations/{cid}/turns/{tid}/cancel"
        assert client.post(url).json()["state"] == "cancelled"
        assert client.post(url).json()["state"] == "cancelled"
    with pytest.raises(conversation_store.ConversationConflict):
        conversation_store.finish_turn(cid, tid, 0, "succeeded", "迟到结果", {})
    assert research_workspace.list_outputs(cid)[0]["name"] == "partial.md"
    followup = conversation_store.add_user_message(cid, "continue", 0, "继续研究")
    assert followup["state"] == "awaiting_agent"


def test_data_discovery_exposes_actual_schema_and_unknown_units(research, tmp_path, monkeypatch):
    from datetime import datetime
    import pyarrow as pa
    import pyarrow.parquet as pq
    cid, tid = research
    source = tmp_path / "market.parquet"
    pq.write_table(pa.Table.from_pylist([{
        "stock_code": "600000.SH", "trade_date": datetime(2026, 9, 14),
        "open": 10., "high": 12., "low": 9., "close": 11., "volume": 100., "amount": 1000.,
    }]), source)
    monkeypatch.setattr(market, "STOCK_FILE", source)
    result = screening_tools.registry.dispatch(ToolCall("discover", "discover_research_data", {}),
                                               screening_tools.ToolContext(cid, tid, 0, workflow_type="research"))
    assert result["ok"], result
    data = result["result"]
    assert {item["name"]: item["type"] for item in data["market"]["columns"]}["close"] == "double"
    assert data["market"]["first_date"] == data["market"]["last_date"] == "2026-09-14"
    assert data["market"]["volume_unit"] == data["market"]["price_basis"] == "unknown"
    assert {item["name"] for item in data["sources"]["schemas"]["report_pages"]} == {"document_id", "page_number", "text"}
    assert conversation_store.get_conversation(cid)["task_revision"] == 0


def test_tushare_saves_the_complete_returned_page_without_credentials(research, monkeypatch):
    from apps.api.app import research_tools
    cid, tid = research
    monkeypatch.setattr(research_tools.tushare_sync, "create_client", lambda: object())
    monkeypatch.setattr(research_tools.tushare_sync, "_query", lambda *_args, **_kwargs: [{"close": index} for index in range(250)])
    context = screening_tools.ToolContext(cid, tid, 0, workflow_type="research")
    call = ToolCall("external", "query_tushare", {"api_name": "daily", "params": {"trade_date": "20260914"}, "limit": 10})
    result = screening_tools.registry.dispatch(call, context)
    assert result["ok"], result
    page = result["result"]
    assert len(page["items"]) == 10 and page["received"] == 250
    saved = json.loads(Path(page["artifact"]["path"]).read_text(encoding="utf-8"))
    assert len(saved["items"]) == 250
    assert saved["params"] == {"trade_date": "20260914"}
    assert "api_key" not in json.dumps(saved)
    replay = screening_tools.registry.dispatch(call, context)
    assert replay["result"]["artifact"] == page["artifact"]
    assert len(research_workspace.list_outputs(cid)) == 1
