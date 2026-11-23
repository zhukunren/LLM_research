"""Read-only research panels backed by the configured Tushare connection."""
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Path, Query

from . import tushare_company_features as company, tushare_market_features as market
from .tushare_client import TushareError
from .tushare_feature_data import Reader, error_note, now


router = APIRouter(prefix="/api/v1/tushare-features", tags=["Tushare 投研数据"])
STOCK_CODE = Path(pattern=r"^\d{6}\.(SH|SZ|BJ)$")


def as_of_day(value: date | None) -> date:
    today = now().date()
    if value and (value > today or value.year < 2000):
        raise HTTPException(422, "请选择 2000 年至今的截止日期")
    return value or today


def unavailable(exc: TushareError):
    raise HTTPException(503, {"code": "tushare_features_unavailable", "message": error_note(exc)}) from exc


@router.get("/company/{code}/earnings")
def earnings(code: str = STOCK_CODE, as_of: date | None = None,
             year: int | None = Query(None, ge=2000, le=2099),
             window_days: int = Query(30, ge=7, le=90)):
    day = as_of_day(as_of)
    try:
        return company.earnings(Reader(), code, day, year or day.year, window_days)
    except TushareError as exc:
        unavailable(exc)


@router.get("/company/{code}/chips")
def chips(code: str = STOCK_CODE, as_of: date | None = None):
    day = as_of_day(as_of)
    try:
        return company.chips(Reader(), code, day)
    except TushareError as exc:
        unavailable(exc)


@router.get("/company/{code}/institutions")
def institutions(code: str = STOCK_CODE, as_of: date | None = None,
                 month: str | None = Query(None, pattern=r"^\d{4}-(0[1-9]|1[0-2])$")):
    day = as_of_day(as_of)
    latest_month = day if day == now().date() else day.replace(day=1) - timedelta(days=1)
    selected = month or latest_month.strftime("%Y-%m")
    if selected > latest_month.strftime("%Y-%m"):
        raise HTTPException(422, "历史截止日请选择已结束的月份")
    try:
        return company.institutions(Reader(), code, day, selected)
    except TushareError as exc:
        unavailable(exc)


@router.get("/rotation")
def rotation(as_of: date | None = None):
    as_of_day(as_of)
    try:
        return market.rotation(Reader(), as_of)
    except TushareError as exc:
        unavailable(exc)


@router.get("/etf")
def etf(as_of: date | None = None):
    as_of_day(as_of)
    try:
        return market.etf_peers(Reader(), as_of)
    except TushareError as exc:
        unavailable(exc)
