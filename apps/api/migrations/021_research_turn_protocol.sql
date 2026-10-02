CREATE TRIGGER jobs_require_research_turn_worker
BEFORE UPDATE ON jobs
WHEN NEW.state='running' AND NEW.required_protocol='research-turn-v1'
 AND (NEW.lease_owner IS NULL OR NEW.lease_owner NOT LIKE 'research-turn-v1:%')
BEGIN
    SELECT RAISE(ABORT, 'This task requires the background research turn worker');
END;
