from __future__ import annotations

import csv
from datetime import date
from io import StringIO
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import Field, model_validator

from . import market, security_catalog, screening_service, maintenance_service
from .db import connect, json_dump, json_load, utc_now
from . import conversation_store
from .screening_contracts import ContractModel, ScreeningTaskRevision, UniverseScope, validate_executable_task

router = APIRouter(prefix="/api/v1", tags=["股票搜索与日常使用"])


class ScopeUpdate(ContractModel):
    base_revision: int = Field(ge=1)
    client_message_id: str = Field(min_length=1, max_length=100)
    universe: UniverseScope
    as_of: date


class CompositionUpdate(ContractModel):
    base_revision: int = Field(ge=1)
    client_message_id: str = Field(min_length=1, max_length=100)
    expected_logic_tree: dict | None
    expected_reference_ids: list[str] = Field(min_length=1)
    logic_mode: Literal["all", "any"] | None = None
    remove_reference_id: str | None = Field(default=None, min_length=1, max_length=80)

    @model_validator(mode="after")
    def has_single_change(self):
        if (self.logic_mode is None) == (self.remove_reference_id is None):
            raise ValueError("每次只能调整组合方式或移除一条条件")
        return self


def _prune_logic_reference(node: dict, reference_id: str) -> dict | None:
    if node["op"] == "condition":
        return None if node["reference_id"] == reference_id else node
    children = [
        child for item in node["children"]
        if (child := _prune_logic_reference(item, reference_id)) is not None
    ]
    if not children:
        return None
    if node["op"] != "not" and len(children) == 1:
        return children[0]
    return {"op": node["op"], "children": children}


def _logic_contains_reference(node: object, reference_id: str) -> bool:
    if not isinstance(node, dict):
        return False
    if node.get("op") == "condition":
        return node.get("reference_id") == reference_id
    children = node.get("children")
    return isinstance(children, list) and any(_logic_contains_reference(child, reference_id) for child in children)


def _auto_execution(task: ScreeningTaskRevision, message_id: str) -> tuple[dict, str | None]:
    try:
        validate_executable_task(task)
    except ValueError as exc:
        return {"ready_to_execute": False, "execution_authorized": False, "clarification": str(exc)}, None
    return {
        "ready_to_execute": True,
        "execution_authorized": True,
        "execution_authorization_message_id": message_id,
    }, message_id


@router.post("/conversations/{conversation_id}/scope")
def update_scope(conversation_id: str, payload: ScopeUpdate):
    latest = market.cached_profile().get("last_date")
    if latest and payload.as_of.isoformat() > latest:
        raise HTTPException(422, f"行情只更新到 {latest}，请选择该日或更早日期。")
    scope_label = "全部A股" if payload.universe.kind == "all_a_shares" else "我的自选分组" if payload.universe.kind == "watchlist" else "、".join(payload.universe.stock_codes)
    content = f"将范围设为{scope_label}，截止日期设为{payload.as_of.isoformat()}。更新后自动重筛。"
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
            execution, pending_message_id = _auto_execution(task, message["message_id"])
            conversation_store.finish_turn(conversation_id, message["turn_id"], task.revision, "succeeded",
                f"已采用{scope_label}、{payload.as_of.isoformat()}的行情。其他条件保持原样，正在自动重筛。"
                if pending_message_id else
                f"已采用{scope_label}、{payload.as_of.isoformat()}的行情。其他条件保持原样，但当前条件还不完整。",
                {"intent": "edit", "task_revision": task.revision, **execution},
                pending_execute_message_id=pending_message_id, _connection=connection)
            return result
    except conversation_store.ConversationNotFound as exc:
        raise HTTPException(404, "找不到要调整的选股方案。") from exc
    except (conversation_store.ConversationStoreError, conversation_store.ConversationConflict) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/conversations/{conversation_id}/composition")
def update_composition(conversation_id: str, payload: CompositionUpdate):
    try:
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")

            edit = {
                "logic_mode": payload.logic_mode,
                "remove_reference_id": payload.remove_reference_id,
                "expected_logic_tree": payload.expected_logic_tree,
                "expected_reference_ids": payload.expected_reference_ids,
            }
            existing = connection.execute(
                """SELECT t.base_revision,t.result_json
                   FROM conversation_messages m
                   JOIN conversation_turns t ON t.user_message_id=m.id
                   WHERE m.conversation_id=? AND m.role='user' AND m.client_message_id=?""",
                (conversation_id, payload.client_message_id),
            ).fetchone()
            if existing:
                prior_edit = json_load(existing["result_json"]).get("composition_edit")
                if existing["base_revision"] != payload.base_revision or prior_edit != edit:
                    raise conversation_store.ConversationConflict("相同请求ID不能应用不同的组合修改。")
                current = connection.execute(
                    "SELECT task_revision FROM conversations WHERE id=?", (conversation_id,),
                ).fetchone()
                if not current:
                    raise conversation_store.ConversationNotFound(conversation_id)
                saved = connection.execute(
                    "SELECT task_json FROM screening_task_revisions WHERE conversation_id=? AND revision=?",
                    (conversation_id, current["task_revision"]),
                ).fetchone()
                if not saved:
                    raise conversation_store.ConversationNotFound(conversation_id)
                return {
                    "revision": current["task_revision"],
                    "task": json_load(saved["task_json"]),
                    "idempotent_replay": True,
                }

            current = connection.execute(
                "SELECT task_revision,state,workflow_type FROM conversations WHERE id=?",
                (conversation_id,),
            ).fetchone()
            if not current:
                raise conversation_store.ConversationNotFound(conversation_id)
            if current["state"] != "active":
                raise conversation_store.ConversationConflict("此对话已归档，不能修改条件")
            if current["workflow_type"] != "screening":
                raise conversation_store.ConversationConflict("请先将研究转为选股方案，再编辑组合")
            if current["task_revision"] != payload.base_revision:
                raise conversation_store.ConversationConflict("选股方案已更新，请刷新后再修改")
            if connection.execute(
                "SELECT 1 FROM screening_task_runs WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1",
                (conversation_id,),
            ).fetchone():
                raise conversation_store.ConversationConflict("筛选正在运行，完成后再修改组合")

            row = connection.execute(
                "SELECT task_json FROM screening_task_revisions WHERE conversation_id=? AND revision=?",
                (conversation_id, payload.base_revision),
            ).fetchone()
            if not row:
                raise conversation_store.ConversationNotFound(conversation_id)
            raw = json_load(row[0])
            references = raw.get("references", [])
            conditions = raw.get("conditions", [])
            tree = raw.get("logic_tree")
            reference_ids = [item.get("reference_id") for item in references]
            if tree != payload.expected_logic_tree or reference_ids != payload.expected_reference_ids:
                raise conversation_store.ConversationConflict("组合已被其他操作更新，请刷新方案后重试")

            if payload.logic_mode is not None:
                if not isinstance(tree, dict):
                    raise HTTPException(422, "当前方案没有可直接切换的平铺组合")
                if tree.get("op") == "condition":
                    leaves = [tree]
                elif tree.get("op") in {"all", "any"} and all(
                    isinstance(child, dict) and child.get("op") == "condition"
                    for child in tree.get("children", [])
                ):
                    leaves = tree["children"]
                else:
                    raise HTTPException(422, "该方案包含嵌套或排除逻辑，请在高级组合中继续编辑")
                if len(leaves) < 2:
                    raise HTTPException(422, "至少有两条条件时才能切换组合方式")
                label = "全部满足" if payload.logic_mode == "all" else "满足任一"
                content = f"将筛选条件组合方式改为{label}。更新后自动重筛。"
                raw["logic_tree"] = {"op": payload.logic_mode, "children": leaves}
            else:
                reference = next((item for item in references if item.get("reference_id") == payload.remove_reference_id), None)
                if reference is None:
                    raise HTTPException(404, "找不到要移除的条件，请刷新方案后重试。")
                if len(references) <= 1:
                    raise HTTPException(422, "至少保留一条筛选条件。")
                condition = next((item for item in conditions if item.get("condition_id") == reference["condition_id"]), None)
                ranking = (raw.get("scope") or {}).get("ranking") or {}
                if ((condition and condition.get("library") == "ranking")
                        or ranking.get("metric_reference_id") == reference["reference_id"]
                        or _logic_contains_reference(ranking.get("population_logic_tree"), reference["reference_id"])):
                    raise HTTPException(422, "该条件是排名计算所需依据，不能单独移除。")
                description = condition.get("description", "筛选条件") if condition else "筛选条件"
                content = f"将筛选条件「{description}」从组合中移除。更新后自动重筛。"
                raw["references"] = [item for item in references if item["reference_id"] != reference["reference_id"]]
                raw["logic_tree"] = _prune_logic_reference(tree, reference["reference_id"])
                referenced_conditions = {item["condition_id"] for item in raw["references"]}
                raw["conditions"] = [item for item in conditions if item["condition_id"] in referenced_conditions]

            raw["revision"] = payload.base_revision
            original_messages = raw.get("original_user_messages", [])
            raw["original_user_messages"] = [*original_messages, content] if len(original_messages) < 100 else original_messages
            try:
                task = ScreeningTaskRevision.model_validate(raw)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            task_json = json_dump(task.model_dump(mode="json"))
            message = conversation_store.add_user_message(
                conversation_id, payload.client_message_id, payload.base_revision, content, _connection=connection,
            )
            if message["idempotent_replay"]:
                raise conversation_store.ConversationConflict("组合已被其他操作更新，请刷新方案后重试")
            updated = connection.execute(
                """UPDATE screening_task_revisions SET task_json=?
                   WHERE conversation_id=? AND revision=?
                     AND revision=(SELECT task_revision FROM conversations WHERE id=?)""",
                (task_json, conversation_id, payload.base_revision, conversation_id),
            )
            if updated.rowcount != 1:
                raise conversation_store.ConversationConflict("选股方案已更新，请刷新后再修改")
            label = "组合方式已更新" if payload.logic_mode is not None else "条件已移除"
            execution, pending_message_id = _auto_execution(task, message["message_id"])
            conversation_store.finish_turn(
                conversation_id, message["turn_id"], payload.base_revision, "succeeded",
                f"{label}，其他条件保持原样；正在自动重筛。" if pending_message_id
                else f"{label}，其他条件保持原样，但当前条件还不完整。",
                {
                    "intent": "edit",
                    "task_revision": task.revision,
                    **execution,
                    "composition_edit": edit,
                },
                pending_execute_message_id=pending_message_id,
                _connection=connection,
            )
            return {
                "conversation_id": conversation_id,
                "revision": task.revision,
                "task": json_load(task_json),
                "idempotent_replay": False,
            }
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
