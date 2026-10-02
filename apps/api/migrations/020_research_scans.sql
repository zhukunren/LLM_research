CREATE TABLE research_scans (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    request_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    as_of TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled')),
    snapshot_json TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE (conversation_id, request_hash)
);

CREATE INDEX research_scans_conversation_order
    ON research_scans(conversation_id, created_at DESC, id DESC);

CREATE TABLE research_scan_decisions (
    scan_id TEXT NOT NULL REFERENCES research_scans(id) ON DELETE CASCADE,
    stock_code TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('true','false','unknown')),
    evaluation_status TEXT NOT NULL CHECK (evaluation_status IN ('completed','failed','not_evaluated')),
    reason_code TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    PRIMARY KEY (scan_id, stock_code)
);

CREATE INDEX research_scan_decisions_state
    ON research_scan_decisions(scan_id, state, stock_code);

CREATE TRIGGER research_scan_snapshot_immutable
BEFORE UPDATE OF snapshot_json ON research_scans
BEGIN
    SELECT RAISE(ABORT, 'Research scan snapshots are immutable');
END;

CREATE TRIGGER research_scan_result_immutable
BEFORE UPDATE OF result_json ON research_scans
WHEN OLD.status IN ('succeeded','partial','cancelled','failed')
BEGIN
    SELECT RAISE(ABORT, 'Completed research scan results are immutable');
END;

CREATE TRIGGER research_scan_job_state_mirror
AFTER UPDATE OF state ON jobs
WHEN NEW.kind='research_scan' AND NEW.state IN ('queued','running','succeeded','partial','failed','cancelled')
BEGIN
    UPDATE research_scans
       SET status=NEW.state,
           finished_at=CASE WHEN NEW.state IN ('queued','running') THEN NULL ELSE NEW.updated_at END
     WHERE job_id=NEW.id;
END;

CREATE TRIGGER research_scan_decisions_insert_while_running
BEFORE INSERT ON research_scan_decisions
WHEN (SELECT status FROM research_scans WHERE id=NEW.scan_id) != 'running'
BEGIN
    SELECT RAISE(ABORT, 'Research scan decisions can only be committed by a running worker');
END;

CREATE TRIGGER research_scan_decisions_immutable
BEFORE UPDATE ON research_scan_decisions
BEGIN
    SELECT RAISE(ABORT, 'Research scan decisions are immutable');
END;

CREATE TRIGGER jobs_require_research_scan_worker
BEFORE UPDATE ON jobs
WHEN NEW.state='running' AND NEW.required_protocol='research-scan-v1'
 AND (NEW.lease_owner IS NULL OR NEW.lease_owner NOT LIKE 'research-scan-v1:%')
BEGIN
    SELECT RAISE(ABORT, 'This task requires the research scan worker');
END;

CREATE TABLE research_turn_jobs (
    turn_id TEXT PRIMARY KEY REFERENCES conversation_turns(id),
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    created_at TEXT NOT NULL
);
