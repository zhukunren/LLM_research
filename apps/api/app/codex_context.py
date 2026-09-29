from __future__ import annotations

from .db import connect
from .screening_contracts import ScreeningTaskRevision
from .screening_tools import ToolContext


def task_tool_context(
    conversation_id: str,
    turn_id: str,
    revision: int,
    task: ScreeningTaskRevision | None,
    source_refs: list[dict],
) -> ToolContext:
    """Build the fixed data scope supplied to Codex MCP handlers."""
    scope = task.scope if task else None
    universe = scope.universe if scope else None
    stock_codes = frozenset(universe.stock_codes) if universe and universe.kind == "explicit" else None
    if universe and universe.kind == "watchlist":
        with connect() as connection:
            stock_codes = frozenset(
                row[0]
                for row in connection.execute(
                    "SELECT stock_code FROM watchlist_items WHERE watchlist_id=?",
                    (universe.watchlist_id,),
                )
            )
    return ToolContext(
        conversation_id=conversation_id,
        turn_id=turn_id,
        task_revision=revision,
        as_of=scope.as_of.isoformat() if scope and scope.as_of else None,
        universe_kind=universe.kind if universe else None,
        stock_codes=stock_codes,
        report_lookback_calendar_days=scope.report_lookback_calendar_days if scope else None,
        news_lookback_calendar_days=scope.news_lookback_calendar_days if scope else None,
        allowed_document_ids=frozenset(
            item["source_id"] for item in source_refs if item.get("kind") == "report_page"
        ) or None,
        allowed_news_ids=frozenset(
            item["source_id"] for item in source_refs if item.get("kind") == "news_item"
        ) or None,
    )
