"""A shared SQLite clock budget for all processes using the same provider token."""
from __future__ import annotations

import math
from pathlib import Path
import sqlite3
import time

from .tushare_client import TushareError


class TushareRateLimiter:
    def __init__(self, path: Path, *, interval: float = 0.6, endpoints: dict[str, float] | None = None,
                 max_wait: float = 60, clock=time.time, sleep=time.sleep):
        self.path, self.interval, self.endpoints = path, interval, endpoints or {}
        self.clock, self.sleep, self.max_wait = clock, sleep, max_wait
        if any(not math.isfinite(v) or v < 0 for v in [interval, max_wait, *self.endpoints.values()]):
            raise ValueError("限速间隔必须是有限非负数")

    def acquire(self, credential: str, endpoint: str):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        started = self.clock()
        while True:
            with sqlite3.connect(self.path, timeout=10) as connection:
                connection.execute("CREATE TABLE IF NOT EXISTS budgets (credential TEXT, endpoint TEXT, next_at REAL, PRIMARY KEY(credential,endpoint))")
                connection.execute("BEGIN IMMEDIATE")
                now = self.clock()
                budgets = [("*", self.interval), (endpoint, self.endpoints.get(endpoint, 0))]
                ready = now
                for key, _ in budgets:
                    row = connection.execute("SELECT next_at FROM budgets WHERE credential=? AND endpoint=?", (credential, key)).fetchone()
                    ready = max(ready, row[0] if row else now)
                if ready <= now:
                    for key, interval in budgets:
                        connection.execute("INSERT INTO budgets VALUES(?,?,?) ON CONFLICT(credential,endpoint) DO UPDATE SET next_at=excluded.next_at",
                                           (credential, key, now + interval))
                    return
            remaining = self.max_wait - (self.clock() - started)
            if ready - self.clock() > remaining or remaining <= 0:
                raise TushareError("本地调用预算已用尽，请稍后重试", kind="rate_limited")
            self.sleep(max(0, min(ready - self.clock(), 1.0)))


def configured_limiter() -> TushareRateLimiter:
    from .settings import _read_config
    from .storage import storage_paths
    config = _read_config()
    section = config["tushare_limits"] if config.has_section("tushare_limits") else {}
    try:
        interval = float(section.get("min_interval_seconds", "0.6"))
        endpoints = {key: float(value) for key, value in section.items() if key != "min_interval_seconds"}
    except ValueError:
        raise TushareError("Tushare 限速配置无效", kind="configuration_error") from None
    try:
        return TushareRateLimiter(storage_paths().state_root / "provider-rate-limits.sqlite3",
                                  interval=interval, endpoints=endpoints)
    except ValueError:
        raise TushareError("Tushare 限速配置无效", kind="configuration_error") from None
