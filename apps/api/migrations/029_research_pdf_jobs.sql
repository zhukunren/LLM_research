CREATE TABLE research_pdf_exports (
    id TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL CHECK(owner_type IN ('conversation','project')),
    owner_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('turn','note','file','scan','discovery')),
    source_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL DEFAULT 0,
    source_fingerprint TEXT NOT NULL,
    template_version TEXT NOT NULL,
    conversation_id TEXT REFERENCES conversations(id),
    project_id TEXT REFERENCES research_projects(id),
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    name TEXT NOT NULL,
    snapshot_json TEXT NOT NULL DEFAULT '{}',
    item_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner_type,owner_id,source_kind,source_id,source_revision,source_fingerprint,template_version)
);
CREATE INDEX research_pdf_exports_owner ON research_pdf_exports(owner_type,owner_id,created_at DESC);
CREATE INDEX research_pdf_exports_note ON research_pdf_exports(project_id,source_id,source_revision);
CREATE TRIGGER research_pdf_source_immutable BEFORE UPDATE OF
    owner_type,owner_id,source_kind,source_id,source_revision,source_fingerprint,template_version,snapshot_json
ON research_pdf_exports BEGIN
    SELECT RAISE(ABORT, 'Research PDF source snapshots are immutable');
END;
