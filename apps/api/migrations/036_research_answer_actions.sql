ALTER TABLE conversation_messages ADD COLUMN regeneration_of TEXT;
ALTER TABLE conversation_messages ADD COLUMN file_conversation_id TEXT;

CREATE TABLE research_answer_actions (
    source_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('branch','regenerate')),
    source_message_id TEXT NOT NULL,
    target_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    target_turn_id TEXT REFERENCES conversation_turns(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(source_conversation_id,request_id)
);
