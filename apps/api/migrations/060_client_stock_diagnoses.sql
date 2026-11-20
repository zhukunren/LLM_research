CREATE TABLE client_stock_diagnoses (
    request_id TEXT PRIMARY KEY,
    stock_code TEXT NOT NULL,
    stock_name TEXT NOT NULL,
    cutoff TEXT NOT NULL,
    market_json TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    turn_id TEXT NOT NULL UNIQUE REFERENCES conversation_turns(id)
);
