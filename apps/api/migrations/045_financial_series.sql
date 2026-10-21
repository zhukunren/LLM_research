CREATE TABLE financial_sync_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    request_id TEXT NOT NULL UNIQUE,
    credential_id TEXT NOT NULL,
    input_json TEXT NOT NULL,
    fallback_planned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE financial_sync_parts (
    run_id TEXT NOT NULL REFERENCES financial_sync_runs(id),
    part_key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    parent_key TEXT,
    PRIMARY KEY(run_id,part_key)
);
CREATE TABLE financial_sync_attempts (
    run_id TEXT NOT NULL,
    part_key TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY(run_id,part_key,attempt),
    FOREIGN KEY(run_id,part_key) REFERENCES financial_sync_parts(run_id,part_key)
);
CREATE TABLE financial_sync_observations (
    run_id TEXT NOT NULL,
    part_key TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    record_id TEXT NOT NULL REFERENCES financial_source_records(id),
    response_hash TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY(run_id,part_key,attempt,record_id),
    FOREIGN KEY(run_id,part_key,attempt) REFERENCES financial_sync_attempts(run_id,part_key,attempt)
);
CREATE TABLE financial_facts (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES financial_source_records(id),
    metric_code TEXT NOT NULL,
    stock_code TEXT NOT NULL,
    report_period TEXT NOT NULL,
    family TEXT NOT NULL,
    report_type TEXT NOT NULL,
    scope TEXT NOT NULL,
    company_type TEXT NOT NULL,
    value_decimal TEXT,
    unit TEXT NOT NULL,
    currency TEXT,
    temporal TEXT NOT NULL,
    status TEXT NOT NULL,
    fact_json TEXT NOT NULL,
    normalization_version TEXT NOT NULL,
    UNIQUE(record_id,metric_code,normalization_version)
);
CREATE INDEX financial_fact_series ON financial_facts(stock_code,report_period,metric_code);
CREATE TABLE financial_calculations (
    id TEXT PRIMARY KEY,
    formula_version TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TRIGGER financial_facts_immutable BEFORE UPDATE ON financial_facts
BEGIN SELECT RAISE(ABORT,'Financial facts are immutable'); END;
CREATE TRIGGER financial_facts_no_delete BEFORE DELETE ON financial_facts
BEGIN SELECT RAISE(ABORT,'Financial facts are immutable'); END;
CREATE TRIGGER financial_sync_attempts_immutable BEFORE UPDATE ON financial_sync_attempts
BEGIN SELECT RAISE(ABORT,'Financial acquisition evidence is immutable'); END;
CREATE TRIGGER financial_calculations_immutable BEFORE UPDATE ON financial_calculations
BEGIN SELECT RAISE(ABORT,'Financial calculations are immutable'); END;
CREATE TRIGGER financial_calculations_no_delete BEFORE DELETE ON financial_calculations
BEGIN SELECT RAISE(ABORT,'Financial calculations are immutable'); END;
