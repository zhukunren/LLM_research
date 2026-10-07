from __future__ import annotations

from .db import connect
from . import conversation_store
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
    # A turn owns its workflow and research scope snapshot. A prior screening
    # plan remains readable history, and cannot become a new research scope.
    conversation = conversation_store.get_conversation(conversation_id, message_limit=1)
    try:
        turn = conversation_store.get_turn(conversation_id, turn_id)
    except conversation_store.ConversationNotFound:
        turn = conversation
    workflow = turn.get("workflow_type", conversation.get("workflow_type", "research"))
    depth = turn.get("research_depth", conversation.get("research_depth", "standard"))
    research_scope = turn.get("research_scope", conversation.get("research_scope", {})) or {}
    if workflow == "research":
        codes = research_scope.get("stock_codes") or []
        return ToolContext(
            conversation_id=conversation_id, turn_id=turn_id,
            task_revision=turn.get("base_revision", revision),
            workflow_type=workflow, research_depth=depth,
            research_scope_revision=turn.get("research_scope_revision", conversation.get("research_scope_revision", 0)),
            as_of=research_scope.get("as_of"), universe_kind="explicit" if codes else "all_a_shares",
            stock_codes=frozenset(codes) if codes else None,
            report_lookback_calendar_days=research_scope.get("report_lookback_calendar_days"),
            news_lookback_calendar_days=research_scope.get("news_lookback_calendar_days"),
        )
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
        workflow_type=workflow,
        research_depth=depth,
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
