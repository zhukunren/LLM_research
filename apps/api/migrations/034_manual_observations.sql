CREATE TABLE manual_observation_candidates (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    request_json TEXT NOT NULL,
    stock_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'watching' CHECK(status IN ('watching','priority','ended')),
    note TEXT NOT NULL DEFAULT '',
    verification TEXT NOT NULL DEFAULT '',
    invalidation TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE observation_quick_requests (
    request_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE VIEW observation_candidate_index AS
SELECT id,request_id,request_json,conversation_id,source_message_id,source_text,source_message_created_at,
       source_refs_json,project_id,source_scope_json,source_scope_revision,source_scope_status,source_as_of,
       stock_code,status,note,verification,invalidation,revision,created_at,updated_at,'research' origin_kind,rowid sort_order
FROM research_observation_candidates
UNION ALL
SELECT id,request_id,request_json,NULL,NULL,'手动加入观察池',created_at,'[]',NULL,NULL,NULL,'unknown',NULL,
       stock_code,status,note,verification,invalidation,revision,created_at,updated_at,'manual' origin_kind,rowid sort_order
FROM manual_observation_candidates;
