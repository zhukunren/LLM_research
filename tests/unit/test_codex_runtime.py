from __future__ import annotations

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
    }
    overrides = codex_runtime._provider_overrides(settings)
    assert any(item.startswith("model_provider=") for item in overrides)
    assert any("proxy.example/v1" in item for item in overrides)
    assert all("private-test-key" not in item for item in overrides)
    assert "mcp_servers.llm_research" in " ".join(codex_runtime._mcp_overrides())


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

