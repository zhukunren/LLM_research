CREATE TABLE codex_threads (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL UNIQUE,
    model TEXT NOT NULL,
    runtime_version TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE codex_turn_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    app_turn_id TEXT NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
    codex_thread_id TEXT NOT NULL,
    codex_turn_id TEXT,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    method TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (app_turn_id, sequence)
);

CREATE INDEX codex_turn_events_cursor
    ON codex_turn_events(conversation_id, app_turn_id, sequence);

CREATE TRIGGER codex_turn_events_immutable
BEFORE UPDATE ON codex_turn_events
BEGIN
    SELECT RAISE(ABORT, 'Codex turn events are immutable');
END;
