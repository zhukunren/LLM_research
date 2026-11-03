CREATE TABLE IF NOT EXISTS pattern_search_runs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    selected_key TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS pattern_search_runs_owner_created ON pattern_search_runs(tenant_id,user_id,created_at);
