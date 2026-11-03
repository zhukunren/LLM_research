"""Actor-owned, immutable search evidence with editable research annotations."""
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import Field

from .db import connect, json_dump, json_load, utc_now
from .models import StrictModel
from .security_context import can_write, current_actor

router = APIRouter(prefix="/api/v1/patterns/search-runs", tags=["形态研究记录"])
MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
REPLAY_NOTE = "保存的是本次请求、模板与结果快照，可复查；未冻结全市场原始行情，不保证日后重新计算完全一致。"


def save_search(template: dict, result: dict, request: dict) -> dict:
    actor = current_actor()
    # A viewer's legacy GET best-match remains genuinely read-only.
    if not can_write(actor):
        return {**result, "search_run_id": None, "snapshot_notice": "只读账户未保存研究记录。"}
    identifier, created = str(uuid4()), utc_now()
    result = {**result, "search_run_id": identifier, "snapshot_notice": REPLAY_NOTE}
    snapshot = {"id": identifier, "created_at": created, "name": template.get("name", "未命名形态"),
                "requested_as_of": result.get("requested_as_of"), "as_of": result.get("as_of"),
                "request": request, "template": template, "result": result, "snapshot_notice": REPLAY_NOTE}
    encoded = json_dump(snapshot)
    if len(encoded.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        raise HTTPException(413, "检索快照超过4 MB，请减少返回样本或输入参数。")
    summary = {key: value for key, value in snapshot.items() if key not in {"request", "template", "result"}}
    with connect() as connection:
        connection.execute("INSERT INTO pattern_search_runs(id,tenant_id,user_id,created_at,snapshot_json,summary_json) VALUES(?,?,?,?,?,?)",
                           (identifier, actor.tenant_id, actor.user_id, created, encoded, json_dump(summary)))
    return result


def _row(identifier):
    actor = current_actor()
    with connect() as connection:
        row = connection.execute("SELECT * FROM pattern_search_runs WHERE id=? AND tenant_id=? AND user_id=?",
                                 (identifier, actor.tenant_id, actor.user_id)).fetchone()
    if row is None:
        raise HTTPException(404, "找不到研究记录")
    return row


def _record(row):
    return {**json_load(row["snapshot_json"]), "selected_key": row["selected_key"], "note": row["note"]}


@router.get("")
def list_search_runs():
    actor = current_actor()
    with connect() as connection:
        rows = connection.execute("SELECT summary_json,selected_key,note FROM pattern_search_runs WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
                                  (actor.tenant_id, actor.user_id)).fetchall()
    return {"items": [{**json_load(row["summary_json"]), "selected_key": row["selected_key"], "note": row["note"]} for row in rows]}


@router.get("/{search_run_id}")
def get_search_run(search_run_id: str):
    return _record(_row(search_run_id))


class SearchAnnotation(StrictModel):
    note: str | None = Field(default=None, max_length=4000)
    selected_key: str | None = Field(default=None, max_length=100)


@router.patch("/{search_run_id}")
def annotate_search_run(search_run_id: str, payload: SearchAnnotation):
    actor = current_actor()
    if not can_write(actor):
        raise HTTPException(403, "当前账户只有查看权限")
    row = _row(search_run_id)
    record = _record(row)
    if payload.selected_key is not None and payload.selected_key:
        keys = {f"{item.get('stock_code')}@{item.get('start_date')}" for item in record["result"].get("items", [])}
        if payload.selected_key not in keys:
            raise HTTPException(422, "所选案例不在该次检索快照中")
    # Update only submitted non-null fields: selecting a case in a second tab
    # must not overwrite a concurrently saved note with a stale read.
    changes = {key: getattr(payload, key) for key in ("note", "selected_key")
               if key in payload.model_fields_set and getattr(payload, key) is not None}
    if changes:
        assignments = ",".join(f"{key}=?" for key in changes)
        with connect() as connection:
            connection.execute(f"UPDATE pattern_search_runs SET {assignments} WHERE id=? AND tenant_id=? AND user_id=?",
                               (*changes.values(), search_run_id, actor.tenant_id, actor.user_id))
    return _record(_row(search_run_id))
