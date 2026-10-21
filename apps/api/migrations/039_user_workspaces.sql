-- A personal workspace owns all of its business records. Identity and sessions
-- live in the separately controlled identity database; no business query uses it.
CREATE TABLE workspace_owner (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    tenant_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL
);
CREATE TRIGGER workspace_owner_no_update BEFORE UPDATE ON workspace_owner
BEGIN SELECT RAISE(ABORT, 'Workspace owner is immutable'); END;
CREATE TRIGGER workspace_owner_no_delete BEFORE DELETE ON workspace_owner
BEGIN SELECT RAISE(ABORT, 'Workspace owner is immutable'); END;
ALTER TABLE jobs ADD COLUMN authorization_json TEXT NOT NULL DEFAULT '{}';
-- Authorization snapshots must not revalidate the leases of historical jobs.
-- Keep protocol enforcement on every update that can acquire/change a lease.
DROP TRIGGER jobs_require_compatible_worker;
CREATE TRIGGER jobs_require_compatible_worker
BEFORE UPDATE OF state, lease_owner, required_protocol ON jobs
WHEN NEW.state='running' AND NEW.required_protocol='condition-decisions-v1'
 AND (NEW.lease_owner IS NULL OR NEW.lease_owner NOT LIKE 'condition-decisions-v1:%')
BEGIN SELECT RAISE(ABORT, 'This task requires the current condition execution worker'); END;
DROP TRIGGER jobs_require_screening_task_worker;
CREATE TRIGGER jobs_require_screening_task_worker
BEFORE UPDATE OF state, lease_owner, required_protocol ON jobs
WHEN NEW.state='running' AND NEW.required_protocol='screening-task-v1'
 AND (NEW.lease_owner IS NULL OR NEW.lease_owner NOT LIKE 'screening-task-v1:%')
BEGIN SELECT RAISE(ABORT, 'This task requires the conversation screening worker'); END;
DROP TRIGGER jobs_require_research_scan_worker;
CREATE TRIGGER jobs_require_research_scan_worker
BEFORE UPDATE OF state, lease_owner, required_protocol ON jobs
WHEN NEW.state='running' AND NEW.required_protocol='research-scan-v1'
 AND (NEW.lease_owner IS NULL OR NEW.lease_owner NOT LIKE 'research-scan-v1:%')
BEGIN SELECT RAISE(ABORT, 'This task requires the research scan worker'); END;
DROP TRIGGER jobs_require_research_turn_worker;
CREATE TRIGGER jobs_require_research_turn_worker
BEFORE UPDATE OF state, lease_owner, required_protocol ON jobs
WHEN NEW.state='running' AND NEW.required_protocol='research-turn-v1'
 AND (NEW.lease_owner IS NULL OR NEW.lease_owner NOT LIKE 'research-turn-v1:%')
BEGIN SELECT RAISE(ABORT, 'This task requires the background research turn worker'); END;
CREATE TRIGGER jobs_authorization AFTER INSERT ON jobs
BEGIN UPDATE jobs SET authorization_json=llmr_actor_json() WHERE id=NEW.id; END;
UPDATE jobs SET authorization_json=llmr_actor_json() WHERE authorization_json='{}';
