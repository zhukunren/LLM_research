CREATE TABLE research_assistants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
    description TEXT NOT NULL CHECK(length(description) <= 240),
    instructions TEXT NOT NULL CHECK(length(trim(instructions)) BETWEEN 1 AND 16000),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    create_request_id TEXT UNIQUE,
    create_request_hash TEXT
);

ALTER TABLE conversations ADD COLUMN assistant_snapshot_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN assistant_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_turns ADD COLUMN assistant_snapshot_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE conversation_turns ADD COLUMN assistant_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_turns ADD COLUMN requested_assistant_revision INTEGER;

CREATE TRIGGER conversation_turn_assistant_immutable
BEFORE UPDATE OF assistant_snapshot_json,assistant_revision,requested_assistant_revision ON conversation_turns
BEGIN
    SELECT RAISE(ABORT, 'Turn assistant snapshots are immutable');
END;
