CREATE TABLE financial_probe_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    request_id TEXT NOT NULL UNIQUE,
    credential_id TEXT NOT NULL,
    input_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE financial_probe_checks (
    run_id TEXT NOT NULL REFERENCES financial_probe_runs(id),
    sample_key TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    stock_code TEXT NOT NULL,
    result_json TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (run_id,sample_key)
);
CREATE TABLE financial_source_records (
    id TEXT PRIMARY KEY,
    logical_key TEXT NOT NULL,
    schema_hash TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    record_json TEXT NOT NULL,
    first_observed_at TEXT NOT NULL
);
CREATE INDEX financial_record_versions ON financial_source_records(logical_key,schema_hash);
CREATE TABLE financial_source_observations (
    run_id TEXT NOT NULL,
    sample_key TEXT NOT NULL,
    record_id TEXT NOT NULL REFERENCES financial_source_records(id),
    response_hash TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (run_id,sample_key,record_id),
    FOREIGN KEY (run_id,sample_key) REFERENCES financial_probe_checks(run_id,sample_key)
);
CREATE TABLE provider_capabilities (
    credential_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('available','denied','rate_limited','transient_error','unknown')),
    checked_at TEXT NOT NULL,
    evidence_run_id TEXT NOT NULL REFERENCES financial_probe_runs(id),
    evidence_sample_key TEXT NOT NULL,
    PRIMARY KEY (credential_id,endpoint)
);
CREATE TRIGGER financial_records_immutable BEFORE UPDATE ON financial_source_records
BEGIN SELECT RAISE(ABORT,'Financial source versions are immutable'); END;
CREATE TRIGGER financial_records_no_delete BEFORE DELETE ON financial_source_records
BEGIN SELECT RAISE(ABORT,'Financial source versions are immutable'); END;
CREATE TRIGGER financial_checks_immutable BEFORE UPDATE ON financial_probe_checks
BEGIN SELECT RAISE(ABORT,'Financial check evidence is immutable'); END;
CREATE TRIGGER financial_observations_immutable BEFORE UPDATE ON financial_source_observations
BEGIN SELECT RAISE(ABORT,'Financial observations are immutable'); END;
