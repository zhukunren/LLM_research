from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Event, Thread
from typing import Any
from uuid import uuid4

from .db import connect, json_dump, json_load, utc_now


LEASE_SECONDS = 90
MAX_ATTEMPTS = 3
RUN_TABLES = {"screening": ("screening_runs", "run_id"), "report_evaluation": ("report_evaluation_runs", "evaluation_run_id")}
RUN_STATE_TABLES = {
    **RUN_TABLES,
    "screening_task": ("screening_task_runs", "run_id"),
}


def _expiry() -> str:
    return (datetime.now(UTC) + timedelta(seconds=LEASE_SECONDS)).isoformat(timespec="seconds")


def _set_run_state(connection, kind: str, payload: dict, state: str, finished_at: str | None = None) -> None:
    if kind in RUN_STATE_TABLES:
        table, key = RUN_STATE_TABLES[kind]
        connection.execute(f"UPDATE {table} SET status=?,finished_at=? WHERE id=?", (state, finished_at, payload[key]))


@dataclass
class JobLease:
    id: str
    kind: str
    payload: dict[str, Any]
    owner: str

    def active(self) -> bool:
        with connect() as connection:
            return connection.execute(
                "SELECT 1 FROM jobs WHERE id=? AND state='running' AND lease_owner=? AND lease_expires_at>?",
                (self.id, self.owner, utc_now()),
            ).fetchone() is not None

    def progress(self, value: float, message: str) -> None:
        with connect() as connection:
            connection.execute(
                "UPDATE jobs SET progress=?,message=?,updated_at=? WHERE id=? AND state='running' AND lease_owner=?",
                (max(0, min(1, value)), message, utc_now(), self.id, self.owner),
            )

    def heartbeat(self) -> None:
        with connect() as connection:
            connection.execute(
                "UPDATE jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND state='running' AND lease_owner=? AND lease_expires_at>?",
                (_expiry(), utc_now(), self.id, self.owner, utc_now()),
            )

    def finish(self, state: str, message: str, result: dict | None = None, coverage: dict | None = None, decisions: list[dict] | None = None) -> bool:
        # Finalization and cancellation serialize under the same SQLite write lock.
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT state,lease_owner,lease_expires_at FROM jobs WHERE id=?", (self.id,)
            ).fetchone()
            if not row or row[0] != "running" or row[1] != self.owner or row[2] <= utc_now():
                return False
            now = utc_now()
            if self.kind == "screening_task" and decisions is not None:
                connection.executemany(
                    """INSERT INTO screening_task_decisions(
                           run_id,stock_code,state,evaluation_status,reason_code,decision_json
                       ) VALUES(?,?,?,?,?,?)""",
                    [
                        (
                            self.payload["run_id"], item["stock_code"], item["state"],
                            item["evaluation_status"], item["reason_code"], json_dump(item),
                        )
                        for item in decisions
                    ],
                )
            if self.kind == "screening_task" and result is not None:
                connection.execute(
                    "UPDATE screening_task_runs SET result_json=? WHERE id=?",
                    (json_dump(result), self.payload["run_id"]),
                )
            connection.execute(
                "UPDATE jobs SET state=?,message=?,progress=CASE WHEN ? IN ('succeeded','partial') THEN 1 ELSE progress END,updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?",
                (state, message, state, now, self.id),
            )
            _set_run_state(connection, self.kind, self.payload, state, now)
            if self.kind in RUN_TABLES:
                table, key = RUN_TABLES[self.kind]
                if result is not None:
                    connection.execute(f"UPDATE {table} SET result_json=? WHERE id=?", (json_dump(result), self.payload[key]))
                if coverage is not None and self.kind == "report_evaluation":
                    connection.execute("UPDATE report_evaluation_runs SET coverage_json=? WHERE id=?", (json_dump(coverage), self.payload[key]))
                if decisions is not None and self.kind == "screening":
                    connection.executemany("INSERT INTO screening_decisions(run_id,stock_code,state,score,detail_json) VALUES(?,?,?,?,?)", [(self.payload[key], item["stock_code"], item["state"], item["score"], json_dump(item)) for item in decisions])
            return True

    def __enter__(self):
        self._stop = Event()

        def keepalive():
            while not self._stop.wait(15):
                try:
                    self.heartbeat()
                except Exception:
                    # Losing a lease prevents final writes; a new worker may recover it.
                    return

        self._thread = Thread(target=keepalive, name="job-heartbeat", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_):
        self._stop.set()
        self._thread.join(timeout=1)


def claim(job_id: str | None = None) -> JobLease | None:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        now = utc_now()
        expired = connection.execute(
            "SELECT id,kind,payload_json,attempts FROM jobs WHERE state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)", (now,)
        ).fetchall()
        for row in expired:
            state = "failed" if row[3] >= MAX_ATTEMPTS else "queued"
            message = "工作进程多次中断，请检查后重试" if state == "failed" else "工作进程中断，任务已重新排队"
            connection.execute(
                "UPDATE jobs SET state=?,message=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?", (state, message, now, row[0])
            )
            _set_run_state(connection, row[1], json_load(row[2]), state, now if state == "failed" else None)
        row = connection.execute(
            "SELECT id,kind,payload_json FROM jobs WHERE state='queued' AND required_protocol IN ('legacy','condition-decisions-v1','screening-task-v1') AND (? IS NULL OR id=?) ORDER BY created_at,id LIMIT 1", (job_id, job_id)
        ).fetchone()
        if not row:
            return None
        protocol = connection.execute("SELECT required_protocol FROM jobs WHERE id=?", (row[0],)).fetchone()[0]
        owner = f"{protocol}:{uuid4()}"
        connection.execute(
            "UPDATE jobs SET state='running',attempts=attempts+1,lease_owner=?,lease_expires_at=?,progress=0,message='任务正在执行',updated_at=? WHERE id=?",
            (owner, _expiry(), now, row[0]),
        )
        payload = json_load(row[2])
        _set_run_state(connection, row[1], payload, "running")
        return JobLease(row[0], row[1], payload, owner)


def cancel(job_id: str) -> dict:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT state,kind,payload_json FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise KeyError(job_id)
        if row[0] not in {"queued", "running"}:
            return {"id": job_id, "state": row[0], "message": "任务已结束"}
        now = utc_now()
        connection.execute(
            "UPDATE jobs SET state='cancelled',message='用户已取消',updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?", (now, job_id)
        )
        _set_run_state(connection, row[1], json_load(row[2]), "cancelled", now)
    return {"id": job_id, "state": "cancelled"}


def retry(job_id: str) -> dict:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        old = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not old:
            raise KeyError(job_id)
        existing = connection.execute("SELECT id,payload_json,state FROM jobs WHERE retry_of=?", (job_id,)).fetchone()
        if existing:
            return {"job_id": existing[0], "status": existing[2], **json_load(existing[1])}
        if old["state"] not in {"failed", "cancelled", "partial"}:
            raise ValueError("只能重试失败、已取消或部分完成的任务")
        if old["kind"] not in RUN_TABLES:
            raise ValueError("不支持重试此任务类型")
        payload = json_load(old["payload_json"])
        new_job, new_run, now = str(uuid4()), str(uuid4()), utc_now()
        if old["kind"] == "screening":
            row = connection.execute("SELECT * FROM screening_runs WHERE id=?", (payload["run_id"],)).fetchone()
            if not row:
                raise ValueError("原筛选运行已不存在")
            connection.execute(
                "INSERT INTO screening_runs(id,strategy_id,strategy_version,as_of,mode,status,result_json,created_at,context_json) VALUES(?,?,?,?,?,'queued','{}',?,?)",
                (new_run, row["strategy_id"], row["strategy_version"], row["as_of"], row["mode"], now, row["context_json"]),
            )
            payload["run_id"] = new_run
        else:
            row = connection.execute("SELECT * FROM report_evaluation_runs WHERE id=?", (payload["evaluation_run_id"],)).fetchone()
            if not row:
                raise ValueError("原研报评估已不存在")
            connection.execute(
                "INSERT INTO report_evaluation_runs(id,filter_id,filter_version,as_of,lookback_start,model,prompt_version,status,coverage_json,result_json,job_id,created_at) VALUES(?,?,?,?,?,?,?,'queued','{}','{}',?,?)",
                (new_run, row["filter_id"], row["filter_version"], row["as_of"], row["lookback_start"], row["model"], row["prompt_version"], new_job, now),
            )
            payload["evaluation_run_id"] = new_run
        connection.execute(
            "INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at,retry_of,required_protocol) VALUES(?,?,?,'queued','等待重试',?,?,?,?)",
            (new_job, old["kind"], json_dump(payload), now, now, job_id, "condition-decisions-v1" if old["kind"] == "screening" else old["required_protocol"]),
        )
        return {"job_id": new_job, "status": "queued", **payload}
