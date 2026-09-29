ALTER TABLE jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN retry_of TEXT REFERENCES jobs(id);
CREATE UNIQUE INDEX jobs_retry_once ON jobs(retry_of) WHERE retry_of IS NOT NULL;
CREATE INDEX jobs_queue_lease ON jobs(state,lease_expires_at,created_at);
