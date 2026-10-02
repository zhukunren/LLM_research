from __future__ import annotations

import pytest

from apps.api.app import codex_runtime, codex_store, conversation_store, db
from apps.api.app.screening_contracts import ScreeningTaskRevision


def _task(conversation_id: str) -> ScreeningTaskRevision:
    return ScreeningTaskRevision.model_validate({
        "task_id": conversation_id,
        "revision": 1,
        "original_user_messages": ["收盘价高于20日均线，筛一下"],
        "conditions": [{
            "condition_id": "ma", "library": "technical",
            "source_quote": "收盘价高于20日均线", "description": "收盘价高于20日均线",
            "expression": {},
            "implementation_id": "llm-python-screen", "implementation_version": "python-screen-v1",
            "program": {
                "contract_version": "python-screen-v1",
                "source_code": "def screen(context, frames, params):\n    return {'decisions': {code: None for code in context['stock_codes']}}",
                "required_fields": ["close"], "required_history_bars": 2,
                "parameters": {}, "parameter_specs": {},
            },
        }],
        "references": [{"reference_id": "r1", "condition_id": "ma"}],
        "logic_tree": {"op": "condition", "reference_id": "r1"},
        "scope": {"universe": {"kind": "explicit", "stock_codes": ["600000.SH"]}, "as_of": "2026-09-14"},
        "unresolved": [],
    })


def test_codex_overrides_keep_credentials_out_of_runtime_configuration(monkeypatch, tmp_path):
    monkeypatch.setattr(codex_runtime, "PROJECT_ROOT", tmp_path)
    settings = {
        "base_url": "https://proxy.example/v1",
        "model": "gpt-6-luna",
        "api_key": "private-test-key",
        "reasoning_effort": "max",
    }
    overrides = codex_runtime._provider_overrides(settings)
    assert any(item.startswith("model_provider=") for item in overrides)
    assert any("proxy.example/v1" in item for item in overrides)
    assert all("private-test-key" not in item for item in overrides)
    assert 'model_reasoning_effort="max"' in overrides
    assert "mcp_servers.llm_research" in " ".join(codex_runtime._mcp_overrides())
    workspace_overrides = codex_runtime._workspace_overrides(tmp_path)
    assert 'sandbox_workspace_write.network_access=true' in workspace_overrides
    assert all("private-test-key" not in item for item in workspace_overrides)


def test_tushare_research_query_is_scoped_and_bounded(monkeypatch):
    from apps.api.app import research_tools
    from apps.api.app.screening_tools import ToolDispatchError

    observed = {}
    monkeypatch.setattr(research_tools.tushare_sync, "create_client", lambda: object())
    def query(client, api_name, **params):
        observed.update({"api_name": api_name, "params": params})
        return [{"ts_code": "000001.SZ", "close": index} for index in range(250)]
    monkeypatch.setattr(research_tools.tushare_sync, "_query", query)
    result = research_tools.query_tushare(research_tools.TushareQueryArgs(
        api_name="daily", params={"ts_code": "000001.SZ", "start_date": "20260901"}, limit=10, save_to_file=False), None)
    assert observed == {"api_name": "daily", "params": {"ts_code": "000001.SZ", "start_date": "20260901"}}
    assert result["returned"] == 10 and result["received"] == 250 and result["truncated"]
    assert "api_key" not in str(result)
    with pytest.raises(ToolDispatchError, match="接口未开放"):
        research_tools.query_tushare(research_tools.TushareQueryArgs(
            api_name="unknown", params={"ts_code": "000001.SZ"}), None)
    with pytest.raises(ToolDispatchError, match="证券代码或查询日期"):
        research_tools.query_tushare(research_tools.TushareQueryArgs(
            api_name="daily", params={}), None)


def test_research_program_error_can_be_repaired_in_the_same_turn(tmp_path, monkeypatch):
    from apps.api.app import market
    from apps.api.app.screening_tools import ToolContext, registry
    from apps.api.app.tool_protocol import ToolCall
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "preview.db")
    db.init_db()
    cid = conversation_store.create_conversation("screening")["id"]
    msg = conversation_store.add_user_message(cid, "preview", 0, "验证收盘价高于20日均线的程序")
    conversation_store.start_turn(cid, msg["turn_id"])
    task = _task(cid)
    task.conditions[0].program.source_code = "def screen(context, frames, params):\n    return missing_variable"
    conversation_store.save_task_revision(cid, 0, msg["message_id"], task, turn_id=msg["turn_id"])
    monkeypatch.setattr(market, "get_bars", lambda *_: [
        {"trade_date": "2026-09-13", "close": 10., "quality_valid": True},
        {"trade_date": "2026-09-14", "close": 12., "quality_valid": True},
    ])
    monkeypatch.setattr(market, "latest_market_date", lambda *_: "2026-09-14")
    context = ToolContext(cid, msg["turn_id"], 1, as_of="2026-09-14", universe_kind="explicit", stock_codes=frozenset({"600000.SH"}))
    args = {"revision": 1, "reference_id": "r1", "stock_codes": ["600000.SH"]}
    failed = registry.dispatch(ToolCall("broken", "preview_screening_program", args), context)
    assert failed["error"]["code"] == "program_preview_failed"
    assert "missing_variable" in failed["error"]["message"]
    task.revision = 2
    task.conditions[0].program.source_code = "def screen(context, frames, params):\n    return {'decisions': {code: True for code in context['stock_codes']}}"
    conversation_store.save_task_revision(cid, 1, msg["message_id"], task, turn_id=msg["turn_id"])
    from dataclasses import replace
    repaired = registry.dispatch(ToolCall("fixed", "preview_screening_program", {**args, "revision": 2}), replace(context, task_revision=2))
    assert repaired["ok"], repaired
    assert repaired["result"]["results"]["600000.SH"]["state"] == "true"
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM screening_task_runs").fetchone()[0] == 0


def test_resumed_codex_gets_workspace_model_effort_and_only_final_answer(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from apps.api.app import market
    import openai_codex
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "runtime.db")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "missing.parquet")
    db.init_db()
    cid = conversation_store.create_conversation("screening")["id"]
    msg = conversation_store.add_user_message(cid, "run", 0, "读取资料")
    conversation_store.start_turn(cid, msg["turn_id"])
    codex_store.bind_thread(cid, "previous-thread", "old-model", "test")
    observed = {}

    class FakeCodex:
        def __init__(self, config):
            observed["config"] = config
            self._client = SimpleNamespace()
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def thread_resume(self, thread_id, **kwargs):
            observed["resume"] = kwargs
            return SimpleNamespace(id=thread_id, turn=self.turn)
        def turn(self, inputs, **kwargs):
            observed["turn"] = kwargs
            events = [
                SimpleNamespace(method="item/completed", payload={"item": {"type": "agentMessage", "phase": "commentary", "text": "读取中"}}),
                SimpleNamespace(method="item/completed", payload={"item": {"type": "agentMessage", "phase": "final_answer", "text": "已核对原文"}}),
                SimpleNamespace(method="turn/completed", payload={"turn": {"status": "completed"}}),
            ]
            return SimpleNamespace(id="native-turn", stream=lambda: iter(events))

    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
    monkeypatch.setattr(codex_runtime, "llm_settings", lambda: {"model": "configured-model", "base_url": "https://example.invalid", "api_key": "secret", "reasoning_effort": "max"})
    monkeypatch.setattr(codex_runtime, "_sdk", lambda: (openai_codex.ApprovalMode, FakeCodex, openai_codex.CodexConfig, openai_codex.Sandbox, openai_codex.SkillInput, openai_codex.TextInput))
    result = codex_runtime.run_conversation_turn(cid, msg["turn_id"])
    assert result["response"] == "已核对原文"
    assert observed["resume"]["model"] == "configured-model"
    assert observed["resume"]["sandbox"] == openai_codex.Sandbox.workspace_write
    assert observed["turn"]["effort"] == "max"
    assert observed["turn"]["cwd"] == str(tmp_path / "research" / cid / "work")
    assert "sandbox" not in observed["turn"]  # Preserve the configured writable roots on turn/start.


def test_codex_events_are_append_only_and_cursor_paginates(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "codex.db")
    db.init_db()
    conversation = conversation_store.create_conversation("screening")
    message = conversation_store.add_user_message(
        conversation["id"], "client-1", 0, "先解释行情覆盖。"
    )
    conversation_store.start_turn(conversation["id"], message["turn_id"])
    codex_store.bind_thread(conversation["id"], "thread-1", "gpt-6-luna", "0.159.0")
    codex_store.append_event(
        conversation["id"], message["turn_id"], "thread-1", "turn-1", 0,
        "turn/started", {"status": "inProgress"},
    )
    codex_store.append_event(
        conversation["id"], message["turn_id"], "thread-1", "turn-1", 1,
        "item/completed", {"item": {"type": "agentMessage", "text": "已读取覆盖信息。"}},
    )

    first = codex_store.list_events(conversation["id"], message["turn_id"], after=-1, limit=1)
    second = codex_store.list_events(
        conversation["id"], message["turn_id"], after=first["next_after"], limit=10
    )
    assert [item["sequence"] for item in first["items"]] == [0]
    assert first["has_more"] is True
    assert [item["sequence"] for item in second["items"]] == [1]
    assert second["items"][0]["payload"]["item"]["text"] == "已读取覆盖信息。"


def test_codex_finish_turn_publishes_structured_execution_state_after_tool_mutations(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "codex-finish.db")
    db.init_db()
    conversation = conversation_store.create_conversation("screening")
    message = conversation_store.add_user_message(
        conversation["id"], "client-2", 0, "收盘价高于20日均线，筛一下"
    )
    conversation_store.start_turn(conversation["id"], message["turn_id"])
    task = _task(conversation["id"])
    conversation_store.save_task_revision(conversation["id"], 0, message["message_id"], task)
    conversation_store.set_pending_execute_message(conversation["id"], 1, message["message_id"])
    monkeypatch.setattr(
        codex_runtime,
        "run_conversation_turn",
        lambda *_: {
            "thread_id": "thread-2", "codex_turn_id": "turn-2", "event_count": 3,
            "model": "gpt-6-luna", "response": "已核对条件，可以开始筛选。",
        },
    )

    result = codex_runtime.process_conversation_turn(conversation["id"], message["turn_id"])
    assert result["state"] == "succeeded"
    assert result["result"]["task_revision"] == 1
    assert result["result"]["execution_authorized"] is True
    assert result["result"]["ready_to_execute"] is True


def test_failure_after_task_mutation_finishes_turn_and_allows_followup(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "failure.db")
    db.init_db()
    cid = conversation_store.create_conversation("screening")["id"]
    message = conversation_store.add_user_message(cid, "request", 0, "收盘价高于20日均线，筛一下")
    conversation_store.start_turn(cid, message["turn_id"])

    def fail_after_mutation(*_):
        conversation_store.save_task_revision(cid, 0, message["message_id"], _task(cid))
        conversation_store.set_pending_execute_message(cid, 1, message["message_id"])
        raise codex_runtime.CodexRuntimeError("模拟传输中断")

    monkeypatch.setattr(codex_runtime, "run_conversation_turn", fail_after_mutation)
    with pytest.raises(codex_runtime.CodexRuntimeError, match="模拟传输中断"):
        codex_runtime.process_conversation_turn(cid, message["turn_id"])
    turn = conversation_store.get_turn(cid, message["turn_id"])
    assert turn["state"] == "failed"
    assert turn["result"]["ready_to_execute"] is False
    assert conversation_store.get_task_revision(cid, 1).revision == 1
    assert conversation_store.get_pending_execute_message(cid) is None
    assert conversation_store.fail_turn(cid, message["turn_id"], "迟到异常") is False
    next_message = conversation_store.add_user_message(cid, "followup", 1, "先解释一下条件")
    assert next_message["state"] == "awaiting_agent"
    assert conversation_store.get_turn(cid, message["turn_id"])["response_text"] == "模拟传输中断"


def test_expired_turn_recovers_without_overwriting_live_or_completed_turns(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "recovery.db")
    db.init_db()
    cid = conversation_store.create_conversation("screening")["id"]
    message = conversation_store.add_user_message(cid, "interrupted", 0, "筛一下")
    conversation_store.start_turn(cid, message["turn_id"])
    conversation_store.save_task_revision(cid, 0, message["message_id"], _task(cid))
    conversation_store.set_pending_execute_message(cid, 1, message["message_id"])
    other = conversation_store.create_conversation("screening")["id"]
    live = conversation_store.add_user_message(other, "live", 0, "解释行情")
    conversation_store.start_turn(other, live["turn_id"])
    with db.connect() as connection:
        connection.execute("UPDATE conversation_turns SET updated_at='2000-01-01' WHERE id=?", (message["turn_id"],))
    assert conversation_store.heartbeat_turn(cid, message["turn_id"]) is False
    assert conversation_store.heartbeat_turn(other, live["turn_id"]) is True

    # Read after a restart or page reload reclaims only the expired processor.
    recovered = conversation_store.get_conversation(cid)
    assert recovered["turns"][0]["state"] == "failed"
    assert recovered["turns"][0]["result"]["error_code"] == "turn_interrupted"
    assert recovered["pending_execution"] is False
    assert conversation_store.get_turn(other, live["turn_id"])["state"] == "running"
    with pytest.raises(conversation_store.ConversationConflict):
        conversation_store.finish_turn(cid, message["turn_id"], 1, "succeeded", "迟到结果", {})
    with pytest.raises(conversation_store.ConversationConflict):
        conversation_store.save_task_revision(cid, 1, message["message_id"], _task(cid).model_copy(update={"revision": 2}),
                                             turn_id=message["turn_id"])
    with pytest.raises(conversation_store.ConversationConflict):
        conversation_store.set_pending_execute_message(cid, 1, message["message_id"], turn_id=message["turn_id"])
    assert conversation_store.recover_expired_turns() == 0
    assert len(conversation_store.get_conversation(cid)["messages"]) == 2
    assert conversation_store.add_user_message(cid, "resumed", 1, "继续")["state"] == "awaiting_agent"
