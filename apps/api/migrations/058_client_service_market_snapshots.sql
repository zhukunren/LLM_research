CREATE TABLE IF NOT EXISTS client_service_market_snapshots (
 turn_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, cutoff TEXT NOT NULL,
 payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
