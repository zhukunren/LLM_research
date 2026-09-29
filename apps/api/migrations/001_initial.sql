CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS filters (
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL DEFAULT 'local',
    library TEXT NOT NULL CHECK (library IN ('news', 'technical', 'report')),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL,
    dsl_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS filters_library_created ON filters(library, created_at DESC);

CREATE TABLE IF NOT EXISTS strategies (
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL DEFAULT 'local',
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    strategy_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS patterns (
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL DEFAULT 'local',
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    pattern_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    title TEXT NOT NULL,
    publication_date TEXT,
    market TEXT,
    stock_code TEXT,
    pages INTEGER NOT NULL,
    extracted_chars INTEGER NOT NULL,
    parse_status TEXT NOT NULL,
    source_path TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_pages (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (document_id, page_number)
);
CREATE VIRTUAL TABLE IF NOT EXISTS document_pages_fts USING fts5(
    document_id UNINDEXED,
    page_number UNINDEXED,
    text,
    tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS watchlists (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL DEFAULT 'local',
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist_items (
    watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
    stock_code TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL,
    PRIMARY KEY (watchlist_id, stock_code)
);

CREATE TABLE IF NOT EXISTS screening_runs (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    strategy_version INTEGER NOT NULL,
    as_of TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('formal', 'exploratory')),
    status TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    version INTEGER,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
