CREATE TABLE saved_screening_tasks (
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL DEFAULT 'local',
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    task_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, version)
);
CREATE INDEX saved_screening_tasks_latest ON saved_screening_tasks(id, version DESC);
