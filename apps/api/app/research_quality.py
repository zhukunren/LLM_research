"""Auditable checks for frozen evidence and annotated research benchmark answers."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import re
from typing import Literal

from pydantic import Field, ValidationError, field_validator

from . import evidence_sources, research_matrices, research_projects
from .db import connect, json_load, utc_now
from .screening_contracts import ContractModel

ZONE = timezone(timedelta(hours=8))


def _numeric_value(value):
    text = str(value)
    if ',' in text:
        if not re.fullmatch(r'[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?', text):
            raise InvalidOperation('Invalid thousands grouping')
        text = text.replace(',', '')
    return Decimal(text)


class BenchmarkFact(ContractModel):
    key: str = Field(min_length=1, max_length=100)
    value: str | int | float
    unit: str = Field(min_length=1, max_length=100)
    period: str = Field(min_length=1, max_length=100)
    source_ids: list[str] = Field(max_length=12)

    @field_validator("value", mode="before")
    @classmethod
    def numeric_value_cannot_be_boolean(cls, value):
        if isinstance(value, bool):
            raise ValueError("A numeric fact cannot be a boolean")
        return value


class BenchmarkCitation(ContractModel):
    source_id: str = Field(min_length=1, max_length=100)
    quote: str = Field(min_length=1, max_length=5000)
    start_hint: int | None = Field(default=None, ge=0)


class BenchmarkResponse(ContractModel):
    state: Literal["answered", "insufficient_data", "conflicting"]
    answer: str = Field(default="", max_length=20000)
    facts: list[BenchmarkFact] = Field(default_factory=list, max_length=20)
    citations: list[BenchmarkCitation] = Field(default_factory=list, max_length=20)


def available_by(value: str, cutoff: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value)
        day = parsed.astimezone(ZONE).date() if parsed.tzinfo else parsed.date()
        return day <= date.fromisoformat(cutoff)
    except (TypeError, ValueError):
        return False


def check_reference(reference: dict, cutoff: str) -> list[str]:
    issues = []
    text, quote = reference.get("text", ""), reference.get("quote", "")
    positions = [reference.get("quote_start", -1), reference.get("quote_end", -1), reference.get("char_start", 0)]
    if any(type(value) is not int for value in positions):
        return ["quote_mismatch"]
    start, end = positions[0] - positions[2], positions[1] - positions[2]
    if not quote or not 0 <= start < end <= len(text) or text[start:end] != quote:
        issues.append("quote_mismatch")
    if not available_by(reference.get("available_at", ""), cutoff):
        issues.append("outside_cutoff")
    return issues


def project_audit(project_id: str) -> dict:
    issues = []
    metrics = {"claims": 0, "references": 0, "valid_references": 0, "stale_claims": 0, "matrix_cells": 0, "reviewed_cells": 0, "needs_review_cells": 0}
    with connect() as connection:
        research_projects._require_project(connection, project_id)
        claims = connection.execute("""SELECT c.*,n.revision current_revision,n.title note_title FROM research_claims c
            JOIN research_notes n ON n.id=c.note_id WHERE n.project_id=? ORDER BY c.created_at DESC LIMIT 2000""", (project_id,)).fetchall()
        for claim in claims:
            metrics["claims"] += 1
            if claim["note_revision"] != claim["current_revision"]:
                metrics["stale_claims"] += 1
                issues.append({"kind": "claim", "id": claim["id"], "note_id": claim["note_id"], "title": claim["statement"], "code": "note_revision_changed"})
            for reference in json_load(claim["evidence_json"]):
                metrics["references"] += 1
                errors = check_reference(reference, claim["as_of"])
                metrics["valid_references"] += not errors
                for error in errors:
                    issues.append({"kind": "claim", "id": claim["id"], "note_id": claim["note_id"], "title": claim["statement"], "code": error})
            for reference in json_load(claim["numeric_evidence_json"]):
                from .financial_contracts import digest
                data = reference.get("data_snapshot", {})
                identity = digest({key: value for key, value in data.items() if key not in {"id", "citation_url", "created_at"}})
                valid = reference.get("source_id") == identity and data.get("stock_code") == claim["stock_code"] and data.get("as_of", "9999") <= claim["as_of"]
                metrics["references"] += 1
                metrics["valid_references"] += valid
                if not valid:
                    issues.append({"kind": "claim", "id": claim["id"], "note_id": claim["note_id"], "title": claim["statement"], "code": "numeric_snapshot_mismatch"})
        runs = connection.execute("""SELECT r.* FROM research_matrix_runs r JOIN research_matrices m ON m.id=r.matrix_id
            WHERE m.project_id=? AND r.status IN ('succeeded','partial','failed','cancelled') ORDER BY r.created_at DESC LIMIT 200""", (project_id,)).fetchall()
        for run in runs:
            for cell in research_matrices._cells(connection, run):
                metrics["matrix_cells"] += 1
                metrics["reviewed_cells"] += cell["review_revision"] > 0
                metrics["needs_review_cells"] += cell["status"] in {"pending", "needs_review"}
                if cell["status"] in {"pending", "needs_review"}:
                    issues.append({"kind": "matrix", "id": run["matrix_id"], "run_id": run["id"], "title": cell["stock_code"] + " · " + cell["question_id"], "code": "cell_pending" if cell["status"] == "pending" else "cell_needs_review"})
                for reference in cell.get("evidence", []):
                    metrics["references"] += 1
                    errors = check_reference(reference, run["as_of"])
                    metrics["valid_references"] += not errors
                    for error in errors:
                        issues.append({"kind": "matrix", "id": run["matrix_id"], "run_id": run["id"], "title": cell["stock_code"] + " · " + cell["question_id"], "code": error})
    return {"project_id": project_id, "checked_at": utc_now(), "metrics": metrics, "issues": issues[:300], "issue_count": len(issues),
            "limits": {"claims": 2000, "matrix_runs": 200}, "semantic_support_verified": False,
            "note": "仅检查原文定位、资料日期和版本一致性；结论语义、数值推导及投资意义需人工复核。数值正确率请使用带标准答案的评测集。"}


def evaluate_case(case: dict, response: dict, sources: dict) -> dict:
    """Evaluate atomic annotated facts, units, periods and located numeric spans."""
    try:
        response = BenchmarkResponse.model_validate(response).model_dump()
    except ValidationError:
        return {"case_id": case["id"], "category": case["category"], "automated_pass": False, "issues": ["malformed_response"], "human_review_required": True}
    issues, citations = [], {}
    if response.get("state") != case["expected_state"]:
        issues.append("answer_state_mismatch")
    for citation in response.get("citations", []):
        source_id = citation.get("source_id")
        source = sources.get(source_id)
        if source is None or source_id not in case["source_ids"]:
            issues.append("source_outside_case")
            continue
        if not available_by(source["available_at"], case["as_of"]):
            issues.append("outside_cutoff")
            continue
        try:
            located = evidence_sources.locate_quote({"text": source["text"], "char_start": 0, "source_type": "benchmark", "source_id": source_id,
                "stock_code": "", "page_number": 1}, citation.get("quote", ""), start_hint=citation.get("start_hint"))
            citations.setdefault(source_id, []).append((located["char_start"], located["char_end"]))
        except evidence_sources.EvidenceSourceError:
            issues.append("quote_mismatch")
    expected = {fact["key"]: fact for fact in case.get("expected_facts", [])}
    actual = {}
    for fact in response.get("facts", []):
        key = fact.get("key")
        if key not in expected or key in actual:
            issues.append("unexpected_or_duplicate_fact")
        actual[key] = fact
    for key, fact in expected.items():
        answer = actual.get(key)
        if answer is None:
            issues.append("missing_fact:" + key)
            continue
        try:
            value = _numeric_value(answer["value"])
            correct = value.is_finite() and abs(value - Decimal(str(fact["value"]))) <= Decimal(str(fact.get("tolerance", "0.000001")))
        except (KeyError, InvalidOperation, TypeError, ValueError):
            correct = False
        if not correct:
            issues.append("numeric_mismatch:" + key)
        if answer.get("unit") != fact["unit"]:
            issues.append("unit_mismatch:" + key)
        if answer.get("period") != fact["period"]:
            issues.append("period_mismatch:" + key)
        source_ids = answer.get("source_ids", [])
        if fact["source_id"] not in source_ids or any(source_id not in case["source_ids"] or source_id not in sources for source_id in source_ids):
            issues.append("fact_source_mismatch:" + key)
        start, end = fact["numeric_span"]
        if not any(left <= start and right >= end for left, right in citations.get(fact["source_id"], [])):
            issues.append("numeric_evidence_missing:" + key)
    if case["expected_state"] == "insufficient_data" and response.get("facts"):
        issues.append("unsupported_fact_in_refusal")
    return {"case_id": case["id"], "category": case["category"], "automated_pass": not issues,
            "issues": sorted(set(issues)), "human_review_required": True,
            "note": "通过仅表示结构化事实与冻结标准答案一致，不等于自然语言结论已被语义验证。"}
