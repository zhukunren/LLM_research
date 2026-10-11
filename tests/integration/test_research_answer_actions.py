from __future__ import annotations

from io import BytesIO
import json

import pytest
from fastapi.testclient import TestClient

from apps.api.app import codex_runtime, codex_store, conversation_store as store, db, main, research_attachments
from apps.api.app.research_answer_actions import apply, visible_messages


@pytest.fixture
def research(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "answers.db")
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
    db.init_db()
    return store.create_conversation("report", workflow_type="research")["id"]


def answer(cid, content="问题", response="研究结论", attachment_ids=None):
    request = store.add_user_message(cid, content, 0, content, attachment_ids=attachment_ids)
    store.start_turn(cid, request["turn_id"])
    store.finish_turn(cid, request["turn_id"], 0, "succeeded", response, {})
    return store.get_conversation(cid)["messages"][-1]


def test_latest_regeneration_retains_original_and_frozen_turn_settings(research):
    original = answer(research)
    before = store.get_conversation(research)
    codex_store.bind_thread(research, "old-native-thread", "old-model", None)
    result = apply(research, original["id"], "retry", "regenerate")
    assert result["conversation_id"] == research and result["turn_id"]
    assert codex_store.get_thread(research) is None
    frozen = store.get_turn(research, result["turn_id"])
    for key in ("model_id", "reasoning_effort", "assistant", "research_scope", "research_depth"):
        assert frozen[key] == before["turns"][0][key]
    store.start_turn(research, result["turn_id"])
    store.finish_turn(research, result["turn_id"], 0, "succeeded", "新结论", {})
    current = store.get_conversation(research)
    assert current["messages"][:2] == before["messages"]
    assert current["messages"][-1]["regeneration_of"] == original["id"]
    assert [item["content"] for item in visible_messages(current["messages"])] == ["问题", "新结论"]
    assert apply(research, original["id"], "retry", "regenerate")["idempotent_replay"]
    assert len(store.get_conversation(research)["messages"]) == 4


def test_repeated_regeneration_groups_versions_and_excludes_old_answers_from_prompt(research):
    original = answer(research, content="原始问题", response="旧结论")
    first = apply(research, original["id"], "first", "regenerate")
    store.start_turn(research, first["turn_id"])
    store.finish_turn(research, first["turn_id"], 0, "succeeded", "第二结论", {})
    second_answer = store.get_conversation(research)["messages"][-1]
    second = apply(research, second_answer["id"], "second", "regenerate")
    prompt = json.loads(codex_runtime._prompt(research, second["turn_id"]))
    assert prompt["current_user_request"] == "原始问题"
    assert prompt["conversation_history"] == [{"role": "user", "content": "原始问题"}]
    store.start_turn(research, second["turn_id"])
    store.finish_turn(research, second["turn_id"], 0, "succeeded", "第三结论", {})
    assert store.get_conversation(research)["messages"][-1]["regeneration_of"] == original["id"]


def test_earlier_regeneration_forks_prefix_and_preserves_later_messages(research):
    original = answer(research, "第一问题", "第一结论")
    answer(research, "后续问题", "后续结论")
    before = store.get_conversation(research)
    result = apply(research, original["id"], "earlier", "regenerate")
    assert result["conversation_id"] != research
    assert store.get_conversation(research) == before
    branch = store.get_conversation(result["conversation_id"])
    assert [item["content"] for item in branch["messages"]] == ["第一问题"]
    assert branch["turns"][0]["state"] == "awaiting_agent"


def test_branch_from_selected_answer_copies_only_prefix_and_can_continue(research):
    first = answer(research, "第一问题", "第一结论")
    answer(research, "后续问题", "后续结论")
    result = apply(research, first["id"], "branch", "branch")
    branch = store.get_conversation(result["conversation_id"])
    assert [item["content"] for item in branch["messages"]] == ["第一问题", "第一结论"]
    assert branch["messages"][-1]["file_conversation_id"] == research
    assert branch["messages"][-1]["turn_id"] == branch["turns"][0]["id"]
    assert result["turn_id"] is None
    assert store.add_user_message(branch["id"], "followup", 0, "沿分支继续研究")["state"] == "awaiting_agent"
    assert apply(research, first["id"], "branch", "branch")["conversation_id"] == branch["id"]


def test_branch_of_regenerated_answer_keeps_chosen_version_and_matching_turn(research):
    original = answer(research)
    regenerated = apply(research, original["id"], "regenerate", "regenerate")
    store.start_turn(research, regenerated["turn_id"])
    store.finish_turn(research, regenerated["turn_id"], 0, "succeeded", "选择的新结论", {})
    latest = store.get_conversation(research)["messages"][-1]
    branch = store.get_conversation(apply(research, latest["id"], "branch", "branch")["conversation_id"])
    assert [item["content"] for item in branch["messages"]] == ["问题", "选择的新结论"]
    assert branch["turns"][0]["response_text"] == "选择的新结论"
    assert branch["messages"][-1]["turn_id"] == branch["turns"][0]["id"]


@pytest.mark.parametrize("kind", ["branch", "regenerate"])
def test_branch_and_regeneration_preserve_attachment_originals(research, kind):
    attachment = research_attachments.upload(research, "file", "evidence.txt", BytesIO("附件证据".encode()))
    original = answer(research, attachment_ids=[attachment["id"]])
    if kind == "regenerate":
        answer(research, "后续问题", "后续结论")
    result = apply(research, original["id"], kind, kind)
    branch = store.get_conversation(result["conversation_id"])
    copied = branch["messages"][0]["attachments"][0]
    assert copied["id"] != attachment["id"] and copied["sha256"] == attachment["sha256"]
    path, _ = research_attachments.download(branch["id"], copied["id"])
    assert path.read_text(encoding="utf-8") == "附件证据"
    if kind == "regenerate":
        assert research_attachments.turn_manifest(branch["id"], result["turn_id"])[0]["sha256"] == copied["sha256"]


def test_regeneration_failure_is_a_version_and_original_still_exists(research):
    original = answer(research)
    result = apply(research, original["id"], "failed", "regenerate")
    store.fail_turn(research, result["turn_id"], "test failure", include_queued=True)
    messages = store.get_conversation(research)["messages"]
    assert messages[1]["id"] == original["id"]
    assert messages[-1]["regeneration_of"] == original["id"]
    assert len(visible_messages(messages)) == 2


def test_actions_validate_ownership_busy_state_and_idempotency(research):
    original = answer(research)
    other = store.create_conversation("report", workflow_type="research")["id"]
    with pytest.raises(store.ConversationStoreError):
        apply(other, original["id"], "foreign", "branch")
    apply(research, original["id"], "key", "branch")
    with pytest.raises(store.ConversationConflict):
        apply(research, original["id"], "key", "regenerate")
    store.add_user_message(research, "running", 0, "未完成的问题")
    with pytest.raises(store.ConversationConflict):
        apply(research, original["id"], "busy", "branch")


def test_api_queues_regeneration_once_and_unavailable_runtime_writes_nothing(research, monkeypatch):
    original = answer(research)
    payload = {"message_id": original["id"], "request_id": "api-retry"}
    url = f"/api/v1/conversations/{research}/answers/regenerate"
    with TestClient(main.app) as client:
        monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": False, "reason": "暂不可用"})
        assert client.post(url, json=payload).status_code == 503
        assert len(store.get_conversation(research)["messages"]) == 2
        monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
        first = client.post(url, json=payload)
        second = client.post(url, json=payload)
        assert first.status_code == second.status_code == 202
        assert first.json()["turn_id"] == second.json()["turn_id"]
        assert store.get_turn(research, first.json()["turn_id"])["job"]["state"] == "queued"
