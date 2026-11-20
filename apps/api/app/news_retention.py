"""The local news window and opt-in cleanup for the current workspace."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
import hashlib
import logging
import re

from .db import connect, utc_now


DAYS = 30
LOCAL_ZONE = timezone(timedelta(hours=8))
BATCH_SIZE = 250
_RECORD_ID = re.compile(r"\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b", re.I)

# Keep versions cited through older Markdown links as well as structured evidence.
_REFERENCES = (
    ("conversation_messages", "content, source_refs_json"),
    ("conversation_turns", "response_text, result_json"),
    ("codex_turn_events", "payload_json"),
    ("research_message_evidence", "evidence_json"),
    ("research_conversation_shares", "snapshot_json"),
    ("research_observation_candidates", "source_refs_json, source_text"),
    ("observation_notes", "note"),
    ("research_notes", "body"),
    ("research_note_versions", "snapshot_json"),
    ("research_tracking_checks", "snapshot_json, changes_json"),
    ("research_claims", "evidence_json, numeric_evidence_json"),
    ("research_matrices", "definition_json"),
    ("research_matrix_runs", "inputs_json, result_json"),
    ("research_matrix_cell_reviews", "payload_json"),
    ("research_pdf_exports", "source_id, snapshot_json, item_json"),
    ("research_scans", "snapshot_json, result_json"),
    ("research_scan_decisions", "decision_json"),
    ("screening_draft_sources", "source_snapshot_json"),
    ("screening_task_revisions", "task_json"),
    ("screening_task_runs", "snapshot_json, result_json"),
    ("screening_task_decisions", "decision_json"),
    ("screening_runs", "context_json, result_json"),
    ("screening_decisions", "detail_json"),
    ("intelligence_runs", "result_json"),
    ("intelligence_source_requests", "source_id"),
    ("investment_monitor_events", "source_url, source_key, summary"),
    ("news_url_imports", "result_json"),
)


class PreviewChanged(ValueError):
    pass


def today() -> date:
    return datetime.now(LOCAL_ZONE).date()


def cutoff_day(day: date) -> date:
    return day - timedelta(days=DAYS - 1)


def day_start(day: date) -> str:
    return datetime.combine(day, time.min, LOCAL_ZONE).astimezone(timezone.utc).isoformat()


def window(day: date) -> tuple[str, str]:
    return day_start(cutoff_day(day)), day_start(day + timedelta(days=1))


def article_time(alias: str) -> str:
    return f"COALESCE({alias}.published_at, {alias}.available_at, {alias}.created_at)"


def _candidates(connection, cutoff: str) -> tuple[list[str], int]:
    rows = connection.execute(f"""
        SELECT id, root_id FROM news_records WHERE root_id IN (
            SELECT n.root_id FROM news_records n
            WHERE n.origin='tushare' AND {article_time('n')}<?
            GROUP BY n.root_id HAVING COUNT(*)=(
                SELECT COUNT(*) FROM news_records v WHERE v.root_id=n.root_id
            )
        )
    """, (cutoff,)).fetchall()
    if not rows:
        return [], 0
    root_by_id = {row["id"].lower(): row["root_id"] for row in rows}
    roots = set(root_by_id.values())
    protected = {root for item_id, root in root_by_id.items() if not _RECORD_ID.fullmatch(item_id)}
    for table, fields in _REFERENCES:
        if protected == roots:
            break
        for row in connection.execute(f"SELECT {fields} FROM {table}"):
            for value in row:
                if isinstance(value, str):
                    protected.update(
                        root_by_id[match[0].lower()]
                        for match in _RECORD_ID.finditer(value)
                        if match[0].lower() in root_by_id
                    )
    return sorted(roots - protected), len(protected)


def _enabled(connection) -> bool:
    return bool(connection.execute("SELECT enabled FROM news_retention_settings WHERE singleton=1").fetchone()[0])


def _status(connection, day: date) -> dict:
    cutoff = cutoff_day(day)
    eligible, protected = _candidates(connection, day_start(cutoff))
    last = connection.execute(
        "SELECT * FROM news_retention_runs ORDER BY run_day DESC LIMIT 1"
    ).fetchone()
    token = hashlib.sha256("\n".join((cutoff.isoformat(), str(protected), *eligible)).encode()).hexdigest()
    return {
        "enabled": _enabled(connection), "days": DAYS, "cutoff_day": cutoff.isoformat(),
        "eligible_count": len(eligible), "protected_count": protected, "preview_token": token,
        "last_run": dict(last) if last else None,
    }


def status() -> dict:
    with connect() as connection:
        connection.execute("BEGIN")
        return _status(connection, today())


def set_enabled(enabled: bool, preview_token: str | None) -> dict:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        preview = _status(connection, today())
        if enabled and not preview["enabled"] and preview_token != preview["preview_token"]:
            raise PreviewChanged("待清理资讯已变化，请重新预览后确认。")
        connection.execute("UPDATE news_retention_settings SET enabled=? WHERE singleton=1", (int(enabled),))
        return {**preview, "enabled": enabled}


def _needs_run(connection, day: str) -> bool:
    return _enabled(connection) and connection.execute(
        "SELECT 1 FROM news_retention_runs WHERE run_day=? AND finished_at IS NOT NULL", (day,)
    ).fetchone() is None


def cleanup_due() -> None:
    day = today()
    run_day, cutoff = day.isoformat(), cutoff_day(day)
    with connect() as connection:
        if not _needs_run(connection, run_day):
            return
        connection.execute("BEGIN IMMEDIATE")
        if not _needs_run(connection, run_day) or connection.execute("""
            SELECT 1 FROM jobs WHERE state IN ('queued','running')
            UNION ALL SELECT 1 FROM conversation_turns WHERE state IN ('awaiting_agent','running') LIMIT 1
        """).fetchone():
            return
        eligible, protected = _candidates(connection, day_start(cutoff))
        batch = eligible[:BATCH_SIZE]
        connection.execute(
            "INSERT OR IGNORE INTO news_retention_runs(run_day,cutoff_day,started_at) VALUES(?,?,?)",
            (run_day, cutoff.isoformat(), utc_now()),
        )
        if batch:
            marks = ",".join("?" for _ in batch)
            connection.execute(f"DELETE FROM news_records WHERE root_id IN ({marks})", batch)
        finished = len(eligible) <= BATCH_SIZE
        receipts = 0
        if finished:
            receipts = connection.execute("""
                DELETE FROM news_import_requests
                WHERE origin='tushare' AND json_valid(result_json)
                    AND json_array_length(result_json, '$.items') > 0
                    AND NOT EXISTS (
                        SELECT 1 FROM json_each(CASE WHEN json_valid(news_import_requests.result_json)
                            THEN news_import_requests.result_json ELSE '{}' END, '$.items') item
                        LEFT JOIN news_records n ON n.id=json_extract(
                            CASE WHEN item.type='object' THEN item.value ELSE '{}' END, '$.id'
                        )
                        WHERE item.type<>'object' OR n.id IS NOT NULL
                    )
            """).rowcount
        connection.execute("""
            UPDATE news_retention_runs SET deleted_count=deleted_count+?, receipt_count=receipt_count+?,
                protected_count=?, finished_at=? WHERE run_day=?
        """, (len(batch), receipts, protected, utc_now() if finished else None, run_day))


def scheduler_tick() -> None:
    from .db import database_path, ensure_initialized
    from .security_context import LOCAL_ACTOR, AccessDenied, actor_scope, auth_mode, can_write

    if auth_mode() == "oidc":
        from .identity import execution_actors
        actors = execution_actors()
    else:
        actors = [LOCAL_ACTOR]
    for actor in actors:
        if not actor.platform_admin or not can_write(actor):
            continue
        try:
            with actor_scope(actor):
                if database_path().is_file():
                    ensure_initialized()
                    cleanup_due()
        except AccessDenied:
            continue
        except Exception:
            logging.getLogger(__name__).exception("News retention failed")
