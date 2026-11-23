CREATE TABLE intelligence_rotation_snapshots (
    run_id TEXT PRIMARY KEY REFERENCES intelligence_runs(id),
    snapshot_json TEXT NOT NULL,
    source_id TEXT REFERENCES intelligence_sources(id),
    created_at TEXT NOT NULL
);

CREATE TRIGGER intelligence_rotation_snapshot_immutable BEFORE UPDATE ON intelligence_rotation_snapshots
BEGIN SELECT RAISE(ABORT, 'Closing rotation snapshots are immutable'); END;
