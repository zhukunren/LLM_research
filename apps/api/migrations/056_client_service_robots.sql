CREATE TABLE IF NOT EXISTS client_service_robots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    webhook_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS client_service_deliveries (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    robot_id TEXT NOT NULL REFERENCES client_service_robots(id),
    robot_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    card_id TEXT,
    state TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS client_service_deliveries_robot ON client_service_deliveries(robot_id,created_at);
