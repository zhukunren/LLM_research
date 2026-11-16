CREATE TABLE IF NOT EXISTS client_service_reviews (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, card_id TEXT NOT NULL REFERENCES client_service_cards(id),
 card_revision INTEGER NOT NULL, image_hash TEXT NOT NULL, conversation_id TEXT NOT NULL,
 turn_id TEXT, state TEXT NOT NULL, message TEXT NOT NULL, result_json TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS client_service_reviews_card ON client_service_reviews(card_id,created_at);
