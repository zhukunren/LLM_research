ALTER TABLE documents ADD COLUMN material_kind TEXT NOT NULL DEFAULT 'report'
    CHECK(material_kind IN ('report','disclosure'));
CREATE TABLE disclosures (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
CREATE TABLE disclosure_versions (
    id TEXT PRIMARY KEY,
    disclosure_id TEXT NOT NULL REFERENCES disclosures(id),
    version INTEGER NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(id),
    previous_version_id TEXT REFERENCES disclosure_versions(id),
    related_version_id TEXT REFERENCES disclosure_versions(id),
    source_kind TEXT NOT NULL,
    source_url TEXT,
    final_url TEXT,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(disclosure_id,version),
    UNIQUE(disclosure_id,sha256)
);
CREATE INDEX disclosure_document_lookup ON disclosure_versions(document_id);
CREATE INDEX disclosure_url_lookup ON disclosure_versions(source_url);
CREATE TABLE disclosure_metadata (
    version_id TEXT NOT NULL REFERENCES disclosure_versions(id),
    revision INTEGER NOT NULL,
    metadata_json TEXT NOT NULL,
    suggestions_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(version_id,revision)
);
CREATE TABLE disclosure_imports (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    filename TEXT NOT NULL,
    sha256 TEXT,
    final_url TEXT,
    stage TEXT NOT NULL,
    version_id TEXT REFERENCES disclosure_versions(id),
    outcome TEXT,
    created_at TEXT NOT NULL
);
CREATE TRIGGER disclosure_versions_immutable BEFORE UPDATE ON disclosure_versions
BEGIN SELECT RAISE(ABORT,'Disclosure file versions are immutable'); END;
CREATE TRIGGER disclosure_versions_no_delete BEFORE DELETE ON disclosure_versions
BEGIN SELECT RAISE(ABORT,'Disclosure file versions are immutable'); END;
CREATE TRIGGER disclosure_metadata_immutable BEFORE UPDATE ON disclosure_metadata
BEGIN SELECT RAISE(ABORT,'Disclosure classification history is immutable'); END;
CREATE TRIGGER disclosure_metadata_no_delete BEFORE DELETE ON disclosure_metadata
BEGIN SELECT RAISE(ABORT,'Disclosure classification history is immutable'); END;
