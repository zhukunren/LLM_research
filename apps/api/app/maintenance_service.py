"""Data maintenance service shared by HTTP and background workers."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from . import security_catalog
from .db import connect, json_dump, json_load, utc_now


def _progress_details(details):
    # Calendar/deferred histories can contain decades of dates. Keep polling
    # compact, including snapshots saved by older workers, and retain failures.
    output = {key: value for key, value in details.items() if key not in {"open_days", "deferred_days"}}
    if "deferred_days" in details:
        output["deferred_days_count"] = len(details["deferred_days"])
    return output


def maintenance_status():
    with connect() as connection:
        row = connection.execute("""SELECT j.id,j.state,j.message,j.progress,j.created_at,j.updated_at,r.result_json
            FROM jobs j LEFT JOIN maintenance_results r ON r.job_id=j.id WHERE j.kind='data_sync'
            ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1""").fetchone()
    result = dict(row) if row else None
    if result:
        result["result"] = json_load(result.pop("result_json") or "{}")
        if isinstance(result["result"].get("market"), dict):
            result["result"]["market"] = _progress_details(result["result"]["market"])
    return {"job": result}


def start_refresh():
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        current = connection.execute("SELECT id FROM jobs WHERE kind='data_sync' AND state IN ('queued','running') LIMIT 1").fetchone()
        if current:
            return {"job_id": current[0]}
        job_id, now = str(uuid4()), utc_now()
        connection.execute("INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at) VALUES(?,'data_sync','{}','queued','正在等待更新股票名称、行情和资讯',?,?)", (job_id, now, now))
        connection.execute("INSERT INTO maintenance_results VALUES(?,?)", (job_id, json_dump({
            name: {"status": "pending"} for name in ("names", "market", "news")
        })))
    return {"job_id": job_id}


def refresh_data(lease):
    from . import tushare_sync
    stages = ("names", "market", "news")
    successful = {"completed", "updated", "up_to_date", "no_new_rows"}
    terminal = successful | {"failed", "partial"}
    result = {name: {"status": "pending"} for name in stages}
    result["events"] = []

    def report(name, details):
        now = utc_now()
        stage = result[name]
        stage.setdefault("started_at", now)
        stage.update(_progress_details(details), updated_at=now)
        if stage["status"] in terminal:
            stage["finished_at"] = now
            stage["message"] = {
                "names": f"股票名称已更新，共 {stage.get('count', 0):,} 只。",
                "market": f"行情已写入 {stage.get('rows_written', 0):,} 条。",
                "news": f"资讯新增 {stage.get('import', {}).get('created', 0):,} 条。",
            }[name] if stage["status"] in successful else (
                stage.get("reason") or ("行情部分完成，待重试或继续补齐。" if name == "market" else "资讯部分完成，请查看下方覆盖与失败详情。")
            )
        message = stage.get("message", "正在更新数据…")
        result["events"].append({"at": now, "stage": name, "message": message})
        result["events"] = result["events"][-80:]
        base, weight = {"names": (0, 0.1), "market": (0.1, 0.7), "news": (0.8, 0.2)}[name]
        fraction = 1 if stage["status"] in terminal else min(1, stage.get("completed", 0) / max(1, stage.get("total", 0)))
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            updated = connection.execute(
                """UPDATE jobs SET progress=?,message=?,updated_at=?
                   WHERE id=? AND state='running' AND lease_owner=? AND lease_expires_at>?""",
                (min(0.99, base + weight * fraction), message, now, lease.id, lease.owner, now),
            )
            if updated.rowcount != 1:
                raise RuntimeError("数据更新任务已停止")
            connection.execute("INSERT OR REPLACE INTO maintenance_results VALUES(?,?)", (lease.id, json_dump(result)))

    if not lease.active():
        return
    report("names", {"status": "running", "message": "正在读取并保存股票名称…"})
    try:
        names = {"status": "updated", "count": security_catalog.refresh()}
    except Exception as exc:
        names = {"status": "failed", "reason": str(exc) if isinstance(exc, tushare_sync.TushareError) else "股票名称暂未更新，已保留原资料。请稍后重试。"}
    if not lease.active():
        return
    report("names", names)
    now = datetime.now(timezone(timedelta(hours=8)))
    cutoff = now.date() if now.hour >= 16 else (now - timedelta(days=1)).date()
    try:
        synced = tushare_sync.sync_tushare(as_of=cutoff, days=30, on_progress=report)
        # Retain compatibility with sync runners that only return final results.
        for name, stage in synced["stages"].items():
            if result[name]["status"] not in terminal:
                report(name, stage)
    except Exception as exc:
        if not lease.active():
            return
        for name in ("market", "news"):
            if result[name]["status"] not in terminal:
                report(name, {"status": "failed", "reason": str(exc) if isinstance(exc, tushare_sync.TushareError) else "更新处理失败，请保存诊断信息交给维护者。"})
    failed = [name for name in stages if result[name]["status"] not in successful]
    if lease.active():
        lease.finish("partial" if failed else "succeeded", "部分资料尚未更新，可重试；原有资料仍可使用。" if failed else "股票名称、行情和资讯已更新。")
