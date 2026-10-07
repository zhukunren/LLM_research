"""Read model for user-visible work; never submits, recovers or authorizes jobs."""
from __future__ import annotations

from .db import connect


KIND_LABELS = {
    "research_turn": "研究对话",
    "research_scan": "研究计算",
    "screening_task": "条件选股",
    "screening": "条件选股",
    "report_evaluation": "研报评估",
    "report_metadata": "研报整理",
    "data_sync": "资料更新",
    "research_pdf": "报告生成",
}
STATE_LABELS = {
    "queued": "排队中", "running": "处理中", "awaiting_user": "待补充",
    "succeeded": "已完成", "partial": "部分完成", "failed": "需重试", "cancelled": "已停止",
    "blocked_dependency": "待准备",
}


def _presentation(kind: str, state: str, conversation_id: str | None, scope: str | None, project_id: str | None = None) -> tuple[str, dict]:
    if state == "blocked_dependency":
        return "检查数据与服务", {"kind": "settings"}
    if conversation_id:
        destination = {"kind": "conversation", "conversation_id": conversation_id, "scope": scope or "screening"}
        action = "补充要求" if state == "awaiting_user" else "查看原因并重试" if state == "failed" else "查看结果" if state in {"succeeded", "partial"} else "查看进展"
    elif project_id:
        destination, action = {"kind": "project", "project_id": project_id}, "查看研究笔记"
    elif kind == "data_sync":
        destination, action = {"kind": "settings"}, "查看数据更新"
    elif kind in {"report_evaluation", "report_metadata"}:
        destination, action = {"kind": "page", "page": "reports"}, "打开研报库"
    elif kind == "screening":
        destination, action = {"kind": "page", "page": "conditions"}, "打开条件选股"
    else:
        destination, action = {"kind": "settings"}, "查看服务状态"
    return action, destination


def _stage(kind: str, state: str) -> str:
    if state == "blocked_dependency":
        return "所需数据或助手配置尚未就绪，请先检查数据与服务。"
    if state == "queued":
        return "等待后台开始，可以先做其他工作。"
    if state == "awaiting_user":
        return "需要补充信息，打开原对话查看具体问题。"
    if state == "failed":
        return "处理未完成，已有工作仍保留；打开详情查看恢复方式。"
    if state == "partial":
        return "已保存可用结果，部分资料或计算仍需核对。"
    if state == "cancelled":
        return "任务已停止，可以回到原工作继续。"
    if state == "succeeded":
        return "结果已保存，可以打开查看。"
    if state != "running":
        return "任务状态需要核对，请打开原工作确认。"
    return {
        "research_turn": "正在查证和整理研究，可离开页面后再回来。",
        "research_scan": "正在计算研究指标，可在原对话查看进展。",
        "screening_task": "正在按已确认的条件筛选。",
        "screening": "正在按已确认的条件筛选。",
        "report_evaluation": "正在按固定条件核对研报证据。",
        "report_metadata": "正在整理研报标题、公司与原文信息。",
        "data_sync": "正在更新名称、行情和资讯，原有资料仍可使用。",
        "research_pdf": "正文已保存，正在生成可下载报告。",
    }.get(kind, "后台正在处理，原有工作仍保留。")


def list_tasks(*, active_only: bool = True, limit: int = 100) -> dict:
    """Combine background jobs and unqueued turns, filtering before pagination."""
    limit = max(1, min(limit, 200))
    active_states = "('queued','running')"
    with connect() as connection:
        job_filter = f"WHERE j.state IN {active_states}" if active_only else ""
        rows = connection.execute(f"""
            SELECT j.id,j.kind,j.state,j.created_at,j.updated_at,
                   COALESCE(tj.conversation_id,sc.conversation_id,sr.conversation_id,pe.conversation_id) conversation_id,
                   c.entry_scope,c.workflow_type,pe.project_id,
                   CASE WHEN j.kind='research_turn' AND t.state='awaiting_user'
                        THEN 'awaiting_user' ELSE j.state END display_state,
                   COALESCE(sc.name,pe.name,
                     (SELECT substr(m.content,1,120) FROM conversation_messages m
                      WHERE m.conversation_id=c.id AND m.role='user' ORDER BY m.rowid LIMIT 1),
                     d.title,d.filename,'') title
            FROM jobs j
            LEFT JOIN research_turn_jobs tj ON tj.job_id=j.id
            LEFT JOIN conversation_turns t ON t.id=tj.turn_id
            LEFT JOIN research_scans sc ON sc.job_id=j.id
            LEFT JOIN screening_task_runs sr ON sr.job_id=j.id
            LEFT JOIN research_pdf_exports pe ON j.kind='research_pdf' AND pe.id=json_extract(j.payload_json,'$.export_id')
            LEFT JOIN conversations c ON c.id=COALESCE(tj.conversation_id,sc.conversation_id,sr.conversation_id,pe.conversation_id)
            LEFT JOIN documents d ON d.metadata_job_id=j.id
            {job_filter}
            ORDER BY CASE WHEN j.state IN {active_states} THEN 0 ELSE 1 END,
                     j.updated_at DESC,j.id DESC LIMIT ?
        """, (limit,)).fetchall()
        turn_filter = "AND t.state IN ('awaiting_agent','running')" if active_only else ""
        turns = connection.execute(f"""
            SELECT t.id,t.state,t.created_at,t.updated_at,c.id conversation_id,
                   c.entry_scope,c.workflow_type,substr(m.content,1,120) title
            FROM conversation_turns t
            JOIN conversations c ON c.id=t.conversation_id
            JOIN conversation_messages m ON m.id=t.user_message_id
            WHERE NOT EXISTS (SELECT 1 FROM research_turn_jobs tj WHERE tj.turn_id=t.id)
              AND c.state='active' {turn_filter}
            ORDER BY CASE WHEN t.state IN ('awaiting_agent','running') THEN 0 ELSE 1 END,
                     t.updated_at DESC,t.id DESC LIMIT ?
        """, (limit,)).fetchall()
        active_count = connection.execute("SELECT count(*) FROM jobs WHERE state IN ('queued','running')").fetchone()[0]
        active_count += connection.execute("""SELECT count(*) FROM conversation_turns t JOIN conversations c ON c.id=t.conversation_id
            WHERE c.state='active' AND t.state IN ('awaiting_agent','running')
              AND NOT EXISTS (SELECT 1 FROM research_turn_jobs tj WHERE tj.turn_id=t.id)""").fetchone()[0]
    items = []
    for row in rows:
        kind, state = row["kind"], row["display_state"]
        action, destination = _presentation(kind, state, row["conversation_id"], row["entry_scope"], row["project_id"])
        items.append({
            "id": f"job:{row['id']}", "kind": kind, "title": row["title"] or KIND_LABELS.get(kind, "后台任务"),
            "kind_label": "条件选股" if kind == "research_turn" and row["workflow_type"] == "screening" else KIND_LABELS.get(kind, "后台任务"), "state": state, "state_label": STATE_LABELS.get(state, "待核对"),
            "stage": _stage(kind, state), "created_at": row["created_at"], "updated_at": row["updated_at"],
            "action_label": action, "destination": destination,
        })
    for row in turns:
        state = "queued" if row["state"] == "awaiting_agent" else row["state"]
        action, destination = _presentation("research_turn", state, row["conversation_id"], row["entry_scope"])
        waiting_to_submit = row["state"] == "awaiting_agent"
        items.append({
            "id": f"turn:{row['id']}", "kind": "research_turn", "title": row["title"] or "待继续的对话",
            "kind_label": "条件选股" if row["workflow_type"] == "screening" else "研究对话",
            "state": state, "state_label": "待继续" if waiting_to_submit else STATE_LABELS.get(state, "待核对"),
            "stage": "尚未进入后台，打开原对话继续处理。" if waiting_to_submit else _stage("research_turn", state),
            "created_at": row["created_at"], "updated_at": row["updated_at"], "action_label": "继续处理" if waiting_to_submit else action, "destination": destination,
        })
    items.sort(key=lambda item: (item["updated_at"], item["id"]), reverse=True)
    items.sort(key=lambda item: 0 if item["state"] in {"queued", "running"} else 1)
    return {"items": items[:limit], "active_count": active_count}
