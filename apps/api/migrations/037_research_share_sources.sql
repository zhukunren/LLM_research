CREATE TABLE research_message_evidence (
    message_id TEXT PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE,
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE research_conversation_shares (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    snapshot_json TEXT NOT NULL,
    public_url TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published','revoked')),
    created_at TEXT NOT NULL,
    UNIQUE(conversation_id,request_id)
);
