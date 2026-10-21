CREATE TABLE intelligence_advisor_context (
    run_id TEXT PRIMARY KEY REFERENCES intelligence_runs(id),
    context_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TRIGGER intelligence_advisor_context_immutable BEFORE UPDATE ON intelligence_advisor_context
BEGIN SELECT RAISE(ABORT,'Adviser task inputs and market snapshots are immutable'); END;
