CREATE TABLE condition_submission_requests (
    scope TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope, request_id)
);
