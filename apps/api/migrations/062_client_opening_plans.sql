CREATE TABLE client_opening_plans (
    request_id TEXT PRIMARY KEY,
    plan_date TEXT NOT NULL,
    cutoff TEXT NOT NULL,
    market_json TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    turn_id TEXT NOT NULL UNIQUE REFERENCES conversation_turns(id)
);
