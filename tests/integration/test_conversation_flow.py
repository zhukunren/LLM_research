from __future__ import annotations

import json
from copy import deepcopy

from fastapi.testclient import TestClient
import pytest

from apps.api.app import conversation_service, conversation_store, db, main, screening_tools
from apps.api.app.model_client import FunctionCall, ToolTurn


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "conversation-flow.db")
    with TestClient(main.app) as session:
        yield session


def create_message(client: TestClient, content: str, *, base_revision: int = 0):
    conversation = client.post(
        "/api/v1/conversations", json={"entry_scope": "technical"}
    ).json()
    response = client.post(
        f"/api/v1/conversations/{conversation['id']}/messages",
        json={
            "client_message_id": f"client-{content[:12]}",
            "base_revision": base_revision,
            "content": content,
        },
    )
    assert response.status_code == 202, response.text
    return conversation, response.json()


def task_candidate(*, scope=None, unresolved=None, quote="收盘价高于20日均线"):
    return {
        "task_id": "model-controlled-value-is-replaced",
        "revision": 99,
        "original_user_messages": [],
        "conditions": [
            {
                "condition_id": "ma-close",
                "library": "technical",
                "source_quote": quote,
                "expression": {"op": "indicator_compare", "window": 20},
                "description": "收盘价高于20日均线",
            }
        ],
        "references": [{"reference_id": "r-ma", "condition_id": "ma-close"}],
        "logic_tree": {"op": "condition", "reference_id": "r-ma"},
        "scope": scope or {
            "universe": None,
            "as_of": None,
            "report_lookback_calendar_days": None,
            "news_lookback_calendar_days": None,
            "price_basis": None,
            "ranking": None,
        },
        "unresolved": unresolved or [],
    }


def model_plan(
    message_id,
    *,
    intent="discuss",
    task=None,
    clarify=False,
    question=None,
    use_tools=False,
    requirements=None,
    cancel_pending_execute=False,
):
    return {
        "proposal": {
            "intent": intent,
            "message_id": message_id,
            "run_id": None,
            "stock_code": None,
            "requires_clarification": clarify,
            "clarification": question,
        },
        "task_revision": task,
        "assistant_text": "我理解了当前请求。",
        "use_tools": use_tools,
        "requirements": requirements or [],
        "cancel_pending_execute": cancel_pending_execute,
    }


def process(client: TestClient, conversation_id: str, turn_id: str):
    return client.post(
        f"/api/v1/conversations/{conversation_id}/turns/{turn_id}/process"
    )


def create_two_condition_task(client: TestClient, followup_content="把均线周期改成30日"):
    original = "收盘价高于20日均线且成交量大于5日均量"
    conversation, message = create_message(client, original)
    conversation_store.finish_turn(
        conversation["id"], message["turn_id"], 0, "succeeded", "条件已载入。", {}
    )
    task = {
        "task_id": conversation["id"],
        "revision": 1,
        "original_user_messages": [original],
        "conditions": [
            {
                "condition_id": "ma-close",
                "library": "technical",
                "source_quote": "收盘价高于20日均线",
                "expression": {"op": "indicator_compare", "window": 20},
                "description": "收盘价高于20日均线",
            },
            {
                "condition_id": "volume-average",
                "library": "technical",
                "source_quote": "成交量大于5日均量",
                "expression": {"op": "volume_compare", "window": 5},
                "description": "成交量大于5日均量",
            },
        ],
        "references": [
            {"reference_id": "r-ma", "condition_id": "ma-close", "condition_version": None, "parameter_overrides": {}, "source_quote": None},
            {"reference_id": "r-volume", "condition_id": "volume-average", "condition_version": None, "parameter_overrides": {}, "source_quote": None},
        ],
        "logic_tree": {
            "op": "all",
            "children": [
                {"op": "condition", "reference_id": "r-ma"},
                {"op": "condition", "reference_id": "r-volume"},
            ],
        },
        "scope": {
            "universe": {"kind": "all_a_shares", "watchlist_id": None, "stock_codes": []},
            "as_of": "2026-09-14",
            "report_lookback_calendar_days": None,
            "news_lookback_calendar_days": None,
            "price_basis": None,
            "ranking": None,
        },
        "unresolved": [],
    }
    saved = client.post(
        f"/api/v1/conversations/{conversation['id']}/revisions",
        json={"base_revision": 0, "source_message_id": message["message_id"], "task": task},
    )
    assert saved.status_code == 201, saved.text
    followup = client.post(
        f"/api/v1/conversations/{conversation['id']}/messages",
        json={
            "client_message_id": "change-ma-window",
            "base_revision": 1,
            "content": followup_content,
        },
    ).json()
    return conversation, followup, task


def test_discussion_completes_without_mutating_the_screening_revision(client, monkeypatch):
    conversation, message = create_message(client, "股票筛选系统能看哪些指标？")
    monkeypatch.setattr(
        conversation_service.model_client,
        "complete_json",
        lambda *_args, **_kwargs: model_plan(message["message_id"], use_tools=False),
    )

    response = process(client, conversation["id"], message["turn_id"])
    restored = client.get(f"/api/v1/conversations/{conversation['id']}").json()

    assert response.status_code == 200, response.text
    assert response.json()["state"] == "succeeded"
    assert response.json()["result"]["intent"] == "discuss"
    assert restored["task_revision"] == 0
    assert len(restored["messages"]) == 2
    assert restored["messages"][-1]["role"] == "assistant"


def test_model_repairs_wrong_logic_format_without_asking_user_to_rewrite(client, monkeypatch):
    conversation, message = create_message(client, "收盘价高于20日均线")
    good = task_candidate()
    bad = deepcopy(good)
    bad['logic_tree'] = {'op': 'condition', 'condition_id': 'r-ma'}
    calls = []
    def complete(_instructions, payload, **kwargs):
        calls.append(json.loads(payload))
        return model_plan(message['message_id'], intent='edit', task=bad if len(calls) == 1 else good,
                          requirements=[{'source_quote': '收盘价高于20日均线', 'treatment': 'condition', 'target_id': 'ma-close'}])
    monkeypatch.setattr(conversation_service.model_client, 'complete_json', complete)
    response = process(client, conversation['id'], message['turn_id'])
    assert response.json()['state'] == 'succeeded', response.text
    assert len(calls) == 2 and calls[1]['repair']['validation_errors']
    assert client.get(f"/api/v1/conversations/{conversation['id']}").json()['task_revision'] == 1


def test_shorthand_logic_preserves_operators_and_rejects_ambiguous_condition_ids():
    raw = task_candidate()
    raw['logic_tree'] = {'not': [{'condition': 'ma-close'}]}
    candidate = conversation_service._make_candidate(raw, 'one', 1, ['收盘价高于20日均线'])
    assert candidate.logic_tree == {'op': 'not', 'children': [{'op': 'condition', 'reference_id': 'r-ma'}]}
    raw['references'].append({'reference_id': 'r-second', 'condition_id': 'ma-close', 'parameter_overrides': {'window': 60}})
    with pytest.raises(conversation_service.ConversationProcessingError):
        conversation_service._make_candidate(raw, 'one', 1, ['收盘价高于20日均线'])


def test_short_clarification_answer_keeps_the_original_unsaved_requirement(client, monkeypatch):
    conversation, message = create_message(client, "收盘价高于20日均线")
    cid = conversation['id']
    conversation_store.finish_turn(cid, message['turn_id'], 0, 'awaiting_user', '采用简单收盘均线吗？', {
        'unresolved_requirements': [{'source_quote': '收盘价高于20日均线', 'question': '采用简单收盘均线吗？'}],
    })
    reply = client.post(f'/api/v1/conversations/{cid}/messages', json={'client_message_id': 'reply', 'base_revision': 0, 'content': '是的'}).json()
    def complete(_instructions, payload, **kwargs):
        data = json.loads(payload)
        assert data['requirements_text'] == '收盘价高于20日均线\n是的'
        return model_plan(reply['message_id'], intent='edit', task=task_candidate(), requirements=[
            {'source_quote': '收盘价高于20日均线', 'treatment': 'condition', 'target_id': 'ma-close'},
            {'source_quote': '是的', 'treatment': 'context'},
        ])
    monkeypatch.setattr(conversation_service.model_client, 'complete_json', complete)
    response = process(client, cid, reply['turn_id'])
    assert response.json()['state'] == 'succeeded', response.text
    assert client.get(f'/api/v1/conversations/{cid}').json()['task_revision'] == 1
    assert response.json()['result']['ready_to_execute'] is False


def test_pure_action_sentence_can_span_punctuation_but_cannot_hide_a_condition():
    task = conversation_service._make_candidate(task_candidate(), 'one', 1, ['收盘价高于20日均线'])
    coverage = [conversation_service.RequirementCoverage(source_quote='收盘价高于20日均线', treatment='condition', target_id='ma-close'),
                conversation_service.RequirementCoverage(source_quote='先整理条件，先不执行。', treatment='context')]
    assert conversation_service._validate_requirement_coverage('收盘价高于20日均线。先整理条件，先不执行。', coverage, None, task) == ([], [])
    coverage[-1] = conversation_service.RequirementCoverage(source_quote='先不执行，市值大于100亿', treatment='context')
    with pytest.raises(conversation_service.ConversationProcessingError):
        conversation_service._validate_requirement_coverage('收盘价高于20日均线。先不执行，市值大于100亿', coverage, None, task)


def test_execution_grant_survives_clarification_and_does_not_ask_again(client, monkeypatch):
    conversation, initial = create_message(client, "收盘价高于20日均线，筛一下")
    incomplete = task_candidate()
    monkeypatch.setattr(
        conversation_service.model_client,
        "complete_json",
        lambda *_args, **_kwargs: model_plan(
            initial["message_id"],
            intent="execute",
            task=incomplete,
            requirements=[{"source_quote": "收盘价高于20日均线", "treatment": "condition", "target_id": "ma-close"}],
        ),
    )

    first = process(client, conversation["id"], initial["turn_id"])
    first_conversation = client.get(f"/api/v1/conversations/{conversation['id']}").json()

    assert first.json()["state"] == "awaiting_user"
    assert "筛选范围" in first.json()["response_text"]
    assert first_conversation["pending_execution"] is True
    assert first_conversation["task_revision"] == 1

    followup = client.post(
        f"/api/v1/conversations/{conversation['id']}/messages",
        json={
            "client_message_id": "scope-answer",
            "base_revision": 1,
            "content": "全部A股，以2026-09-14为数据截止日",
        },
    ).json()
    complete = task_candidate(
        scope={
            "universe": {"kind": "all_a_shares", "watchlist_id": None, "stock_codes": []},
            "as_of": "2026-09-14",
            "report_lookback_calendar_days": None,
            "news_lookback_calendar_days": None,
            "price_basis": None,
            "ranking": None,
        }
    )
    monkeypatch.setattr(
        conversation_service.model_client,
        "complete_json",
        lambda *_args, **_kwargs: model_plan(
            initial["message_id"],
            intent="execute",
            task=complete,
            requirements=[
                {"source_quote": "全部A股", "treatment": "scope", "target_id": "universe"},
                {"source_quote": "2026-09-14", "treatment": "scope", "target_id": "as_of"},
            ]
        ),
    )

    second = process(client, conversation["id"], followup["turn_id"])
    restored = client.get(f"/api/v1/conversations/{conversation['id']}").json()

    assert second.status_code == 200, second.text
    assert second.json()["state"] == "succeeded"
    assert second.json()["result"]["intent_message_id"] == initial["message_id"]
    assert second.json()["result"]["execution_authorized"] is True
    assert second.json()["result"]["ready_to_execute"] is True
    assert "不需要重复确认" not in second.json()["response_text"]
    assert "执行授权已记录" in second.json()["response_text"]
    assert restored["task_revision"] == 2
    assert restored["pending_execution"] is True


def test_explicit_followup_executes_the_current_revision_without_reconfirmation(client, monkeypatch):
    conversation, followup, _task = create_two_condition_task(client, "按这个筛")
    monkeypatch.setattr(
        conversation_service.model_client,
        "complete_json",
        lambda *_args, **_kwargs: model_plan(
            followup["message_id"], intent="execute", task=None
        ),
    )

    response = process(client, conversation["id"], followup["turn_id"])
    current = client.get(f"/api/v1/conversations/{conversation['id']}").json()
    with db.connect() as connection:
        run_count = connection.execute("SELECT COUNT(*) FROM screening_runs").fetchone()[0]

    assert response.json()["state"] == "succeeded"
    assert response.json()["result"]["task_revision"] == 1
    assert response.json()["result"]["ready_to_execute"] is True
    assert "已确认当前条件" in response.json()["response_text"]
    assert current["pending_execution"] is True
    assert run_count == 0


def test_tool_output_is_returned_with_the_exact_model_call_id(client, monkeypatch):
    conversation, message = create_message(client, "当前接入了哪些行情能力？")
    monkeypatch.setattr(
        conversation_service.model_client,
        "complete_json",
        lambda *_args, **_kwargs: model_plan(
            message["message_id"], intent="discuss", use_tools=True
        ),
    )
    dispatches = []
    monkeypatch.setattr(
        screening_tools.registry,
        "dispatch",
        lambda call, _context: dispatches.append(call.call_id)
        or {"ok": True, "result": {"echo": call.call_id}},
    )
    model_requests = []

    def fake_tool_turn(_instructions, model_conversation, _tools, **_kwargs):
        model_requests.append(model_conversation)
        if len(model_requests) == 1:
            call = FunctionCall(
                "call-preserve-7", "describe_capabilities", {"domain": "market", "include_unavailable": False}
            )
            return ToolTurn(
                "responses",
                "gpt-6-luna",
                "response-tools",
                None,
                (call,),
                ({"type": "function_call", "call_id": call.call_id, "name": call.name},),
            )
        return ToolTurn("responses", "gpt-6-luna", "response-final", "已读取行情能力。", (), ())

    monkeypatch.setattr(conversation_service.model_client, "create_tool_turn", fake_tool_turn)

    response = process(client, conversation["id"], message["turn_id"])

    assert response.status_code == 200, response.text
    assert dispatches == ["call-preserve-7"]
    assert model_requests[1][-1]["type"] == "function_call_output"
    assert model_requests[1][-1]["call_id"] == "call-preserve-7"
    assert json.loads(model_requests[1][-1]["output"]) == {
        "ok": True,
        "result": {"echo": "call-preserve-7"},
    }
    assert response.json()["result"]["tool_call_ids"] == ["call-preserve-7"]


def test_candidate_source_quote_must_exist_in_a_persisted_user_message(client, monkeypatch):
    conversation, message = create_message(client, "收盘价高于20日均线，筛一下")
    fabricated = task_candidate(quote="成交额突破历史新高")
    monkeypatch.setattr(
        conversation_service.model_client,
        "complete_json",
        lambda *_args, **_kwargs: model_plan(
            message["message_id"], intent="execute", task=fabricated
        ),
    )

    response = process(client, conversation["id"], message["turn_id"])
    restored = client.get(f"/api/v1/conversations/{conversation['id']}").json()

    assert response.json()["state"] == "failed"
    assert response.json()["result"]["error_code"] == "invalid_model_plan"
    assert restored["task_revision"] == 0
    assert restored["pending_execution"] is False


def test_process_rejects_a_second_claim_while_a_turn_is_running(client, monkeypatch):
    conversation, message = create_message(client, "解释一下成交量指标")
    calls = []
    monkeypatch.setattr(
        conversation_service.model_client,
        "complete_json",
        lambda *_args, **_kwargs: calls.append("planner") or model_plan(message["message_id"]),
    )
    conversation_store.start_turn(conversation["id"], message["turn_id"])

    second = process(client, conversation["id"], message["turn_id"])

    assert second.status_code == 409
    assert calls == []


def test_uncovered_clause_is_clarified_without_saving_supported_half(client, monkeypatch):
    content = "市值小于100亿且收盘价高于20日均线"
    conversation, message = create_message(client, content)
    partial = task_candidate()
    monkeypatch.setattr(
        conversation_service.model_client,
        "complete_json",
        lambda *_args, **_kwargs: model_plan(
            message["message_id"],
            intent="edit",
            task=partial,
            requirements=[{
                "source_quote": "收盘价高于20日均线",
                "treatment": "condition",
                "target_id": "ma-close",
            }],
        ),
    )

    response = process(client, conversation["id"], message["turn_id"])
    restored = client.get(f"/api/v1/conversations/{conversation['id']}").json()

    assert response.json()["state"] == "awaiting_user"
    assert "市值小于100亿" in response.json()["response_text"]
    assert restored["task_revision"] == 0
    assert restored["pending_execution"] is False


def test_explicit_cancel_clears_pending_execution_without_creating_a_run(client, monkeypatch):
    conversation, initial = create_message(client, "收盘价高于20日均线，筛一下")
    monkeypatch.setattr(
        conversation_service.model_client,
        "complete_json",
        lambda *_args, **_kwargs: model_plan(
            initial["message_id"],
            intent="execute",
            task=task_candidate(),
            requirements=[{"source_quote": "收盘价高于20日均线", "treatment": "condition", "target_id": "ma-close"}],
        ),
    )
    first = process(client, conversation["id"], initial["turn_id"])
    assert first.json()["state"] == "awaiting_user"

    cancel_message = client.post(
        f"/api/v1/conversations/{conversation['id']}/messages",
        json={"client_message_id": "cancel-run", "base_revision": 1, "content": "先不运行，解释一下"},
    ).json()
    monkeypatch.setattr(
        conversation_service.model_client,
        "complete_json",
        lambda *_args, **_kwargs: model_plan(
            cancel_message["message_id"],
            intent="discuss",
            cancel_pending_execute=True,
        ),
    )

    cancelled = process(client, conversation["id"], cancel_message["turn_id"])
    restored = client.get(f"/api/v1/conversations/{conversation['id']}").json()

    assert cancelled.json()["state"] == "succeeded"
    assert cancelled.json()["result"]["execute_grant_cancelled"] is True
    assert cancelled.json()["result"]["execution_authorized"] is False
    assert restored["pending_execution"] is False


def test_parameter_edit_changes_only_the_target_condition_and_keeps_old_revision(client, monkeypatch):
    conversation, followup, original = create_two_condition_task(client)
    changed = deepcopy(original)
    changed["conditions"][0]["source_quote"] = "把均线周期改成30日"
    changed["conditions"][0]["expression"]["window"] = 30
    changed["conditions"][0]["description"] = "收盘价高于30日均线"
    monkeypatch.setattr(
        conversation_service.model_client,
        "complete_json",
        lambda *_args, **_kwargs: model_plan(
            followup["message_id"],
            intent="edit",
            task=changed,
            requirements=[{
                "source_quote": "把均线周期改成30日",
                "treatment": "condition",
                "target_id": "ma-close",
            }],
        ),
    )

    response = process(client, conversation["id"], followup["turn_id"])
    old_revision = client.get(f"/api/v1/conversations/{conversation['id']}/revisions/1").json()
    new_revision = client.get(f"/api/v1/conversations/{conversation['id']}/revisions/2").json()

    assert response.json()["state"] == "succeeded"
    assert len(response.json()["result"]["revision_changes"]) == 2
    assert old_revision["conditions"][0]["expression"]["window"] == 20
    assert new_revision["conditions"][0]["expression"]["window"] == 30
    assert new_revision["conditions"][1] == old_revision["conditions"][1]
    assert [item["reference_id"] for item in new_revision["references"]] == ["r-ma", "r-volume"]


def test_parameter_edit_cannot_silently_change_an_untargeted_condition(client, monkeypatch):
    conversation, followup, original = create_two_condition_task(client)
    changed = deepcopy(original)
    changed["conditions"][0]["source_quote"] = "把均线周期改成30日"
    changed["conditions"][0]["expression"]["window"] = 30
    changed["conditions"][0]["description"] = "收盘价高于30日均线"
    changed["conditions"][1]["source_quote"] = "把均线周期改成30日"
    changed["conditions"][1]["expression"]["window"] = 10
    monkeypatch.setattr(
        conversation_service.model_client,
        "complete_json",
        lambda *_args, **_kwargs: model_plan(
            followup["message_id"],
            intent="edit",
            task=changed,
            requirements=[{
                "source_quote": "把均线周期改成30日",
                "treatment": "condition",
                "target_id": "ma-close",
            }],
        ),
    )

    response = process(client, conversation["id"], followup["turn_id"])
    current = client.get(f"/api/v1/conversations/{conversation['id']}").json()

    assert response.json()["state"] == "failed"
    assert response.json()["result"]["error_code"] == "invalid_model_plan"
    assert current["task_revision"] == 1
