"""Read-only, long-running research scans owned by a Codex conversation.

Research scans deliberately do not create a screening task, condition revision,
observation record, or formal execution grant. They freeze the local market
source and universe, run a validated Python program in the existing restricted
child process, and persist the resulting evidence for the next Codex turn.
"""
from __future__ import annotations

import hashlib
import json
import csv
from datetime import date
from io import StringIO
import re
from typing import Any, Literal
from uuid import uuid4

from . import conversation_store, market, program_conditions
from .db import connect, json_dump, json_load, utc_now
from .screening_contracts import CustomProgram


RESEARCH_SCAN_PROTOCOL = "research-scan-v1"
MAX_UNIVERSE_SIZE = 20_000
BATCH_SIZE = 256


class ResearchScanError(ValueError):
    def __init__(self, code: str, message: str, status_code: int = 422):
        self.code = code
        self.status_code = status_code
        super().__init__(message)


def _request_hash(snapshot: dict[str, Any]) -> str:
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _freeze_universe(kind: str, stock_codes: list[str], as_of: str) -> dict[str, Any]:
    if kind == "all_a_shares":
        if stock_codes:
            raise ResearchScanError("invalid_universe", "全部A股范围不能同时指定证券名单。")
        codes = market.security_codes(as_of)
        name = "本地行情中截止日有记录的A股"
    elif kind == "explicit":
        codes = sorted(stock_codes)
        name = "指定证券"
    else:
        raise ResearchScanError("invalid_universe", "研究扫描只支持全部A股或指定证券范围。")
    if not codes:
        raise ResearchScanError("empty_universe", "研究扫描范围内没有可处理的证券。")
    if len(codes) > MAX_UNIVERSE_SIZE:
        raise ResearchScanError("universe_too_large", f"研究扫描范围超过{MAX_UNIVERSE_SIZE}只证券。")
    invalid = [code for code in codes if not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", code)]
    if invalid:
        raise ResearchScanError("market_unavailable", "当前只接入沪深北市场日线。")
    if len(codes) != len(set(codes)):
        raise ResearchScanError("invalid_universe", "研究扫描范围包含重复证券。")
    return {"kind": kind, "name": name, "codes": codes}


def _require_running_turn(conversation_id: str, turn_id: str) -> None:
    try:
        turn = conversation_store.get_turn(conversation_id, turn_id)
    except conversation_store.ConversationNotFound as exc:
        raise ResearchScanError("conversation_turn_not_found", "找不到当前研究回合。", 404) from exc
    if turn["state"] != "running":
        raise ResearchScanError("conversation_turn_inactive", "当前研究回合已结束，不能创建新的扫描。", 409)


def enqueue_scan(
    conversation_id: str,
    turn_id: str,
    *,
    name: str,
    program: CustomProgram,
    as_of: date | None,
    universe: str,
    stock_codes: list[str],
    execution_mode: Literal["cross_sectional", "per_stock"] = "cross_sectional",
) -> dict[str, Any]:
    if execution_mode not in {"cross_sectional", "per_stock"}:
        raise ResearchScanError("invalid_execution_mode", "研究扫描计算模式无效。")
    _require_running_turn(conversation_id, turn_id)
    fingerprint = market.source_fingerprint()
    if fingerprint is None:
        raise ResearchScanError("market_data_unavailable", "无法读取行情文件指纹。", 503)
    if not market.daily_bar_source_available():
        raise ResearchScanError("market_data_unavailable", "本地行情文件当前不可用。", 503)
    profile = market.cached_profile()
    watermark = profile.get("last_date")
    if not watermark:
        raise ResearchScanError("market_data_unavailable", "本地行情水位不可用。", 503)
    requested_as_of = as_of.isoformat() if as_of else str(watermark)
    try:
        date.fromisoformat(requested_as_of)
    except ValueError as exc:
        raise ResearchScanError("invalid_as_of", "研究扫描截止日不是有效日期。") from exc
    if requested_as_of > str(watermark):
        raise ResearchScanError("date_after_watermark", f"截止日晚于行情水位 {watermark}。")
    effective_market_date = market.latest_market_date(requested_as_of)
    if not effective_market_date:
        raise ResearchScanError("date_without_bars", "截止日前没有可用行情。")

    frozen_universe = _freeze_universe(universe, stock_codes, requested_as_of)
    if market.source_fingerprint() != fingerprint:
        raise ResearchScanError("source_changed", "冻结研究范围期间行情文件发生变化，请重试。", 409)
    snapshot = {
        "protocol_version": RESEARCH_SCAN_PROTOCOL,
        "conversation_id": conversation_id,
        "turn_id": turn_id,
        "name": name,
        "as_of": requested_as_of,
        "effective_market_date": effective_market_date,
        "universe": frozen_universe,
        "source_fingerprint": list(fingerprint),
        "program": program.model_dump(mode="json"),
        "execution_mode": execution_mode,
        "source_sha256": program_conditions.source_sha256(program),
        "price_basis": profile.get("price_basis", "unknown"),
    }
    request_hash = _request_hash(snapshot)
    with connect() as connection:
        existing = connection.execute(
            """SELECT id,job_id,status,result_json FROM research_scans
               WHERE conversation_id=? AND request_hash=?""",
            (conversation_id, request_hash),
        ).fetchone()
        if existing:
            return _scan_response(existing, idempotent_replay=True)

    scan_id, job_id, now = str(uuid4()), str(uuid4()), utc_now()
    snapshot_json = json_dump(snapshot)
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            conversation_store.require_running_turn(connection, conversation_id, turn_id)
        except conversation_store.ConversationConflict as exc:
            raise ResearchScanError("conversation_turn_inactive", str(exc), 409) from exc
        if market.source_fingerprint() != fingerprint:
            raise ResearchScanError("source_changed", "提交研究扫描时行情文件发生变化，请重试。", 409)
        existing = connection.execute(
            "SELECT id,job_id,status,result_json FROM research_scans WHERE conversation_id=? AND request_hash=?",
            (conversation_id, request_hash),
        ).fetchone()
        if existing:
            return _scan_response(existing, idempotent_replay=True)
        connection.execute(
            """INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at,required_protocol)
               VALUES(?,?,?,'queued','等待研究扫描',?,?,?)""",
            (job_id, "research_scan", json_dump({"scan_id": scan_id}), now, now, RESEARCH_SCAN_PROTOCOL),
        )
        connection.execute(
            """INSERT INTO research_scans(
                 id,conversation_id,turn_id,job_id,request_hash,name,as_of,status,
                 snapshot_json,result_json,created_at
               ) VALUES(?,?,?,?,?,?,?,'queued',?,'{}',?)""",
            (scan_id, conversation_id, turn_id, job_id, request_hash, name, requested_as_of, snapshot_json, now),
        )
    return {
        "scan_id": scan_id,
        "job_id": job_id,
        "status": "queued",
        "name": name,
        "as_of": requested_as_of,
        "universe_size": len(frozen_universe["codes"]),
        "source_sha256": snapshot["source_sha256"],
        "execution_mode": execution_mode,
        "idempotent_replay": False,
        "read_only_research": True,
        "note": "这是只读研究扫描，不会创建正式筛选运行、条件版本或观察池记录。",
    }


def _scan_response(row, *, idempotent_replay: bool) -> dict[str, Any]:
    return {
        "scan_id": row[0],
        "job_id": row[1],
        "status": row[2],
        "result": json_load(row[3]) if row[3] else {},
        "idempotent_replay": idempotent_replay,
        "read_only_research": True,
    }


def _scan_row(conversation_id: str, scan_id: str):
    with connect() as connection:
        row = connection.execute(
            """SELECT s.*,j.state AS job_state,j.progress,j.message AS job_message
               FROM research_scans s JOIN jobs j ON j.id=s.job_id
               WHERE s.id=? AND s.conversation_id=?""",
            (scan_id, conversation_id),
        ).fetchone()
    if not row:
        raise ResearchScanError("scan_not_found", "找不到当前对话的研究扫描。", 404)
    return row


def get_scan(conversation_id: str, scan_id: str) -> dict[str, Any]:
    row = _scan_row(conversation_id, scan_id)
    snapshot = json_load(row["snapshot_json"])
    result = json_load(row["result_json"])
    result = {**_result(snapshot, scan_id, [], status=row["status"]), **result,
              "status": row["status"],
              "result_valid": row["status"] in {"succeeded", "partial"} and not result.get("error")}
    if row["status"] == "failed" and not result.get("error"):
        result["error"] = row["job_message"]
    return {
        "id": row["id"],
        "conversation_id": row["conversation_id"],
        "turn_id": row["turn_id"],
        "job_id": row["job_id"],
        "name": row["name"],
        "as_of": row["as_of"],
        "status": row["status"],
        "created_at": row["created_at"],
        "finished_at": row["finished_at"],
        "universe": {"kind": snapshot["universe"]["kind"], "size": len(snapshot["universe"]["codes"])},
        "program": {
            "contract_version": snapshot["program"]["contract_version"],
            "source_sha256": snapshot["source_sha256"],
            "required_fields": snapshot["program"]["required_fields"],
            "required_history_bars": snapshot["program"]["required_history_bars"],
        },
        "source_fingerprint": snapshot["source_fingerprint"],
        "execution_mode": snapshot["execution_mode"],
        "result": result,
        "job": {"state": row["job_state"], "progress": row["progress"], "message": row["job_message"]},
        "read_only_research": True,
        "uses_current_data": False,
        "export_url": f"/api/v1/conversations/{conversation_id}/research-scans/{scan_id}/export",
    }


def list_scans(conversation_id: str, limit: int = 50) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 100))
    with connect() as connection:
        rows = connection.execute(
            """SELECT s.id,s.name,s.as_of,s.status,s.job_id,s.created_at,s.finished_at,
                      j.progress,j.message,json_extract(s.result_json,'$.coverage') AS coverage_json,
                      json_array_length(s.snapshot_json,'$.universe.codes') AS target_total
               FROM research_scans s JOIN jobs j ON j.id=s.job_id WHERE s.conversation_id=?
               ORDER BY s.created_at DESC,s.rowid DESC LIMIT ?""",
            (conversation_id, limit),
        ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item["coverage"] = json_load(item.pop("coverage_json") or "{}")
        item["coverage"].setdefault("target_total", item.pop("target_total"))
        item["export_url"] = f"/api/v1/conversations/{conversation_id}/research-scans/{item['id']}/export"
        items.append(item)
    return items


def list_decisions(
    conversation_id: str,
    scan_id: str,
    *,
    state: str = "",
    query: str = "",
    offset: int = 0,
    limit: int = 100,
) -> dict[str, Any]:
    if state not in {"", "true", "false", "unknown"}:
        raise ResearchScanError("invalid_scan_state", "研究扫描结果状态无效。")
    row = _scan_row(conversation_id, scan_id)
    limit, offset, query = max(1, min(int(limit), 200)), max(0, int(offset)), query[:32].upper()
    clause = "scan_id=? AND (?='' OR state=?) AND (?='' OR stock_code LIKE ?)"
    params = (scan_id, state, state, query, f"%{query}%")
    with connect() as connection:
        total = connection.execute(
            f"SELECT COUNT(*) FROM research_scan_decisions WHERE {clause}", params
        ).fetchone()[0]
        rows = connection.execute(
            f"""SELECT decision_json FROM research_scan_decisions
                WHERE {clause} ORDER BY stock_code LIMIT ? OFFSET ?""",
            (*params, limit, offset),
        ).fetchall()
    return {
        "scan_id": row["id"],
        "status": row["status"],
        "items": [json_load(item[0]) for item in rows],
        "total": total,
        "offset": offset,
        "limit": limit,
        "read_only_research": True,
    }


def cancel_scan(conversation_id: str, scan_id: str) -> dict[str, Any]:
    row = _scan_row(conversation_id, scan_id)
    from . import jobs
    try:
        jobs.cancel(row["job_id"])
    except KeyError as exc:
        raise ResearchScanError("scan_job_not_found", "研究扫描后台任务不存在。", 404) from exc
    return get_scan(conversation_id, scan_id)


def export_csv(conversation_id: str, scan_id: str):
    scan = get_scan(conversation_id, scan_id)
    if scan["status"] in {"queued", "running"}:
        raise ResearchScanError("scan_not_finished", "研究扫描仍在运行，请完成后导出。", 409)

    def rows():
        buffer = StringIO()
        writer = csv.writer(buffer)
        yield "\ufeff"
        writer.writerow(["scan_id", "scan_status", "as_of", "result_valid", "execution_mode", "source_sha256",
                         "stock_code", "state", "evaluation_status", "reason_code", "data_as_of", "metrics", "units", "explanation"])
        yield buffer.getvalue()
        with connect() as connection:
            cursor = connection.execute(
                "SELECT decision_json FROM research_scan_decisions WHERE scan_id=? ORDER BY stock_code", (scan_id,)
            )
            for row in cursor:
                item = json_load(row[0])
                buffer.seek(0)
                buffer.truncate()
                writer.writerow([scan_id, scan["status"], scan["as_of"], scan["result"]["result_valid"],
                                 scan["execution_mode"], scan["program"]["source_sha256"],
                                 item["stock_code"], item["state"], item["evaluation_status"], item["reason_code"],
                                 item.get("data_as_of"), json_dump(item.get("metrics", {})),
                                 json_dump(item.get("units", {})), item["explanation"]])
                yield buffer.getvalue()
    return rows()


def _decision(stock_code: str, value: dict[str, Any]) -> dict[str, Any]:
    state = value.get("state") if value.get("state") in {"true", "false", "unknown"} else "unknown"
    status = value.get("evaluation_status") if value.get("evaluation_status") in {"completed", "failed", "not_evaluated"} else "failed"
    return {
        "stock_code": stock_code,
        "state": state,
        "evaluation_status": status,
        "reason_code": str(value.get("reason_code") or "data_missing"),
        "explanation": str(value.get("explanation") or program_conditions.metrics_summary(value.get("metrics") or {}, value.get("units"))
                           or {"true": "研究条件符合", "false": "研究条件不符合", "unknown": "所需数据不足，无法判断"}[state])[:4000],
        "metrics": value.get("metrics") or {},
        "units": value.get("units") or {},
        "thresholds": value.get("thresholds") or {},
        "data_as_of": value.get("data_as_of"),
    }


def _failed_decision(stock_code: str, message: str) -> dict[str, Any]:
    return _decision(stock_code, {
        "state": "unknown",
        "evaluation_status": "failed",
        "reason_code": "execution_failed",
        "explanation": message,
    })


def _result(snapshot: dict, scan_id: str, decisions: list[dict], *, status: str, error: str | None = None) -> dict:
    counts = {state: sum(item["state"] == state for item in decisions) for state in ("true", "false", "unknown")}
    return {
        "scan_id": scan_id,
        "status": status,
        "processed_total": len(decisions),
        "coverage": {
            "target_total": len(snapshot["universe"]["codes"]), **{key + "_count": value for key, value in counts.items()},
            "failed_count": sum(item["evaluation_status"] == "failed" for item in decisions),
            "not_evaluated_count": len(snapshot["universe"]["codes"]) - len(decisions),
        },
        "source_fingerprint": snapshot["source_fingerprint"],
        "effective_market_date": snapshot["effective_market_date"],
        "execution_mode": snapshot["execution_mode"],
        "error": error,
        "result_valid": status in {"succeeded", "partial"} and error is None,
    }


def execute_scan(lease) -> None:
    """Worker entry point. The lease owns all final writes and cancellation."""
    with connect() as connection:
        row = connection.execute(
            "SELECT snapshot_json,result_json FROM research_scans WHERE id=?", (lease.payload["scan_id"],)
        ).fetchone()
    if not row:
        lease.finish("failed", "研究扫描快照不存在")
        return
    snapshot = json_load(row[0])
    if list(market.source_fingerprint() or ()) != snapshot.get("source_fingerprint"):
        lease.finish("failed", "行情来源在排队后发生变化，请重新创建研究扫描", {"error": "source_changed"})
        return

    program = CustomProgram.model_validate(snapshot["program"])
    codes = list(snapshot["universe"]["codes"])
    condition = {"program": program.model_dump(mode="json")}
    reference = {"parameter_overrides": {}}
    with connect() as connection:
        decisions = [json_load(row[0]) for row in connection.execute(
            "SELECT decision_json FROM research_scan_decisions WHERE scan_id=? ORDER BY stock_code", (lease.payload["scan_id"],)
        )]
    processed = {item["stock_code"] for item in decisions}
    remaining = [code for code in codes if code not in processed]
    batch_size = BATCH_SIZE if snapshot["execution_mode"] == "per_stock" else max(1, len(codes))
    error = (json_load(row["result_json"]).get("error") or "已提交记录包含程序执行失败") if any(
        item["evaluation_status"] == "failed" for item in decisions) else None
    if error:
        remaining = []
    for offset in range(0, len(remaining), batch_size):
        batch = remaining[offset:offset + batch_size]
        if not lease.active():
            return
        if list(market.source_fingerprint() or ()) != snapshot.get("source_fingerprint"):
            error = "行情来源在研究扫描期间发生变化"
            break
        try:
            bars_by_stock = {code: [] for code in batch}
            for code, bars in market.iter_recent_bars(
                snapshot["as_of"], program.required_history_bars, batch
            ) or ():
                if code in bars_by_stock:
                    bars_by_stock[code] = bars
            evaluated = program_conditions.evaluate_batch(
                condition,
                reference,
                batch,
                bars_by_stock,
                as_of=snapshot["as_of"],
                effective_market_date=snapshot["effective_market_date"],
                is_active=lease.active,
            )
            if list(market.source_fingerprint() or ()) != snapshot["source_fingerprint"]:
                error = "行情来源在研究扫描计算期间发生变化"
                break
        except Exception as exc:
            if not lease.active():
                return
            error = f"{type(exc).__name__}: {str(exc)[:1500]}"
            failed = [_failed_decision(code, error) for code in batch]
            decisions.extend(failed)
            lease.checkpoint_research_scan(failed, _result(snapshot, lease.payload["scan_id"], decisions, status="running", error=error), len(decisions) / len(codes))
            break
        completed = [_decision(code, evaluated[code]) for code in batch]
        decisions.extend(completed)
        if not lease.checkpoint_research_scan(completed, _result(snapshot, lease.payload["scan_id"], decisions, status="running"), len(decisions) / len(codes)):
            return

    if list(market.source_fingerprint() or ()) != snapshot["source_fingerprint"]:
        error = "行情来源在研究扫描期间发生变化"
    status = "failed" if error else "partial" if any(item["state"] == "unknown" for item in decisions) else "succeeded"
    result = _result(snapshot, lease.payload["scan_id"], decisions, status=status, error=error)
    counts = result["coverage"]
    message = (
        f"研究扫描完成：共 {len(codes)} 只，符合 {counts['true_count']} 只，"
        f"不符合 {counts['false_count']} 只，未知 {counts['unknown_count']} 只"
    )
    if error:
        message = f"研究扫描失败：{error}"
    lease.finish(status, message, result)
