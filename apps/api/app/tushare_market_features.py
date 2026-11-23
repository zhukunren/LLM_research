"""Trading-day market rotation and ETF peer comparisons."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from math import prod

from .tushare_client import TushareError
from .tushare_feature_data import FEEDS, Reader, coerce_day, day_text, error_note, now, number, scoped_day
from .tushare_screening_data import A_SHARE, industry_memberships


ROTATION_READY_AT = time(18, 30)
ROTATION_WINDOWS = (1, 5, 20)


def _unique_by_code(rows, day: date, endpoint: str) -> dict[str, dict]:
    result = {}
    for row, _ in scoped_day(rows, "trade_date", day, day, endpoint):
        code = str(row["ts_code"])
        if not A_SHARE.fullmatch(code) or code in result:
            raise TushareError(f"{endpoint} 证券代码无效或重复", kind="invalid_response")
        result[code] = row
    return result


def _industry_returns(reader: Reader, day: date, days: list[date]) -> dict[str, dict]:
    catalog = {str(row["index_code"]): str(row["industry_name"]) for row in
               reader.read("index_classify", level="L1", src="SW2021")
               if str(row["level"]) == "L1" and row["src"] == "SW2021" and row["industry_name"]}
    windows = days[-max(ROTATION_WINDOWS):]
    changes: dict[tuple[str, date], float | None] = {}
    for i in range(0, len(windows), 5):
        start, end = windows[i], windows[min(i + 4, len(windows) - 1)]
        rows = reader.read("sw_daily", start_date=day_text(start), end_date=day_text(end))
        for row, trade_day in scoped_day(rows, "trade_date", start, end, "sw_daily"):
            key = (str(row["ts_code"]), trade_day)
            if key in changes:
                raise TushareError("申万行业日线返回重复记录", kind="invalid_response")
            changes[key] = number(row["pct_change"], minimum=-100)
    result = {}
    for code, name in catalog.items():
        returns = {}
        for width in ROTATION_WINDOWS:
            values = [changes.get((code, value)) for value in windows[-width:]]
            returns[str(width)] = round((prod(1 + value / 100 for value in values) - 1) * 100, 4) \
                if len(values) == width and all(value is not None for value in values) else None
        result[code] = {"code": code, "name": name, "returns": returns, "breadth": None}
    if not catalog or not any(row["returns"]["1"] is not None for row in result.values()):
        raise TushareError(f"{day.isoformat()} 暂无已发布的申万行业日线", kind="no_data")
    return result


def _breadth(reader: Reader, day: date, industries: dict[str, dict]) -> dict:
    quotes = _unique_by_code(reader.read("daily", trade_date=day_text(day)), day, "daily")
    if not quotes:
        raise TushareError("暂无所选交易日个股行情", kind="no_data")
    changes = {code: number(row["pct_chg"]) for code, row in quotes.items()}

    def count(codes):
        values = [changes[code] for code in codes if changes.get(code) is not None]
        return {"up": sum(value > 0 for value in values), "down": sum(value < 0 for value in values),
                "flat": sum(value == 0 for value in values), "covered": len(values), "total": len(codes)}

    result = {"market": count(list(quotes)), "issue": None, "membership_source": None}
    if not industries:
        return result
    try:
        members = industry_memberships(reader.client)
    except TushareError as exc:
        result["issue"] = error_note(exc)
        return result
    result["membership_source"] = {"name": "index_member_all", "label": "申万行业成分",
                                   "url": "https://tushare.pro/document/2?doc_id=335", "observed_at": members.observed_at}
    day_key = day.isoformat()
    by_stock: dict[str, set[str]] = {}
    for row in members.rows:
        if row["in_date"] <= day_key and (row["out_date"] is None or day_key < row["out_date"]):
            by_stock.setdefault(row["stock_code"], set()).add(row["path"][0][0])
    by_industry = {code: [] for code in industries}
    for stock, options in by_stock.items():
        if len(options) == 1:
            code = next(iter(options))
            if code in by_industry:
                by_industry[code].append(stock)
    for code, stocks in by_industry.items():
        if stocks:
            industries[code]["breadth"] = count(stocks)
    return result


def rotation(reader: Reader, as_of: date | None, *, cutoff: datetime | None = None) -> dict:
    cutoff = cutoff or now()
    latest_allowed = cutoff.date() if cutoff.time() >= ROTATION_READY_AT else cutoff.date() - timedelta(days=1)
    requested = as_of or latest_allowed
    if requested > latest_allowed:
        return {"as_of": requested.isoformat(), "trade_date": None, "industries": [], "breadth": None,
                "limits": {}, "streaks": [], "issues": [{"label": "盘面数据", "message": "所选时点的盘后数据尚未发布"}], "sources": []}
    days = reader.days(requested)
    if not days or as_of is not None and days[-1] != requested:
        return {"as_of": requested.isoformat(), "trade_date": None, "industries": [], "breadth": None,
                "limits": {}, "streaks": [], "issues": [{"label": "交易日", "message": "所选日期无已确认的 A 股交易日"}],
                "sources": reader.sources()}
    day = days[-1]
    issues = []
    try:
        industries = _industry_returns(reader, day, days)
    except TushareError as exc:
        industries = {}
        issues.append({"label": "申万行业涨跌", "message": error_note(exc)})
    breadth, membership_source = None, None
    try:
        totals = _breadth(reader, day, industries)
        breadth = totals["market"]
        membership_source = totals["membership_source"]
        if totals["issue"]:
            issues.append({"label": "行业上涨家数", "message": totals["issue"]})
    except TushareError as exc:
        issues.append({"label": "上涨与下跌家数", "message": error_note(exc)})
    limits = {}
    for kind, label in (("U", "涨停"), ("D", "跌停"), ("Z", "炸板")):
        if day < date(2020, 1, 1):
            issues.append({"label": f"{label}名单", "message": "接口覆盖自 2020 年开始"})
            continue
        try:
            rows = _unique_by_code(reader.read("limit_list_d", trade_date=day_text(day), limit_type=kind), day, "limit_list_d")
            if any(row["limit"] != kind for row in rows.values()):
                raise TushareError("涨跌停类型不符", kind="invalid_response")
            limits[kind] = [{"code": code, "name": row["name"] or code, "open_times": number(row["open_times"], minimum=0)}
                            for code, row in sorted(rows.items())]
        except TushareError as exc:
            issues.append({"label": f"{label}名单", "message": error_note(exc)})
    streaks = []
    try:
        if day < date(2023, 11, 13):
            issues.append({"label": FEEDS["limit_step"].label, "message": "接口覆盖自 2023-11-13 开始"})
            rows = {}
        else:
            rows = _unique_by_code(reader.read("limit_step", trade_date=day_text(day)), day, "limit_step")
        for code, row in rows.items():
            height = number(row["nums"], minimum=1)
            if height and height.is_integer():
                streaks.append({"code": code, "name": row["name"] or code, "days": int(height)})
        streaks.sort(key=lambda item: (-item["days"], item["code"]))
    except TushareError as exc:
        issues.append({"label": "连板天梯", "message": error_note(exc)})
    sources = reader.sources() + ([membership_source] if membership_source else [])
    return {"as_of": requested.isoformat(), "trade_date": day.isoformat(),
            "industries": sorted(industries.values(), key=lambda row: (
                row["returns"]["1"] is None, -(row["returns"]["1"] or 0), row["code"])),
            "breadth": breadth, "limits": limits, "streaks": streaks, "issues": issues, "sources": sources}


def etf_peers(reader: Reader, as_of: date | None) -> dict:
    clock = now()
    latest = clock.date() - timedelta(days=1 if clock.time() >= time(8, 30) else 2)
    requested = as_of or latest
    issues = []
    empty = {"as_of": requested.isoformat(), "trade_date": None, "previous_date": None, "items": []}
    if requested > latest:
        return {**empty, "issues": [{"label": "ETF 份额", "message": "所选交易日的份额要到次日更新"}], "sources": []}
    days = reader.days(requested, span=28)
    if not days or as_of is not None and days[-1] != requested:
        return {**empty, "issues": [{"label": "交易日", "message": "所选日期无已确认的 ETF 交易日"}], "sources": reader.sources()}
    day = days[-1]
    prior = days[-2] if len(days) > 1 else None
    current = _unique_by_code(reader.read("etf_share_size", trade_date=day_text(day)), day, "etf_share_size")
    previous, quotes, catalog = {}, {}, {}
    if prior:
        try:
            previous = _unique_by_code(reader.read("etf_share_size", trade_date=day_text(prior)), prior, "etf_share_size")
            if not previous:
                issues.append({"label": "前一交易日份额", "message": "暂无前一交易日份额"})
        except TushareError as exc:
            issues.append({"label": "前一交易日份额", "message": error_note(exc)})
    try:
        funds = reader.read("fund_daily", trade_date=day_text(day))
        quotes = _unique_by_code([row for row in funds if row["ts_code"] in current], day, "fund_daily")
    except TushareError as exc:
        issues.append({"label": "ETF 成交额", "message": error_note(exc)})
    try:
        for row in reader.read("etf_basic"):
            listed = coerce_day(row["list_date"])
            if listed and listed <= day:
                catalog[row["ts_code"]] = row
        if not catalog:
            issues.append({"label": "ETF 跟踪指数", "message": "暂无可对照的 ETF 目录"})
    except TushareError as exc:
        issues.append({"label": "ETF 跟踪指数", "message": error_note(exc)})
    items = []
    for code, row in current.items():
        basic = catalog.get(code, {})
        shares = number(row["total_share"], minimum=0)
        prior_shares = number(previous.get(code, {}).get("total_share"), minimum=0)
        change = round(shares - prior_shares, 4) if shares is not None and prior_shares is not None else None
        size = number(row["total_size"], minimum=0)
        prior_size = number(previous.get(code, {}).get("total_size"), minimum=0)
        amount = number(quotes.get(code, {}).get("amount"), minimum=0)
        items.append({
            "code": code, "name": basic.get("extname") or row["etf_name"] or code,
            "index_code": basic.get("index_code") or None, "index_name": basic.get("index_name") or None,
            "shares_wan": shares, "share_change_wan": change,
            "share_change_pct": round(change / prior_shares * 100, 4) if change is not None and prior_shares else None,
            "size_yi": round(size / 10_000, 6) if size is not None else None,
            "size_change_yi": round((size - prior_size) / 10_000, 6) if size is not None and prior_size is not None else None,
            "amount_yi": round(amount / 100_000, 6) if amount is not None else None,
        })
    items.sort(key=lambda item: (item["share_change_pct"] is None, -(item["share_change_pct"] or 0), item["code"]))
    return {"as_of": requested.isoformat(), "trade_date": day.isoformat(),
            "previous_date": prior.isoformat() if prior else None, "items": items, "issues": issues, "sources": reader.sources()}
