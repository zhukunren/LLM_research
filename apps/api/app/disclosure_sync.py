"""Manual disclosure ingestion through recoverable background jobs."""
from __future__ import annotations

import hashlib

from . import disclosures, disclosure_sources, documents
from .db import connect, utc_now
from .report_parser import ReportParserError


def _checkpoint(lease, import_id, *, stage, sha=None, final_url=None) -> bool:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if not connection.execute("SELECT 1 FROM jobs WHERE id=? AND state='running' AND lease_owner=? AND lease_expires_at>?",
                                  (lease.id, lease.owner, utc_now())).fetchone():
            return False
        updated = connection.execute("""UPDATE disclosure_imports SET stage=?,sha256=COALESCE(?,sha256),
            final_url=COALESCE(?,final_url) WHERE id=? AND job_id=?""", (stage, sha, final_url, import_id, lease.id))
        return bool(updated.rowcount)


def execute(lease):
    import_id = lease.payload["import_id"]
    item = disclosures.read_import(import_id)
    if item["job_id"] != lease.id:
        lease.finish("cancelled", "已有新的导入任务，请查看最新进度")
        return
    if item["version_id"]:
        lease.finish("succeeded", "原始披露已归档")
        return
    try:
        sha = item["sha256"]
        if not sha:
            if not _checkpoint(lease, import_id, stage="downloading"):
                return
            lease.progress(.1, "正在下载官方 PDF 原文")
            data, final_url = disclosure_sources.download(item["request"]["url"], active=lease.active)
            sha = hashlib.sha256(data).hexdigest()
            if not lease.active():
                return
            documents._store_original(data, sha)
            del data
            if not _checkpoint(lease, import_id, stage="downloaded", sha=sha, final_url=final_url):
                return
        if not _checkpoint(lease, import_id, stage="parsing"):
            return
        lease.progress(.45, "正在解析原始披露并保留物理页码")
        result = documents.index_pdf_snapshot(documents._snapshot_path(sha), sha, item["filename"], material_kind="disclosure")
        if not lease.active():
            return
        with connect() as connection:
            first_pages = "\n".join(row[0] for row in connection.execute(
                "SELECT text FROM document_pages WHERE document_id=? AND page_number<=3 ORDER BY page_number", (result["id"],)))
        hints = disclosures.suggestions(item["filename"], first_pages)
        if disclosures.publish(import_id, result["id"], hints, lease):
            stored = disclosures.read_import(import_id)
            message = "相同原文已归档，已返回已有版本" if stored["outcome"] == "duplicate" else "原始披露已归档，可核对分类与阅读原文"
            lease.finish("succeeded", message)
    except InterruptedError:
        if lease.active():
            lease.finish("cancelled", "原始披露导入已停止")
    except (ValueError, OSError) as exc:
        message = str(exc) if isinstance(exc, (ValueError, ReportParserError)) else "原始文件保存或读取失败，请重试"
        lease.finish("failed", message[:300])
