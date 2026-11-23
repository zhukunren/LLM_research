"""Shared history view for condition combinations and conversation runs."""

from .db import connect, json_load


def list_runs(limit: int) -> list[dict]:
    # Both sources report the version accepted at submission as strategy_version.
    # Apply the limit to the combined history, including runs with the same time.
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT r.id AS id, r.strategy_id, r.strategy_version, r.as_of, r.status,
                   r.created_at AS created_at, s.name, 'legacy' AS kind,
                   NULL AS snapshot_json, NULL AS conversation_id, NULL AS entry_scope
            FROM screening_runs r
            LEFT JOIN strategies s ON s.id = r.strategy_id AND s.version = r.strategy_version
            UNION ALL
            SELECT r.id, '', r.task_revision, r.as_of, r.status,
                   r.created_at, NULL, 'conversation',
                   r.snapshot_json, r.conversation_id, c.entry_scope
            FROM screening_task_runs r
            JOIN conversations c ON c.id = r.conversation_id
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    items = []
    for row in rows:
        item = dict(row)
        snapshot = item.pop("snapshot_json")
        if item["kind"] == "conversation":
            task = json_load(snapshot).get("task", {})
            descriptions = "；".join(condition.get("description", "") for condition in task.get("conditions", []))
            item["name"] = descriptions[:120] or "对话选股方案"
        else:
            del item["conversation_id"], item["entry_scope"]
        items.append(item)
    return items
