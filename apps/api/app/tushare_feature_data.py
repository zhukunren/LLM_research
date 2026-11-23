"""Date-scoped reads shared by the Tushare research panels and screening rules."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
import hashlib
import json
import math
from zoneinfo import ZoneInfo

from . import tushare_sync
from .storage import storage_paths
from .tushare_client import TushareError
from .tushare_screening_data import SourceRows, _cache, _source_day


SHANGHAI = ZoneInfo("Asia/Shanghai")


@dataclass(frozen=True)
class Feed:
    document: int
    label: str
    fields: str
    limit: int


FEEDS = {
    "trade_cal": Feed(26, "交易日历", "cal_date,is_open", 5000),
    "report_rc": Feed(292, "券商盈利预测", "ts_code,report_date,org_name,quarter,eps,create_time", 3000),
    "fina_indicator": Feed(79, "财务指标", "ts_code,ann_date,end_date,eps", 100),
    "cyq_perf": Feed(293, "每日筹码指标", "ts_code,trade_date,cost_5pct,cost_50pct,cost_95pct,weight_avg,winner_rate", 6000),
    "cyq_chips": Feed(294, "筹码价位分布", "ts_code,trade_date,price,percent", 6000),
    "broker_recommend": Feed(267, "券商月度金股", "month,broker,ts_code", 1000),
    "stk_surv": Feed(275, "机构调研记录", "ts_code,surv_date,fund_visitors,rece_mode,rece_org", 400),
    "index_classify": Feed(181, "申万行业分类", "index_code,industry_name,level,src", 1000),
    "sw_daily": Feed(327, "申万行业日线", "ts_code,trade_date,pct_change", 4000),
    "daily": Feed(27, "A 股日线", "ts_code,trade_date,pct_chg", 6000),
    "limit_list_d": Feed(298, "涨跌停与炸板", "ts_code,trade_date,name,limit,open_times", 2500),
    "limit_step": Feed(356, "连板天梯", "ts_code,trade_date,name,nums", 2000),
    "share_float": Feed(160, "限售股解禁", "ts_code,ann_date,float_date,float_share,float_ratio,holder_name", 6000),
    "stk_holdertrade": Feed(175, "股东增减持", "ts_code,ann_date,holder_name,in_de,change_vol,change_ratio,begin_date,close_date", 3000),
    "disclosure_date": Feed(162, "财报披露日程", "ts_code,ann_date,end_date,pre_date,actual_date,modify_date", 3000),
    "etf_basic": Feed(385, "ETF 基础信息", "ts_code,extname,index_code,index_name,list_date", 5000),
    "etf_share_size": Feed(408, "ETF 份额规模", "ts_code,trade_date,etf_name,total_share,total_size", 5000),
    "fund_daily": Feed(127, "ETF 日线", "ts_code,trade_date,amount", 5000),
}


def now() -> datetime:
    return datetime.now(SHANGHAI)


def day_text(value: date) -> str:
    return value.strftime("%Y%m%d")


def coerce_day(value) -> date | None:
    return _source_day(value)


def number(value, *, minimum: float | None = None, maximum: float | None = None) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if (not math.isfinite(result) or minimum is not None and result < minimum
            or maximum is not None and result > maximum):
        return None
    return result


def scoped_day(rows, field: str, start: date, end: date, endpoint: str):
    for row in rows:
        day = coerce_day(row.get(field))
        if day is None or not start <= day <= end:
            raise TushareError(f"{endpoint} 返回了查询范围外或无法确认日期的记录", kind="invalid_response")
        yield row, day


class Reader:
    def __init__(self, client=None):
        self.client = client if client is not None else tushare_sync.create_client(timeout=8, retries=0)
        self.snapshots: dict[str, SourceRows] = {}

    def read(self, endpoint: str, *, paginate: bool = False, **params) -> list[dict]:
        feed = FEEDS[endpoint]
        identity = json.dumps([feed.fields, paginate, params], sort_keys=True)
        key = f"{endpoint}-{hashlib.sha256(identity.encode()).hexdigest()[:32]}"
        if key not in self.snapshots:
            root = storage_paths().state_root / "tushare-features" / self.client.dataset_id
            self.snapshots[key] = _cache(key, lambda: self._fetch(endpoint, feed, paginate, params),
                                         max_age=timedelta(minutes=30), root=root)
        return self.snapshots[key].rows

    def _fetch(self, endpoint: str, feed: Feed, paginate: bool, params: dict) -> list[dict]:
        fields = set(feed.fields.split(","))
        rows, page_keys = [], set()
        for offset in range(0, feed.limit * 12, feed.limit):
            paging = {"limit": feed.limit, "offset": offset} if paginate else {}
            page = tushare_sync._query(self.client, endpoint, fields=feed.fields, **paging, **params)
            if len(page) > feed.limit or any(not fields <= row.keys() for row in page):
                raise TushareError(f"{endpoint} 返回的字段或行数与接口约定不符", kind="invalid_response")
            if len(page) < feed.limit:
                return rows + page
            if not paginate:
                break
            key = hashlib.sha256(json.dumps(page, sort_keys=True).encode()).hexdigest()
            if key in page_keys:
                break
            page_keys.add(key)
            rows.extend(page)
        raise TushareError(f"{endpoint} 已达到单次行数上限，无法确认查询覆盖完整", kind="incomplete")

    def days(self, as_of: date, span: int = 70) -> list[date]:
        start = as_of - timedelta(days=span)
        rows = self.read("trade_cal", exchange="SSE", start_date=day_text(start), end_date=day_text(as_of))
        return sorted({day for row, day in scoped_day(rows, "cal_date", start, as_of, "trade_cal")
                       if str(row["is_open"]).strip() in {"1", "1.0", "True"}})

    def latest_day(self, as_of: date, *, ready_at: time) -> date | None:
        clock = now()
        last = min(as_of, clock.date())
        if last == clock.date() and clock.time() < ready_at:
            last -= timedelta(days=1)
        days = self.days(last, span=28)
        return days[-1] if days else None

    def manifests(self) -> list[str]:
        return [source.manifest for source in self.snapshots.values()]

    def sources(self) -> list[dict]:
        by_endpoint: dict[str, dict] = {}
        for key, source in self.snapshots.items():
            endpoint = key.split("-", 1)[0]
            feed = FEEDS[endpoint]
            item = by_endpoint.setdefault(endpoint, {
                "name": endpoint, "label": feed.label, "url": f"https://tushare.pro/document/2?doc_id={feed.document}",
                "observed_at": source.observed_at,
            })
            if (source.observed_at or "") > (item["observed_at"] or ""):
                item["observed_at"] = source.observed_at
        return list(by_endpoint.values())


def error_note(exc: TushareError) -> str:
    message = {
        "not_configured": "尚未配置 Tushare 数据连接",
        "denied": "当前 Tushare 连接的接口权限不足",
        "rate_limited": "Tushare 请求暂时受限",
        "transient_error": "Tushare 暂时无法连接",
        "invalid_response": "Tushare 返回格式待核对",
        "incomplete": "Tushare 返回行数达到上限，覆盖不完整",
    }
    return message.get(exc.kind, "Tushare 数据暂不可用")
