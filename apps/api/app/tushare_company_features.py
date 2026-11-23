"""Company earnings expectations, daily chip costs, and institutional activity."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from statistics import median

from .tushare_client import TushareError
from .tushare_feature_data import Reader, SHANGHAI, coerce_day, day_text, error_note, now, number, scoped_day
from .tushare_screening_data import A_SHARE


REVISION_BASELINE_DAYS = 90
CHIPS_READY_AT = time(19)


@dataclass(frozen=True)
class Estimate:
    stock_code: str
    fiscal_year: int
    broker: str
    report_date: date
    available_at: datetime
    eps: float


def end_of_day(day: date) -> datetime:
    return min(datetime.combine(day, time.max, SHANGHAI), now())


def estimates(reader: Reader, start: date, cutoff: datetime, codes: set[str], *, active=lambda: True) -> list[Estimate]:
    end = cutoff.date()
    rows = []
    if len(codes) <= 6:
        for code in sorted(codes):
            if not active():
                return []
            params = {"start_date": day_text(start), "end_date": day_text(end), "ts_code": code}
            batch = reader.read("report_rc", paginate=True, **params)
            if any(str(row["ts_code"]) != code for row in batch):
                raise TushareError("券商盈利预测返回了其他证券", kind="invalid_response")
            rows.extend(batch)
    else:
        day = start
        while day <= end:
            if not active():
                return []
            last = min(day + timedelta(days=6), end)
            batch = reader.read("report_rc", paginate=True, start_date=day_text(day), end_date=day_text(last))
            rows.extend(row for row, _ in scoped_day(batch, "report_date", day, last, "report_rc")
                        if row["ts_code"] in codes)
            day = last + timedelta(days=1)
    output: set[Estimate] = set()
    for row, day in scoped_day(rows, "report_date", start, end, "report_rc"):
        period = str(row["quarter"] or "")
        broker = str(row["org_name"] or "").strip()
        eps = number(row["eps"])
        if len(period) != 6 or not period.startswith(("19", "20", "21")) or not period[:4].isdigit() \
                or not period.endswith("Q4") or not broker or eps is None:
            continue
        try:
            observed = datetime.fromisoformat(str(row["create_time"]))
            observed = observed.replace(tzinfo=SHANGHAI) if observed.tzinfo is None else observed.astimezone(SHANGHAI)
        except ValueError:
            continue
        if observed.date() >= day and observed <= cutoff:
            output.add(Estimate(row["ts_code"], int(period[:4]), broker, day, observed, eps))
    return sorted(output, key=lambda item: (item.available_at, item.report_date, item.broker, item.eps))


def _estimates_by_broker(rows: list[Estimate]) -> dict[str, list[Estimate]]:
    grouped = defaultdict(lambda: defaultdict(list))
    for row in rows:
        grouped[row.broker][row.report_date].append(row)
    by_broker = {}
    for broker, days in grouped.items():
        ordered = []
        for day, reports in sorted(days.items()):
            last_time = max(report.available_at for report in reports)
            same_time = [report for report in reports if report.available_at == last_time]
            # A simultaneous batch can contain divergent analyst estimates at one brokerage.
            ordered.append(same_time[0] if len({report.eps for report in same_time}) == 1 else None)
        by_broker[broker] = ordered
    return by_broker


def revisions(rows: list[Estimate], fiscal_year: int, as_of: date, window_days: int) -> dict:
    start = as_of - timedelta(days=window_days - 1)
    relevant = [row for row in rows if row.fiscal_year == fiscal_year
                and row.report_date >= start - timedelta(days=REVISION_BASELINE_DAYS)]
    by_broker = _estimates_by_broker(relevant)
    latest, comparisons = [], []
    for broker, records in sorted(by_broker.items()):
        if not records or records[-1] is None:
            continue
        current = records[-1]
        latest.append(current.eps)
        if len(records) < 2 or records[-2] is None or not start <= current.report_date <= as_of:
            continue
        previous = records[-2]
        direction = "up" if current.eps > previous.eps else "down" if current.eps < previous.eps else "flat"
        comparisons.append({"broker": broker, "direction": direction, "previous_eps": previous.eps,
                            "current_eps": current.eps, "previous_date": previous.report_date.isoformat(),
                            "report_date": current.report_date.isoformat(), "available_at": current.available_at.isoformat()})
    return {
        "fiscal_year": fiscal_year, "window_start": start.isoformat(), "window_days": window_days,
        "consensus_eps": median(latest) if latest else None, "brokers": len(latest), "comparable_brokers": len(comparisons),
        **{key: sum(row["direction"] == key for row in comparisons) for key in ("up", "down", "flat")},
        "comparisons": sorted(comparisons, key=lambda row: (row["report_date"], row["broker"]), reverse=True),
    }


def _actual_eps(reader: Reader, code: str, year: int, as_of: date) -> dict | None:
    end = date(year, 12, 31)
    if end > as_of:
        return None
    rows = reader.read("fina_indicator", ts_code=code, period=day_text(end))
    confirmed = defaultdict(set)
    for row in rows:
        day, eps = coerce_day(row["ann_date"]), number(row["eps"])
        if row["ts_code"] == code and coerce_day(row["end_date"]) == end and day and day <= as_of and eps is not None:
            confirmed[day].add(eps)
    if not confirmed or len(confirmed[max(confirmed)]) != 1:
        return None
    day = max(confirmed)
    return {"eps": next(iter(confirmed[day])), "ann_date": day.isoformat(), "period": end.isoformat()}


def earnings(reader: Reader, code: str, as_of: date, year: int, window_days: int) -> dict:
    start = as_of - timedelta(days=window_days + REVISION_BASELINE_DAYS - 1)
    rows = [row for row in estimates(reader, start, end_of_day(as_of), {code}) if row.fiscal_year == year]
    summary = revisions(rows, year, as_of, window_days)
    days = sorted({row.available_at.date() for row in rows if row.available_at.date() >= date.fromisoformat(summary["window_start"])})
    series = []
    for day in days:
        sources = _estimates_by_broker([row for row in rows if row.available_at.date() <= day])
        values = [items[-1].eps for items in sources.values() if items and items[-1] is not None]
        if values:
            series.append({"date": day.isoformat(), "eps": median(values), "brokers": len(values)})
    issues = []
    try:
        actual = _actual_eps(reader, code, year, as_of)
    except TushareError as exc:
        actual = None
        issues.append({"label": "已披露 EPS", "message": error_note(exc)})
    return {"stock_code": code, "as_of": as_of.isoformat(), **summary, "series": series,
            "actual": actual, "issues": issues, "sources": reader.sources()}


def chip_spread(row: dict) -> float | None:
    low, center, high = (number(row.get(key), minimum=0) for key in ("cost_5pct", "cost_50pct", "cost_95pct"))
    if low is None or center is None or high is None or not 0 < low <= center <= high:
        return None
    return round((high - low) / center * 100, 6)


def chip_day(reader: Reader, day: date, code: str | None = None) -> dict[str, dict]:
    params = {"ts_code": code} if code else {}
    rows = reader.read("cyq_perf", paginate=True, trade_date=day_text(day), **params)
    result = {}
    for row, _ in scoped_day(rows, "trade_date", day, day, "cyq_perf"):
        key = str(row["ts_code"])
        if not A_SHARE.fullmatch(key) or code and key != code or key in result:
            raise TushareError("每日筹码指标返回了非目标证券或重复记录", kind="invalid_response")
        result[key] = row
    return result


def chips(reader: Reader, code: str, as_of: date) -> dict:
    day = reader.latest_day(as_of, ready_at=CHIPS_READY_AT)
    result = {"stock_code": code, "as_of": as_of.isoformat(), "trade_date": day.isoformat() if day else None,
              "distribution": [], "series": [], "issues": []}
    if day is None:
        return {**result, "sources": reader.sources()}
    start = day - timedelta(days=120)
    rows = reader.read("cyq_perf", ts_code=code, start_date=day_text(start), end_date=day_text(day))
    series = {}
    for row, source_day in scoped_day(rows, "trade_date", start, day, "cyq_perf"):
        if row["ts_code"] != code or source_day in series:
            raise TushareError("每日筹码指标返回了非目标证券或重复记录", kind="invalid_response")
        series[source_day] = {
            "trade_date": source_day.isoformat(), "low_cost": number(row["cost_5pct"], minimum=0),
            "median_cost": number(row["cost_50pct"], minimum=0), "high_cost": number(row["cost_95pct"], minimum=0),
            "average_cost": number(row["weight_avg"], minimum=0), "winner_pct": number(row["winner_rate"], minimum=0, maximum=100),
            "spread_pct": chip_spread(row),
        }
    result["series"] = [series[key] for key in sorted(series)]
    try:
        distribution = reader.read("cyq_chips", ts_code=code, trade_date=day_text(day))
        prices = set()
        for row, _ in scoped_day(distribution, "trade_date", day, day, "cyq_chips"):
            price, percent = number(row["price"], minimum=0), number(row["percent"], minimum=0, maximum=100)
            if row["ts_code"] != code or price in prices:
                raise TushareError("筹码价位分布返回了非目标证券或重复价格", kind="invalid_response")
            if price is not None and price > 0 and percent is not None:
                prices.add(price)
                result["distribution"].append({"price": price, "percent": percent})
        result["distribution"].sort(key=lambda item: item["price"])
    except TushareError as exc:
        result["distribution"] = []
        result["issues"].append({"label": "价位分布", "message": error_note(exc)})
    return {**result, "sources": reader.sources()}


def institutions(reader: Reader, code: str, as_of: date, month: str) -> dict:
    picks, surveys, issues = [], [], []
    try:
        monthly = reader.read("broker_recommend", month=month.replace("-", ""))
        if any(str(row["month"]) != month.replace("-", "") for row in monthly):
            raise TushareError("券商月度金股返回了其他月份", kind="invalid_response")
        picks = sorted({str(row["broker"]).strip() for row in monthly if row["ts_code"] == code and row["broker"]})
    except TushareError as exc:
        issues.append({"label": "券商月度金股", "message": error_note(exc)})
    try:
        first = as_of - timedelta(days=119)
        rows = reader.read("stk_surv", paginate=True, ts_code=code, start_date=day_text(first), end_date=day_text(as_of))
        unique = {}
        for row in rows:
            visit = coerce_day(row["surv_date"])
            if row["ts_code"] != code or visit is None or not first <= visit <= as_of:
                raise TushareError("机构调研记录返回了其他证券或时间范围", kind="invalid_response")
            visitors = str(row["fund_visitors"] or "").strip()
            key = (visit.isoformat(), visitors, str(row["rece_mode"] or ""), str(row["rece_org"] or ""))
            unique[key] = dict(zip(("visit_date", "visitors", "mode", "host"), key, strict=True))
        surveys = [unique[key] for key in sorted(unique, reverse=True)]
    except TushareError as exc:
        issues.append({"label": "机构调研记录", "message": error_note(exc)})
    return {"stock_code": code, "as_of": as_of.isoformat(), "month": month, "brokers": picks,
            "surveys": surveys, "issues": issues, "sources": reader.sources()}
