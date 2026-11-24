from __future__ import annotations

from typing import Any

from . import market, report_evaluation, tushare_feature_rules
from .condition_contract import describe_filter
from .db import connect, json_load
from .jobs import JobLease
from .market import cached_profile, iter_recent_bars, source_fingerprint
from .model_modes import DEFAULT_MODEL_MODE, ModelMode
from .patterns import score_window
from .rules import combine, evaluate_filter, pattern_references, references, resolve_filter_expression
from .screening_contracts import TUSHARE_RULES
from .settings import MAX_RECENT_BARS


def _eval_tree(
    node: dict[str, Any],
    stock_code: str,
    bars: list[dict[str, Any]],
    filters: dict[tuple[str, int], dict[str, Any]],
    patterns: dict[tuple[str, int], dict[str, Any]],
    report_assessments: dict[tuple[str, int], dict[str, Any]],
    path: str = "root",
    *, as_of: str | None = None, active=lambda: True, feature_inputs: tushare_feature_rules.Inputs | None = None,
    model_mode: ModelMode = DEFAULT_MODEL_MODE,
) -> tuple[str, list[dict[str, Any]], float]:
    op = node.get("op")
    if op == "filter_ref":
        key = (node["filter_id"], node["version"])
        item = filters[key]
        library = item["library"]
        if library in {"news", "report"} and item["expression"].get("evaluation_mode") == "question":
            from .condition_builder import evaluate_question
            cached = report_assessments.setdefault(key, {})
            if stock_code not in cached:
                cutoff = as_of or (bars[-1]["trade_date"] if bars else None)
                cached[stock_code] = evaluate_question(
                    library, item["expression"], stock_code, cutoff, active=active, model_mode=model_mode
                ) if cutoff else {"state": "unknown", "reason": "缺少明确的研究截止日期"}
            detail = dict(cached[stock_code])
        elif library == "technical":
            expression = resolve_filter_expression(library, item["expression"], node.get("parameter_overrides"))
            if expression["op"] in TUSHARE_RULES and feature_inputs is not None:
                decision = tushare_feature_rules.evaluate(TUSHARE_RULES[expression["op"]].model_validate(expression),
                    feature_inputs, stock_code, condition_id=item["id"], reference_id="combination", condition_version=item["version"])
                detail = {"state": decision.state, "reason": decision.explanation, "actual_values": decision.actual_values,
                          "thresholds": decision.thresholds, "units": decision.units, "data_as_of": decision.data_as_of}
            else:
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
                       "provenance": item.get("provenance", {}), "data_date": detail.get("data_as_of") or
                       (as_of if item["expression"].get("evaluation_mode") == "question" else bars[-1].get("trade_date") if bars else None)})
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
            state, child_detail, _ = _eval_tree(child, stock_code, bars, filters, patterns, report_assessments, f"{path}.{index}",
                                                as_of=as_of, active=active, feature_inputs=feature_inputs, model_mode=model_mode)
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


def _structured_strategy_rules(tree, filters):
    pending, result = [tree], []
    while pending:
        node = pending.pop()
        pending.extend(node.get("children", []))
        if node["op"] != "filter_ref":
            continue
        item = filters[(node["filter_id"], node["version"])]
        rule = TUSHARE_RULES.get(item["expression"].get("op"))
        if rule is not None:
            expression = resolve_filter_expression(item["library"], item["expression"], node.get("parameter_overrides"))
            result.append(rule.model_validate(expression))
    return result


def execute(lease: JobLease) -> None:
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
    model_mode = context.get("model_mode", DEFAULT_MODEL_MODE)

    filter_map, pattern_map = _load_snapshots(strategy)
    report_assessments, report_coverage = report_evaluation.load_assessments(
        references(strategy["tree"]), run[1], context.get("report_evaluation_ids"),
    )
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
        feature_inputs = None
        feature_rules = _structured_strategy_rules(strategy["tree"], filter_map)
        if feature_rules:
            codes = selected_codes if selected_codes is not None else market.security_codes(run[1])
            feature_inputs = tushare_feature_rules.prepare(feature_rules, run[1], context.get("effective_market_date"),
                codes, active=lease.active, progress=lease.progress)
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
            state, details, score = _eval_tree(strategy["tree"], stock_code, bars, filter_map, pattern_map,
                report_assessments, as_of=run[1], active=lease.active, feature_inputs=feature_inputs, model_mode=model_mode)
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
            state, details, _ = _eval_tree(strategy["tree"], code, [], filter_map, pattern_map,
                report_assessments, as_of=run[1], active=lease.active, feature_inputs=feature_inputs, model_mode=model_mode)
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
        **({"tushare_source_manifests": feature_inputs.manifests} if feature_inputs else {}),
        "trace_version": "condition-decisions-v1",
        "warnings": ["探索模式：成交量与成交额单位尚未确认", "证券基础资料和完整交易日历尚未接入"],
    }
    state = "cancelled" if cancelled else ("partial" if counts["unknown"] or counts["evaluated"] == 0 else "succeeded")
    lease.finish(state, f"完成：评估 {counts['evaluated']:,} 只，命中 {counts['true']:,} 只，未知 {counts['unknown']:,} 只", result, decisions=decisions)
