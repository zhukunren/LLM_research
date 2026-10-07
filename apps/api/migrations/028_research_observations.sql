CREATE TABLE research_observation_candidates (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    request_json TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    source_message_id TEXT NOT NULL REFERENCES conversation_messages(id),
    source_text TEXT NOT NULL,
    source_message_created_at TEXT NOT NULL,
    source_refs_json TEXT NOT NULL DEFAULT '[]',
    project_id TEXT REFERENCES research_projects(id),
    source_scope_json TEXT,
    source_scope_revision INTEGER,
    source_scope_status TEXT NOT NULL CHECK(source_scope_status IN ('frozen','unknown')),
    source_as_of TEXT,
    stock_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'watching' CHECK(status IN ('watching','priority','ended')),
    note TEXT NOT NULL DEFAULT '',
    verification TEXT NOT NULL DEFAULT '',
    invalidation TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX research_observation_candidates_updated ON research_observation_candidates(updated_at DESC,id);
CREATE INDEX research_observation_candidates_status ON research_observation_candidates(status,updated_at DESC);
CREATE TRIGGER research_observation_source_immutable
BEFORE UPDATE OF request_id,request_json,conversation_id,source_message_id,source_text,source_message_created_at,
                 source_refs_json,project_id,source_scope_json,source_scope_revision,source_scope_status,
                 source_as_of,stock_code,created_at ON research_observation_candidates
BEGIN
    SELECT RAISE(ABORT,'Research observation source references are immutable');
END;
