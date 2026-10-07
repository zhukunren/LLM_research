"""Shared capability queries used by HTTP and Agent tools."""
from . import market, runtime_executor
from .db import connect
from .indicators import INDICATORS
from .screening_capabilities import build_manifest, market_coverage
from .settings import llm_settings


def screening_capability_manifest(*, stock_file=None, model_configured: bool | None = None):
    from .screening_tools import registry
    with connect() as connection:
        reports = connection.execute("SELECT COUNT(DISTINCT document_id) FROM document_pages").fetchone()[0]
        patterns = connection.execute("SELECT COUNT(*) FROM patterns").fetchone()[0]
        news = connection.execute("SELECT COUNT(DISTINCT root_id) FROM news_records").fetchone()[0]
    return build_manifest(
        market_available=market.daily_bar_source_available(stock_file or market.STOCK_FILE),
        indexed_reports=reports, saved_patterns=patterns, indexed_news=news,
        builtin_indicators=INDICATORS,
        model_configured=bool(llm_settings()["configured"]) if model_configured is None else model_configured,
        registered_tool_names=registry.registered_tool_names(), runtime_ready=runtime_executor.readiness()["ready"],
    )


def data_coverage():
    return market_coverage(market.cached_profile())
