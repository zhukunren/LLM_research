ALTER TABLE client_service_cards ADD COLUMN generation_focus TEXT NOT NULL DEFAULT '';
ALTER TABLE client_opening_plans ADD COLUMN generation_focus TEXT NOT NULL DEFAULT '';
ALTER TABLE client_rebalance_suggestions ADD COLUMN generation_focus TEXT NOT NULL DEFAULT '';
ALTER TABLE client_service_reviews ADD COLUMN review_focus_json TEXT NOT NULL DEFAULT '[]';
