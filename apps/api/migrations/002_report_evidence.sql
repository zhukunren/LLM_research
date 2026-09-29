ALTER TABLE documents ADD COLUMN stock_code_status TEXT NOT NULL DEFAULT 'filename_candidate';
ALTER TABLE documents ADD COLUMN stock_code_confirmed_at TEXT;

CREATE TABLE IF NOT EXISTS report_assessment_cache (
    id TEXT PRIMARY KEY,
    filter_id TEXT NOT NULL,
    filter_version INTEGER NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(id),
    document_sha256 TEXT NOT NULL,
    rubric_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    status TEXT NOT NULL,
    assessment_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(filter_id, filter_version, document_id, document_sha256, rubric_hash, model, prompt_version)
);

CREATE TABLE IF NOT EXISTS report_evaluation_runs (
    id TEXT PRIMARY KEY,
    filter_id TEXT NOT NULL,
    filter_version INTEGER NOT NULL,
    as_of TEXT NOT NULL,
    lookback_start TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    status TEXT NOT NULL,
    coverage_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    job_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS report_evaluation_lookup
    ON report_evaluation_runs(filter_id, filter_version, as_of, created_at DESC);
