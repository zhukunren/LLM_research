from __future__ import annotations

import json

from apps.api.app import db, jobs


def _job(connection, *, job_id="recovery-job", state="running", attempts=1, kind="screening_task"):
    now = db.utc_now()
    connection.execute("""INSERT INTO jobs(id,kind,payload_json,state,attempts,progress,message,created_at,updated_at,
        required_protocol,lease_owner,lease_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
        (job_id, kind, json.dumps({"run_id": "missing-run"}), state, attempts, 0, "", now, now,
         "screening-task-v1", "worker:old" if state == "running" else None, "2000-01-01" if state == "running" else None))


def test_expired_screening_task_is_requeued_then_failed_after_three_attempts(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "recovery.db")
    db.init_db()
    with db.connect() as connection:
        _job(connection, attempts=1)
    lease = jobs.claim("recovery-job")
    assert lease is not None
    assert lease.owner.startswith("screening-task-v1:")
    with db.connect() as connection:
        connection.execute("UPDATE jobs SET lease_expires_at='2000-01-01' WHERE id='recovery-job'")
    assert jobs.claim("recovery-job") is not None
    with db.connect() as connection:
        connection.execute("UPDATE jobs SET lease_expires_at='2000-01-01' WHERE id='recovery-job'")
    assert jobs.claim("recovery-job") is None
    with db.connect() as connection:
        row = connection.execute("SELECT state,message FROM jobs WHERE id='recovery-job'").fetchone()
    assert row["state"] == "failed"
    assert "多次中断" in row["message"]


def test_cancelled_job_cannot_be_claimed_after_worker_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "cancel-recovery.db")
    db.init_db()
    with db.connect() as connection:
        _job(connection, job_id="cancelled", state="queued", attempts=0)
    assert jobs.cancel("cancelled")["state"] == "cancelled"
    assert jobs.claim("cancelled") is None
