from __future__ import annotations

import json

import pytest

from apps.api.app import db, model_client, report_adapter, screening_execution, evidence_analysis


@pytest.fixture
def prepare(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "report-screen.db")
    db.init_db()
    monkeypatch.setattr(report_adapter, "llm_settings", lambda: {"configured": True})

    def setup(texts, assessments, *, proposal="true", quantifier="exists", unread_page=False, forged=False):
        with db.connect() as connection:
            for index, text in enumerate(texts):
                identity = f"doc-{index}"
                connection.execute("""INSERT INTO documents(id,sha256,filename,title,stock_code,pages,
                    extracted_chars,parse_status,source_path,imported_at,stock_code_status,available_at,available_at_status)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (identity, identity, identity + ".pdf", identity,
                    "600000.SH", 2 if unread_page else 1, len(text), "indexed", "synthetic", db.utc_now(),
                    "confirmed", "2026-09-10", "confirmed"))
                connection.execute("INSERT INTO document_pages(document_id,page_number,text) VALUES(?,1,?)", (identity, text))
                if unread_page:
                    connection.execute("INSERT INTO document_pages(document_id,page_number,text) VALUES(?,2,?)", (identity, "尚未阅读的重要信息。"))
        calls = [model_client.FunctionCall("list", "list_sources", {"offset": 0, "limit": 50})]
        calls.extend(model_client.FunctionCall(f"read-{i}", "read_source_chunk", dict(
            source_id=f"doc-{i}", page_number=1, offset=0, limit=12000)) for i in range(len(texts)))
        calls.append(model_client.FunctionCall("submit", "submit_decision", dict(
            state=proposal, explanation="根据原文判断收入变化。", evidence=[dict(
                source_id=f"doc-{i}", page_number=2 if forged else 1, quote=text, char_start=0)
                for i, text in enumerate(texts)])))
        pending = iter(calls)
        observed = []
        def model_turn(instructions, conversation, tools, **kwargs):
            call = next(pending)
            observed.append(call.name)
            return model_client.ToolTurn("responses", "fixture", None, None, (call,),
                                        ({"type": "function_call", "call_id": call.call_id,
                                          "name": call.name, "arguments": json.dumps(call.arguments)},))
        def verify(instructions, content, **kwargs):
            payload = json.loads(content)
            assert payload["stock_code"] == "600000.SH"
            assert len(payload["evidence"]) == len(assessments)
            return {"assessments": [dict(index=i, subject_match=True, period_match=True,
                                         fact_type="actual", relation="support", **{}) | item
                                    for i, item in enumerate(assessments)]}
        monkeypatch.setattr(model_client, "create_tool_turn", model_turn)
        monkeypatch.setattr(model_client, "complete_json", verify)
        prompt = "筛选本期收入实际增长的公司"
        task = dict(task_id="report-task", revision=1, original_user_messages=[prompt],
                    conditions=[dict(condition_id="growth", library="report", source_quote=prompt, description=prompt,
                                     expression=dict(question=prompt, fact_requirement="actual", quantifier=quantifier, source_ids=None),
                                     implementation_id="report-evidence-v1", implementation_version="1")],
                    references=[dict(reference_id="growth-ref", condition_id="growth")],
                    logic_tree={"op": "condition", "reference_id": "growth-ref"},
                    scope=dict(universe={"kind": "explicit", "stock_codes": ["600000.SH"]},
                               as_of="2026-09-14", report_lookback_calendar_days=30))
        snapshot = dict(task=task, execution_request={"request_id": "request"}, universe={"codes": ["600000.SH"]},
                        as_of="2026-09-14", source_manifests=[], tool_call_ids=[], model_metadata={})
        return snapshot, observed
    return setup


@pytest.mark.parametrize("texts,assessments,proposal,expected,reason", [
    (["本公司本期营业收入同比增长20%。"], [{}], "true", "true", "condition_met"),
    (["预计本公司下期营业收入增长20%。"], [{"fact_type": "forecast"}], "true", "unknown", "semantic_uncertain"),
    (["同行公司本期营业收入同比增长20%。"], [{"subject_match": False}], "true", "unknown", "semantic_uncertain"),
    (["本公司去年营业收入同比增长20%。"], [{"period_match": False}], "true", "unknown", "semantic_uncertain"),
    (["本公司本期营业收入同比下降20%。"], [{"relation": "counter"}], "false", "false", "condition_not_met"),
    (["本公司本期营业收入同比增长20%。", "更正：本公司本期营业收入同比下降20%。"],
     [{}, {"relation": "counter"}], "true", "unknown", "evidence_conflict"),
])
def test_worker_checks_fact_subject_period_and_conflicting_evidence(prepare, texts, assessments, proposal, expected, reason):
    snapshot, observed = prepare(texts, assessments, proposal=proposal)
    result = screening_execution.execute_snapshot(snapshot, run_id="run", active=lambda: True, progress=lambda *args: None)
    decision = result.stock_decisions[0].condition_decisions[0]
    assert decision.state == expected, decision
    assert decision.reason_code == reason
    assert decision.actual_values["coverage"]["complete"] is True
    assert decision.evidence_refs
    assert observed[0] == "list_sources" and observed[-1] == "submit_decision"


@pytest.mark.parametrize("proposal,quantifier,assessment,expected", [
    ("false", "exists", {"relation": "counter"}, "unknown"),
    ("true", "all", {}, "unknown"),
    ("true", "exists", {}, "true"),
    ("false", "all", {"relation": "counter"}, "false"),
])
def test_quantifier_controls_judgement_with_partial_reading(prepare, proposal, quantifier, assessment, expected):
    snapshot, _ = prepare(["本公司本期收入变化记录。"], [assessment], proposal=proposal,
                          quantifier=quantifier, unread_page=True)
    result = screening_execution.execute_snapshot(snapshot, run_id="run", active=lambda: True, progress=lambda *args: None)
    decision = result.stock_decisions[0].condition_decisions[0]
    assert decision.state == expected
    assert decision.actual_values["coverage"]["complete"] is False


def test_quote_from_an_unread_page_cannot_create_a_positive_result(prepare):
    snapshot, _ = prepare(["本公司本期营业收入同比增长20%。"], [{}], unread_page=True, forged=True)
    result = screening_execution.execute_snapshot(snapshot, run_id="run", active=lambda: True, progress=lambda *args: None)
    decision = result.stock_decisions[0].condition_decisions[0]
    assert decision.state == "unknown" and decision.evaluation_status == "failed"


def test_tool_round_budget_ends_without_auto_rewriting_condition(prepare, monkeypatch):
    snapshot, observed = prepare(["本公司本期营业收入同比增长20%。"], [{}])
    monkeypatch.setattr(evidence_analysis, "MAX_ROUNDS", 1)
    result = screening_execution.execute_snapshot(snapshot, run_id="run", active=lambda: True, progress=lambda *args: None)
    assert observed == ["list_sources"]
    assert result.stock_decisions[0].evaluation_status == "failed"


def test_source_tools_expose_strict_schemas():
    for tool in evidence_analysis.tools():
        model_client._validate_strict_schema(tool.parameters)


def test_cancelled_model_response_is_not_published(prepare, monkeypatch):
    snapshot, observed = prepare(["本公司本期营业收入同比增长20%。"], [{}])
    original = model_client.create_tool_turn
    state = {"active": True}
    def cancel_after_response(*args, **kwargs):
        result = original(*args, **kwargs)
        state["active"] = False
        return result
    monkeypatch.setattr(model_client, "create_tool_turn", cancel_after_response)
    result = screening_execution.execute_snapshot(snapshot, run_id="run", active=lambda: state["active"], progress=lambda *args: None)
    assert result.status == "cancelled"
    assert result.stock_decisions[0].condition_decisions[0].evaluation_status == "not_evaluated"
    assert observed == ["list_sources"]


def test_explicit_report_scope_does_not_accept_another_report_quote(prepare):
    snapshot, _ = prepare(["本公司本期营业收入同比增长20%。", "另一份报告显示收入下降。"], [{}, {"relation": "counter"}])
    snapshot["task"]["conditions"][0]["expression"]["source_ids"] = ["doc-0"]
    result = screening_execution.execute_snapshot(snapshot, run_id="run", active=lambda: True, progress=lambda *args: None)
    decision = result.stock_decisions[0].condition_decisions[0]
    assert decision.state == "unknown" and decision.evaluation_status == "failed"
