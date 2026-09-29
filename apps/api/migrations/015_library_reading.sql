ALTER TABLE documents ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE documents ADD COLUMN metadata_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE documents ADD COLUMN metadata_error TEXT;
ALTER TABLE documents ADD COLUMN metadata_job_id TEXT;
CREATE TABLE news_url_imports (
    request_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    result_json TEXT NOT NULL
);
CREATE TABLE pattern_examples (
    cache_key TEXT PRIMARY KEY,
    result_json TEXT NOT NULL
);
