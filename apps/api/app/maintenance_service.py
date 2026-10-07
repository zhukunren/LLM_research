"""Data maintenance service shared by HTTP and background workers."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from . import security_catalog
from .db import connect, json_dump, json_load, utc_now


def maintenance_status():
    with connect() as connection:
        row = connection.execute("""SELECT j.id,j.state,j.message,j.progress,j.updated_at,r.result_json
            FROM jobs j LEFT JOIN maintenance_results r ON r.job_id=j.id WHERE j.kind='data_sync'
            ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1""").fetchone()
    result = dict(row) if row else None
    if result:
        result["result"] = json_load(result.pop("result_json") or "{}")
    return {"job": result}


def start_refresh():
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        current = connection.execute("SELECT id FROM jobs WHERE kind='data_sync' AND state IN ('queued','running') LIMIT 1").fetchone()
        if current:
            return {"job_id": current[0]}
        job_id, now = str(uuid4()), utc_now()
        connection.execute("INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at) VALUES(?,'data_sync','{}','queued','正在等待更新股票名称、行情和资讯',?,?)", (job_id, now, now))
    return {"job_id": job_id}


def refresh_data(lease):
    from . import tushare_sync
    result = {}
    lease.progress(0.05, "正在更新股票名称…")
    try:
        result["names"] = {"status": "updated", "count": security_catalog.refresh()}
    except Exception:
        result["names"] = {"status": "failed", "message": "股票名称暂未更新，已保留原资料。请稍后重试。"}
    if not lease.active():
        return
    lease.progress(0.25, "正在更新行情和最近30天资讯，可继续浏览其他页面…")
    now = datetime.now(timezone(timedelta(hours=8)))
    cutoff = now.date() if now.hour >= 16 else (now - timedelta(days=1)).date()
    try:
        synced = tushare_sync.sync_tushare(as_of=cutoff, days=30)
    except Exception:
        synced = {"stages": {"market": {"status": "failed"}, "news": {"status": "failed"}}}
    for name, stage in synced["stages"].items():
        result[name] = {"status": stage.get("status"), "message": "更新未完成，请稍后重试。" if stage.get("status") == "failed" else ""}
    successful = {"completed", "updated", "up_to_date", "no_new_rows"}
    failed = [name for name, item in result.items() if item["status"] not in successful]
    if lease.active():
        with connect() as connection:
            connection.execute("INSERT OR REPLACE INTO maintenance_results VALUES(?,?)", (lease.id, json_dump(result)))
        lease.finish("partial" if failed else "succeeded", "部分资料尚未更新，可重试；原有资料仍可使用。" if failed else "股票名称、行情和资讯已更新。")
