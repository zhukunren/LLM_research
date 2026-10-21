CREATE TABLE observation_entry_preferences (
    entry_key TEXT PRIMARY KEY,
    hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
    sort_order INTEGER,
    updated_at TEXT NOT NULL
);

CREATE INDEX observation_entry_preferences_order
    ON observation_entry_preferences(hidden,sort_order);
