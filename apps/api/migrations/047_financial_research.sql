CREATE TABLE financial_evidence_links (
    id TEXT PRIMARY KEY,
    fact_id TEXT NOT NULL REFERENCES financial_facts(id),
    version_id TEXT NOT NULL REFERENCES disclosure_versions(id),
    metadata_revision INTEGER NOT NULL,
    as_of TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('document_related','value_verified','conflict')),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX financial_evidence_fact ON financial_evidence_links(fact_id,created_at);
CREATE TABLE research_data_evidence (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('financial','disclosure')),
    stock_code TEXT NOT NULL,
    as_of TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX research_data_company ON research_data_evidence(stock_code,as_of);
CREATE TABLE financial_comparisons (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES research_projects(id),
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
ALTER TABLE research_claims ADD COLUMN numeric_evidence_json TEXT NOT NULL DEFAULT '[]';
CREATE TRIGGER financial_evidence_immutable BEFORE UPDATE ON financial_evidence_links
BEGIN SELECT RAISE(ABORT,'Financial evidence is immutable'); END;
CREATE TRIGGER financial_evidence_no_delete BEFORE DELETE ON financial_evidence_links
BEGIN SELECT RAISE(ABORT,'Financial evidence is immutable'); END;
CREATE TRIGGER research_data_immutable BEFORE UPDATE ON research_data_evidence
BEGIN SELECT RAISE(ABORT,'Research evidence is immutable'); END;
CREATE TRIGGER research_data_no_delete BEFORE DELETE ON research_data_evidence
BEGIN SELECT RAISE(ABORT,'Research evidence is immutable'); END;
CREATE TRIGGER financial_comparisons_immutable BEFORE UPDATE ON financial_comparisons
BEGIN SELECT RAISE(ABORT,'Financial comparisons are immutable'); END;
CREATE TRIGGER financial_comparisons_no_delete BEFORE DELETE ON financial_comparisons
BEGIN SELECT RAISE(ABORT,'Financial comparisons are immutable'); END;
