CREATE TABLE intelligence_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    cutoff_at TEXT NOT NULL,
    window_start TEXT NOT NULL,
    version INTEGER NOT NULL,
    conversation_id TEXT UNIQUE REFERENCES conversations(id) ON DELETE SET NULL,
    turn_id TEXT UNIQUE REFERENCES conversation_turns(id) ON DELETE SET NULL,
    previous_id TEXT REFERENCES intelligence_runs(id),
    retry_of TEXT REFERENCES intelligence_runs(id),
    result_json TEXT,
    result_status TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE(kind,scope_hash,version)
);
CREATE INDEX intelligence_history ON intelligence_runs(kind,created_at DESC);
CREATE TABLE intelligence_sources (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES intelligence_runs(id),
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    publisher_date TEXT,
    UNIQUE(run_id,url)
);
CREATE TABLE intelligence_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES intelligence_runs(id),
    stage TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX intelligence_activity_run ON intelligence_activity(run_id,id);
CREATE TABLE intelligence_preferences (
    kind TEXT PRIMARY KEY,
    scope_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TRIGGER intelligence_results_immutable
BEFORE UPDATE OF result_json,result_status ON intelligence_runs
WHEN OLD.result_json IS NOT NULL
BEGIN SELECT RAISE(ABORT,'Intelligence result versions are immutable'); END;
CREATE TRIGGER intelligence_sources_immutable BEFORE UPDATE ON intelligence_sources
BEGIN SELECT RAISE(ABORT,'Intelligence evidence snapshots are immutable'); END;
