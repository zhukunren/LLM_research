CREATE TABLE news_records (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    source TEXT NOT NULL,
    published_at TEXT,
    available_at TEXT,
    stock_codes_json TEXT NOT NULL,
    event_key TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(root_id, version)
);
CREATE INDEX news_records_time ON news_records(available_at);
CREATE INDEX news_records_root ON news_records(root_id, version DESC);
CREATE TABLE news_import_requests (
    request_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL
);
