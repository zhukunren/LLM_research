CREATE TABLE observation_executions (
    request_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    asset_version INTEGER NOT NULL,
    name TEXT NOT NULL,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
    turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
    created_at TEXT NOT NULL
);

CREATE TABLE observation_notes (
    run_id TEXT NOT NULL REFERENCES screening_task_runs(id),
    stock_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'watching' CHECK(status IN ('watching','priority','ended')),
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY(run_id, stock_code),
    FOREIGN KEY(run_id, stock_code) REFERENCES screening_task_decisions(run_id, stock_code)
);
