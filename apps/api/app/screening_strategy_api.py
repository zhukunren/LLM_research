from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

from fastapi import APIRouter

from . import market
from .api_responses import bad_request, csv_response
from .db import connect, json_dump, json_load, utc_now
from .filter_api import require_filter
from .model_modes import DEFAULT_MODEL_MODE
from .models import ScreenInput, StrategyInput, StrategyValidationInput
from .rules import pattern_references, references, validate_tree

router = APIRouter(prefix="/api/v1")


def _filter_catalog(keys: list[tuple[str, int]] | None = None) -> dict[tuple[str, int], dict[str, Any]]:
    with connect() as connection:
        if keys:
            result = {}
            for asset_id, version in set(keys):
                row = connection.execute(
                    "SELECT id,library,name,version,dsl_json FROM filters WHERE id=? AND version=?",
                    (asset_id, version),
                ).fetchone()
                if row:
                    result[(asset_id, version)] = {**dict(row), "expression": json_load(row["dsl_json"])["expression"]}
            return result
        rows = connection.execute("SELECT id,library,name,version,dsl_json FROM filters").fetchall()
    return {(row["id"], row["version"]): {**dict(row), "expression": json_load(row["dsl_json"])["expression"]} for row in rows}


def _pattern_keys(keys: list[tuple[str, int]] | None = None) -> set[tuple[str, int]]:
    with connect() as connection:
        if keys:
            result = set()
            for asset_id, version in set(keys):
                row = connection.execute("SELECT id,version FROM patterns WHERE id=? AND version=?", (asset_id, version)).fetchone()
                if row:
                    result.add((row[0], row[1]))
            return result
        rows = connection.execute("SELECT id,version FROM patterns").fetchall()
    return {(row[0], row[1]) for row in rows}


def _strategy_obj(row) -> dict[str, Any]:
    return {"id": row["id"], "version": row["version"], "created_at": row["created_at"], **json_load(row["strategy_json"])}


@router.post("/strategies/validate")
def validate_strategy(payload: StrategyValidationInput):
    filter_keys = references(payload.tree)
    pattern_keys = pattern_references(payload.tree)
    errors = validate_tree(payload.tree, _filter_catalog(filter_keys), _pattern_keys(pattern_keys))
    return {
        "valid": not errors, "errors": errors,
        "references": [{"id": item_id, "version": version} for item_id, version in filter_keys],
        "patterns": [{"id": item_id, "version": version} for item_id, version in pattern_keys],
    }


@router.get("/strategies")
def list_strategies(include_history: bool = False):
    with connect() as connection:
        rows = connection.execute(
            "SELECT * FROM strategies ORDER BY created_at DESC,version DESC" if include_history else
            """SELECT s.* FROM strategies s JOIN (SELECT id,MAX(version) version FROM strategies GROUP BY id) latest
               ON latest.id=s.id AND latest.version=s.version ORDER BY s.created_at DESC"""
        ).fetchall()
    return {"items": [_strategy_obj(row) for row in rows]}


@router.post("/strategies")
def save_strategy(payload: StrategyInput):
    with connect() as connection:
        replay = _submission_replay(connection, "strategy", payload)
        if replay is not None:
            return replay
    validation = validate_strategy(StrategyValidationInput(tree=payload.tree))
    if not validation["valid"]:
        bad_request("策略引用校验失败", 422, "invalid_strategy", validation["errors"])
    strategy_id = payload.id or str(uuid4())
    now = utc_now()
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        replay = _submission_replay(connection, "strategy", payload)
        if replay is not None:
            return replay
        version = connection.execute("SELECT COALESCE(MAX(version),0)+1 FROM strategies WHERE id=?", (strategy_id,)).fetchone()[0]
        strategy = {
            "schema_version": "1.0", "name": payload.name, "tree": payload.tree,
            "top_n": payload.top_n, "status": "published",
            "dependency_policy": "require_all_enabled", "unknown_policy": "exclude_and_report",
        }
        connection.execute(
            "INSERT INTO strategies(id,name,version,strategy_json,created_at) VALUES(?,?,?,?,?)",
            (strategy_id, payload.name, version, json_dump(strategy), now),
        )
        connection.execute(
            "INSERT INTO audit_events(action,entity_type,entity_id,version,created_at) VALUES('publish','strategy',?,?,?)",
            (strategy_id, version, now),
        )
        row = connection.execute("SELECT * FROM strategies WHERE id=? AND version=?", (strategy_id, version)).fetchone()
        result = _strategy_obj(row)
        _remember_submission(connection, "strategy", payload, result)
    return result


def _submission_identity(payload: StrategyInput | ScreenInput) -> str:
    value = payload.model_dump(exclude={"request_id"})
    if isinstance(payload, ScreenInput) and payload.model_mode is None:
        value.pop("model_mode")
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _submission_replay(connection, scope: str, payload: StrategyInput | ScreenInput):
    if not payload.request_id:
        return None
    row = connection.execute(
        "SELECT request_json,response_json FROM condition_submission_requests WHERE scope=? AND request_id=?",
        (scope, payload.request_id),
    ).fetchone()
    if row is None:
        return None
    if row["request_json"] != _submission_identity(payload):
        bad_request("这次提交编号已用于其他内容，请重新提交", 409, "submission_request_conflict")
    return json_load(row["response_json"])


def _remember_submission(connection, scope: str, payload: StrategyInput | ScreenInput, response: dict):
    if payload.request_id:
        connection.execute(
            "INSERT INTO condition_submission_requests(scope,request_id,request_json,response_json,created_at) VALUES(?,?,?,?,?)",
            (scope, payload.request_id, _submission_identity(payload), json_dump(response), utc_now()),
        )


def _strategy_blockers(strategy: dict[str, Any], mode: str) -> list[str]:
    if mode != "formal":
        return []
    profile = market.cached_profile()
    blockers = profile.get("formal_blockers", []).copy()
    if not profile.get("available"):
        blockers.append("本地行情文件不可用")
    for filter_id, version in references(strategy["tree"]):
        item = require_filter(filter_id, version)
        if item["library"] == "news":
            blockers.append("资讯证据不能证明全市场覆盖完整，请使用探索筛选" if item["expression"].get("evaluation_mode") == "question" else "此旧版条件尚未接入本地资讯执行，请在对话中重新定义资讯口径")
        elif item["library"] == "report":
            blockers.append("本地研报评估不能证明全市场研报覆盖完整")
    if pattern_references(strategy["tree"]):
        blockers.append("形态识别与全市场匹配尚无冻结评测报告")
    return list(dict.fromkeys(blockers))


@router.post("/screening-runs")
def create_screening_run(payload: ScreenInput):
    with connect() as connection:
        replay = _submission_replay(connection, "screening", payload)
        if replay is not None:
            return replay
        row = connection.execute(
            "SELECT strategy_json FROM strategies WHERE id=? AND version=?",
            (payload.strategy_id, payload.strategy_version),
        ).fetchone()
    if not row:
        bad_request("找不到指定版本的策略", 404, "strategy_version_not_found")
    strategy = json_load(row[0])
    blockers = _strategy_blockers(strategy, payload.mode)
    profile = market.cached_profile()
    if payload.mode == "exploratory" and not profile.get("available"):
        bad_request("请先添加本地行情文件，再运行探索筛选", 422, "market_data_unavailable")
    if payload.mode == "exploratory" and profile.get("last_date") and payload.as_of > profile["last_date"]:
        bad_request(f"筛选日期晚于行情水位 {profile['last_date']}", 422, "date_after_watermark")
    universe = {"kind": "all_a_shares", "name": "全部 A 股", "codes": None}
    evaluation_ids = {}
    with connect() as connection:
        if payload.watchlist_id:
            watchlist = connection.execute("SELECT name FROM watchlists WHERE id=?", (payload.watchlist_id,)).fetchone()
            if not watchlist:
                bad_request("找不到股票池", 404, "watchlist_not_found")
            codes = [row[0] for row in connection.execute("SELECT stock_code FROM watchlist_items WHERE watchlist_id=? ORDER BY stock_code", (payload.watchlist_id,))]
            if not codes:
                bad_request("股票池为空，请先添加股票", 422, "empty_universe")
            universe = {"kind": "watchlist", "id": payload.watchlist_id, "name": watchlist[0], "codes": codes}
        for filter_id, version in references(strategy["tree"]):
            evaluation = connection.execute("SELECT id FROM report_evaluation_runs WHERE filter_id=? AND filter_version=? AND as_of=? AND status IN ('succeeded','partial') ORDER BY created_at DESC,rowid DESC LIMIT 1", (filter_id, version, payload.as_of)).fetchone()
            evaluation_ids[f"{filter_id}@{version}"] = evaluation[0] if evaluation else None
    context = {"universe": universe, "strategy_snapshot": strategy,
               "model_mode": payload.model_mode or DEFAULT_MODEL_MODE,
               "source_fingerprint": market.source_fingerprint(), "report_evaluation_ids": evaluation_ids,
               "effective_market_date": profile.get("last_date") if payload.as_of == profile.get("last_date") else market.latest_market_date(payload.as_of)}
    run_id, now = str(uuid4()), utc_now()
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        replay = _submission_replay(connection, "screening", payload)
        if replay is not None:
            return replay
        if blockers:
            result = {
                "blockers": blockers, "mode": payload.mode, "results": [],
                "counts": {"evaluated": 0, "true": 0, "false": 0, "unknown": 0},
            }
            connection.execute(
                "INSERT INTO screening_runs(id,strategy_id,strategy_version,as_of,mode,status,result_json,created_at,finished_at,context_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (run_id, payload.strategy_id, payload.strategy_version, payload.as_of, payload.mode, "blocked_dependency", json_dump(result), now, now, json_dump(context)),
            )
            response = {"id": run_id, "status": "blocked_dependency", **result}
        else:
            job_id = str(uuid4())
            connection.execute(
                "INSERT INTO screening_runs(id,strategy_id,strategy_version,as_of,mode,status,result_json,created_at,context_json) VALUES(?,?,?,?,?,?,?,?,?)",
                (run_id, payload.strategy_id, payload.strategy_version, payload.as_of, payload.mode, "queued", "{}", now, json_dump(context)),
            )
            connection.execute(
                "INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at,required_protocol) VALUES(?,?,?,?,?,?,?,?)",
                (job_id, "screening", json_dump({"run_id": run_id, "strategy_id": payload.strategy_id, "strategy_version": payload.strategy_version}), "queued", "等待筛选 worker", now, now, "condition-decisions-v1"),
            )
            response = {"id": run_id, "job_id": job_id, "status": "queued", "mode": payload.mode, "message": "筛选任务已进入本地队列"}
        _remember_submission(connection, "screening", payload, response)
    return response


@router.get("/screening-runs")
def list_screening_runs():
    with connect() as connection:
        rows = connection.execute("SELECT * FROM screening_runs ORDER BY created_at DESC,rowid DESC LIMIT 100").fetchall()
    return {"items": [
        {"id": row[0], "strategy_id": row[1], "strategy_version": row[2], "as_of": row[3], "mode": row[4], "status": row[5], "created_at": row[7]}
        for row in rows
    ]}


@router.get("/screening-runs/{run_id}")
def get_screening_run(run_id: str):
    with connect() as connection:
        row = connection.execute("SELECT * FROM screening_runs WHERE id=?", (run_id,)).fetchone()
        job = connection.execute("SELECT id,state,progress,message FROM jobs WHERE payload_json LIKE ?", (f'%"run_id":"{run_id}"%',)).fetchone()
    if not row:
        bad_request("找不到筛选运行", 404, "run_not_found")
    result = json_load(row[6])
    return {
        "id": row[0], "strategy_id": row[1], "strategy_version": row[2], "as_of": row[3],
        "mode": row[4], "status": row[5], "created_at": row[7], "finished_at": row[8],
        "result": result, "context": json_load(row["context_json"]), "job": dict(job) if job else None,
    }


@router.get("/screening-runs/{run_id}/decisions")
def screening_decisions(run_id: str, state: str = "", query: str = "", offset: int = 0, limit: int = 50):
    if state not in ("", "true", "false", "unknown"):
        bad_request("结果状态无效")
    limit, offset = max(1, min(limit, 100)), max(0, offset)
    with connect() as connection:
        if not connection.execute("SELECT 1 FROM screening_runs WHERE id=?", (run_id,)).fetchone():
            bad_request("找不到筛选记录", 404)
        from . import security_catalog
        params = (run_id, state, state, *security_catalog.query_params(query))
        clause = "run_id=? AND (?='' OR state=?) AND " + security_catalog.query_clause()
        total = connection.execute(f"SELECT COUNT(*) FROM screening_decisions WHERE {clause}", params).fetchone()[0]
        rows = connection.execute(f"SELECT detail_json FROM screening_decisions WHERE {clause} ORDER BY score DESC,stock_code LIMIT ? OFFSET ?", (*params, limit, offset)).fetchall()
    return {"items": [json_load(row[0]) for row in rows], "total": total, "offset": offset, "limit": limit}


@router.get("/screening-runs/{run_id}/export")
def export_screening_run(run_id: str):
    result = get_screening_run(run_id)
    rows: list[list[Any]] = [["运行ID", "策略ID", "策略版本", "截止日", "模式", "状态", "证券代码", "市场", "实际日期", "收盘", "综合分", "条件详情"]]
    for item in result["result"].get("results", []):
        rows.append([
            result["id"], result["strategy_id"], result["strategy_version"], result["as_of"], result["mode"], result["status"],
            item.get("stock_code"), item.get("market"), item.get("as_of"), item.get("close"), item.get("score"),
            json_dump(item.get("details", [])),
        ])
    if not result["result"].get("results"):
        rows.append([result["id"], result["strategy_id"], result["strategy_version"], result["as_of"], result["mode"], result["status"], "", "", "", "", "", json_dump(result["result"])])
    return csv_response(f"screening-{run_id[:8]}.csv", rows)
