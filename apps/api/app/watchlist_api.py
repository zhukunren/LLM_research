from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter

from .api_responses import bad_request, csv_response
from .db import connect, utc_now
from .models import WatchlistInput, WatchlistItemInput

router = APIRouter(prefix="/api/v1/watchlists")


@router.get("")
def list_watchlists():
    with connect() as connection:
        rows = connection.execute("SELECT id,name,created_at FROM watchlists ORDER BY created_at").fetchall()
        output = []
        for row in rows:
            members = connection.execute(
                "SELECT stock_code,note,added_at FROM watchlist_items WHERE watchlist_id=? ORDER BY added_at DESC",
                (row[0],),
            ).fetchall()
            output.append({"id": row[0], "name": row[1], "created_at": row[2], "items": [dict(member) for member in members]})
    return {"items": output}


@router.post("")
def create_watchlist(payload: WatchlistInput):
    watchlist_id, now = str(uuid4()), utc_now()
    with connect() as connection:
        connection.execute("INSERT INTO watchlists(id,name,created_at) VALUES(?,?,?)", (watchlist_id, payload.name, now))
    return {"id": watchlist_id, "name": payload.name, "created_at": now, "items": []}


@router.post("/{watchlist_id}/items")
def add_watchlist_item(watchlist_id: str, payload: WatchlistItemInput):
    stock_code = payload.stock_code.upper()
    if not stock_code.endswith((".SH", ".SZ", ".BJ")):
        bad_request("观察池仅接受 A 股证券代码")
    now = utc_now()
    with connect() as connection:
        exists = connection.execute("SELECT 1 FROM watchlists WHERE id=?", (watchlist_id,)).fetchone()
        if not exists:
            bad_request("找不到观察分组", 404, "watchlist_not_found")
        connection.execute(
            """INSERT INTO watchlist_items(watchlist_id,stock_code,note,added_at) VALUES(?,?,?,?)
               ON CONFLICT(watchlist_id,stock_code) DO UPDATE SET note=CASE WHEN ? THEN excluded.note ELSE watchlist_items.note END""",
            (watchlist_id, stock_code, payload.note, now, payload.replace_note),
        )
        saved = connection.execute("SELECT note,added_at FROM watchlist_items WHERE watchlist_id=? AND stock_code=?", (watchlist_id, stock_code)).fetchone()
    return {"watchlist_id": watchlist_id, "stock_code": stock_code, "note": saved[0], "added_at": saved[1]}


@router.delete("/{watchlist_id}/items/{stock_code}")
def remove_watchlist_item(watchlist_id: str, stock_code: str):
    with connect() as connection:
        connection.execute("DELETE FROM watchlist_items WHERE watchlist_id=? AND stock_code=?", (watchlist_id, stock_code.upper()))
    return {"removed": True}


@router.get("/{watchlist_id}/export")
def export_watchlist(watchlist_id: str):
    with connect() as connection:
        group = connection.execute("SELECT name FROM watchlists WHERE id=?", (watchlist_id,)).fetchone()
        members = connection.execute("SELECT stock_code,note,added_at FROM watchlist_items WHERE watchlist_id=? ORDER BY stock_code", (watchlist_id,)).fetchall()
    if not group:
        bad_request("找不到观察分组", 404, "watchlist_not_found")
    rows = [["证券代码", "人工笔记", "加入时间"], *[[row[0], row[1], row[2]] for row in members]]
    return csv_response(f"watchlist-{watchlist_id[:8]}.csv", rows)
