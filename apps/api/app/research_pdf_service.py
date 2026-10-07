"""Persistent PDF jobs. Read endpoints inspect metadata; rendering belongs to workers."""
from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime
from hashlib import sha256
import logging
import os
from pathlib import Path
from uuid import uuid4

from . import conversation_store, db, research_pdf, research_workspace

logger = logging.getLogger(__name__)
SUPPORTED_INPUTS = {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".html", ".htm"}
READ_COLUMNS = "e.id,e.owner_type,e.owner_id,e.source_kind,e.source_id,e.source_revision,e.template_version,e.conversation_id,e.project_id,e.job_id,e.name,e.item_json,e.created_at,e.updated_at"


class ExportError(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def require_owner(owner_type: str, owner_id: str, *, connection=None):
    with (nullcontext(connection) if connection is not None else db.connect()) as conn:
        table = "conversations" if owner_type == "conversation" else "research_projects"
        row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (owner_id,)).fetchone()
        if row is None:
            raise ExportError("找不到这项研究工作。", 404)
        return row


def _item(row) -> dict:
    item = db.json_load(row["item_json"])
    stamp = datetime.fromisoformat(row["created_at"]).timestamp()
    return {"name": row["name"], "bytes": 0, "modified_at": stamp, "url": None,
            "media_type": "application/pdf", "template_version": row["template_version"], **item,
            "id": row["id"], "job_id": row["job_id"], "status": row["job_state"],
            "message": row["job_message"], "source_kind": row["source_kind"],
            "source_id": row["source_id"], "source_revision": row["source_revision"],
            "conversation_id": row["conversation_id"] or "", "project_id": row["project_id"],
            "retry_url": f"/api/v1/{'conversations' if row['owner_type'] == 'conversation' else 'research-projects'}/{row['owner_id']}/research-pdf-jobs/{row['id']}/retry"}


def _row(conn, export_id: str):
    return conn.execute("""SELECT e.*,j.state job_state,j.message job_message FROM research_pdf_exports e
        JOIN jobs j ON j.id=e.job_id WHERE e.id=?""", (export_id,)).fetchone()


def _store_input(conversation_id: str, suffix: str, data: bytes) -> tuple[str, str]:
    digest = sha256(data).hexdigest()
    root = research_pdf._root(conversation_id) / "inputs"
    root.mkdir(exist_ok=True)
    if root.is_symlink() or (hasattr(root, "is_junction") and root.is_junction()):
        raise ExportError("报告输入目录不能使用链接。")
    filename = digest + suffix.lower()
    target = root / filename
    if target.exists() and (target.is_symlink() or target.stat().st_nlink != 1):
        raise ExportError("报告输入文件不能使用链接。")
    if not target.exists():
        temporary = root / f"{uuid4().hex}.partial"
        try:
            temporary.write_bytes(data)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    return filename, digest


def _capture_images(conversation_id: str | None, content: str, *, relative_to="") -> dict:
    """Capture referenced local images only; no directory walk or document layout."""
    if not conversation_id or "![" not in content:
        return {}
    images = {}
    def visit(nodes):
        for node in nodes:
            if node["type"] == "image":
                url = node.get("attrs", {}).get("url", "")
                path = research_pdf._image_resolver(conversation_id, relative_to, read_only=True)(url)
                if path:
                    filename, digest = _store_input(conversation_id, path.suffix, path.read_bytes())
                    images[url] = {"input": filename, "sha256": digest}
            visit(node.get("children", []))
    try:
        visit(research_pdf._markdown(content))
    except Exception as exc:
        # A missing/unwritable PDF input must never roll back an accepted note/body.
        images["__error__"] = str(exc)[:250]
    return images


def _enqueue(owner_type: str, owner_id: str, source_kind: str, source_id: str, source_revision: int,
             name: str, snapshot: dict, *, conversation_id=None, project_id=None, connection=None) -> dict:
    fingerprint = sha256(db.json_dump(snapshot).encode()).hexdigest()
    with (nullcontext(connection) if connection is not None else db.connect()) as conn:
        if connection is None:
            conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute("""SELECT id FROM research_pdf_exports WHERE owner_type=? AND owner_id=?
            AND source_kind=? AND source_id=? AND source_revision=? AND source_fingerprint=? AND template_version=?""",
            (owner_type, owner_id, source_kind, source_id, source_revision, fingerprint, research_pdf.TEMPLATE_VERSION)).fetchone()
        if existing:
            return _item(_row(conn, existing["id"]))
        export_id, job_id, now = str(uuid4()), str(uuid4()), db.utc_now()
        conn.execute("""INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at,required_protocol)
            VALUES(?,'research_pdf',?,'queued','正文已保存，等待生成报告',?,?,'research-pdf-v1')""",
            (job_id, db.json_dump({"export_id": export_id}), now, now))
        conn.execute("""INSERT INTO research_pdf_exports(id,owner_type,owner_id,source_kind,source_id,source_revision,
            source_fingerprint,template_version,conversation_id,project_id,job_id,name,snapshot_json,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (export_id, owner_type, owner_id, source_kind, source_id, source_revision, fingerprint,
             research_pdf.TEMPLATE_VERSION, conversation_id, project_id, job_id, name, db.json_dump(snapshot), now, now))
        return _item(_row(conn, export_id))


def enqueue_turn(conversation_id: str, turn_id: str, *, connection=None, discover_outputs=True) -> dict:
    with (nullcontext(connection) if connection is not None else db.connect()) as conn:
        if connection is None:
            conn.execute("BEGIN IMMEDIATE")
        require_owner("conversation", conversation_id, connection=conn)
        row = conn.execute("SELECT * FROM conversation_turns WHERE id=? AND conversation_id=?", (turn_id, conversation_id)).fetchone()
        if not row or row["workflow_type"] != "research" or row["state"] not in {"succeeded", "awaiting_user"} or not row["response_text"].strip():
            raise ExportError("只能为已完成的研究正文生成报告。", 409)
        snapshot = {key: row[key] for key in ("id", "user_message_id", "workflow_type", "state", "response_text", "created_at")}
        snapshot["research_scope"] = db.json_load(row["research_scope_json"])
        previous = conn.execute("SELECT snapshot_json FROM research_pdf_exports WHERE owner_type='conversation' AND owner_id=? AND source_kind='turn' AND source_id=? ORDER BY rowid LIMIT 1", (conversation_id, turn_id)).fetchone()
        snapshot["images"] = db.json_load(previous[0]).get("images", {}) if previous else _capture_images(conversation_id, row["response_text"])
        stamp = research_pdf._beijing_stamp(row["created_at"])[:10].replace("-", "")
        item = _enqueue("conversation", conversation_id, "turn", turn_id, 0, f"研究报告-{stamp}-{turn_id[:8]}.pdf", snapshot,
                        conversation_id=conversation_id, connection=conn)
        # A separate worker discovers supplementary files and finished scans. No directory walk on the save path.
        if discover_outputs:
            enqueue_discovery("conversation", conversation_id, f"turn:{turn_id}", connection=conn)
        return item


def enqueue_note(project_id: str, note_id: str, revision: int | None = None, *, connection=None) -> dict:
    with (nullcontext(connection) if connection is not None else db.connect()) as conn:
        if connection is None:
            conn.execute("BEGIN IMMEDIATE")
        project = require_owner("project", project_id, connection=conn)
        note = conn.execute("SELECT * FROM research_notes WHERE id=? AND project_id=?", (note_id, project_id)).fetchone()
        if not note:
            raise ExportError("找不到此研究笔记。", 404)
        revision = revision or note["revision"]
        version = conn.execute("SELECT snapshot_json FROM research_note_versions WHERE note_id=? AND revision=?", (note_id, revision)).fetchone()
        if not version:
            raise ExportError("找不到此笔记版本。", 404)
        note_snapshot = db.json_load(version[0])
        claims = [dict(row) for row in conn.execute("SELECT statement,kind,as_of,evidence_json FROM research_claims WHERE note_id=? AND note_revision=? ORDER BY rowid", (note_id, revision))]
        snapshot = {"note": note_snapshot, "project_name": project["name"], "claims": claims}
        previous = conn.execute("SELECT snapshot_json FROM research_pdf_exports WHERE project_id=? AND source_kind='note' AND source_id=? AND source_revision=? ORDER BY rowid LIMIT 1", (project_id, note_id, revision)).fetchone()
        snapshot["images"] = db.json_load(previous[0]).get("images", {}) if previous else _capture_images(note_snapshot.get("source_conversation_id"), note_snapshot["body"])
        return _enqueue("project", project_id, "note", note_id, revision, f"研究笔记-{note_id[:8]}-v{revision}.pdf", snapshot,
                        conversation_id=note_snapshot.get("source_conversation_id"), project_id=project_id, connection=conn)


def enqueue_discovery(owner_type: str, owner_id: str, request_id: str, *, connection=None) -> dict:
    require_owner(owner_type, owner_id, connection=connection)
    return _enqueue(owner_type, owner_id, "discovery", request_id, 0, "整理已有研究报告",
                    {"owner_type": owner_type, "owner_id": owner_id},
                    conversation_id=owner_id if owner_type == "conversation" else None,
                    project_id=owner_id if owner_type == "project" else None, connection=connection)


def enqueue_scan(conversation_id: str, scan_id: str) -> dict:
    from . import research_scan_service
    scan = research_scan_service.get_scan(conversation_id, scan_id)
    if scan["status"] in {"queued", "running"}:
        raise ExportError("研究计算尚未完成。", 409)
    with db.connect() as conn:
        decisions = [db.json_load(row[0]) for row in conn.execute("SELECT decision_json FROM research_scan_decisions WHERE scan_id=? ORDER BY stock_code", (scan_id,))]
    return _enqueue("conversation", conversation_id, "scan", scan_id, 0, f"研究扫描-{scan_id[:8]}.pdf",
                    {"scan": scan, "decisions": decisions}, conversation_id=conversation_id)


def _enqueue_file(conversation_id: str, relative: str) -> dict:
    source = research_workspace.output_path(conversation_id, relative)
    data = source.read_bytes()
    filename, digest = _store_input(conversation_id, source.suffix, data)
    name = relative if source.suffix.lower() == ".pdf" else relative + ".pdf"
    images = _capture_images(conversation_id, data.decode("utf-8-sig"), relative_to=relative) if source.suffix.lower() in {".md", ".markdown", ".txt"} else {}
    return _enqueue("conversation", conversation_id, "file", relative, 0, name,
                    {"relative": relative, "input": filename, "sha256": digest, "modified_at": source.stat().st_mtime, "images": images}, conversation_id=conversation_id)


def _discover(owner_type: str, owner_id: str) -> dict:
    """Runs only on a worker; legacy files are discovered explicitly or after a new turn."""
    require_owner(owner_type, owner_id)
    result = {"queued": 0, "existing": 0, "unsupported": [], "errors": [], "active_workspaces_skipped": []}
    with db.connect() as conn:
        if owner_type == "project":
            ids = [row[0] for row in conn.execute("""SELECT id FROM conversations WHERE project_id=? UNION
                SELECT source_conversation_id FROM research_notes WHERE project_id=? AND source_conversation_id IS NOT NULL""", (owner_id, owner_id))]
            notes = [(row["id"], row["revision"]) for row in conn.execute("""SELECT n.id,v.revision FROM research_notes n
                JOIN research_note_versions v ON v.note_id=n.id WHERE n.project_id=?""", (owner_id,))]
        else:
            ids, notes = [owner_id], []
    def add(operation, *args):
        try:
            item = operation(*args)
            if item["status"] == "succeeded":
                result["existing"] += 1
            elif item["status"] in {"failed", "cancelled", "partial"}:
                result["errors"].append({"source": str(args[-1]), "message": "已有报告生成任务未完成，请单独重试该报告。"})
            else:
                result["queued"] += 1
        except Exception as exc:
            result["errors"].append({"source": str(args[-1]), "message": str(exc)[:250]})
    for note_id, revision in notes:
        add(enqueue_note, owner_id, note_id, revision)
    for cid in ids:
        with db.connect() as conn:
            turns = [row[0] for row in conn.execute("SELECT id FROM conversation_turns WHERE conversation_id=? AND workflow_type='research' AND state IN ('succeeded','awaiting_user') AND response_text<>''", (cid,))]
            scans = [row[0] for row in conn.execute("SELECT id FROM research_scans WHERE conversation_id=? AND status NOT IN ('queued','running')", (cid,))]
            active = conn.execute("SELECT 1 FROM conversation_turns WHERE conversation_id=? AND state IN ('awaiting_agent','running') LIMIT 1", (cid,)).fetchone()
        for turn_id in turns:
            add(lambda c, t: enqueue_turn(c, t, discover_outputs=False), cid, turn_id)
        for scan_id in scans:
            add(enqueue_scan, cid, scan_id)
        if active:
            result["active_workspaces_skipped"].append(cid)
            continue
        for output in research_workspace.list_outputs(cid):
            name = output["name"]
            if name.startswith("tushare/"):
                continue
            if Path(name).suffix.lower() not in SUPPORTED_INPUTS:
                result["unsupported"].append(name)
                continue
            add(_enqueue_file, cid, name)
    return result


def execute_export(lease) -> None:
    with db.connect() as conn:
        row = _row(conn, lease.payload["export_id"])
    if not row or row["job_id"] != lease.id or not lease.active():
        return
    snapshot = db.json_load(row["snapshot_json"])
    try:
        kind = row["source_kind"]
        if kind == "discovery":
            result = _discover(row["owner_type"], row["owner_id"])
            state = "partial" if result["errors"] or result["unsupported"] else "succeeded"
            message = f"已有成果已检查，{result['queued']} 项报告等待生成，{result['existing']} 项已生成。"
            if result["unsupported"]:
                message += f" {len(result['unsupported'])} 个文件格式暂不支持，原件保留。"
            if result["active_workspaces_skipped"]:
                message += " 正在研究的工作区将在本回合完成后再整理。"
            with db.connect() as conn:
                conn.execute("UPDATE research_pdf_exports SET item_json=?,updated_at=? WHERE id=? AND job_id=?", (db.json_dump({"discovery": result}), db.utc_now(), row["id"], lease.id))
            lease.finish(state, message)
            return
        if kind == "turn":
            item = research_pdf.export_turn(row["owner_id"], row["source_id"], source_snapshot=snapshot)
        elif kind == "note":
            item = research_pdf.export_note(row["owner_id"], row["source_id"], revision=row["source_revision"], source_snapshot=snapshot)
        elif kind == "scan":
            item = research_pdf.export_scan(row["owner_id"], row["source_id"], source_snapshot=snapshot)
        else:
            path = research_pdf._root(row["owner_id"], create=False) / "inputs" / snapshot["input"]
            if path.parent.is_symlink() or (hasattr(path.parent, "is_junction") and path.parent.is_junction()) or path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1:
                raise ExportError("保存的报告输入不可用，原件仍保留。")
            data = path.read_bytes()
            if sha256(data).hexdigest() != snapshot["sha256"]:
                raise ExportError("报告输入校验不一致，原件仍保留。")
            item = research_pdf.export_file_snapshot(row["owner_id"], snapshot["relative"], data, modified_at=snapshot["modified_at"], image_path=path, images=snapshot.get("images"))
        # Publish metadata and terminal state under the same lease/transaction.
        with db.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            active = conn.execute("SELECT 1 FROM jobs WHERE id=? AND state='running' AND lease_owner=? AND lease_expires_at>?", (lease.id, lease.owner, db.utc_now())).fetchone()
            if not active:
                return
            conn.execute("UPDATE research_pdf_exports SET item_json=?,updated_at=? WHERE id=? AND job_id=?", (db.json_dump(item), db.utc_now(), row["id"], lease.id))
            conn.execute("UPDATE jobs SET state='succeeded',progress=1,message='报告已生成，正文与原件已保留',updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?", (db.utc_now(), lease.id))
    except Exception as exc:
        logger.exception("PDF job failed: %s", row["id"])
        lease.finish("failed", f"报告生成失败：{str(exc)[:350]}；研究正文已保存，可单独重试报告。")


def list_exports(owner_type: str, owner_id: str) -> list[dict]:
    require_owner(owner_type, owner_id)
    with db.connect() as conn:
        rows = conn.execute(f"""SELECT {READ_COLUMNS},j.state job_state,j.message job_message FROM research_pdf_exports e
            JOIN jobs j ON j.id=e.job_id WHERE e.owner_type=? AND e.owner_id=? ORDER BY e.rowid DESC""", (owner_type, owner_id)).fetchall()
        latest_notes = {row["id"]: row["revision"] for row in conn.execute("SELECT id,revision FROM research_notes WHERE project_id=?", (owner_id,))} if owner_type == "project" else {}
    items, seen_sources, seen_urls = [], set(), set()
    for row in rows:
        if row["source_kind"] == "note" and latest_notes.get(row["source_id"]) != row["source_revision"]:
            continue
        key = (row["source_kind"], row["owner_id"] if row["source_kind"] == "discovery" else row["source_id"], row["source_revision"])
        if key in seen_sources:
            continue
        seen_sources.add(key)
        if row["source_kind"] == "discovery" and row["job_state"] == "succeeded":
            continue
        item = _item(row)
        if item["url"]:
            seen_urls.add(item["url"])
        items.append(item)
    # Existing PDFs remain immediately readable before any background backfill.
    cached = [
        {"conversation_id": owner_id if owner_type == "conversation" else "", "project_id": owner_id if owner_type == "project" else None,
         "modified_at": 0, **item}
        for item in research_pdf.cached_deliverables(owner_id, project=owner_type == "project")
    ]
    for item in sorted(cached, key=lambda value: (-value["modified_at"], value["name"], value["url"])):
        if item["url"] in seen_urls:
            continue
        if owner_type == "project" and not any(item["name"] == f"研究笔记-{nid[:8]}-v{revision}.pdf" for nid, revision in latest_notes.items()):
            continue
        # Never promote a new queued/failed source from an older same-name PDF.
        equivalents = [old for old in items if old["name"] == item["name"]]
        if any(old.get("url") for old in equivalents):
            continue
        if equivalents:
            item["previous"] = True
        if any(old.get("url") and old["name"] == item["name"] for old in items):
            continue
        items.append(item)
    return sorted(items, key=lambda item: (-item["modified_at"], item["name"], item.get("url") or "", item.get("id") or ""))


def note_status(project_id: str, note_id: str, revision: int, *, connection=None) -> dict | None:
    with (nullcontext(connection) if connection is not None else db.connect()) as conn:
        row = conn.execute(f"""SELECT {READ_COLUMNS},j.state job_state,j.message job_message FROM research_pdf_exports e
            JOIN jobs j ON j.id=e.job_id WHERE e.project_id=? AND e.source_kind='note' AND e.source_id=? AND e.source_revision=?
            ORDER BY e.rowid DESC LIMIT 1""", (project_id, note_id, revision)).fetchone()
        return _item(row) if row else None


def download_note(project_id: str, note_id: str, revision: int | None = None) -> dict:
    """Explicit legacy download may render immediately, using the identical queued snapshot."""
    task = enqueue_note(project_id, note_id, revision)
    with db.connect() as conn:
        row = _row(conn, task["id"])
    item = research_pdf.export_note(project_id, note_id, revision=row["source_revision"], source_snapshot=db.json_load(row["snapshot_json"]))
    with db.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        # A queued task can be satisfied by the explicit download; an active worker keeps its own lease.
        if conn.execute("SELECT 1 FROM jobs WHERE id=? AND state='queued'", (row["job_id"],)).fetchone():
            conn.execute("UPDATE research_pdf_exports SET item_json=?,updated_at=? WHERE id=?", (db.json_dump(item), db.utc_now(), row["id"]))
            conn.execute("UPDATE jobs SET state='succeeded',progress=1,message='报告已生成',updated_at=? WHERE id=?", (db.utc_now(), row["job_id"]))
    return item


def retry_export(owner_type: str, owner_id: str, export_id: str) -> dict:
    from . import jobs
    require_owner(owner_type, owner_id)
    with db.connect() as conn:
        row = _row(conn, export_id)
        if not row or row["owner_type"] != owner_type or row["owner_id"] != owner_id:
            raise ExportError("找不到此报告生成任务。", 404)
        if row["job_state"] in {"queued", "running", "succeeded"}:
            return _item(row)
    try:
        jobs.retry(row["job_id"])
    except ValueError as exc:
        raise ExportError(str(exc), 409) from exc
    with db.connect() as conn:
        return _item(_row(conn, export_id))
