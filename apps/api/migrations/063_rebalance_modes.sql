ALTER TABLE client_rebalance_suggestions ADD COLUMN mode TEXT;
ALTER TABLE client_rebalance_suggestions ADD COLUMN service_tier TEXT;
ALTER TABLE client_rebalance_suggestions ADD COLUMN market_json TEXT NOT NULL DEFAULT 'null';
