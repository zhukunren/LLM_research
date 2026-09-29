CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    entry_scope TEXT NOT NULL CHECK (entry_scope IN ('technical','news','report','pattern','screening')),
    task_revision INTEGER NOT NULL DEFAULT 0 CHECK (task_revision >= 0),
    active_run_id TEXT,
    pending_execute_message_id TEXT,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX conversations_updated ON conversations(updated_at DESC, id);

CREATE TABLE conversation_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
    content TEXT NOT NULL CHECK (length(content) > 0),
    client_message_id TEXT,
    source_refs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, client_message_id)
);

CREATE INDEX conversation_messages_order ON conversation_messages(conversation_id, created_at, id);

CREATE TABLE conversation_turns (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_message_id TEXT NOT NULL UNIQUE REFERENCES conversation_messages(id),
    base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('awaiting_agent','running','awaiting_user','succeeded','failed','cancelled')),
    response_text TEXT,
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (conversation_id, user_message_id)
);

CREATE INDEX conversation_turns_order ON conversation_turns(conversation_id, created_at DESC);
CREATE UNIQUE INDEX conversation_one_active_turn
    ON conversation_turns(conversation_id)
    WHERE state IN ('awaiting_agent','running');

CREATE TABLE screening_task_revisions (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    source_message_id TEXT NOT NULL REFERENCES conversation_messages(id),
    task_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, revision)
);

CREATE TRIGGER conversation_messages_immutable
BEFORE UPDATE ON conversation_messages
BEGIN
    SELECT RAISE(ABORT, 'Conversation messages are immutable');
END;

CREATE TRIGGER task_revisions_immutable
BEFORE UPDATE ON screening_task_revisions
BEGIN
    SELECT RAISE(ABORT, 'Screening task revisions are immutable');
END;
