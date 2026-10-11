ALTER TABLE conversations ADD COLUMN title TEXT;
ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1));
ALTER TABLE conversations ADD COLUMN deleted_at TEXT;

CREATE INDEX conversations_history ON conversations(workflow_type,state,pinned DESC,updated_at DESC) WHERE deleted_at IS NULL;
