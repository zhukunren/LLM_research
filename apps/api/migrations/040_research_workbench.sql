CREATE TABLE research_matrices (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES research_projects(id),
    name TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(project_id,request_id)
);
CREATE TABLE research_matrix_runs (
    id TEXT PRIMARY KEY,
    matrix_id TEXT NOT NULL REFERENCES research_matrices(id),
    job_id TEXT UNIQUE REFERENCES jobs(id),
    as_of TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('manual','assisted')),
    status TEXT NOT NULL,
    inputs_json TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE(matrix_id,request_id)
);
CREATE INDEX research_matrix_runs_history ON research_matrix_runs(matrix_id,created_at DESC);
CREATE TRIGGER jobs_require_matrix_worker
BEFORE UPDATE OF state,lease_owner,required_protocol ON jobs
WHEN NEW.state='running' AND NEW.required_protocol='research-matrix-v1'
 AND (NEW.lease_owner IS NULL OR NEW.lease_owner NOT LIKE 'research-matrix-v1:%')
BEGIN SELECT RAISE(ABORT,'This task requires the research matrix worker'); END;
CREATE TABLE research_matrix_cell_reviews (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES research_matrix_runs(id),
    stock_code TEXT NOT NULL,
    question_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    request_id TEXT NOT NULL,
    reviewer_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id,stock_code,question_id,revision),
    UNIQUE(run_id,request_id)
);
CREATE TRIGGER research_matrix_reviews_immutable BEFORE UPDATE ON research_matrix_cell_reviews
BEGIN SELECT RAISE(ABORT,'Matrix review versions are immutable'); END;
CREATE TABLE research_tracking_checks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES research_projects(id),
    stock_code TEXT NOT NULL,
    as_of TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    changes_json TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(project_id,stock_code,request_id)
);
CREATE INDEX research_tracking_company ON research_tracking_checks(project_id,stock_code,created_at DESC);
CREATE TRIGGER research_tracking_checks_immutable BEFORE UPDATE ON research_tracking_checks
BEGIN SELECT RAISE(ABORT,'Research tracking snapshots are immutable'); END;
CREATE TABLE research_change_reviews (
    id TEXT PRIMARY KEY,
    check_id TEXT NOT NULL REFERENCES research_tracking_checks(id),
    change_key TEXT NOT NULL,
    comment TEXT NOT NULL,
    reviewer_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(check_id,change_key)
);
