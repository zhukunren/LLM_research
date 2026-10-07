from __future__ import annotations

import hashlib
import json
from typing import Any
from uuid import uuid4

from . import conversation_store, market, runtime_executor, pattern_adapter
from .db import connect, json_dump, json_load, utc_now
from .screening_contracts import ExecutionRequest, ScreeningTaskRevision, validate_executable_task
from .screening_execution import EXECUTION_VERSION

MAX_UNIVERSE_SIZE = 20_000
JOB_PROTOCOL = "screening-task-v1"


class ScreeningServiceError(ValueError):
    def __init__(self, code: str, message: str, status_code: int = 422):
        self.code = code
        self.status_code = status_code
        super().__init__(message)


def _source_id(fingerprint: tuple[str, int, int] | None) -> str:
    if fingerprint is None:
        raise ScreeningServiceError("market_data_unavailable", "本地行情文件当前不可用。", 503)
    encoded = json.dumps(fingerprint, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _existing_request(conversation_id: str, idempotency_key: str) -> dict[str, Any] | None:
    with connect() as connection:
        row = connection.execute(
            """SELECT r.id AS request_id,r.request_json,s.id AS run_id,s.job_id,s.status,s.task_revision
               FROM execution_requests r JOIN screening_task_runs s ON s.execution_request_id=r.id
               WHERE r.conversation_id=? AND r.idempotency_key=?""",
            (conversation_id, idempotency_key),
        ).fetchone()
    if not row:
        return None
    return {
        "execution_request_id": row["request_id"],
        "run_id": row["run_id"],
        "job_id": row["job_id"],
        "status": row["status"],
        "task_revision": row["task_revision"],
        "idempotent_replay": True,
    }


def _freeze_universe(task: ScreeningTaskRevision) -> dict[str, Any]:
    universe = task.scope.universe
    if universe is None:
        raise ScreeningServiceError("universe_required", "执行前必须确定股票范围。")
    if universe.kind == "all_a_shares":
        codes = market.security_codes(task.scope.as_of.isoformat())
        result = {"kind": "all_a_shares", "name": "本地行情中截止日有记录的A股", "codes": codes}
    elif universe.kind == "explicit":
        codes = sorted(universe.stock_codes)
        result = {"kind": "explicit", "name": "指定证券", "codes": codes}
    else:
        with connect() as connection:
            watchlist = connection.execute(
                "SELECT name FROM watchlists WHERE id=?", (universe.watchlist_id,)
            ).fetchone()
            if not watchlist:
                raise ScreeningServiceError("watchlist_not_found", "找不到指定的自选股票池。", 404)
            codes = [
                row[0] for row in connection.execute(
                    "SELECT stock_code FROM watchlist_items WHERE watchlist_id=? ORDER BY stock_code",
                    (universe.watchlist_id,),
                )
            ]
        result = {"kind": "watchlist", "id": universe.watchlist_id, "name": watchlist[0], "codes": codes}

    if not codes:
        raise ScreeningServiceError("empty_universe", "筛选范围内没有可处理的证券。")
    if len(codes) > MAX_UNIVERSE_SIZE:
        raise ScreeningServiceError("universe_too_large", f"筛选范围超过{MAX_UNIVERSE_SIZE}只证券。")
    if len(codes) != len(set(codes)):
        raise ScreeningServiceError("invalid_universe", "股票范围快照包含重复证券。")
    invalid = [code for code in codes if code.rsplit(".", 1)[-1] not in {"SH", "SZ", "BJ"}]
    if invalid:
        raise ScreeningServiceError("market_unavailable", "当前只接入沪深北市场日线。")
    return result


def _run_response(request_id: str, run_id: str, job_id: str, revision: int) -> dict[str, Any]:
    return {
        "execution_request_id": request_id,
        "run_id": run_id,
        "job_id": job_id,
        "status": "queued",
        "task_revision": revision,
        "idempotent_replay": False,
    }


def enqueue_turn(conversation_id: str, turn_id: str, *, observation: dict | None = None,
                 agent_active: bool = False, button_authorized: bool = False,
                 button_revision: int | None = None, button_request_id: str | None = None) -> dict[str, Any]:
    if agent_active and button_authorized:
        raise ScreeningServiceError("invalid_execution_action", "执行授权方式无效。", 422)
    conversation = conversation_store.get_conversation(conversation_id, message_limit=1)
    if conversation.get("workflow_type", "screening") != "screening":
        raise ScreeningServiceError("screening_workflow_required", "正式筛选必须在条件选股工作区提交。", 409)
    turn = conversation_store.get_turn(conversation_id, turn_id)
    if turn.get("workflow_type", "screening") != "screening":
        raise ScreeningServiceError("screening_workflow_required", "投研回合不能授权正式筛选，请在选股工作区提交当前方案。", 409)
    revision = button_revision if button_authorized else conversation["task_revision"] if agent_active else (turn.get("result") or {}).get("task_revision", 0)
    if button_authorized and (not button_request_id or button_revision is None):
        raise ScreeningServiceError("invalid_execution_action", "按钮执行必须指定任务版本和请求标识。")
    idempotency_key = f"button:{button_request_id}" if button_authorized else f"conversation-turn:{turn_id}:revision:{revision}"
    existing = _existing_request(conversation_id, idempotency_key)
    if existing:
        if button_authorized:
            with connect() as connection:
                prior = connection.execute("SELECT turn_id,task_revision FROM execution_requests WHERE id=?", (existing["execution_request_id"],)).fetchone()
            if prior["turn_id"] != turn_id or prior["task_revision"] != revision:
                raise ScreeningServiceError("request_conflict", "同一执行请求不能用于不同的任务版本。", 409)
        return existing

    expected_state = "running" if agent_active else "succeeded"
    if turn["state"] != expected_state:
        raise ScreeningServiceError("turn_not_ready", "对话回合尚未完成，不能创建筛选运行。", 409)
    if button_authorized and (conversation["task_revision"] != revision or not conversation["turns"] or conversation["turns"][0]["id"] != turn_id):
        raise ScreeningServiceError("revision_conflict", "筛选条件或对话已有更新，请读取最新版本后再执行。", 409)
    result = turn["result"] or {}
    if agent_active:
        from .execution_policy import requests_execution
        original = conversation_store.get_user_message(conversation_id, turn["user_message_id"])
        grant = conversation_store.get_pending_execute_message(conversation_id)
        if grant != original["id"] or not requests_execution(original["content"]):
            raise ScreeningServiceError("execution_not_authorized", "当前研究回合没有对应用户原话的执行授权。", 409)
        result = {"ready_to_execute": True, "execution_authorized": True, "task_revision": revision,
                  "execution_authorization_message_id": grant}
    elif button_authorized:
        result = {"ready_to_execute": True, "execution_authorized": True, "task_revision": revision,
                  "execution_authorization_message_id": turn["user_message_id"]}
    if (
        result.get("ready_to_execute") is not True
        or result.get("execution_authorized") is not True
        or not isinstance(result.get("task_revision"), int)
    ):
        raise ScreeningServiceError("execution_not_authorized", "当前对话回合没有有效的筛选执行授权。", 409)

    task_revision = result["task_revision"]
    if conversation["task_revision"] != task_revision:
        raise ScreeningServiceError("revision_conflict", "筛选条件已有更新，请读取最新版本后再执行。", 409)
    stored_grant = conversation_store.get_pending_execute_message(conversation_id)
    pending_message_id = (result.get("execution_authorization_message_id") if button_authorized
                           else stored_grant or result.get("execution_authorization_message_id"))
    if not pending_message_id:
        raise ScreeningServiceError("execution_grant_missing", "待执行授权已撤回或已经消费。", 409)
    conversation_store.get_user_message(conversation_id, pending_message_id)

    task = conversation_store.get_task_revision(conversation_id, task_revision)
    runtime_info = None
    try:
        validate_executable_task(task)
    except ValueError as exc:
        raise ScreeningServiceError("task_incomplete", str(exc), 422) from exc
    if any(condition.program is not None for condition in task.conditions):
        runtime_info = runtime_executor.readiness()
        if not runtime_info["ready"]:
            raise ScreeningServiceError(
                "runtime_unavailable",
                f"本地 Python 计算环境不可用：{runtime_info['reason']}。条件已保留，请修复本地依赖后再执行。",
                503,
            )
    if task.scope.as_of is None:
        raise ScreeningServiceError("as_of_required", "执行前必须确定数据截止日。")
    try:
        pattern_assets = pattern_adapter.freeze_for_task(task)
    except ValueError as exc:
        raise ScreeningServiceError("pattern_unavailable", str(exc)) from exc
    if not market.daily_bar_source_available():
        raise ScreeningServiceError("market_data_unavailable", "本地行情文件当前不可用。", 503)

    source_fingerprint = market.source_fingerprint()
    source_digest = _source_id(source_fingerprint)
    profile = market.cached_profile()
    watermark = profile.get("last_date")
    as_of = task.scope.as_of.isoformat()
    if not profile.get("available") or not watermark:
        raise ScreeningServiceError("market_data_unavailable", "本地行情水位不可用。", 503)
    if as_of > watermark:
        raise ScreeningServiceError("date_after_watermark", f"截止日晚于行情水位 {watermark}。", 422)
    effective_market_date = market.latest_market_date(as_of)
    if not effective_market_date:
        raise ScreeningServiceError("date_without_bars", "截止日前没有可用A股行情。", 422)
    universe = _freeze_universe(task)
    if market.source_fingerprint() != source_fingerprint:
        raise ScreeningServiceError("source_changed", "冻结股票范围期间行情文件发生变化，请重试。", 409)

    execution_request_id = str(uuid4())
    run_id, job_id = str(uuid4()), str(uuid4())
    request = ExecutionRequest(
        request_id=execution_request_id,
        task_id=conversation_id,
        revision=task_revision,
        action="button" if button_authorized else "explicit_user_message",
        source_message_id=pending_message_id,
        idempotency_key=idempotency_key,
    )
    source_manifests = [f"local-daily-bars:fingerprint:{source_digest}"]
    turn_tool_ids = []
    with connect() as connection:
        turn_row = connection.execute(
            "SELECT result_json,state FROM conversation_turns WHERE id=? AND conversation_id=?",
            (turn_id, conversation_id),
        ).fetchone()
        if turn_row and turn_row["state"] == expected_state:
            with_id = connection.execute(
                "SELECT call_id FROM tool_calls WHERE turn_id=? ORDER BY created_at,call_id",
                (turn_id,),
            ).fetchall()
            turn_tool_ids = [row[0] for row in with_id]
        turn_metadata = (json_load(turn_row["result_json"]) or {}).get("model_metadata", {}) if turn_row else {}
    snapshot = {
        "protocol_version": EXECUTION_VERSION,
        "execution_request": request.model_dump(mode="json"),
        "task": task.model_dump(mode="json"),
        "as_of": as_of,
        "effective_market_date": effective_market_date,
        "universe": universe,
        "source_manifests": source_manifests,
        "source_fingerprint": list(source_fingerprint) if source_fingerprint else None,
        "tool_call_ids": turn_tool_ids,
        "model_metadata": turn_metadata,
        "pattern_assets": pattern_assets,
    }
    if observation is not None:
        from .observation_market import reference_prices
        snapshot["observation"] = {
            **observation, "price_basis": profile.get("price_basis", "unknown"),
            "historical_replay": as_of < watermark,
            "reference_prices": reference_prices(universe["codes"], effective_market_date),
        }
    snapshot_json = json_dump(snapshot)
    request_json = json_dump(request.model_dump(mode="json"))
    now = utc_now()

    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if agent_active:
            try:
                conversation_store.require_running_turn(connection, conversation_id, turn_id)
            except conversation_store.ConversationConflict as exc:
                raise ScreeningServiceError("execution_state_changed", str(exc), 409) from exc
        existing = connection.execute(
            """SELECT r.id,r.turn_id,s.id AS run_id,s.job_id,s.status,s.task_revision
               FROM execution_requests r JOIN screening_task_runs s ON s.execution_request_id=r.id
               WHERE r.conversation_id=? AND r.idempotency_key=?""",
            (conversation_id, idempotency_key),
        ).fetchone()
        if existing:
            if button_authorized and (existing["turn_id"] != turn_id or existing["task_revision"] != task_revision):
                raise ScreeningServiceError("request_conflict", "同一执行请求不能用于不同的任务版本。", 409)
            return {
                "execution_request_id": existing["id"],
                "run_id": existing["run_id"],
                "job_id": existing["job_id"],
                "status": existing["status"],
                "task_revision": existing["task_revision"],
                "idempotent_replay": True,
            }
        current = connection.execute(
            "SELECT task_revision,pending_execute_message_id,state,workflow_type FROM conversations WHERE id=?",
            (conversation_id,),
        ).fetchone()
        current_turn = connection.execute(
            "SELECT state,result_json,workflow_type FROM conversation_turns WHERE id=? AND conversation_id=?",
            (turn_id, conversation_id),
        ).fetchone()
        latest_turn = connection.execute("SELECT id FROM conversation_turns WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1", (conversation_id,)).fetchone()
        if (
            not current or current["state"] != "active"
            or current["workflow_type"] != "screening"
            or current["task_revision"] != task_revision
            or ((not button_authorized) and current["pending_execute_message_id"] != pending_message_id)
            or not current_turn or current_turn["state"] != expected_state
            or current_turn["workflow_type"] != "screening"
            or (button_authorized and (not latest_turn or latest_turn["id"] != turn_id))
            or (not agent_active and not button_authorized and (
                json_load(current_turn["result_json"]).get("ready_to_execute") is not True
                or json_load(current_turn["result_json"]).get("execution_authorized") is not True
                or json_load(current_turn["result_json"]).get("task_revision") != task_revision
                or json_load(current_turn["result_json"]).get("execution_authorization_message_id") != pending_message_id
            ))
            or market.source_fingerprint() != source_fingerprint
        ):
            raise ScreeningServiceError("execution_state_changed", "对话条件或执行授权已经变化，请重新读取。", 409)
        source = connection.execute(
            "SELECT 1 FROM conversation_messages WHERE id=? AND conversation_id=? AND role='user'",
            (pending_message_id, conversation_id),
        ).fetchone()
        if not source:
            raise ScreeningServiceError("execution_source_invalid", "待执行授权没有对应的用户消息。", 409)

        connection.execute(
            """INSERT INTO execution_requests(
                   id,conversation_id,turn_id,task_revision,source_message_id,idempotency_key,request_json,created_at
               ) VALUES(?,?,?,?,?,?,?,?)""",
            (execution_request_id, conversation_id, turn_id, task_revision, pending_message_id, idempotency_key, request_json, now),
        )
        connection.execute(
            """INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at,required_protocol)
               VALUES(?,?,?,'queued','等待对话筛选 worker',?,?,?)""",
            (job_id, "screening_task", json_dump({"run_id": run_id}), now, now, JOB_PROTOCOL),
        )
        connection.execute(
            """INSERT INTO screening_task_runs(
                   id,conversation_id,task_revision,execution_request_id,job_id,as_of,status,
                   execution_version,snapshot_json,result_json,created_at
               ) VALUES(?,?,?,?,?,?, 'queued', ?, ?, '{}', ?)""",
            (run_id, conversation_id, task_revision, execution_request_id, job_id, as_of, EXECUTION_VERSION, snapshot_json, now),
        )
        connection.execute(
            """UPDATE conversations SET active_run_id=?,pending_execute_message_id=NULL,updated_at=?
               WHERE id=?""",
            (run_id, now, conversation_id),
        )
    return _run_response(execution_request_id, run_id, job_id, task_revision)


def get_task_run(conversation_id: str, run_id: str) -> dict[str, Any]:
    with connect() as connection:
        row = connection.execute(
            """SELECT s.id,s.conversation_id,s.task_revision,s.execution_request_id,s.job_id,s.as_of,
                      s.status,s.execution_version,s.snapshot_json,s.result_json,s.created_at,s.finished_at,
                      j.state AS job_state,j.progress,j.message AS job_message
               FROM screening_task_runs s JOIN jobs j ON j.id=s.job_id
               WHERE s.id=? AND s.conversation_id=?""",
            (run_id, conversation_id),
        ).fetchone()
    if not row:
        raise ScreeningServiceError("run_not_found", "找不到此对话的筛选运行。", 404)
    snapshot = json_load(row["snapshot_json"])
    return {
        "id": row["id"],
        "conversation_id": row["conversation_id"],
        "task_revision": row["task_revision"],
        "execution_request_id": row["execution_request_id"],
        "job_id": row["job_id"],
        "as_of": row["as_of"],
        "status": row["status"],
        "execution_version": row["execution_version"],
        "created_at": row["created_at"],
        "finished_at": row["finished_at"],
        "universe": {"kind": snapshot["universe"]["kind"], "size": len(snapshot["universe"]["codes"])},
        "task": snapshot["task"],
        "result": json_load(row["result_json"]),
        "job": {"state": row["job_state"], "progress": row["progress"], "message": row["job_message"]},
    }


def list_task_runs(conversation_id: str, limit: int = 50) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 100))
    with connect() as connection:
        rows = connection.execute(
            """SELECT id,task_revision,as_of,status,job_id,created_at,finished_at
               FROM screening_task_runs WHERE conversation_id=?
               ORDER BY created_at DESC,id DESC LIMIT ?""",
            (conversation_id, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def list_task_decisions(
    conversation_id: str,
    run_id: str,
    *,
    state: str = "",
    query: str = "",
    offset: int = 0,
    limit: int = 50,
) -> dict[str, Any]:
    if state not in {"", "true", "false", "unknown"}:
        raise ScreeningServiceError("invalid_decision_state", "逐股状态无效。")
    limit, offset, query = max(1, min(limit, 100)), max(0, offset), query[:32]
    with connect() as connection:
        if not connection.execute(
            "SELECT 1 FROM screening_task_runs WHERE id=? AND conversation_id=?", (run_id, conversation_id)
        ).fetchone():
            raise ScreeningServiceError("run_not_found", "找不到此对话的筛选运行。", 404)
        from . import security_catalog
        clause = "run_id=? AND (?='' OR state=?) AND " + security_catalog.query_clause()
        params = (run_id, state, state, *security_catalog.query_params(query))
        total = connection.execute(
            f"SELECT COUNT(*) FROM screening_task_decisions WHERE {clause}", params
        ).fetchone()[0]
        rows = connection.execute(
            f"""SELECT decision_json FROM screening_task_decisions
                WHERE {clause} ORDER BY stock_code LIMIT ? OFFSET ?""",
            (*params, limit, offset),
        ).fetchall()
    return {"items": [json_load(row[0]) for row in rows], "total": total, "offset": offset, "limit": limit}


def explain_task_run(conversation_id: str, run_id: str, *, stock_code: str | None = None) -> dict[str, Any]:
    """Read an immutable run and saved decisions without querying current data."""
    with connect() as connection:
        run = connection.execute(
            """SELECT id,conversation_id,task_revision,as_of,status,execution_version,
                      snapshot_json,result_json,created_at,finished_at
               FROM screening_task_runs WHERE id=? AND conversation_id=?""",
            (run_id, conversation_id),
        ).fetchone()
        if not run:
            raise ScreeningServiceError("run_not_found", "找不到此对话的筛选运行。", 404)
        snapshot = json_load(run["snapshot_json"])
        result = json_load(run["result_json"])
        decision = None
        if stock_code:
            row = connection.execute(
                "SELECT decision_json FROM screening_task_decisions WHERE run_id=? AND stock_code=?",
                (run_id, stock_code.upper()),
            ).fetchone()
            if not row:
                raise ScreeningServiceError("decision_not_found", "这次运行没有该证券的已保存逐股依据。", 404)
            decision = json_load(row["decision_json"])
        elif run["status"] in {"queued", "running"}:
            raise ScreeningServiceError("run_not_finished", "筛选仍在运行，暂时没有可解释的完整结果。", 409)
    return {
        "run_id": run["id"], "conversation_id": run["conversation_id"],
        "task_revision": run["task_revision"], "as_of": run["as_of"], "status": run["status"],
        "execution_version": run["execution_version"], "created_at": run["created_at"],
        "finished_at": run["finished_at"], "task": snapshot["task"], "universe": snapshot["universe"],
        "coverage": result.get("coverage") if isinstance(result, dict) else None,
        "stock_code": stock_code.upper() if stock_code else None, "decision": decision,
        "read_only": True, "uses_current_data": False,
    }


def explain_task_run_text(conversation_id: str, run_id: str, *, stock_code: str | None = None) -> str:
    item = explain_task_run(conversation_id, run_id, stock_code=stock_code)
    if item["status"] in {"queued", "running"}:
        return f"运行 {run_id} 仍在处理中，当前没有完整历史依据。"
    if item["status"] in {"failed", "cancelled"} and not item["decision"]:
        return f"运行 {run_id} 的状态是 {item['status']}，没有可发布的逐股结论；这不是一次新的筛选。"
    if not item["decision"]:
        coverage = item.get("coverage") or {}
        return (f"运行于 {item['as_of']} 截止，状态为 {item['status']}；目标 {coverage.get('target_total', '未知')} 只，"
                f"符合 {coverage.get('true_count', '未知')} 只，不符合 {coverage.get('false_count', '未知')} 只，"
                f"数据不足 {coverage.get('unknown_count', '未知')} 只。以上数字来自该次已保存运行，没有读取最新行情。")
    decision = item["decision"]
    lines = [f"证券 {decision['stock_code']} 在 {item['as_of']} 的历史筛选结果是：{decision['state']}。",
             f"总说明：{decision['reason_code']}；{decision['evaluation_status']}。"]
    for condition in decision.get("condition_decisions", []):
        lines.append(f"条件 {condition['condition_id']}：{condition['state']}；{condition['explanation']}")
        if condition.get("actual_values"):
            lines.append("实际值：" + json.dumps(condition["actual_values"], ensure_ascii=False, separators=(",", ":")))
        if condition.get("thresholds"):
            lines.append("口径阈值：" + json.dumps(condition["thresholds"], ensure_ascii=False, separators=(",", ":")))
        if condition.get("evidence_refs"):
            lines.append("引用：" + "；".join(condition["evidence_refs"]))
    lines.append("这是对该次运行已保存依据的只读解释，没有使用当前数据重新筛选。")
    return "\n".join(lines)
