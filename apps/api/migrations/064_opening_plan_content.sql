CREATE TABLE client_opening_plan_content (
    scope TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    content_json TEXT NOT NULL,
    collection_request_id TEXT REFERENCES client_opening_plans(request_id),
    updated_at TEXT NOT NULL
);
