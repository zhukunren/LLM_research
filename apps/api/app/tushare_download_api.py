"""Download documented Tushare datasets using the workspace connection."""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
import re
from typing import Any, Literal

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from . import tushare_sync
from .api_responses import bad_request, csv_response
from .settings import tushare_settings
from .tushare_client import TushareError
from .tushare_download_catalog import (
    BOND, CODE_EXAMPLES, CONTRACT, DATASETS, DATE_LABELS, DC_CODE, ETF, FUND, INDEX, SW_INDEX,
    THS_CODE, Dataset,
)
from .tushare_endpoints import CODE
from .tushare_feature_data import coerce_day, day_text, error_note, now


router = APIRouter(prefix="/api/v1/tushare-download", tags=["Tushare 数据下载"])
EARLIEST_DATE = date(1990, 1, 1)
MARKET_DAYS = 7
MAX_ROWS = 40_000
MAX_CALLS = 28
MAX_BYTES = 16 * 1024 * 1024
VIP_PAGE_SIZE = 1_000
FIELD_NAME = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*")
SYMBOL = re.compile(r"[A-Z0-9]{1,12}\.[A-Z]{2,6}")
CODE_PATTERNS = {
    INDEX: SYMBOL, CONTRACT: SYMBOL, ETF: re.compile(r"\d{6}\.(SH|SZ)"), BOND: re.compile(r"\d{6}\.(SH|SZ|BJ)"),
    FUND: re.compile(r"\d{6}\.(SH|SZ|OF)"), SW_INDEX: re.compile(r"\d{6}\.SI"),
    THS_CODE: re.compile(r"\d{6}\.TI"), DC_CODE: re.compile(r"BK\d{4,8}\.DC"),
}
MONTH_NUMBER = r"(0[1-9]|1[0-2])"
MONTH = rf"[0-9]{{4}}-{MONTH_NUMBER}"
COMPACT_MONTH = rf"[0-9]{{4}}{MONTH_NUMBER}"
QUARTER = r"[0-9]{4}Q[1-4]"
QUERY_FIELDS = {
    "range": {"start_date", "end_date"}, "listing": {"list_status"}, "period": {"period"}, "month": {"month"},
    "months": {"start_month", "end_month"}, "quarters": {"start_quarter", "end_quarter"}, "snapshot": set(),
}


class Filters(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    code: str | None = Field(default=None, min_length=1, max_length=20)
    start_date: date | None = None
    end_date: date | None = None
    period: date | None = None
    month: str | None = Field(default=None, pattern=f"^{MONTH}$")
    start_month: str | None = Field(default=None, pattern=f"^{MONTH}$")
    end_month: str | None = Field(default=None, pattern=f"^{MONTH}$")
    start_quarter: str | None = Field(default=None, pattern=f"^{QUARTER}$")
    end_quarter: str | None = Field(default=None, pattern=f"^{QUARTER}$")
    list_status: Literal["L", "D", "P"] | None = None
    option: str | None = Field(default=None, min_length=1, max_length=20)


def _query_parameters(dataset: Dataset, filters: Filters, today: date) -> dict[str, str]:
    values = filters.model_dump(exclude_none=True)
    allowed = set(QUERY_FIELDS[dataset.mode])
    if dataset.code_label:
        allowed.add("code")
    if dataset.choice:
        allowed.add("option")
    if values.keys() - allowed:
        bad_request("所选数据类型不支持这些查询条件。")

    params = dict(dataset.fixed_params)
    if dataset.choice:
        options = dict(dataset.choice.options)
        option = filters.option or next(iter(options))
        if option not in options:
            bad_request(f"请选择有效的{dataset.choice.label}。")
        params[dataset.choice.parameter] = option
    if filters.code:
        rule = CODE_PATTERNS.get(dataset.code_label, CODE)
        code = filters.code.upper()
        if not rule.fullmatch(code):
            bad_request(f"请输入带市场后缀的{dataset.code_label}。")
        params[dataset.code_parameter] = code
    elif dataset.code_required:
        bad_request(f"请输入{dataset.code_label}。")

    if dataset.mode == "snapshot":
        return params
    if dataset.mode == "listing":
        return {**params, "list_status": filters.list_status or "L"}
    if dataset.mode == "month":
        if not filters.month or not "1990-01" <= filters.month <= today.isoformat()[:7]:
            bad_request("请选择有效的历史月份或当前月份。")
        return {**params, "month": filters.month.replace("-", "")}
    if dataset.mode == "months":
        start_month, end_month = filters.start_month, filters.end_month
        if not start_month or not end_month or not "1990-01" <= start_month <= end_month <= today.isoformat()[:7]:
            bad_request("请选择有效的月份区间。")
        return {**params, "start_m": start_month.replace("-", ""), "end_m": end_month.replace("-", "")}
    if dataset.mode == "quarters":
        start_quarter, end_quarter = filters.start_quarter, filters.end_quarter
        current = f"{today.year}Q{(today.month + 2) // 3}"
        if not start_quarter or not end_quarter or not "1990Q1" <= start_quarter <= end_quarter <= current:
            bad_request("请选择有效的季度区间。")
        return {**params, "start_q": start_quarter, "end_q": end_quarter}
    if dataset.mode == "period":
        period = filters.period
        if not period or not EARLIEST_DATE <= period <= today or (period.month, period.day) not in {(3, 31), (6, 30), (9, 30), (12, 31)}:
            bad_request("请选择已结束的报告期末，例如 2025-12-31。")
        return {**params, "period": day_text(period)}

    start, end = filters.start_date, filters.end_date
    if not start or not end or not EARLIEST_DATE <= start <= end or (not dataset.future_dates and end > today):
        bad_request("请选择有效的日期范围，开始日期须早于或等于结束日期。")
    if _day_parameter(dataset, params) and (end - start).days >= MARKET_DAYS:
        bad_request(f"所选接口按日取数，每次最多下载 {MARKET_DAYS} 个自然日。")
    return {**params, "start_date": day_text(start), "end_date": day_text(end)}


def _day_parameter(dataset: Dataset, params: dict) -> str:
    if dataset.mode != "range":
        return ""
    if dataset.day_parameter:
        return dataset.day_parameter
    if dataset.market_wide and dataset.code_parameter not in params:
        return dataset.market_day_parameter or ("trade_date" if dataset.date_field == "trade_date" else "")
    return ""


@dataclass
class Table:
    fields: list[str]
    rows: list[list[Any]]
    size: int

    def column(self, name: str) -> int:
        if name not in self.fields:
            raise TushareError("Tushare 返回缺少查询字段", kind="invalid_response")
        return self.fields.index(name)


class Export:
    def __init__(self, name: str, dataset: Dataset):
        self.name = name
        self.dataset = dataset
        self.client = tushare_sync.create_client(timeout=12, retries=0)
        self.calls = self.count = self.size = 0

    def read(self, name: str, params: dict, *, fields: str | None = None) -> Table:
        if self.calls >= MAX_CALLS:
            raise TushareError("查询超出下载批次上限", kind="export_too_large")
        self.calls += 1
        snapshot = self.client.query_snapshot(name, fields=self.dataset.fields if fields is None else fields, **params)
        fields, rows = snapshot.payload["data"]["fields"], snapshot.payload["data"]["items"]
        if (any(not isinstance(field, str) or not FIELD_NAME.fullmatch(field) for field in fields)
                or len(fields) != len(set(fields))
                or any(not isinstance(row, list) or len(row) != len(fields) or any(
                    value is not None and not isinstance(value, (str, int, bool, Decimal)) for value in row
                ) for row in rows)):
            raise TushareError("Tushare 返回无效的表格", kind="invalid_response")
        table = Table(fields, rows, len(snapshot.body))
        if rows:
            self.check_scope(table, params)
        return table

    def check_scope(self, table: Table, params: dict):
        dataset = self.dataset
        code = params.get(dataset.code_parameter)
        if dataset.code_label or dataset.mode == "month":
            position = table.column(dataset.code_parameter)
            if code and any(row[position] != code for row in table.rows):
                raise TushareError("Tushare 返回查询范围外的证券", kind="invalid_response")
        exact_columns = {"list_status": "list_status", "exchange": "exchange", "month": "month"}
        if dataset.choice and dataset.choice.response_field:
            exact_columns[dataset.choice.parameter] = dataset.choice.response_field
        for param, column in exact_columns.items():
            if param in params:
                position = table.column(column)
                if any(str(row[position]) != params[param] for row in table.rows):
                    raise TushareError("Tushare 返回查询范围外的记录", kind="invalid_response")
        if dataset.mode in {"months", "quarters"}:
            months = dataset.mode == "months"
            start, end = (params["start_m"], params["end_m"]) if months else (params["start_q"], params["end_q"])
            pattern = COMPACT_MONTH if months else QUARTER
            position = table.column(dataset.date_field)
            for row in table.rows:
                value = str(row[position])
                if months and re.fullmatch(MONTH, value):
                    value = value.replace("-", "")
                if not re.fullmatch(pattern, value) or not start <= value <= end:
                    raise TushareError("Tushare 返回查询范围外的月度或季度", kind="invalid_response")
            return
        if dataset.mode not in {"range", "period"}:
            return
        if dataset.mode == "period":
            field, start, end = "end_date", params["period"], params["period"]
        else:
            field = dataset.date_field
            day = params.get(_day_parameter(dataset, params))
            start, end = (day, day) if day else (params["start_date"], params["end_date"])
        position = table.column(field)
        for row in table.rows:
            actual = coerce_day(row[position])
            if actual is None or not start <= day_text(actual) <= end:
                raise TushareError("Tushare 返回查询范围外或日期无效的记录", kind="invalid_response")

    def pages(self, name: str, params: dict, limit: int, *, first: Table | None = None,
              fields: str | None = None) -> Iterator[Table]:
        offset, seen = 0, set()
        page = first if first is not None else self.read(name, {**params, "limit": limit, "offset": offset}, fields=fields)
        while True:
            keys = {tuple(row) for row in page.rows}
            if len(page.rows) > limit or not seen.isdisjoint(keys):
                raise TushareError("Tushare 分页返回了重复或超限的记录", kind="incomplete")
            yield page
            if len(page.rows) < limit:
                return
            seen.update(keys)
            offset += len(page.rows)
            page = self.read(name, {**params, "limit": limit, "offset": offset}, fields=fields)

    def date_range(self, name: str, params: dict, start: date, end: date, *, fields: str | None = None) -> Iterator[Table]:
        span = {**params, "start_date": day_text(start), "end_date": day_text(end)}
        page = self.read(name, span, fields=fields)
        if self.dataset.limit and len(page.rows) >= self.dataset.limit and start < end:
            middle = start + (end - start) // 2
            yield from self.date_range(name, params, start, middle, fields=fields)
            yield from self.date_range(name, params, middle + timedelta(days=1), end, fields=fields)
        elif self.dataset.limit and len(page.rows) >= self.dataset.limit:
            yield from self.pages(name, span, self.dataset.limit, first=page, fields=fields)
        else:
            yield page

    def adjusted_tables(self, params: dict, start: date, end: date) -> Iterator[Table]:
        factors = {}
        for page in self.date_range("adj_factor", params, start, end, fields="ts_code,trade_date,adj_factor"):
            if not page.rows:
                continue
            date_index = page.column("trade_date")
            factor_index = page.column("adj_factor")
            for row in page.rows:
                day = coerce_day(row[date_index])
                factor = row[factor_index]
                if (day in factors or not isinstance(factor, (Decimal, int))
                        or isinstance(factor, bool) or factor <= 0):
                    raise TushareError("复权因子重复或无效", kind="invalid_response")
                factors[day] = Decimal(factor)
        reference_day = max(factors, default=None)
        prices = ("open", "high", "low", "close")
        extra_columns = ["adj_factor", "qfq_base_date", "qfq_base_factor",
                         *(f"{price}_{basis}" for basis in ("qfq", "hfq") for price in prices)]
        for page in self.date_range("daily", params, start, end):
            if not page.rows:
                continue
            date_index = page.column("trade_date")
            price_indices = [page.column(price) for price in prices]
            adjusted = []
            for row in page.rows:
                factor = factors.get(coerce_day(row[date_index]))
                if factor is None:
                    raise TushareError("有行情记录缺少同一交易日的复权因子", kind="adjustment_missing")
                reference = factors[reference_day]
                values = [row[index] for index in price_indices]
                if any(not isinstance(value, (Decimal, int)) or isinstance(value, bool) or value <= 0 for value in values):
                    raise TushareError("存在无效的原始行情价格", kind="invalid_response")
                hfq = [value * factor for value in values]
                qfq = [round(value / reference, 6) for value in hfq]
                adjusted.append([*row, factor, day_text(reference_day), reference, *qfq, *(round(value, 6) for value in hfq)])
            yield Table([*page.fields, *extra_columns], adjusted, page.size)

    def limited_table(self, params: dict) -> Iterator[Table]:
        if self.dataset.page_size:
            yield from self.pages(self.name, params, self.dataset.page_size)
            return
        page = self.read(self.name, params)
        if self.dataset.limit and len(page.rows) >= self.dataset.limit:
            yield from self.pages(self.name, params, self.dataset.limit, first=page)
        else:
            yield page

    def tables(self, params: dict, filters: Filters) -> Iterator[Table]:
        day_parameter = _day_parameter(self.dataset, params)
        if self.name == "daily_adjusted":
            yield from self.adjusted_tables(params, filters.start_date, filters.end_date)
        elif self.dataset.mode == "period" and self.dataset.market_wide and self.dataset.code_parameter not in params:
            yield from self.pages(self.name + "_vip", params, VIP_PAGE_SIZE)
        elif day_parameter:
            base = {key: value for key, value in params.items() if key not in {"start_date", "end_date"}}
            for offset in range((filters.end_date - filters.start_date).days + 1):
                day = filters.start_date + timedelta(days=offset)
                yield from self.limited_table({**base, day_parameter: day_text(day)})
        elif self.dataset.mode == "range":
            yield from self.date_range(self.name, params, filters.start_date, filters.end_date)
        else:
            yield from self.limited_table(params)

    def rows(self, params: dict, filters: Filters) -> Iterator[list[Any]]:
        columns = None
        for table in self.tables(params, filters):
            if not table.rows:
                continue
            self.count += len(table.rows)
            self.size += table.size
            if self.count > MAX_ROWS or self.size > MAX_BYTES:
                raise TushareError("查询结果超出单次下载体积", kind="export_too_large")
            if columns is None:
                columns = table.fields
                yield columns
            if columns != table.fields:
                raise TushareError("Tushare 各批次返回的字段不一致", kind="invalid_response")
            yield from table.rows
        if not self.count:
            bad_request("所选条件暂无数据，请换一个日期或检查证券代码。", 404, "tushare_empty")


@router.get("/catalog")
def catalog(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return {
        "configured": tushare_settings()["configured"],
        "earliest_date": EARLIEST_DATE.isoformat(), "market_days": MARKET_DAYS,
        "datasets": [
            {"id": name, "category": item.category, "label": item.label, "description": item.description,
             "mode": item.mode, "code_label": item.code_label, "code_example": item.code_example or CODE_EXAMPLES.get(item.code_label),
             "market_wide": item.market_wide, "market_day_limit": bool(_day_parameter(item, {})),
             "always_day_limit": bool(item.day_parameter), "future_dates": item.future_dates,
             "date_label": DATE_LABELS.get(item.date_field),
             "choice": {"label": item.choice.label, "options": item.choice.options} if item.choice else None,
             "points": item.points, "doc_url": f"https://tushare.pro/document/2?doc_id={item.document}"}
            for name, item in DATASETS.items()
        ],
    }


@router.get("/{name}", response_class=Response)
def download(name: str, filters: Filters = Query()):
    dataset = DATASETS.get(name)
    if dataset is None:
        bad_request("找不到所选 Tushare 数据。", 404, "tushare_dataset_not_found")
    params = _query_parameters(dataset, filters, now().date())
    try:
        export = Export(name, dataset)
        scope_keys = (dataset.code_parameter, "list_status", "period", "month", "start_date", "end_date",
                      "start_m", "end_m", "start_q", "end_q")
        scope = [params[key] for key in scope_keys if key in params]
        if dataset.choice and params[dataset.choice.parameter].isascii():
            scope.append(params[dataset.choice.parameter])
        response = csv_response("-".join(["tushare", name, *scope]) + ".csv", export.rows(params, filters))
    except TushareError as exc:
        status, message = {
            "not_configured": (503, "尚未配置 Tushare 数据连接，请在「数据与连接」查看状态。"),
            "denied": (403, "当前 Tushare 连接没有此数据的接口权限。"),
            "rate_limited": (429, "Tushare 请求暂时受限，请稍后重试。"),
            "incomplete": (502, "Tushare 返回的数据可能不完整，请缩短日期范围或指定证券。"),
            "export_too_large": (422, "本次数据量超过下载上限，请缩短日期范围或指定证券。"),
            "adjustment_missing": (502, "部分交易日缺少复权因子，请缩小查询区间。"),
        }.get(exc.kind, (503, error_note(exc)))
        bad_request(message, status, f"tushare_{exc.kind}")
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Row-Count"] = str(export.count)
    return response
