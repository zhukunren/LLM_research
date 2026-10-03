CREATE TABLE research_claims (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    note_revision INTEGER NOT NULL,
    stock_code TEXT NOT NULL,
    statement TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('fact','forecast','inference')),
    as_of TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(note_id,note_revision) REFERENCES research_note_versions(note_id,revision),
    UNIQUE(note_id,request_id)
);
CREATE INDEX research_claims_note ON research_claims(note_id,created_at DESC);
CREATE TRIGGER research_claims_immutable
BEFORE UPDATE ON research_claims
BEGIN
    SELECT RAISE(ABORT, 'Research claims and original evidence are immutable');
END;
