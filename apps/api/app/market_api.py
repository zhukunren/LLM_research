from __future__ import annotations

from fastapi import APIRouter

from . import capability_service, market
from .api_responses import bad_request
from .indicators import INDICATORS, chart_display, values
from .models import IndicatorPreviewInput

router = APIRouter(prefix="/api/v1")


@router.get("/data/status")
def data_status():
    return market.cached_profile()


@router.get("/data/coverage")
def data_coverage():
    return capability_service.data_coverage()


@router.get("/securities")
def securities(query: str = "", market_code: str = "", limit: int = 100):
    return {"items": market.search_securities(query, market_code, limit)}


@router.get("/securities/{stock_code}/bars")
def security_bars(stock_code: str, as_of: str | None = None, limit: int = 250):
    items = market.get_bars(stock_code, as_of, limit)
    if not items:
        bad_request("找不到该证券在指定日期前的行情", 404, "bars_not_found")
    return {"stock_code": stock_code, "items": items, "price_basis": market.PRICE_BASIS, "volume_unit": "unknown", "amount_unit": "unknown"}


@router.get("/indicators")
def indicators():
    return {"items": INDICATORS}


@router.post("/indicators/preview")
def indicator_preview(payload: IndicatorPreviewInput):
    bars = market.get_bars(payload.stock_code, payload.as_of, min(500, payload.window + 250))
    price_basis = market.PRICE_BASIS if bars else "unknown"
    if not bars and payload.stock_code == "000001.SH":
        from .index_market import get_bars
        try:
            bars = get_bars(payload.as_of, min(500, payload.window + 250))
        except ValueError as exc:
            bad_request(str(exc), 503, "index_unavailable")
        source_basis = {
            "Tushare index_daily": "unadjusted",
            "腾讯行情 / 上证指数": "forward_adjusted",
        }
        observed_bases = {source_basis.get(bar.get("source"), "unknown") for bar in bars}
        if len(observed_bases) == 1:
            price_basis = next(iter(observed_bases))
        elif observed_bases:
            price_basis = "mixed"
    if not bars:
        bad_request("没有可用行情", 404, "bars_not_found")
    if payload.field == "volume" and payload.indicator not in {"sma"}:
        bad_request("该指标不支持成交量字段")
    series = values(bars, payload.indicator, payload.window, payload.field)
    display = chart_display(bars, payload.indicator, payload.window, payload.field)
    chart_limit = min(120, len(bars))
    def trimmed(item: dict) -> dict:
        return {**item, "values": item["values"][-chart_limit:]}
    chart = {
        "placement": display["placement"],
        "lines": [trimmed(item) for item in display["lines"]],
        "histogram": trimmed(display["histogram"]) if display["histogram"] else None,
        "reference_lines": display["reference_lines"],
        "bars": [
            {key: bar.get(key) for key in ("trade_date", "open", "high", "low", "close", "volume")}
            for bar in bars[-chart_limit:]
        ],
    }
    return {
        "stock_code": payload.stock_code, "indicator": payload.indicator, "window": payload.window,
        "field": payload.field, "as_of": bars[-1]["trade_date"],
        "current": series[-1] if series else None, "previous": series[-2] if len(series) > 1 else None,
        "series": [{"date": bar["trade_date"], "value": value} for bar, value in zip(bars, series)],
        "chart": chart,
        "warmup_bars": payload.window, "history_available": len(bars),
        "state": "known" if series and series[-1] is not None else "unknown",
        "price_basis": price_basis,
        "warning": (
            {
                "unadjusted": "指标按未复权收盘价计算。",
                "forward_adjusted": "指标按腾讯前复权指数收盘价计算。",
                "mixed": "指数行情包含不同价格口径，指标结果可能不连续。",
                "unknown": "行情价格口径未知。",
            }.get(price_basis, "行情价格口径未知。")
            if payload.field == "close"
            else "原始成交量单位尚未确认。"
        ),
    }
