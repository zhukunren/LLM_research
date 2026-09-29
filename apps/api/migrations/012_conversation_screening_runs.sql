CREATE TABLE execution_requests (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
    task_revision INTEGER NOT NULL CHECK (task_revision > 0),
    source_message_id TEXT NOT NULL REFERENCES conversation_messages(id),
    idempotency_key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, idempotency_key)
);

CREATE TABLE screening_task_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    task_revision INTEGER NOT NULL CHECK (task_revision > 0),
    execution_request_id TEXT NOT NULL UNIQUE REFERENCES execution_requests(id),
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    as_of TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled')),
    execution_version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE INDEX screening_task_runs_conversation_order
    ON screening_task_runs(conversation_id, created_at DESC, id DESC);

CREATE TRIGGER execution_requests_immutable
BEFORE UPDATE ON execution_requests
BEGIN
    SELECT RAISE(ABORT, 'Execution requests are immutable');
END;

CREATE TABLE screening_task_decisions (
    run_id TEXT NOT NULL REFERENCES screening_task_runs(id),
    stock_code TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('true','false','unknown')),
    evaluation_status TEXT NOT NULL CHECK (evaluation_status IN ('completed','failed','not_evaluated')),
    reason_code TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    PRIMARY KEY (run_id, stock_code)
);

CREATE INDEX screening_task_decisions_state
    ON screening_task_decisions(run_id, state, stock_code);

CREATE TRIGGER screening_task_snapshot_immutable
BEFORE UPDATE OF snapshot_json ON screening_task_runs
WHEN OLD.status IN ('succeeded','partial','cancelled','failed')
BEGIN
    SELECT RAISE(ABORT, 'Completed task run snapshots are immutable');
END;

CREATE TRIGGER screening_task_result_immutable
BEFORE UPDATE OF result_json ON screening_task_runs
WHEN OLD.status IN ('succeeded','partial','cancelled','failed')
BEGIN
    SELECT RAISE(ABORT, 'Completed task run results are immutable');
END;

CREATE TRIGGER screening_task_job_state_mirror
AFTER UPDATE OF state ON jobs
WHEN NEW.kind='screening_task' AND NEW.state IN ('queued','running','succeeded','partial','failed','cancelled')
BEGIN
    UPDATE screening_task_runs
       SET status=NEW.state,
           finished_at=CASE WHEN NEW.state IN ('queued','running') THEN NULL ELSE NEW.updated_at END
     WHERE job_id=NEW.id;
END;

CREATE TRIGGER screening_task_decisions_insert_while_running
BEFORE INSERT ON screening_task_decisions
WHEN (SELECT status FROM screening_task_runs WHERE id=NEW.run_id) != 'running'
BEGIN
    SELECT RAISE(ABORT, 'Task decisions can only be committed by a running worker');
END;

CREATE TRIGGER screening_task_decisions_immutable
BEFORE UPDATE ON screening_task_decisions
BEGIN
    SELECT RAISE(ABORT, 'Task decisions are immutable');
END;

CREATE TRIGGER jobs_require_screening_task_worker
BEFORE UPDATE ON jobs
WHEN NEW.state='running' AND NEW.required_protocol='screening-task-v1'
 AND (NEW.lease_owner IS NULL OR NEW.lease_owner NOT LIKE 'screening-task-v1:%')
BEGIN
    SELECT RAISE(ABORT, 'This task requires the conversation screening worker');
END;
