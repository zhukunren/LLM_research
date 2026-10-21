CREATE TABLE intelligence_source_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES intelligence_runs(id),
    url TEXT NOT NULL,
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    source_id TEXT REFERENCES intelligence_sources(id),
    error TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(run_id,url)
);
CREATE TRIGGER jobs_require_intelligence_source_worker
BEFORE UPDATE OF state,lease_owner,required_protocol ON jobs
WHEN NEW.state='running' AND NEW.required_protocol='intelligence-source-v1'
 AND (NEW.lease_owner IS NULL OR NEW.lease_owner NOT LIKE 'intelligence-source-v1:%')
BEGIN SELECT RAISE(ABORT,'This task requires the intelligence source worker'); END;
