from concurrent.futures import ThreadPoolExecutor
import sqlite3

import pytest

from apps.api.app.tushare_client import TushareError
from apps.api.app.tushare_limits import TushareRateLimiter


def test_distinct_instances_share_credential_budget_but_not_other_credentials(tmp_path):
    path = tmp_path / "limits.db"
    first = TushareRateLimiter(path, interval=60, max_wait=0)
    second = TushareRateLimiter(path, interval=60, max_wait=0)
    first.acquire("credential-a", "income")
    with pytest.raises(TushareError) as error:
        second.acquire("credential-a", "cashflow")
    assert error.value.kind == "rate_limited"
    second.acquire("credential-b", "cashflow")


def test_endpoint_clock_and_global_clock_release_transactions_before_sleep(tmp_path):
    now = [100.0]
    path = tmp_path / "limits.db"
    def sleep(seconds):
        with sqlite3.connect(path, timeout=0.1) as connection:
            connection.execute("BEGIN IMMEDIATE")
        now[0] += seconds
    limiter = TushareRateLimiter(path, interval=1, endpoints={"income": 3}, clock=lambda: now[0], sleep=sleep)
    limiter.acquire("key", "income")
    limiter.acquire("key", "cashflow")
    assert now[0] == 101
    limiter.acquire("key", "income")
    assert now[0] == 103


def test_concurrent_reservations_do_not_both_pass(tmp_path):
    path = tmp_path / "limits.db"
    def acquire():
        try:
            TushareRateLimiter(path, interval=10, max_wait=0).acquire("credential", "income")
            return True
        except TushareError:
            return False
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: acquire(), range(2)))
    assert results.count(True) == 1
