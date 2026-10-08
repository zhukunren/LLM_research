"""Workflow separation must survive real tool dispatch and historical plans."""
from dataclasses import replace
from datetime import date
import json

import pytest
import pyarrow as pa
import pyarrow.parquet as pq

from apps.api.app import codex_context, codex_runtime, conversation_store, db, market, research_tools, screening_tools
from apps.api.app.screening_contracts import ResearchScope, ScreeningTaskRevision
from apps.api.app.tool_protocol import ToolCall


@pytest.fixture
def research_context(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "workflow-tools.db")
    source = tmp_path / "market.parquet"
    pq.write_table(pa.Table.from_pylist([{
        "stock_code": "600000.SH", "trade_date": date(2026, 9, 14),
        "open": 10., "high": 11., "low": 9., "close": 10., "volume": 100., "amount": 1000.,
    }]), source)
    monkeypatch.setattr(market, "STOCK_FILE", source)
    db.init_db()
    cid = conversation_store.create_conversation("screening", workflow_type="screening")["id"]
    previous = conversation_store.add_user_message(cid, "old-plan", 0, "先保存旧范围，不执行。")
    old_task = ScreeningTaskRevision(task_id=cid, revision=1, original_user_messages=["先保存旧范围，不执行。"],
                                    scope={"as_of": "2026-01-01", "universe": {"kind": "explicit", "stock_codes": ["600001.SH"]}})
    conversation_store.save_task_revision(cid, 0, previous["message_id"], old_task)
    conversation_store.finish_turn(cid, previous["turn_id"], 1, "succeeded", "旧范围已保留。", {})
    conversation_store.update_workflow(cid, workflow_type="research", research_depth="deep")
    conversation_store.update_research_scope(cid, 0, ResearchScope(as_of="2026-09-14", stock_codes=["600000.SH"]))
    current = conversation_store.add_user_message(cid, "research-question", 1, "研究当前公司。", research_scope_revision=1)
    conversation_store.start_turn(cid, current["turn_id"])
    return codex_context.task_tool_context(cid, current["turn_id"], 1, old_task, [])


def test_research_scope_is_independent_and_old_plan_is_not_in_the_prompt(research_context, monkeypatch):
    context = research_context
    assert context.workflow_type == "research" and context.research_depth == "deep"
    assert context.as_of == "2026-09-14" and context.stock_codes == frozenset({"600000.SH"})
    observed = {}
    def bars(code, as_of, limit):
        observed.update(code=code, as_of=as_of, limit=limit)
        return []
    monkeypatch.setattr(market, "get_bars", bars)
    reply = screening_tools.registry.dispatch(ToolCall("bars", "read_market_window", {"stock_code": "600000.SH", "limit": 5}), context)
    assert reply["ok"] and observed["as_of"] == "2026-09-14"
    assert observed["code"] == "600000.SH"
    prompt = json.loads(codex_runtime._prompt(context.conversation_id, context.turn_id))
    assert prompt["confirmed_screening_task"] is None and prompt["task_revision"] == 0
    assert prompt["research_scope"]["stock_codes"] == ["600000.SH"]
    assert prompt["research_budget"]["turn_timeout_seconds"] >= 3600


def test_research_tool_results_do_not_depend_on_screening_revision(research_context):
    context = research_context
    with db.connect() as connection:
        connection.execute("UPDATE conversations SET task_revision=7 WHERE id=?", (context.conversation_id,))
    result = screening_tools.registry.dispatch(ToolCall("state", "get_research_state", {}), context)
    assert result["ok"] and result["result"]["task"] is None
    assert result["result"]["task_revision"] == 0
    assert result["result"]["research_scope_revision"] == 1


def test_research_does_not_expose_or_dispatch_screening_commands(research_context, monkeypatch):
    from apps.api.app import capability_service
    monkeypatch.setattr(capability_service, "screening_capability_manifest", lambda: {"capabilities": []})
    context = research_context
    names = {tool.name for tool in screening_tools.registry.tools_for_codex(context)}
    assert not names.intersection(screening_tools.SCREENING_WORKFLOW_TOOLS)
    assert "start_research_scan" in names and "search_research_sources" in names
    result = screening_tools.registry.dispatch(ToolCall("forbidden", "execute_screening_task", {"revision": 1}), context)
    assert result["error"]["code"] == "screening_workflow_required"
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM screening_task_runs").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM execution_requests").fetchone()[0] == 0


def test_open_research_omits_fixed_cutoff_evidence_tools_but_keeps_open_readers(research_context, monkeypatch):
    from apps.api.app import capability_service
    monkeypatch.setattr(capability_service, "screening_capability_manifest", lambda: {"capabilities": [
        {"id": "report.page_search", "availability": "available"},
        {"id": "news.local_search", "availability": "available"},
    ]})
    open_context = replace(research_context, as_of=None, stock_codes=None)
    open_names = {tool.name for tool in screening_tools.registry.tools_for_codex(open_context)}
    fixed = {"list_report_sources", "read_evidence_chunk", "list_news_sources", "read_news_chunk"}
    assert not open_names.intersection(fixed)
    assert {"search_research_sources", "read_research_source", "search_report_pages", "read_report_page"} <= open_names
    historical_names = {tool.name for tool in screening_tools.registry.tools_for_codex(research_context)}
    assert fixed <= historical_names
    screening_names = {tool.name for tool in screening_tools.registry.tools_for_codex(replace(open_context, workflow_type="screening"))}
    assert fixed <= screening_names


def test_open_followup_uses_current_time_reference_without_reinstating_old_scope(research_context, monkeypatch):
    context = research_context
    monkeypatch.setattr(codex_runtime, "_current_shanghai_time", lambda: "2026-10-08T09:00:00+08:00")
    conversation_store.finish_turn(context.conversation_id, context.turn_id, 0, "succeeded", "截至2026-09-14，仅研究600000.SH。", {})
    cleared = conversation_store.update_research_scope(context.conversation_id, 1, ResearchScope(
        as_of=None, stock_codes=[], report_lookback_calendar_days=None, news_lookback_calendar_days=None, price_basis=None,
    ))
    followup = conversation_store.add_user_message(context.conversation_id, "today-open", 0, "今天有哪些重要的产业政策？",
                                                   research_scope_revision=cleared["research_scope_revision"])
    prompt = json.loads(codex_runtime._prompt(context.conversation_id, followup["turn_id"]))
    assert prompt["research_scope"] == ResearchScope().model_dump(mode="json")
    assert prompt["research_time_reference"] == {
        "current_time": "2026-10-08T09:00:00+08:00", "timezone": "Asia/Shanghai", "is_cutoff": False,
    }
    assert prompt["current_user_request"] == "今天有哪些重要的产业政策？"
    assert any("2026-09-14" in message["content"] for message in prompt["conversation_history"])
    followup_context = codex_context.task_tool_context(context.conversation_id, followup["turn_id"], 0, None, [])
    assert followup_context.as_of is None and followup_context.stock_codes is None
    assert conversation_store.get_turn(context.conversation_id, context.turn_id)["research_scope"]["as_of"] == "2026-09-14"
    # The reference clock is prompt context, not a mutation of the frozen scope.
    assert conversation_store.get_turn(context.conversation_id, followup["turn_id"])["research_scope"]["as_of"] is None


def test_forged_workflow_and_research_scope_are_rejected(research_context):
    context = research_context
    forged = replace(context, workflow_type="screening")
    result = screening_tools.registry.dispatch(ToolCall("forged-workflow", "get_research_state", {}), forged)
    assert result["error"]["code"] == "workflow_conflict"
    changed_scope = replace(context, as_of="2026-09-30")
    result = screening_tools.registry.dispatch(ToolCall("forged-scope", "get_research_state", {}), changed_scope)
    assert result["error"]["code"] == "research_scope_conflict"


def test_research_market_reads_reject_outside_securities_and_future_dates(research_context):
    context = research_context
    for call_id, arguments, expected in [
        ("outside", {"stock_code": "600001.SH", "limit": 5}, "security_outside_research_scope"),
        ("future", {"stock_code": "600000.SH", "limit": 5, "as_of": "2026-09-15"}, "date_outside_research_scope"),
    ]:
        result = screening_tools.registry.dispatch(ToolCall(call_id, "read_market_window", arguments), context)
        assert result["error"]["code"] == expected


def test_research_scan_inherits_its_own_scope_without_creating_a_plan(research_context, monkeypatch):
    observed = {}
    def enqueue(cid, tid, **arguments):
        observed.update(arguments)
        return {"scan_id": "research-only"}
    monkeypatch.setattr(research_tools.research_scan_service, "enqueue_scan", enqueue)
    args = research_tools.StartResearchScanArgs(name="指标比较", program={
        "contract_version": "python-screen-v1", "source_code": "def screen(context, frames, params):\n    return {'decisions': {code: None for code in context['stock_codes']}}",
        "required_fields": ["close"], "required_history_bars": 2,
    })
    assert research_tools.start_research_scan(args, research_context)["scan_id"] == "research-only"
    assert observed["as_of"] == date(2026, 9, 14)
    assert observed["universe"] == "explicit" and observed["stock_codes"] == ["600000.SH"]


def test_research_tool_source_filters_inherit_the_frozen_scope(research_context, monkeypatch):
    observed = {}
    def listing(query, as_of, stock_code, **options):
        observed.update(as_of=as_of, stock_codes=options.get("stock_codes"))
        return {"items": [], "total": 0}
    monkeypatch.setattr(research_tools.documents, "search_source_catalog", listing)
    args = research_tools.SearchSourcesArgs(kind="report", query="订单", stock_code=None, as_of=None, offset=0, limit=5)
    result = research_tools.search_sources(args, research_context)
    assert result["total"] == 0
    assert observed["as_of"] == "2026-09-14" and observed["stock_codes"] == frozenset({"600000.SH"})


def test_research_completion_does_not_publish_an_old_screening_grant(research_context, monkeypatch):
    context = research_context
    monkeypatch.setattr(codex_runtime, "run_conversation_turn", lambda *_: {
        "response": "研究计算完成。", "thread_id": "test-thread", "codex_turn_id": "test-turn", "event_count": 1, "model": "synthetic",
    })
    result = codex_runtime.process_conversation_turn(context.conversation_id, context.turn_id)
    assert result["state"] == "succeeded"
    assert result["result"]["workflow_type"] == "research"
    assert result["result"]["execution_authorized"] is False and result["result"]["ready_to_execute"] is False
    assert result["result"]["task_revision"] == 0
