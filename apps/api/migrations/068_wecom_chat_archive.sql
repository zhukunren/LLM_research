ALTER TABLE client_service_robots ADD COLUMN archive_room_id TEXT;
CREATE UNIQUE INDEX client_service_robots_archive_room
    ON client_service_robots(archive_room_id) WHERE archived = 0 AND archive_room_id IS NOT NULL;

CREATE TABLE client_service_wecom_sync (
    scope TEXT PRIMARY KEY,
    cursor TEXT NOT NULL DEFAULT '0',
    attempted_at INTEGER NOT NULL,
    synced_at INTEGER,
    error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE client_service_wecom_messages (
    scope TEXT NOT NULL,
    message_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (scope, message_id)
);

CREATE INDEX client_service_wecom_messages_room
    ON client_service_wecom_messages(scope, room_id, sent_at DESC);
