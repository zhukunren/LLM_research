CREATE TABLE investment_monitor_preferences (
    owner_user_id TEXT PRIMARY KEY,
    price_move_threshold REAL NOT NULL DEFAULT 5 CHECK(price_move_threshold > 0 AND price_move_threshold <= 50),
    updated_at TEXT NOT NULL
);
CREATE TABLE investment_monitor_state (
    owner_user_id TEXT NOT NULL,
    stock_code TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY(owner_user_id, stock_code)
);
CREATE TABLE investment_monitor_events (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    stock_code TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK(event_kind IN ('price_move','financial_update','new_disclosure')),
    source_key TEXT NOT NULL,
    event_date TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_url TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewed','dismissed')),
    created_at TEXT NOT NULL,
    UNIQUE(owner_user_id, stock_code, event_kind, source_key)
);
CREATE INDEX investment_monitor_events_owner ON investment_monitor_events(owner_user_id, status, created_at DESC);
CREATE TABLE earnings_expectations (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    stock_code TEXT NOT NULL,
    report_period TEXT NOT NULL,
    basis TEXT NOT NULL CHECK(basis IN ('annual','cumulative','quarter','ttm')),
    metric_code TEXT NOT NULL,
    expected_value TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner_user_id, stock_code, report_period, basis, metric_code)
);
CREATE INDEX earnings_expectations_owner ON earnings_expectations(owner_user_id, report_period DESC);
CREATE TABLE portfolio_transactions (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    stock_code TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('buy','sell')),
    quantity TEXT NOT NULL,
    price TEXT NOT NULL,
    fees TEXT NOT NULL DEFAULT '0',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX portfolio_transactions_owner ON portfolio_transactions(owner_user_id, trade_date, created_at);
