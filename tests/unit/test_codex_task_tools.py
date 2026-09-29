from __future__ import annotations

from apps.api.app import conversation_store, db, screening_tools
from apps.api.app.model_client import FunctionCall


def _task(conversation_id: str) -> dict:
    return {
        "task_id": conversation_id,
        "revision": 1,
        "original_user_messages": ["收盘价高于20日均线，筛一下"],
        "conditions": [{
            "condition_id": "ma",
            "library": "technical",
            "source_quote": "收盘价高于20日均线",
            "description": "收盘价高于20日均线",
            "expression": {},
            "implementation_id": "llm-python-screen",
            "implementation_version": "python-screen-v1",
            "program": {
                "contract_version": "python-screen-v1",
                "source_code": "def screen(context, frames, params):\n    return {'decisions': {code: None for code in context['stock_codes']}}",
                "required_fields": ["close"],
                "required_history_bars": 2,
                "parameters": {},
                "parameter_specs": {},
            },
        }],
        "references": [{"reference_id": "r1", "condition_id": "ma"}],
        "logic_tree": {"op": "condition", "reference_id": "r1"},
        "scope": {
            "universe": {"kind": "explicit", "stock_codes": ["600000.SH"]},
            "as_of": "2026-09-14",
        },
        "unresolved": [],
    }


def test_codex_task_tools_save_revision_and_authorize_only_current_explicit_request(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "codex-task-tools.db")
    db.init_db()
    conversation = conversation_store.create_conversation("screening")
    message = conversation_store.add_user_message(
        conversation["id"], "codex-task-message", 0, "收盘价高于20日均线，筛一下"
    )
    conversation_store.start_turn(conversation["id"], message["turn_id"])
    context = screening_tools.ToolContext(
        conversation_id=conversation["id"],
        turn_id=message["turn_id"],
        task_revision=0,
    )
    proposed = screening_tools.registry.dispatch(
        FunctionCall("proposal-1", "propose_screening_task", {"task": _task(conversation["id"])}),
        context,
    )
    assert proposed["ok"] is True
    assert proposed["result"]["task_revision"] == 1

    current = screening_tools.ToolContext(
        conversation_id=conversation["id"],
        turn_id=message["turn_id"],
        task_revision=1,
        as_of="2026-09-14",
        universe_kind="explicit",
        stock_codes=frozenset({"600000.SH"}),
    )
    authorized = screening_tools.registry.dispatch(
        FunctionCall("authorize-1", "authorize_screening_execution", {"revision": 1}),
        current,
    )
    assert authorized["ok"] is True
    assert authorized["result"]["ready_to_execute"] is True
    assert conversation_store.get_pending_execute_message(conversation["id"]) == message["message_id"]


def test_codex_task_tool_repairs_structural_aliases_but_keeps_missing_scope_unresolved(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "codex-task-repair.db")
    db.init_db()
    conversation = conversation_store.create_conversation("screening")
    message = conversation_store.add_user_message(
        conversation["id"], "codex-task-repair", 0, "请保存筛选草稿：收盘价高于20日均线。"
    )
    conversation_store.start_turn(conversation["id"], message["turn_id"])
    context = screening_tools.ToolContext(conversation["id"], message["turn_id"], 0)
    result = screening_tools.registry.dispatch(
        FunctionCall("proposal-repair", "propose_screening_task", {"task": {
            "task_id": "model-draft",
            "revision": 1,
            "original_user_messages": ["请保存筛选草稿：收盘价高于20日均线。"],
            "scope": {"markets": None, "universe": None, "as_of": None},
            "conditions": [{
                "condition_id": "close-above-sma20",
                "condition_type": "technical",
                "name": "收盘价高于20日均线",
                "program": {"contract_version": "python-screen-v1"},
            }],
            "references": [],
            "logic_tree": {"operator": "AND", "children": [{"condition_id": "close-above-sma20"}]},
            "unresolved": [{"field": "scope", "reason": "未指定筛选范围"}],
        }}),
        context,
    )
    assert result["ok"] is True, result
    assert result["result"]["task_revision"] == 1
    saved = conversation_store.get_task_revision(conversation["id"], 1)
    assert saved.unresolved
    assert saved.unresolved[0].kind in {"unsupported", "clarification"}
    assert saved.logic_tree == {
        "op": "all",
        "children": [{"op": "condition", "reference_id": "r-close-above-sma20"}],
    }

