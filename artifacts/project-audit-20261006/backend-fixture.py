"""Create an audit-only synthetic daily-bar source; never read business data."""
from datetime import date, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

target = Path(__file__).parent / "backend-isolated" / "data" / "stock_data" / "stock_daily.parquet"
target.parent.mkdir(parents=True, exist_ok=True)
pq.write_table(pa.Table.from_pylist([
    {
        "stock_code": "600000.SH",
        "trade_date": date(2026, 9, 14) - timedelta(days=29 - offset),
        "open": 10.0,
        "high": 11.0,
        "low": 9.0,
        "close": 10.5,
        "volume": 100.0,
        "amount": 1050.0,
    }
    for offset in range(30)
]), target)
print(target)
