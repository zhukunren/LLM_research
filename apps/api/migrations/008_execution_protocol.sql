ALTER TABLE jobs ADD COLUMN required_protocol TEXT NOT NULL DEFAULT 'legacy';

-- Enforce compatibility in SQLite itself, including against already-running old code.
CREATE TRIGGER jobs_require_compatible_worker
BEFORE UPDATE ON jobs
WHEN NEW.state='running' AND NEW.required_protocol='condition-decisions-v1'
 AND (NEW.lease_owner IS NULL OR NEW.lease_owner NOT LIKE 'condition-decisions-v1:%')
BEGIN
    SELECT RAISE(ABORT, 'This task requires the current condition execution worker');
END;

CREATE TRIGGER screening_final_snapshot_is_immutable
BEFORE UPDATE ON screening_runs
WHEN OLD.status IN ('succeeded','partial','cancelled','failed')
 AND json_extract(OLD.result_json,'$.trace_version')='condition-decisions-v1'
BEGIN
    SELECT RAISE(ABORT, 'Completed screening snapshots are immutable; create a new run');
END;
