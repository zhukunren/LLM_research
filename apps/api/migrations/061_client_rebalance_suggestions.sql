CREATE TABLE client_rebalance_suggestions (
    request_id TEXT PRIMARY KEY,
    stock_code TEXT NOT NULL,
    stock_name TEXT NOT NULL,
    direction TEXT NOT NULL,
    cutoff TEXT NOT NULL,
    reports_json TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    turn_id TEXT NOT NULL UNIQUE REFERENCES conversation_turns(id)
);
