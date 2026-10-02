from __future__ import annotations

import hashlib
import logging
import time
from threading import Event, Thread
from typing import Any
from uuid import uuid4

from .db import connect, json_dump, json_load, utc_now
from .condition_contract import describe_filter
from .jobs import JobLease, claim
from .report_evidence import EvidenceServiceError, PROMPT_VERSION, evaluate_report
from .settings import llm_settings
from .market import cached_profile, iter_recent_bars, source_fingerprint
from .patterns import score_window
from .rules import combine, evaluate_filter, pattern_references, references, resolve_filter_expression
from .settings import MAX_RECENT_BARS
from . import market as market_data
from . import screening_execution


def _eval_tree(
    node: dict[str, Any],
    stock_code: str,
    bars: list[dict[str, Any]],
    filters: dict[tuple[str, int], dict[str, Any]],
    patterns: dict[tuple[str, int], dict[str, Any]],
    report_assessments: dict[tuple[str, int], dict[str, Any]],
    path: str = "root",
) -> tuple[str, list[dict[str, Any]], float]:
    op = node.get("op")
    if op == "filter_ref":
        key = (node["filter_id"], node["version"])
        item = filters[key]
        library = item["library"]
        if library == "technical":
            expression = resolve_filter_expression(library, item["expression"], node.get("parameter_overrides"))
            detail = evaluate_filter(expression, bars)
            detail["effective_expression"] = expression
            detail["parameter_overrides"] = node.get("parameter_overrides", {})
            detail["summary"] = describe_filter(library, expression)["summary"]
        elif library == "news":
            detail = {"state": "unknown", "reason": "旧版筛选运行不执行资讯证据；请使用新版对话执行流程"}
        else:
            security_assessments = report_assessments.get(key, {})
            assessment = security_assessments.get(stock_code)
            if assessment:
                detail = {**assessment}
            else:
                detail = {"state": "unknown", "reason": "没有该证券已确认绑定且符合截止日的研报评估；无报告不等于不符合"}
        weight = max(0.0, min(100.0, float(node.get("score_weight", 1))))
        detail["score_weight"] = weight
        detail["score_contribution"] = weight if detail["state"] == "true" else 0.0
        detail.update({"filter_id": item["id"], "version": item["version"], "name": item["name"], "node_path": path,
                       "provenance": item.get("provenance", {}), "data_date": bars[-1].get("trade_date") if bars else None})
        return detail["state"], [detail], detail["score_contribution"]
    if op == "pattern_ref":
        key = (node["pattern_id"], node["version"])
        pattern = patterns[key]
        detail = score_window(pattern, bars, match_mode=node.get("match_mode"), recent_bars=node.get("recent_bars"))
        if detail["state"] == "true":
            threshold = float(node.get("min_similarity", pattern.get("params", {}).get("min_similarity", 80)))
            detail["state"] = "true" if detail["similarity"] >= threshold else "false"
            detail["threshold"] = threshold
        weight = max(0.0, min(100.0, float(node.get("score_weight", 1))))
        detail["score_weight"] = weight
        detail["score_contribution"] = weight if detail["state"] == "true" else 0.0
        detail.update({"pattern_id": pattern["id"], "version": pattern["version"], "name": pattern["name"], "node_path": path, "provenance": pattern.get("provenance")})
        return detail["state"], [detail], detail["score_contribution"]
    if op in {"all", "any", "not"}:
        child_states: list[str] = []
        details: list[dict[str, Any]] = []
        for index, child in enumerate(node["children"]):
            state, child_detail, _ = _eval_tree(child, stock_code, bars, filters, patterns, report_assessments, f"{path}.{index}")
            child_states.append(state)
            details.extend(child_detail)
        combined = combine(op, child_states)
        if op == "not":
            weight = sum(float(item.get("score_weight", 0)) for item in details) if combined == "true" else 0.0
            for item in details:
                item["score_contribution"] = 0.0
            if details and combined == "true":
                details[0]["score_contribution"] = weight
        score = sum(float(item.get("score_contribution", 0)) for item in details)
        return combined, details, score
    return "unknown", [{"state": "unknown", "reason": f"未知策略节点：{op}"}], 0.0


def logic_trace(node: dict, details: list[dict], path: str = "root") -> dict:
    if node["op"] in ("filter_ref", "pattern_ref"):
        detail = next((item for item in details if item.get("node_path") == path), {})
        return {"op": node["op"], "path": path, "name": detail.get("name"), "state": detail.get("state", "unknown")}
    children = [logic_trace(child, details, f"{path}.{index}") for index, child in enumerate(node["children"])]
    return {"op": node["op"], "path": path, "state": combine(node["op"], [child["state"] for child in children]), "children": children}


def _load_snapshots(strategy: dict[str, Any]) -> tuple[dict[tuple[str, int], dict[str, Any]], dict[tuple[str, int], dict[str, Any]]]:
    filter_map: dict[tuple[str, int], dict[str, Any]] = {}
    pattern_map: dict[tuple[str, int], dict[str, Any]] = {}
    with connect() as connection:
        for filter_id, version in references(strategy["tree"]):
            row = connection.execute(
                "SELECT id,library,name,version,dsl_json FROM filters WHERE id=? AND version=?",
                (filter_id, version),
            ).fetchone()
            if row:
                payload = json_load(row[4])
                filter_map[(filter_id, version)] = {
                    "id": row[0], "library": row[1], "name": row[2], "version": row[3],
                    "expression": payload["expression"], "provenance": payload.get("provenance", {}),
                }
        for pattern_id, version in pattern_references(strategy["tree"]):
            row = connection.execute(
                "SELECT id,name,version,pattern_json FROM patterns WHERE id=? AND version=?",
                (pattern_id, version),
            ).fetchone()
            if row:
                payload = json_load(row[3])
                pattern_map[(pattern_id, version)] = {"id": row[0], "name": row[1], "version": row[2], **payload}
    return filter_map, pattern_map


def _load_report_assessments(
    strategy: dict[str, Any], as_of: str,
    evaluation_ids: dict | None = None,
) -> tuple[dict[tuple[str, int], dict[str, Any]], list[dict[str, Any]]]:
    results: dict[tuple[str, int], dict[str, Any]] = {}
    coverage: list[dict[str, Any]] = []
    with connect() as connection:
        for filter_id, version in references(strategy["tree"]):
            item = connection.execute(
                "SELECT library FROM filters WHERE id=? AND version=?", (filter_id, version)
            ).fetchone()
            if not item or item[0] != "report":
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


def _execute_report_evaluation(lease: JobLease) -> None:
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


def _execute_screening(lease: JobLease) -> None:
    job_id = lease.id
    with connect() as connection:
        job = connection.execute("SELECT payload_json FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not job:
            return
        payload = json_load(job[0])
        run = connection.execute(
            "SELECT id,as_of,result_json,mode,context_json FROM screening_runs WHERE id=?", (payload["run_id"],)
        ).fetchone()
        strategy_row = connection.execute(
            "SELECT strategy_json FROM strategies WHERE id=? AND version=?",
            (payload["strategy_id"], payload["strategy_version"]),
        ).fetchone()
        if not run or not strategy_row:
            raise ValueError("运行引用已失效")
        context = json_load(run[4])
        strategy = context.get("strategy_snapshot") or json_load(strategy_row[0])

    filter_map, pattern_map = _load_snapshots(strategy)
    report_assessments, report_coverage = _load_report_assessments(strategy, run[1], context.get("report_evaluation_ids"))
    matched: list[dict[str, Any]] = []
    unknown_samples: list[dict[str, Any]] = []
    counts = {"evaluated": 0, "true": 0, "false": 0, "unknown": 0}
    fingerprint = source_fingerprint()
    if "source_fingerprint" in context and context["source_fingerprint"] != (list(fingerprint) if fingerprint else None):
        raise ValueError("排队期间行情发生变化，请发起新的筛选")
    profile = cached_profile()
    if not profile.get("available"):
        raise ValueError("本地行情文件不可用")
    watermark = profile.get("last_date")
    cancelled = False
    decisions: list[dict] = []
    universe = context.get("universe", {"kind": "all_a_shares", "name": "全部 A 股", "codes": None})
    selected_codes = set(universe["codes"]) if universe.get("codes") is not None else None
    seen_codes: set[str] = set()

    try:
        scan = iter_recent_bars(run[1], MAX_RECENT_BARS, sorted(selected_codes)) if selected_codes is not None else iter_recent_bars(run[1], MAX_RECENT_BARS)
        for stock_code, bars in scan:
            if selected_codes is not None and stock_code not in selected_codes:
                continue
            seen_codes.add(stock_code)
            if counts["evaluated"] % 100 == 0:
                if not lease.active():
                    cancelled = True
                    break
                lease.progress(min(0.98, counts["evaluated"] / max(1, profile.get("securities", 6000))), f"已评估 {counts['evaluated']:,} 只证券")
            counts["evaluated"] += 1
            state, details, score = _eval_tree(strategy["tree"], stock_code, bars, filter_map, pattern_map, report_assessments)
            stale_reason = None
            if context.get("effective_market_date") and bars[-1]["trade_date"] != context["effective_market_date"]:
                stale_reason = "该证券在所选市场交易日没有行情；不能用更早的价格代替当前判断"
                state, score = "unknown", 0.0
                for detail in details:
                    detail.update({"state": "unknown", "reason": stale_reason, "score_contribution": 0.0})
            counts[state] += 1
            last = bars[-1]
            item = {
                "stock_code": stock_code,
                "market": stock_code.rsplit(".", 1)[-1],
                "as_of": last["trade_date"],
                "close": last["close"],
                "state": state,
                "score": round(score, 4),
                "details": details,
                "logic": logic_trace(strategy["tree"], details),
                "reason": stale_reason,
            }
            decisions.append(item)
            if state == "true":
                matched.append(item)
            elif state == "unknown" and len(unknown_samples) < 30:
                unknown_samples.append(item)
        for code in sorted((selected_codes or set()) - seen_codes):
            state, details, _ = _eval_tree(strategy["tree"], code, [], filter_map, pattern_map, report_assessments)
            for detail in details:
                detail.update({"state": "unknown", "reason": "股票池内该证券在截止日前没有可用 A 股行情", "score_contribution": 0.0})
            item = {"stock_code": code, "market": code.rsplit(".", 1)[-1], "as_of": None, "close": None, "state": "unknown", "score": 0, "details": details, "logic": logic_trace(strategy["tree"], details), "reason": "没有可用行情"}
            counts["evaluated"] += 1
            counts["unknown"] += 1
            decisions.append(item)
            if len(unknown_samples) < 30:
                unknown_samples.append(item)
        if source_fingerprint() != fingerprint:
            raise ValueError("扫描期间行情文件发生变化，请重新运行")
    except Exception as exc:
        lease.finish("failed", f"筛选任务失败：{type(exc).__name__}；请检查行情文件及条件")
        return

    matched.sort(key=lambda item: (-item["score"], item["stock_code"]))
    top_n = strategy.get("top_n", 30)
    result = {
        "counts": counts,
        "results": matched[:top_n],
        "truncated_matches": max(0, len(matched) - top_n),
        "unknown_sample": unknown_samples,
        "mode": run[3],
        "ranking": "按组合树中命中条件的用户权重求和；同分按证券代码稳定排序后应用 TopN",
        "data_snapshot": {"watermark": watermark, "stock_file_bytes": profile.get("bytes"), "sha256": profile.get("sha256"), "price_basis": profile.get("price_basis", "unknown")},
        "report_evaluation_coverage": report_coverage,
        "universe": universe,
        "strategy_snapshot": strategy,
        "condition_snapshots": list(filter_map.values()),
        "trace_version": "condition-decisions-v1",
        "warnings": ["探索模式：复权口径和量额单位尚未确认", "证券基础资料和完整交易日历尚未接入"],
    }
    state = "cancelled" if cancelled else ("partial" if counts["unknown"] or counts["evaluated"] == 0 else "succeeded")
    lease.finish(state, f"完成：评估 {counts['evaluated']:,} 只，命中 {counts['true']:,} 只，未知 {counts['unknown']:,} 只", result, decisions=decisions)


def _execute_screening_task(lease: JobLease) -> None:
    with connect() as connection:
        row = connection.execute(
            "SELECT snapshot_json FROM screening_task_runs WHERE id=?",
            (lease.payload["run_id"],),
        ).fetchone()
    if not row:
        lease.finish("failed", "筛选运行快照不存在")
        return
    snapshot = json_load(row[0])
    fingerprint = market_data.source_fingerprint()
    if fingerprint is None or list(fingerprint) != snapshot.get("source_fingerprint"):
        lease.finish("failed", "行情来源在排队后发生变化，请重新创建筛选运行")
        return

    result = screening_execution.execute_snapshot(
        snapshot,
        run_id=lease.payload["run_id"],
        active=lease.active,
        progress=lease.progress,
    )
    summary = result.model_dump(mode="json", exclude={"stock_decisions"})
    coverage = result.coverage
    message = (
        f"筛选完成：共 {coverage.target_total} 只，符合 {coverage.true_count} 只，"
        f"不符合 {coverage.false_count} 只，未知 {coverage.unknown_count} 只"
    )
    if result.status == "partial":
        message += "；含有未能确认的条件结果"
    lease.finish(
        result.status,
        message,
        summary,
        decisions=[item.model_dump(mode="json") for item in result.stock_decisions],
    )


def execute_job(job_id: str | None = None, *, kinds: tuple[str, ...] | None = None, exclude_kinds: tuple[str, ...] = ()) -> bool:
    lease = claim(job_id, kinds=kinds, exclude_kinds=exclude_kinds)
    if lease is None:
        return False
    with lease:
        try:
            if lease.kind == "screening":
                _execute_screening(lease)
            elif lease.kind == "screening_task":
                _execute_screening_task(lease)
            elif lease.kind == "research_scan":
                from .research_scan_service import execute_scan
                execute_scan(lease)
            elif lease.kind == "research_turn":
                from .research_turn_service import execute_turn
                execute_turn(lease)
            elif lease.kind == "report_evaluation":
                _execute_report_evaluation(lease)
            elif lease.kind == "report_metadata":
                from .report_catalog import execute
                execute(lease)
            elif lease.kind == "data_sync":
                from .product_api import refresh_data
                refresh_data(lease)
            else:
                lease.finish("failed", "未知任务类型")
        except Exception as exc:
            logging.getLogger(__name__).exception("Job failed: %s", lease.id)
            lease.finish("failed", f"后台任务执行失败：{type(exc).__name__}；请检查数据和固定版本引用后重试")
    return True


def execute_screening(job_id: str) -> None:
    execute_job(job_id)


def execute_report_evaluation(job_id: str) -> None:
    execute_job(job_id)


def run_worker(poll_seconds: float = 1.0, *, stop_event: Event | None = None) -> None:
    stop = stop_event if stop_event is not None else Event()

    def consume(*, kinds=None, exclude_kinds=()):
        while not stop.is_set():
            try:
                if not execute_job(kinds=kinds, exclude_kinds=exclude_kinds):
                    stop.wait(poll_seconds)
            except Exception:
                logging.getLogger(__name__).exception("Worker lane failed")
                stop.wait(poll_seconds)

    # A Codex turn can wait for a scan, so its consumer must run independently.
    research = Thread(target=consume, kwargs={"kinds": ("research_turn",)}, name="research-turn-worker", daemon=True)
    research.start()
    try:
        consume(exclude_kinds=("research_turn",))
    finally:
        stop.set()
        research.join(timeout=2)


if __name__ == "__main__":
    from .db import init_db

    init_db()
    run_worker()
