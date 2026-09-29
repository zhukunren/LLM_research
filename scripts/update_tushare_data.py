from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from apps.api.app.db import init_db
from apps.api.app.tushare_sync import sync_tushare


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Update local market data and news from the configured Tushare relay."
    )
    parser.add_argument("--as-of", help="Cutoff date in YYYY-MM-DD form; defaults to today")
    parser.add_argument("--days", type=int, default=30, help="Rolling news window in calendar days (default: 30)")
    parser.add_argument("--skip-market", action="store_true", help="Do not fetch or replace daily-bar data")
    parser.add_argument("--skip-news", action="store_true", help="Do not import news records")
    args = parser.parse_args()

    init_db()
    result = sync_tushare(
        as_of=args.as_of,
        days=args.days,
        include_market=not args.skip_market,
        include_news=not args.skip_news,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["stages"] or all(stage.get("status") == "failed" for stage in result["stages"].values()):
        raise SystemExit(1)


if __name__ == "__main__":  # pragma: no cover - command-line entry point
    main()
