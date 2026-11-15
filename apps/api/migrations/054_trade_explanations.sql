CREATE TABLE IF NOT EXISTS trade_explanations (
    request_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trade_explanations_turn ON trade_explanations(conversation_id,turn_id);
