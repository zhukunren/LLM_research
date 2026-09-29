CREATE TABLE saved_screening_task_requests (
    request_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    asset_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (asset_id, asset_version) REFERENCES saved_screening_tasks(id, version)
);
