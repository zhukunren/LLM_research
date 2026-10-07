ALTER TABLE conversations ADD COLUMN workflow_type TEXT NOT NULL DEFAULT 'research'
    CHECK (workflow_type IN ('research','screening'));
ALTER TABLE conversations ADD COLUMN research_depth TEXT NOT NULL DEFAULT 'standard'
    CHECK (research_depth IN ('standard','deep'));
ALTER TABLE conversations ADD COLUMN workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK (workflow_revision >= 0);
ALTER TABLE conversations ADD COLUMN research_scope_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN research_scope_revision INTEGER NOT NULL DEFAULT 0 CHECK (research_scope_revision >= 0);

UPDATE conversations SET workflow_type=CASE
    WHEN task_revision>0 OR research_mode='screening' THEN 'screening'
    ELSE 'research' END,
    research_depth=CASE WHEN research_mode='advanced' THEN 'deep' ELSE 'standard' END;
UPDATE conversations SET research_mode=CASE
    WHEN workflow_type='screening' THEN 'screening'
    WHEN research_depth='deep' THEN 'advanced' ELSE 'research' END;

ALTER TABLE conversation_turns ADD COLUMN workflow_type TEXT NOT NULL DEFAULT 'research'
    CHECK (workflow_type IN ('research','screening'));
ALTER TABLE conversation_turns ADD COLUMN research_depth TEXT NOT NULL DEFAULT 'standard'
    CHECK (research_depth IN ('standard','deep'));
ALTER TABLE conversation_turns ADD COLUMN workflow_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_turns ADD COLUMN research_scope_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE conversation_turns ADD COLUMN research_scope_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_turns ADD COLUMN requested_research_scope_revision INTEGER;

UPDATE conversation_turns SET
    workflow_type=(SELECT workflow_type FROM conversations WHERE id=conversation_id),
    research_depth=(SELECT research_depth FROM conversations WHERE id=conversation_id);

CREATE TRIGGER conversation_turn_scope_immutable
BEFORE UPDATE OF workflow_type,research_depth,workflow_revision,research_scope_json,research_scope_revision,requested_research_scope_revision ON conversation_turns
BEGIN
    SELECT RAISE(ABORT, 'Turn workflow and research scope snapshots are immutable');
END;

CREATE TABLE screening_draft_sources (
    draft_conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    source_conversation_id TEXT NOT NULL REFERENCES conversations(id),
    source_message_id TEXT NOT NULL REFERENCES conversation_messages(id),
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    instructions TEXT NOT NULL CHECK(length(trim(instructions))>0),
    draft_prompt TEXT NOT NULL,
    source_snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (source_conversation_id,request_id)
);

CREATE TRIGGER screening_draft_source_immutable
BEFORE UPDATE ON screening_draft_sources
BEGIN
    SELECT RAISE(ABORT, 'Research to screening draft provenance is immutable');
END;
