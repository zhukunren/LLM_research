CREATE TABLE IF NOT EXISTS client_service_settings (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL,
    config_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS client_service_cards (
    id TEXT PRIMARY KEY,
    service_date TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    cutoff TEXT NOT NULL,
    template_json TEXT NOT NULL,
    content_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    market_json TEXT,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(service_date,slot_id)
);
CREATE TABLE IF NOT EXISTS client_service_requests (
    request_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    card_id TEXT NOT NULL REFERENCES client_service_cards(id),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS client_service_cards_turn ON client_service_cards(conversation_id,turn_id);
CREATE INDEX IF NOT EXISTS client_service_cards_day ON client_service_cards(service_date,created_at);
CREATE TABLE IF NOT EXISTS client_service_turns (
    conversation_id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL
);
