from __future__ import annotations

import hashlib
from typing import Any
from uuid import uuid4

from .db import connect, json_dump, json_load, utc_now
from .jobs import JobLease
from .report_evidence import EvidenceServiceError, PROMPT_VERSION, evaluate_report
from .settings import llm_settings


def load_assessments(
    filter_versions: list[tuple[str, int]], as_of: str,
    evaluation_ids: dict | None = None,
) -> tuple[dict[tuple[str, int], dict[str, Any]], list[dict[str, Any]]]:
    results: dict[tuple[str, int], dict[str, Any]] = {}
    coverage: list[dict[str, Any]] = []
    with connect() as connection:
        for filter_id, version in filter_versions:
            item = connection.execute(
                "SELECT library,dsl_json FROM filters WHERE id=? AND version=?", (filter_id, version)
            ).fetchone()
            if not item or item[0] != "report":
                continue
            if json_load(item[1])["expression"].get("evaluation_mode") == "question":
                continue
            row = connection.execute(
                """SELECT id,status,coverage_json,result_json FROM report_evaluation_runs
                   WHERE filter_id=? AND filter_version=? AND as_of=? AND status IN ('succeeded','partial')
                     AND (?=0 OR id=?)
                   ORDER BY created_at DESC,rowid DESC LIMIT 1""",
                (filter_id, version, as_of, int(evaluation_ids is not None), (evaluation_ids or {}).get(f"{filter_id}@{version}")),
            ).fetchone()
            if not row:
                coverage.append({"filter_id": filter_id, "version": version, "state": "missing", "reason": "尚未对该截止日执行研报评估"})
                results[(filter_id, version)] = {}
                continue
            result_json = json_load(row[3])
            by_security = result_json.get("by_security", {}) if isinstance(result_json, dict) else {}
            results[(filter_id, version)] = by_security if isinstance(by_security, dict) else {}
            coverage.append({"filter_id": filter_id, "version": version, "evaluation_run_id": row[0], "state": row[1], "coverage": json_load(row[2])})
    return results, coverage


def _empty_rubric_assessment(criteria: list[dict[str, Any]], reason: str) -> dict[str, Any]:
    return {
        "subject_name": None,
        "state": "unknown",
        "criteria": [
            {"criterion_id": criterion["id"], "label": criterion["label"], "state": "unknown", "summary": reason, "evidence": []}
            for criterion in criteria
        ],
        "coverage": {"pages_total": 0, "pages_with_text": 0, "pages_sent": 0, "truncated": False, "complete": False},
        "quote_validation": "not_evaluated",
    }


def execute(lease: JobLease) -> None:
    job_id = lease.id
    with connect() as connection:
        job = connection.execute("SELECT payload_json FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not job:
            return
        payload = json_load(job[0])
        evaluation = connection.execute("SELECT * FROM report_evaluation_runs WHERE id=?", (payload["evaluation_run_id"],)).fetchone()
        filter_row = connection.execute(
            "SELECT dsl_json FROM filters WHERE id=? AND version=?",
            (payload["filter_id"], payload["filter_version"]),
        ).fetchone()
        if not evaluation or not filter_row:
            raise ValueError("评估条件版本已失效")
        expression = json_load(filter_row[0])["expression"]
        criteria = expression["criteria"]

    model = str(evaluation[5])
    rubric_hash = hashlib.sha256(json_dump({"criteria": criteria, "combine": expression["combine"], "lookback": expression["lookback_calendar_days"]}).encode("utf-8")).hexdigest()
    as_of = evaluation[3]
    start_date = evaluation[4]
    with connect() as connection:
        all_docs = connection.execute(
            "SELECT id,available_at,available_at_status FROM documents WHERE parse_status='indexed'"
        ).fetchall()
        eligible_rows = connection.execute(
            """SELECT id,sha256,title,publication_date,market,stock_code,stock_code_status,available_at,available_at_status
               FROM documents WHERE parse_status='indexed' AND available_at_status='confirmed'
                 AND available_at IS NOT NULL AND available_at>=? AND available_at<=?
               ORDER BY available_at DESC,id""",
            (start_date, as_of),
        ).fetchall()
    unconfirmed_availability = sum(row[1] is None or row[2] != "confirmed" for row in all_docs)
    after_as_of = sum(row[1] is not None and row[2] == "confirmed" and row[1] > as_of for row in all_docs)
    before_lookback = sum(row[1] is not None and row[2] == "confirmed" and row[1] < start_date for row in all_docs)
    assessments: list[dict[str, Any]] = []
    failed = 0
    cached_count = 0
    cancelled = False

    try:
        for index, doc in enumerate(eligible_rows):
            if not lease.active():
                cancelled = True
                break
            doc_id, digest, title, publication_date, market, candidate_code, binding_status, available_at, availability_status = tuple(doc)
            cache = None
            with connect() as connection:
                cache = connection.execute(
                    """SELECT assessment_json,status FROM report_assessment_cache
                       WHERE filter_id=? AND filter_version=? AND document_id=? AND document_sha256=?
                         AND rubric_hash=? AND model=? AND prompt_version=?""",
                    (payload["filter_id"], payload["filter_version"], doc_id, digest, rubric_hash, model, PROMPT_VERSION),
                ).fetchone()
                pages = connection.execute(
                    "SELECT page_number,text FROM document_pages WHERE document_id=? ORDER BY page_number", (doc_id,)
                ).fetchall()
            if cache and cache[1] == "succeeded":
                assessment = json_load(cache[0])
                cached_count += 1
            elif not llm_settings()["configured"] or llm_settings()["model"] != model:
                assessment = _empty_rubric_assessment(criteria, "未配置文本模型，未生成语义判断")
                failed += 1
            else:
                try:
                    assessment = evaluate_report(
                        criteria,
                        expression["combine"],
                        [{"page": page[0], "text": page[1]} for page in pages],
                    )
                    if not lease.active():
                        cancelled = True
                        break
                    with connect() as connection:
                        connection.execute(
                            """INSERT OR IGNORE INTO report_assessment_cache
                               (id,filter_id,filter_version,document_id,document_sha256,rubric_hash,model,prompt_version,status,assessment_json,created_at)
                               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                            (str(uuid4()), payload["filter_id"], payload["filter_version"], doc_id, digest, rubric_hash, model, PROMPT_VERSION, "succeeded", json_dump(assessment), utc_now()),
                        )
                except EvidenceServiceError as exc:
                    assessment = _empty_rubric_assessment(criteria, str(exc))
                    failed += 1
                except Exception as exc:
                    assessment = _empty_rubric_assessment(criteria, f"评估异常：{str(exc)[:180]}")
                    failed += 1

            if not lease.active():
                cancelled = True
                break
            extraction = assessment.get("security_candidates", []) if isinstance(assessment, dict) else []
            primary_candidate = assessment.get("primary_security_candidate") if isinstance(assessment, dict) else None
            if isinstance(primary_candidate, dict) and binding_status != "confirmed":
                extracted_code = str(primary_candidate.get("canonical_code", "")).upper()
                if extracted_code:
                    with connect() as connection:
                        connection.execute(
                            """UPDATE documents SET stock_code=?,market=?,stock_code_status='llm_candidate',
                                      stock_code_source='llm',stock_code_evidence_json=?,stock_code_model=?,stock_code_extracted_at=?,stock_code_prompt_version=?
                               WHERE id=? AND stock_code_status!='confirmed'""",
                            (extracted_code, extracted_code.rsplit(".", 1)[-1], json_dump(extraction), model, utc_now(), PROMPT_VERSION, doc_id),
                        )
                    candidate_code = extracted_code
                    binding_status = "llm_candidate"
            elif isinstance(assessment, dict) and assessment.get("prompt_version") == PROMPT_VERSION and binding_status != "confirmed":
                issuer_codes = {
                    str(item.get("canonical_code", "")).upper()
                    for item in extraction
                    if isinstance(item, dict) and item.get("role") == "issuer"
                }
                extracted_status = "llm_ambiguous" if len(issuer_codes) > 1 else ("llm_subject_unclear" if extraction else "llm_no_candidate")
                with connect() as connection:
                    connection.execute(
                        """UPDATE documents SET stock_code=NULL,market=NULL,stock_code_status=?,stock_code_source='llm',
                                  stock_code_evidence_json=?,stock_code_model=?,stock_code_extracted_at=?,stock_code_prompt_version=?
                           WHERE id=? AND stock_code_status!='confirmed'""",
                        (extracted_status, json_dump(extraction), model, utc_now(), PROMPT_VERSION, doc_id),
                    )
                candidate_code = None
                binding_status = extracted_status
            confirmed_code = candidate_code if binding_status == "confirmed" else None
            assessments.append({
                "document_id": doc_id, "title": title, "publication_date": publication_date,
                "publication_date_source": "filename_candidate",
                "available_at": available_at, "availability_status": availability_status,
                "market": market, "candidate_code": candidate_code, "binding_status": binding_status,
                "stock_code": confirmed_code, **assessment,
            })
            lease.progress((index + 1) / max(1, len(eligible_rows)), f"已评估 {index + 1}/{len(eligible_rows)} 份研报")
    except Exception as exc:
        lease.finish("failed", f"研报评估失败：{type(exc).__name__}")
        return

    cancelled = cancelled or not lease.active()

    by_security_docs: dict[str, list[dict[str, Any]]] = {}
    for assessment in assessments:
        if assessment["stock_code"]:
            by_security_docs.setdefault(assessment["stock_code"], []).append(assessment)
    by_security: dict[str, dict[str, Any]] = {}
    for code, docs in by_security_docs.items():
        states = [item["state"] for item in docs]
        state = "true" if "true" in states else ("false" if states and all(value == "false" for value in states) else "unknown")
        by_security[code] = {
            "state": state,
            "reason": "合并已确认绑定、在截止日前可用的本地研报；没有本地研报不代表不符合",
            "assessments": docs,
        }
    unconfirmed_count = sum(item["binding_status"] != "confirmed" for item in assessments)
    incomplete = not assessments or failed or unconfirmed_availability or unconfirmed_count or any(item["state"] == "unknown" or not item["coverage"]["complete"] for item in assessments)
    coverage = {
        "state": "cancelled" if cancelled else ("partial" if incomplete else "complete"),
        "corpus_scope": "indexed_local_reports_only",
        "corpus_is_exhaustive": False,
        "documents_indexed": len(all_docs),
        "documents_in_window": len(eligible_rows),
        "excluded_after_as_of": after_as_of,
        "excluded_before_lookback": before_lookback,
        "excluded_unconfirmed_availability_date": unconfirmed_availability,
        "evaluated": len(assessments),
        "cached": cached_count,
        "failed_or_unknown": sum(item["state"] == "unknown" for item in assessments),
        "model_errors": failed,
        "confirmed_security_bindings": sum(item["binding_status"] == "confirmed" for item in assessments),
        "unconfirmed_security_bindings": unconfirmed_count,
        "start_date": start_date,
        "as_of": as_of,
        "note": "严格历史评估只纳入人工确认的首次可用日期；文件名日期只是候选。范围只覆盖已索引本地研报，不代表全市场研报覆盖。",
    }
    result = {"assessments": assessments, "by_security": by_security, "coverage": coverage}
    run_status = "cancelled" if cancelled else ("partial" if incomplete else "succeeded")
    lease.finish(run_status, f"研报评估完成：范围内 {len(assessments)} 份，已确认证券绑定 {coverage['confirmed_security_bindings']} 份", result, coverage)
