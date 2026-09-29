CREATE TABLE condition_drafts (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    saved_json TEXT
);

ALTER TABLE screening_runs ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE screening_decisions (
    run_id TEXT NOT NULL REFERENCES screening_runs(id),
    stock_code TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('true','false','unknown')),
    score REAL NOT NULL,
    detail_json TEXT NOT NULL,
    PRIMARY KEY (run_id,stock_code)
);
CREATE INDEX screening_decisions_state ON screening_decisions(run_id,state,score DESC,stock_code);
