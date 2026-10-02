from __future__ import annotations

from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from apps.api.app import conversation_store, db, main, screening_tools
from apps.api.app.tool_protocol import ToolCall
from apps.api.app.screening_contracts import ScreeningTaskRevision, combine_logic_tree
from apps.api.app.screening_contracts import ScreeningTaskRevision, validate_executable_task


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
        ToolCall("proposal-1", "propose_screening_task", {"task": _task(conversation["id"])}),
        context,
    )
    assert proposed["ok"] is True
    assert proposed["result"]["task_revision"] == 1
    assert proposed["result"]["revision_saved"] is True
    assert proposed["result"]["saved_to_library"] is False

    current = screening_tools.ToolContext(
        conversation_id=conversation["id"],
        turn_id=message["turn_id"],
        task_revision=1,
        as_of="2026-09-14",
        universe_kind="explicit",
        stock_codes=frozenset({"600000.SH"}),
    )
    authorized = screening_tools.registry.dispatch(
        ToolCall("authorize-1", "authorize_screening_execution", {"revision": 1}),
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
        ToolCall("proposal-repair", "propose_screening_task", {"task": {
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


@pytest.fixture
def turn_context(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tools.db")
    db.init_db()

    def create(content="条件A或者非条件B，截至2026-09-14，筛一下", *, ready=False):
        cid = conversation_store.create_conversation("screening")["id"]
        message = conversation_store.add_user_message(cid, "request", 0, content)
        conversation_store.start_turn(cid, message["turn_id"])
        if ready:
            conversation_store.save_task_revision(cid, 0, message["message_id"], ScreeningTaskRevision.model_validate(_task(cid)))
        return screening_tools.ToolContext(cid, message["turn_id"], int(ready))

    return create


def _two_conditions(cid):
    task = _task(cid)
    other = deepcopy(task["conditions"][0])
    other.update(condition_id="b", source_quote="条件B", description="条件B")
    task["conditions"].append(other)
    task["references"].append({"reference_id": "r2", "condition_id": "b"})
    return task


@pytest.mark.parametrize("operator", ["OR", "or", "any"])
def test_logic_aliases_preserve_or_and_nested_not(turn_context, operator):
    context = turn_context()
    task = _two_conditions(context.conversation_id)
    task["logic_tree"] = {"operator": operator, "children": [
        {"condition_id": "ma"},
        {"operator": "NOT", "children": [{"reference_id": "r2"}]},
    ]}
    result = screening_tools.registry.dispatch(ToolCall("logic", "propose_screening_task", {"task": task}), context)
    assert result["ok"], result
    saved = conversation_store.get_task_revision(context.conversation_id, 1)
    assert saved.logic_tree["op"] == "any"
    assert saved.logic_tree["children"][1]["op"] == "not"
    assert combine_logic_tree(saved.logic_tree, {"r1": "false", "r2": "false"}) == "true"
    assert combine_logic_tree(saved.logic_tree, {"r1": "false", "r2": "true"}) == "false"
    assert combine_logic_tree(saved.logic_tree, {"r1": "unknown", "r2": "true"}) == "unknown"


@pytest.mark.parametrize("tree", [
    None,
    {"operator": "XOR", "children": [{"reference_id": "r1"}]},
    {"op": "any", "operator": "AND", "children": [{"reference_id": "r1"}]},
    {"op": "any", "children": [{"reference_id": "r1"}, {"operator": "bad", "reference_id": "r2"}]},
    {"op": "any", "children": [{"reference_id": "r1"}, None]},
])
def test_invalid_logic_is_rejected_without_saving_a_replacement(turn_context, tree):
    context = turn_context()
    task = _two_conditions(context.conversation_id)
    task["logic_tree"] = tree
    result = screening_tools.registry.dispatch(ToolCall("bad-logic", "propose_screening_task", {"task": task}), context)
    assert result["ok"] is False
    assert result["error"]["code"] == "invalid_task_revision"
    assert conversation_store.get_conversation(context.conversation_id)["task_revision"] == 0


@pytest.mark.parametrize("message", [
    "先不要执行，只保存筛选方案", "不要运行", "请取消筛选", "只保存当前方案", "暂不执行",
    "解释筛选逻辑", "筛选方案怎么保存？", "请解释如何执行这套方案", "运行失败是什么意思",
    "文档中写着“执行当前任务”", "Do not run this plan", "Explain how to run the plan", "不要保存并执行",
])
def test_authorization_rejects_negation_discussion_and_quoted_commands(turn_context, message):
    context = turn_context(message, ready=True)
    result = screening_tools.registry.dispatch(ToolCall("auth", "authorize_screening_execution", {"revision": 1}), context)
    assert result["ok"] is False, message
    assert result["error"]["code"] == "execution_not_explicit"
    assert conversation_store.get_pending_execute_message(context.conversation_id) is None


@pytest.mark.parametrize("message", [
    "按这个筛", "收盘价高于20日均线，筛一下", "帮我筛选收盘价高于20日均线的股票",
    "请执行当前方案", "重新运行这个任务", "保存并执行当前方案", "Please run this plan",
])
def test_explicit_execution_requests_still_authorize(turn_context, message):
    context = turn_context(message, ready=True)
    result = screening_tools.registry.dispatch(ToolCall("auth", "authorize_screening_execution", {"revision": 1}), context)
    assert result["ok"], (message, result)
    assert result["result"]["ready_to_execute"] is True


def test_save_only_message_revokes_a_previous_pending_grant_before_processing(turn_context):
    context = turn_context("筛一下", ready=True)
    source = conversation_store.get_turn(context.conversation_id, context.turn_id)["user_message_id"]
    conversation_store.finish_turn(context.conversation_id, context.turn_id, 1, "awaiting_user", "请核对口径", {}, source)
    assert conversation_store.get_pending_execute_message(context.conversation_id) == source
    message = conversation_store.add_user_message(context.conversation_id, "save-only", 1, "先不要执行，只保存方案")
    assert conversation_store.get_pending_execute_message(context.conversation_id) is None
    conversation_store.start_turn(context.conversation_id, message["turn_id"])
    result = screening_tools.registry.dispatch(ToolCall("late-auth", "authorize_screening_execution", {"revision": 1}),
        screening_tools.ToolContext(context.conversation_id, message["turn_id"], 1))
    assert result["ok"] is False


def test_codex_save_is_visible_reusable_and_idempotent_without_execution(turn_context):
    context = turn_context("只保存当前方案", ready=True)
    args = {"revision": 1, "name": "可复用趋势方案"}
    first = screening_tools.registry.dispatch(ToolCall("save-1", "save_screening_plan", args), context)
    second = screening_tools.registry.dispatch(ToolCall("save-2", "save_screening_plan", args), context)
    assert first["ok"] and second["ok"], (first, second)
    asset_id = first["result"]["asset_id"]
    assert second["result"]["asset_id"] == asset_id
    assert second["result"]["idempotent_replay"] is True
    conflict = screening_tools.registry.dispatch(ToolCall("save-3", "save_screening_plan", {**args, "name": "不同名称"}), context)
    assert conflict["error"]["code"] == "save_request_conflict"
    listed = screening_tools.registry.dispatch(ToolCall("list", "list_saved_screening_tasks", {"limit": 10}), context)
    assert [item["id"] for item in listed["result"]["items"]] == [asset_id]
    with TestClient(main.app) as client:
        assets = client.get("/api/v1/saved-screening-tasks").json()["items"]
        assert [item["id"] for item in assets] == [asset_id]
        cid = client.post("/api/v1/conversations", json={"entry_scope": "screening"}).json()["id"]
        message = client.post(f"/api/v1/conversations/{cid}/messages", json={
            "client_message_id": "reuse", "base_revision": 0, "content": "复用趋势方案",
        }).json()
        reused = client.post(f"/api/v1/conversations/{cid}/saved-screening-tasks/{asset_id}/reuse", json={
            "base_revision": 0, "source_message_id": message["message_id"], "version": 1,
        })
        assert reused.status_code == 201, reused.text
        assert reused.json()["task"]["conditions"] == assets[0]["task"]["conditions"]
    with db.connect() as connection:
        assert connection.execute("SELECT count(*) FROM saved_screening_tasks").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM execution_requests").fetchone()[0] == 0


def test_trading_day_news_window_is_blocked_before_execution():
    task = ScreeningTaskRevision.model_validate({
        "task_id": "news-task",
        "revision": 1,
        "original_user_messages": ["最近3个交易日资讯包含回购"],
        "conditions": [{
            "condition_id": "news", "library": "news",
            "source_quote": "最近3个交易日资讯包含回购",
            "description": "资讯原文包含回购",
            "expression": {"question": "资讯原文是否包含回购", "lookback_trading_days": 3},
        }],
        "references": [{"reference_id": "r-news", "condition_id": "news"}],
        "logic_tree": {"op": "condition", "reference_id": "r-news"},
        "scope": {"universe": {"kind": "all_a_shares"}, "as_of": "2026-09-14"},
        "unresolved": [],
    })
    import pytest
    with pytest.raises(ValueError, match="自然日"):
        validate_executable_task(task)

