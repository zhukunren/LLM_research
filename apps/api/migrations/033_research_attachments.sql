CREATE TABLE conversation_creation_requests (
    request_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);

CREATE TABLE research_attachments (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes>0),
    sha256 TEXT NOT NULL,
    preview_name TEXT,
    preview_sha256 TEXT,
    model_image_name TEXT,
    model_image_sha256 TEXT,
    preview_note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(conversation_id, request_id)
);
CREATE INDEX research_attachments_conversation ON research_attachments(conversation_id,created_at);
CREATE TRIGGER research_attachment_immutable BEFORE UPDATE ON research_attachments
BEGIN
    SELECT RAISE(ABORT, 'Research attachment metadata is immutable');
END;

ALTER TABLE conversation_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE conversation_turns ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
CREATE TRIGGER conversation_turn_attachments_immutable BEFORE UPDATE OF attachments_json ON conversation_turns
BEGIN
    SELECT RAISE(ABORT, 'Turn attachment snapshots are immutable');
END;
