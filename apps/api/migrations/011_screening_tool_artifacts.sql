CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
    call_id TEXT NOT NULL CHECK (length(call_id) BETWEEN 1 AND 200),
    tool_name TEXT NOT NULL,
    task_revision INTEGER NOT NULL CHECK (task_revision >= 0),
    as_of TEXT,
    arguments_json TEXT NOT NULL,
    arguments_sha256 TEXT NOT NULL CHECK (length(arguments_sha256)=64),
    state TEXT NOT NULL CHECK (state IN ('running','succeeded','failed')),
    result_json TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE (turn_id, call_id)
);

CREATE INDEX tool_calls_conversation_order ON tool_calls(conversation_id, turn_id, created_at);

CREATE TABLE execution_artifacts (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES conversation_turns(id),
    kind TEXT NOT NULL CHECK (kind IN ('tool_output','condition_program','input_manifest')),
    sha256 TEXT NOT NULL CHECK (length(sha256)=64),
    storage_key TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('application/json','text/plain')),
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, turn_id, kind, sha256)
);

CREATE INDEX execution_artifacts_conversation
    ON execution_artifacts(conversation_id, turn_id, created_at);

CREATE TRIGGER execution_artifacts_immutable
BEFORE UPDATE ON execution_artifacts
BEGIN
    SELECT RAISE(ABORT, 'Execution artifacts are immutable');
END;
