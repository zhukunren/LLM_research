ALTER TABLE news_records ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
    CHECK(origin IN ('manual', 'tushare'));
ALTER TABLE news_import_requests ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
    CHECK(origin IN ('manual', 'tushare'));

UPDATE news_import_requests SET origin='tushare'
WHERE request_id GLOB 'tushare-news-*-????????-????????-????????????????????????'
    AND json_valid(result_json);

-- A manual import of the same record also protects it on existing installations.
WITH imported AS (
    SELECT r.origin, json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END, '$.id') AS id
    FROM news_import_requests r,
         json_each(CASE WHEN json_valid(r.result_json) THEN r.result_json ELSE '{}' END, '$.items') item
),
automatic_only AS (
    SELECT id FROM imported WHERE id IS NOT NULL GROUP BY id
    HAVING MIN(origin)='tushare' AND MAX(origin)='tushare'
)
UPDATE news_records SET origin='tushare'
WHERE id IN (SELECT id FROM automatic_only)
    AND source LIKE 'Tushare news/%' AND event_key LIKE 'tushare-news:%';

CREATE INDEX news_records_retention_time ON news_records(COALESCE(published_at, available_at, created_at));

CREATE TABLE news_retention_settings (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
INSERT INTO news_retention_settings(singleton, enabled) VALUES(1,0);

CREATE TABLE news_retention_runs (
    run_day TEXT PRIMARY KEY,
    cutoff_day TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    deleted_count INTEGER NOT NULL DEFAULT 0,
    receipt_count INTEGER NOT NULL DEFAULT 0,
    protected_count INTEGER NOT NULL DEFAULT 0
);
