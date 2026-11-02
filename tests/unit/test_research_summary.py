import json

import pytest

from apps.api.app import codex_runtime, conversation_store, db, research_summary, research_workspace


def brief(turn_id="turn-one"):
    return {"version": 1, "turn_id": turn_id, "conclusion": "收入增长仍需核对现金流。",
            "key_points": [{"kind": "inference", "text": "需对齐报告期再比较。"}],
            "risks": ["样本资料不完整。"], "next_steps": ["核对下一份公告。"],
            "data_as_of": None, "data_note": "不同资料采用不同报告期。"}


def test_reads_only_valid_turn_bound_briefs_and_clears_retry_artifacts(tmp_path, monkeypatch):
    monkeypatch.setattr(research_workspace, "directory", lambda _: tmp_path)
    path = tmp_path / research_summary.filename("turn-one")
    path.write_text(json.dumps(brief()), encoding="utf-8")
    assert research_summary.read("conversation", "turn-one") == brief()
    research_summary.clear("conversation", "turn-one")
    assert research_summary.read("conversation", "turn-one") is None
    with pytest.raises(ValueError):
        research_summary.filename("../other-turn")


@pytest.mark.parametrize("update", [
    {"turn_id": "another-turn"}, {"version": 2}, {"conclusion": "   "},
    {"key_points": [{"kind": "guaranteed", "text": "确定上涨"}]},
    {"data_as_of": "日期未确认"}, {"risks": ["风险"] * 4}, {"extra": "unexpected"},
])
def test_rejects_invalid_briefs_without_losing_full_research(tmp_path, monkeypatch, update):
    monkeypatch.setattr(research_workspace, "directory", lambda _: tmp_path)
    (tmp_path / research_summary.filename("turn-one")).write_text(json.dumps({**brief(), **update}), encoding="utf-8")
    assert research_summary.read("conversation", "turn-one") is None


def test_bounds_read_and_keeps_missing_or_malformed_briefs_optional(tmp_path, monkeypatch):
    monkeypatch.setattr(research_workspace, "directory", lambda _: tmp_path)
    path = tmp_path / research_summary.filename("turn-one")
    assert research_summary.read("conversation", "turn-one") is None
    for raw in (b"{broken", b"x" * 16385, b"\xff\xfe"):
        path.write_bytes(raw)
        assert research_summary.read("conversation", "turn-one") is None


def test_prompt_and_finished_turn_preserve_structured_brief(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "brief.db")
    db.init_db()
    conversation = conversation_store.create_conversation("screening", workflow_type="research")
    cid = conversation["id"]
    message = conversation_store.add_user_message(cid, "brief-request", 0, "核对经营变化与风险")
    tid = message["turn_id"]
    payload = json.loads(codex_runtime._prompt(cid, tid, {"workspace": str(tmp_path)}))
    assert payload["reading_brief"]["turn_id"] == tid
    assert payload["reading_brief"]["path_relative_to_workspace"] == research_summary.filename(tid)
    assert payload["reading_brief"]["schema"]["additionalProperties"] is False
    conversation_store.start_turn(cid, tid)
    monkeypatch.setattr(codex_runtime, "run_conversation_turn", lambda *_: {
        "thread_id": "thread", "codex_turn_id": "codex-turn", "event_count": 1,
        "model": "gpt-6-luna", "response": "完整研究正文与依据。", "research_summary": brief(tid),
    })
    codex_runtime.process_conversation_turn(cid, tid)
    restored = conversation_store.get_conversation(cid)
    assert restored["turns"][0]["result"]["research_summary"] == brief(tid)
    assert restored["messages"][-1]["content"] == "完整研究正文与依据。"
