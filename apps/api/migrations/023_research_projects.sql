CREATE TABLE research_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
    objective TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    request_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE research_project_companies (
    project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
    stock_code TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id,stock_code)
);

ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES research_projects(id);
CREATE INDEX conversations_project ON conversations(project_id,updated_at DESC);

CREATE TABLE research_notes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
    body TEXT NOT NULL DEFAULT '',
    stock_code TEXT,
    validation_plan TEXT NOT NULL DEFAULT '',
    invalidation_condition TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'watching' CHECK(status IN ('watching','supported','challenged','invalidated')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    source_conversation_id TEXT REFERENCES conversations(id),
    source_message_id TEXT REFERENCES conversation_messages(id),
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id,request_id),
    UNIQUE(project_id,source_message_id)
);
CREATE INDEX research_notes_project ON research_notes(project_id,updated_at DESC);

CREATE TABLE research_note_versions (
    note_id TEXT NOT NULL REFERENCES research_notes(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(note_id,revision)
);
CREATE TRIGGER research_note_versions_immutable
BEFORE UPDATE ON research_note_versions
BEGIN
    SELECT RAISE(ABORT, 'Research note versions are immutable');
END;
