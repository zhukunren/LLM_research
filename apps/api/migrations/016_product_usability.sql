CREATE TABLE security_catalog (
    stock_code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pinyin TEXT NOT NULL DEFAULT '',
    initials TEXT NOT NULL DEFAULT '',
    market TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE maintenance_results (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id),
    result_json TEXT NOT NULL
);
