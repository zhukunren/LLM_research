CREATE TABLE dynamic_indicator_trials (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    trial_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX dynamic_indicator_trials_conversation ON dynamic_indicator_trials(conversation_id,created_at DESC);
CREATE TABLE dynamic_indicator_versions (
    indicator_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version>=1),
    name TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    definition_hash TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    trial_id TEXT NOT NULL REFERENCES dynamic_indicator_trials(id),
    validation_json TEXT NOT NULL,
    source_context_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(indicator_id,version)
);
CREATE TABLE dynamic_indicator_save_requests (
    request_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TRIGGER dynamic_indicator_versions_no_update BEFORE UPDATE ON dynamic_indicator_versions
BEGIN SELECT RAISE(ABORT, 'Indicator versions are immutable'); END;
CREATE TRIGGER dynamic_indicator_versions_no_delete BEFORE DELETE ON dynamic_indicator_versions
BEGIN SELECT RAISE(ABORT, 'Indicator versions are immutable'); END;
CREATE TRIGGER dynamic_indicator_trials_no_update BEFORE UPDATE ON dynamic_indicator_trials
BEGIN SELECT RAISE(ABORT, 'Indicator trials are immutable'); END;
CREATE TRIGGER dynamic_indicator_trials_no_delete BEFORE DELETE ON dynamic_indicator_trials
BEGIN SELECT RAISE(ABORT, 'Indicator trials are immutable'); END;
