CREATE TABLE research_assistant_launches (
    request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 1 AND 100),
    request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    assistant_id TEXT NOT NULL,
    assistant_revision INTEGER NOT NULL CHECK(assistant_revision >= 1),
    skill_hash TEXT NOT NULL,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
    turn_id TEXT NOT NULL UNIQUE REFERENCES conversation_turns(id),
    as_of_date TEXT NOT NULL,
    started_at TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    launch_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX research_assistant_launches_recent
    ON research_assistant_launches(assistant_id,created_at DESC);
