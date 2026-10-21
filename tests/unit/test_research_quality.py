from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys

import pytest

from apps.api.app import research_quality
from scripts.benchmark_research_quality import load_suite, reference_response

SUITE = Path(__file__).resolve().parents[2] / "data/evaluation/research-core-v1.json"


def test_all_public_benchmark_annotations_are_internally_consistent():
    suite, sources = load_suite(SUITE)
    assert len(suite["cases"]) == 31
    assert len({case["category"] for case in suite["cases"]}) == 7
    assert all(research_quality.evaluate_case(case, reference_response(case, sources), sources)["automated_pass"] for case in suite["cases"])
    result = subprocess.run([sys.executable, "scripts/benchmark_research_quality.py", "--mode", "validate"], cwd=SUITE.parents[2], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout)["model_evaluated"] is False


def test_future_value_questions_do_not_request_the_current_period_in_structured_fields():
    suite, _ = load_suite(SUITE)
    current = {fact["key"]: fact["period"] for case in suite["cases"] if case["category"] == "extract" for fact in case["expected_facts"]}
    for case in suite["cases"]:
        if case["category"] == "unsupported_forecast":
            for field in case["requested_fields"]:
                assert field["period"] != current[field["key"]]
                assert field["period"] in case["question"]


@pytest.mark.parametrize('value,passed', [('12,345.67', True), ('12,34,5.67', False), ('12,345.68', False)])
def test_numeric_grading_accepts_valid_thousands_groups_without_hiding_wrong_values(value, passed):
    text = '营业收入12,345.67元。'
    source = {'s': {'text':text,'available_at':'2025-04-03'}}
    case = {'id':'grouped-number','category':'numeric','as_of':'2025-04-30','source_ids':['s'],'expected_state':'answered',
        'expected_facts':[{'key':'revenue','value':'12345.67','unit':'CNY_yuan','period':'FY2024','source_id':'s','numeric_span':[4,13]}]}
    response = reference_response(case, source)
    response['facts'][0]['value'] = value
    assert research_quality.evaluate_case(case, response, source)['automated_pass'] is passed


@pytest.mark.parametrize("mutation,expected", [
    ("value", "numeric_mismatch"), ("unit", "unit_mismatch"), ("period", "period_mismatch"),
    ("quote", "quote_mismatch"), ("source", "source_outside_case"), ("missing", "missing_fact"),
])
def test_benchmark_checks_metric_context_and_located_evidence_not_just_numbers(mutation, expected):
    suite, sources = load_suite(SUITE)
    case = suite["cases"][0]
    response = reference_response(case, sources)
    if mutation == "quote":
        response["citations"][0]["quote"] = "A made up quotation."
    elif mutation == "source":
        response["citations"][0]["source_id"] = "other-company"
    elif mutation == "missing":
        response["facts"] = []
    else:
        response["facts"][0][mutation] = {"value": "94.9", "unit": "CNY_billion", "period": "FY2023"}[mutation]
    result = research_quality.evaluate_case(case, response, sources)
    assert not result["automated_pass"] and any(item.startswith(expected) for item in result["issues"])
    assert result["human_review_required"]


def test_benchmark_excludes_future_sources_and_unjustified_refusal_facts():
    suite, sources = load_suite(SUITE)
    case = next(item for item in suite["cases"] if item["category"] == "historical_cutoff")
    response = reference_response(suite["cases"][0], sources)
    response["state"] = "insufficient_data"
    result = research_quality.evaluate_case(case, response, sources)
    assert "outside_cutoff" in result["issues"] and "unsupported_fact_in_refusal" in result["issues"]


def test_correct_number_with_a_quote_that_omits_the_number_does_not_pass():
    suite, sources = load_suite(SUITE)
    case = suite["cases"][0]
    response = reference_response(case, sources)
    response["citations"][0]["quote"] = "constant currency"
    result = research_quality.evaluate_case(case, response, sources)
    assert not result["automated_pass"] and "numeric_evidence_missing:msft-revenue" in result["issues"]


@pytest.mark.parametrize("response", [None, {"state": "answered", "facts": "bad"}, {"state": "answered", "citations": [{"quote": "incomplete"}]}])
def test_malformed_answers_fail_without_crashing_a_suite(response):
    suite, sources = load_suite(SUITE)
    assert research_quality.evaluate_case(suite["cases"][0], response, sources)["issues"] == ["malformed_response"]


def test_grading_saved_answers_records_failures_and_creates_a_human_review_sheet(tmp_path):
    suite, sources = load_suite(SUITE)
    responses = [{"case_id": case["id"], "response": reference_response(case, sources)} for case in suite["cases"]]
    responses[0]["response"]["facts"][0]["unit"] = "wrong"
    path = tmp_path / "responses.json"
    path.write_text(json.dumps(responses), encoding="utf-8")
    result = subprocess.run([sys.executable, "scripts/benchmark_research_quality.py", "--mode", "grade", "--responses", str(path), "--output-root", str(tmp_path / "results")], cwd=SUITE.parents[2], capture_output=True, text=True)
    assert result.returncode == 1
    summary = json.loads(result.stdout.splitlines()[-1])
    assert summary["evaluated"] == 31 and summary["failed"] == 1 and summary["human_review_required"]
    report = Path(summary["output"])
    assert report.with_name("human-review.csv").is_file()
    assert not json.loads(report.read_text(encoding="utf-8"))["summary"]["human_review_completed"]


def test_benchmark_rejects_a_boolean_that_would_coerce_to_the_correct_number():
    sources = {"s": {"text": "Metric was 1.", "available_at": "2026-09-10"}}
    case = {"id": "boolean", "category": "numeric", "source_ids": ["s"], "as_of": "2026-09-10", "expected_state": "answered",
        "expected_facts": [{"key": "metric", "value": "1", "unit": "count", "period": "FY2026", "source_id": "s", "numeric_span": [11, 12]}]}
    response = reference_response(case, sources)
    assert research_quality.evaluate_case(case, response, sources)["automated_pass"]
    response["facts"][0]["value"] = True
    assert research_quality.evaluate_case(case, response, sources)["issues"] == ["malformed_response"]


def test_benchmark_rejects_unprovided_sources_in_the_fact_source_list():
    suite, sources = load_suite(SUITE)
    case = suite["cases"][0]
    response = reference_response(case, sources)
    response["facts"][0]["source_ids"].append("unprovided-source")
    result = research_quality.evaluate_case(case, response, sources)
    assert not result["automated_pass"] and "fact_source_mismatch:msft-revenue" in result["issues"]


def test_regrading_accepts_the_exact_suite_snapshot_for_differently_formatted_input(tmp_path):
    suite, sources = load_suite(SUITE)
    suite_path = tmp_path / "compact-suite.json"
    suite_path.write_text(json.dumps(suite, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    responses_path = tmp_path / "responses.json"
    responses_path.write_text(json.dumps([{"case_id": suite["cases"][0]["id"], "response": reference_response(suite["cases"][0], sources)}]), encoding="utf-8")
    command = [sys.executable, "scripts/benchmark_research_quality.py", "--mode", "grade", "--limit", "1", "--output-root", str(tmp_path / "results")]
    first = subprocess.run([*command, "--suite", str(suite_path), "--responses", str(responses_path)], cwd=SUITE.parents[2], capture_output=True, text=True)
    assert first.returncode == 0, first.stdout + first.stderr
    report = Path(json.loads(first.stdout.splitlines()[-1])["output"])
    again = subprocess.run([*command, "--suite", str(report.with_name("suite.json")), "--responses", str(report)], cwd=SUITE.parents[2], capture_output=True, text=True)
    assert again.returncode == 0, again.stdout + again.stderr
