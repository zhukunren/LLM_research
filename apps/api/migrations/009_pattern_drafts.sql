CREATE TABLE pattern_drafts (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    draft_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
