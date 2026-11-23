"""Calendar entries for the user's active observation pool."""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
import re

from .tushare_client import TushareError
from .tushare_feature_data import Reader, coerce_day, day_text, error_note, number, scoped_day


DAYS = 7


def _unlock_events(reader: Reader, day: date, as_of: date, codes: set[str]) -> list[dict]:
    rows = reader.read("share_float", paginate=True, float_date=day_text(day))
    groups = defaultdict(dict)
    for row, _ in scoped_day(rows, "float_date", day, day, "share_float"):
        announced, code = coerce_day(row["ann_date"]), row["ts_code"]
        if code in codes and announced and announced <= as_of:
            # Keep each disclosed shareholder line once.
            shares = number(row["float_share"], minimum=0)
            key = (str(row["holder_name"] or ""), shares, number(row["float_ratio"], minimum=0))
            groups[(code, announced)][key] = shares
    return [
        {"kind": "unlock", "code": code, "date": day.isoformat(), "ann_date": announced.isoformat(),
         "shares": sum(values.values()) if all(value is not None for value in values.values()) else None,
         "shareholders": len(values)}
        for (code, announced), values in groups.items()
    ]


def _appointment_events(reader: Reader, day: date, as_of: date, codes: set[str]) -> list[dict]:
    rows = reader.read("disclosure_date", pre_date=day_text(day))
    result = {}
    for row, _ in scoped_day(rows, "pre_date", day, day, "disclosure_date"):
        code = row["ts_code"]
        announced, actual, period = (coerce_day(row[key]) for key in ("ann_date", "actual_date", "end_date"))
        changes = [coerce_day(value) for value in re.findall(r"\d{4}-\d{2}-\d{2}|\d{8}", str(row["modify_date"] or ""))]
        if (code not in codes or not announced or announced > as_of or not period
                or actual and actual <= as_of or any(value and value > as_of for value in changes)):
            continue
        result[(code, period)] = {"kind": "disclosure", "code": code, "date": day.isoformat(),
                                 "ann_date": announced.isoformat(), "period": period.isoformat()}
    return list(result.values())


def _holder_events(reader: Reader, day: date, codes: set[str]) -> list[dict]:
    result = {}
    rows = reader.read("stk_holdertrade", paginate=True, ann_date=day_text(day))
    for row, _ in scoped_day(rows, "ann_date", day, day, "stk_holdertrade"):
        if row["ts_code"] not in codes or row["in_de"] not in {"IN", "DE"}:
            continue
        start, end = coerce_day(row["begin_date"]), coerce_day(row["close_date"])
        holder = str(row["holder_name"] or "").strip()
        shares, ratio = number(row["change_vol"]), number(row["change_ratio"])
        key = (row["ts_code"], holder, row["in_de"], start, end, shares, ratio)
        result[key] = {
            "kind": "holder_increase" if row["in_de"] == "IN" else "holder_decrease", "code": row["ts_code"],
            "date": day.isoformat(), "ann_date": day.isoformat(), "holder": holder, "shares": abs(shares) if shares is not None else None,
            "ratio": abs(ratio) if ratio is not None else None,
            "start_date": start.isoformat() if start else None, "end_date": end.isoformat() if end else None,
        }
    return list(result.values())


def calendar(reader: Reader | None, as_of: date, stocks: dict[str, str]) -> dict:
    last = as_of + timedelta(days=DAYS - 1)
    first_notice = as_of - timedelta(days=DAYS - 1)
    result = {"as_of": as_of.isoformat(), "upcoming_end": last.isoformat(), "recent_start": first_notice.isoformat(),
              "stock_count": len(stocks), "items": [], "issues": [], "sources": [], "total": 0}
    if not stocks or reader is None:
        return result
    codes = set(stocks)
    events, unavailable = [], set()
    for offset in range(DAYS):
        upcoming, recent = as_of + timedelta(days=offset), as_of - timedelta(days=offset)
        for label, day, load, args in (
            ("限售股解禁", upcoming, _unlock_events, (as_of, codes)),
            ("财报预约披露", upcoming, _appointment_events, (as_of, codes)),
            ("股东增减持", recent, _holder_events, (codes,)),
        ):
            if label in unavailable:
                continue
            try:
                events.extend(load(reader, day, *args))
            except TushareError as exc:
                result["issues"].append({"label": label, "date": day.isoformat(), "message": error_note(exc)})
                if exc.kind in {"denied", "not_configured", "rate_limited", "transient_error"}:
                    unavailable.add(label)
    items = sorted(events, key=lambda item: (item["kind"].startswith("holder"),
        -int(item["date"].replace("-", "")) if item["kind"].startswith("holder") else item["date"],
        item["code"], item["kind"]))
    result["total"] = len(items)
    result["items"] = [{**item, "name": stocks[item["code"]] or item["code"]} for item in items]
    result["sources"] = reader.sources()
    return result
