import json

import pytest

from apps.api.app import db, model_client, news_adapter, news_sources, screening_execution


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "news-screening.db")
    db.init_db()
    monkeypatch.setattr(news_adapter, "llm_settings", lambda: {"configured": True})

    def prepare(assessments, *, minimum=1, event_requirement="completed", numeric=False, declared_events=None, future=False):
        labels = {"planned": "拟回购，计划金额10000万元", "in_progress": "正在回购，计划金额10000万元",
                  "completed": "已完成回购，实际支出10000万元", "unknown": "涉及回购，状态和金额口径待确认"}
        texts = [f"公司事项{i}：{labels[extra.get('event_state', 'completed')]}。" for i, extra in enumerate(assessments)]
        imported = news_sources.import_items(news_sources.NewsImport(request_id="fixture", items=[
            news_sources.NewsItemInput(title=f"公告{i}", body=text, source="本地合成公告", stock_codes=["600000.SH"],
                published_at="2026-09-14T09:00:00+08:00", available_at="2026-09-15T09:00:00+08:00" if future else "2026-09-14T09:01:00+08:00",
                event_key=declared_events[i] if declared_events else None)
            for i, text in enumerate(texts)]))
        ids = [item["id"] for item in imported["items"]]
        steps = [model_client.FunctionCall("list", "list_sources", {"offset": 0, "limit": 50})]
        steps += [model_client.FunctionCall(f"read-{i}", "read_source_chunk", dict(source_id=identity, page_number=1, offset=0, limit=12000))
                  for i, identity in enumerate(ids)]
        steps += [model_client.FunctionCall("submit", "submit_decision", dict(state="true", explanation="资讯支持已完成事项。",
                    evidence=[dict(source_id=identity, page_number=1, quote=texts[i], char_start=0) for i, identity in enumerate(ids)]))]
        turns = iter(steps)
        observed = []
        def turn(*args, **kwargs):
            call = next(turns)
            observed.append(call.name)
            return model_client.ToolTurn("responses", "fixture", None, None, (call,),
                ({"type": "function_call", "call_id": call.call_id, "name": call.name, "arguments": json.dumps(call.arguments)},))
        def verify(instructions, content, **kwargs):
            assert "event_state" in instructions
            assert len(json.loads(content)["evidence"]) == len(assessments)
            return {"assessments": [dict(index=i, subject_match=True, period_match=True, fact_type="actual",
                relation="support", event_state="completed", event_group=f"event-{i}", units_match=True,
                quantities=[dict(label="回购金额", raw_value=10000, raw_unit="万元", normalized_value=1, normalized_unit="亿元")]) | extra
                for i, extra in enumerate(assessments)]}
        monkeypatch.setattr(model_client, "create_tool_turn", turn)
        monkeypatch.setattr(model_client, "complete_json", verify)
        prompt = "筛选已完成回购事项的公司"
        task = dict(task_id="news-task", revision=1, original_user_messages=[prompt], conditions=[dict(
            condition_id="buyback", library="news", source_quote=prompt, description=prompt,
            implementation_id="news-evidence-v1", implementation_version="1", expression=dict(
                question=prompt, fact_requirement="actual", quantifier="exists", source_ids=None,
                event_requirement=event_requirement, minimum_independent_events=minimum, numeric_requirement=numeric))],
            references=[dict(reference_id="news-ref", condition_id="buyback")],
            logic_tree={"op": "condition", "reference_id": "news-ref"}, scope=dict(
                universe={"kind": "explicit", "stock_codes": ["600000.SH"]}, as_of="2026-09-14", news_lookback_calendar_days=3))
        snapshot = dict(task=task, execution_request={"request_id": "request"}, universe={"codes": ["600000.SH"]},
                        as_of="2026-09-14", source_manifests=[], tool_call_ids=[], model_metadata={})
        return snapshot, observed
    return prepare


def run(snapshot):
    result = screening_execution.execute_snapshot(snapshot, run_id="run", active=lambda: True, progress=lambda *args: None)
    return result.stock_decisions[0].condition_decisions[0]


@pytest.mark.parametrize("assessment,expected", [
    ({}, "true"), ({"event_state": "planned"}, "unknown"),
    ({"event_state": "in_progress"}, "unknown"), ({"event_state": "unknown"}, "unknown"),
    ({"units_match": False}, "unknown"), ({"quantities": []}, "unknown"),
])
def test_event_state_and_units_are_checked_independently_of_positive_submission(setup, assessment, expected):
    snapshot, _ = setup([assessment], numeric=True)
    decision = run(snapshot)
    assert decision.state == expected, decision
    assert decision.actual_values["evidence"][0]["assessment"]["event_state"] == assessment.get("event_state", "completed")


def test_same_event_paraphrases_do_not_count_as_two_independent_events(setup):
    snapshot, _ = setup([{"event_group": "same"}, {"event_group": "same"}], minimum=2)
    decision = run(snapshot)
    assert decision.state == "unknown"
    assert decision.actual_values["independent_event_count"] == 1


def test_explicit_same_event_marker_overrides_inconsistent_model_groups(setup):
    snapshot, _ = setup([{}, {}], minimum=2, declared_events=["same-deal", "same-deal"])
    decision = run(snapshot)
    assert decision.state == "unknown" and decision.actual_values["independent_event_count"] == 1


def test_two_independent_events_meet_the_confirmed_count(setup):
    snapshot, _ = setup([{}, {}], minimum=2)
    decision = run(snapshot)
    assert decision.state == "true" and decision.actual_values["independent_event_count"] == 2
    number = decision.actual_values["evidence"][0]["assessment"]["quantities"][0]
    assert number["raw_unit"] == "万元" and number["normalized_unit"] == "亿元"
    assert number["raw_value"] == 10000 and number["normalized_value"] == 1


def test_future_news_is_not_sent_to_the_model(setup):
    snapshot, observed = setup([{}], future=True)
    decision = run(snapshot)
    assert decision.state == "unknown" and decision.reason_code == "data_missing"
    assert observed == []
