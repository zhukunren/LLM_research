-- Publication metadata is added idempotently by init_db for workspaces that
-- initialized the first intelligence schema before this optional field existed.
CREATE INDEX IF NOT EXISTS intelligence_sources_run ON intelligence_sources(run_id);
