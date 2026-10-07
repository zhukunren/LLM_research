from __future__ import annotations

import csv
from datetime import date
from io import StringIO

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from . import market, security_catalog, screening_service, maintenance_service
from .db import connect, json_dump, json_load, utc_now
from . import conversation_store
from .screening_contracts import ContractModel, ScreeningTaskRevision, UniverseScope
from pydantic import Field

router = APIRouter(prefix="/api/v1", tags=["股票搜索与日常使用"])


class ScopeUpdate(ContractModel):
    base_revision: int = Field(ge=1)
    client_message_id: str = Field(min_length=1, max_length=100)
    universe: UniverseScope
    as_of: date


@router.post("/conversations/{conversation_id}/scope")
def update_scope(conversation_id: str, payload: ScopeUpdate):
    latest = market.cached_profile().get("last_date")
    if latest and payload.as_of.isoformat() > latest:
        raise HTTPException(422, f"行情只更新到 {latest}，请选择该日或更早日期。")
    scope_label = "全部A股" if payload.universe.kind == "all_a_shares" else "我的自选分组" if payload.universe.kind == "watchlist" else "、".join(payload.universe.stock_codes)
    content = f"将范围设为{scope_label}，截止日期设为{payload.as_of.isoformat()}。先不执行。"
    try:
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if payload.universe.kind == "watchlist" and not connection.execute("SELECT 1 FROM watchlists WHERE id=?", (payload.universe.watchlist_id,)).fetchone():
                raise HTTPException(422, "找不到所选自选分组，请重新选择。")
            row = connection.execute("SELECT task_json FROM screening_task_revisions WHERE conversation_id=? AND revision=?", (conversation_id, payload.base_revision)).fetchone()
            if not row:
                raise conversation_store.ConversationNotFound(conversation_id)
            message = conversation_store.add_user_message(conversation_id, payload.client_message_id, payload.base_revision, content, _connection=connection)
            if message["idempotent_replay"]:
                saved = connection.execute("SELECT task_json FROM screening_task_revisions WHERE conversation_id=? AND revision=?", (conversation_id, payload.base_revision + 1)).fetchone()
                saved_scope = json_load(saved[0])["scope"] if saved else {}
                if saved_scope.get("universe") != payload.universe.model_dump(mode="json") or saved_scope.get("as_of") != payload.as_of.isoformat():
                    raise conversation_store.ConversationConflict("相同请求不能应用不同的股票范围或日期。")
                return {"revision": payload.base_revision + 1}
            raw = json_load(row[0])
            raw["revision"] = payload.base_revision + 1
            raw["scope"].update(universe=payload.universe.model_dump(mode="json"), as_of=payload.as_of.isoformat())
            raw["original_user_messages"] = [*raw["original_user_messages"], content][-100:]
            task = ScreeningTaskRevision.model_validate(raw)
            result = conversation_store.save_task_revision(conversation_id, payload.base_revision, message["message_id"], task, _connection=connection)
            conversation_store.finish_turn(conversation_id, message["turn_id"], task.revision, "succeeded",
                f"已采用{scope_label}、{payload.as_of.isoformat()}的行情。其他条件保持原样，核对后可开始筛选。",
                {"intent": "edit", "task_revision": task.revision, "ready_to_execute": False}, _connection=connection)
            return result
    except conversation_store.ConversationNotFound as exc:
        raise HTTPException(404, "找不到要调整的选股方案。") from exc
    except (conversation_store.ConversationStoreError, conversation_store.ConversationConflict) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/security-catalog")
def catalog():
    items = security_catalog.entries()
    if not items:
        profile = market.cached_profile()
        items = [{"stock_code": code, "name": "", "market": code[-2:], "pinyin": "", "initials": ""}
                 for code in market.security_codes(profile["last_date"])] if profile.get("last_date") else []
    return {"items": [{"stock_code": "000001.SH", "name": "上证指数", "market": "指数", "pinyin": "shangzhengzhishu", "initials": "szzs"}, *items]}


@router.get("/screening-history")
def history(limit: int = Query(200, ge=1, le=500)):
    with connect() as connection:
        legacy = [dict(row) for row in connection.execute("""SELECT r.id,r.strategy_id,r.strategy_version,
            r.as_of,r.status,r.created_at,s.name,'legacy' AS kind
            FROM screening_runs r LEFT JOIN strategies s ON s.id=r.strategy_id AND s.version=r.strategy_version
            ORDER BY r.created_at DESC LIMIT ?""", (limit,))]
        conversations = connection.execute("""SELECT r.id,r.conversation_id,r.task_revision AS strategy_version,
            r.as_of,r.status,r.created_at,r.snapshot_json,c.entry_scope
            FROM screening_task_runs r JOIN conversations c ON c.id=r.conversation_id
            ORDER BY r.created_at DESC LIMIT ?""", (limit,)).fetchall()
    items = legacy
    for row in conversations:
        item = dict(row)
        snapshot = json_load(item.pop("snapshot_json"))
        task = snapshot.get("task", {})
        item.update(kind="conversation", strategy_id="", name="；".join(c.get("description", "") for c in task.get("conditions", []))[:120] or "对话选股方案")
        items.append(item)
    return {"items": sorted(items, key=lambda item: (item["created_at"], item["id"]), reverse=True)[:limit]}


def _export_rows(conversation_id, run_id, state, query):
    if state not in {"", "true", "false", "unknown"}:
        raise HTTPException(422, "请选择有效的结果状态。")
    try:
        run = screening_service.get_task_run(conversation_id, run_id)
    except screening_service.ScreeningServiceError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    if run["status"] in {"queued", "running"}:
        raise HTTPException(409, "筛选还未完成，请稍后导出。")
    with connect() as connection:
        rows = connection.execute(f"""SELECT decision_json FROM screening_task_decisions
            WHERE run_id=? AND (?='' OR state=?) AND {security_catalog.query_clause()}
            ORDER BY stock_code""", (run_id, state, state, *security_catalog.query_params(query))).fetchall()
    return run, [json_load(row[0]) for row in rows]


@router.get("/conversations/{conversation_id}/screening-runs/{run_id}/codes")
def result_codes(conversation_id: str, run_id: str, state: str = "true", query: str = ""):
    _, rows = _export_rows(conversation_id, run_id, state, query)
    return {"items": [item["stock_code"] for item in rows], "total": len(rows)}


@router.get("/conversations/{conversation_id}/screening-runs/{run_id}/export")
def export_run(conversation_id: str, run_id: str, state: str = "true", query: str = ""):
    run, rows = _export_rows(conversation_id, run_id, state, query)
    labels = security_catalog.names()
    text = StringIO()
    writer = csv.writer(text)
    writer.writerow(["股票代码", "股票名称", "判断", "数据截止日", "判断依据"])
    def cell(value):
        value = str(value)
        return "'" + value if value.startswith(("=", "+", "-", "@", "\t", "\r")) else value
    for item in rows:
        writer.writerow([cell(item["stock_code"]), cell(labels.get(item["stock_code"], "")),
                         {"true": "符合", "false": "不符合", "unknown": "数据不足"}[item["state"]], run["as_of"],
                         cell("；".join(c.get("explanation", "") for c in item.get("condition_decisions", [])))])
    return Response("\ufeff" + text.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="screening-{run_id}.csv"'})


@router.get("/maintenance/status")
def maintenance_status():
    return maintenance_service.maintenance_status()


@router.post("/maintenance/refresh", status_code=202)
def start_refresh():
    return maintenance_service.start_refresh()


# Compatibility for existing maintenance callers. New workers import the service.
refresh_data = maintenance_service.refresh_data
