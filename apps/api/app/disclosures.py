"""Versioned primary disclosures, separate from brokerage report classification."""
from __future__ import annotations

from datetime import date
import hashlib
import json
from pathlib import Path
import re
from typing import Literal
from uuid import uuid4

from pydantic import Field, field_validator, model_validator

from .db import connect, json_dump, json_load, utc_now
from . import documents
from .disclosure_sources import official_url, validate_pdf
from .screening_contracts import ContractModel
from .security_context import AccessDenied, can_write, current_actor

DocumentType = Literal["annual", "half_year", "q1", "q3", "audit", "correction", "other"]
DocumentForm = Literal["full", "summary", "notice"]
IDENTITY_FIELDS = ("stock_code", "report_period", "document_type", "document_form")


class DisclosureError(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


class Metadata(ContractModel):
    title: str = Field(default="", max_length=300)
    stock_code: str | None = Field(default=None, pattern=r"^\d{6}\.(SH|SZ|BJ)$")
    report_period: date | None = None
    document_type: DocumentType = "other"
    document_form: DocumentForm = "full"
    publication_date: date | None = None
    confirmed: bool = False

    @field_validator("stock_code", "report_period", "publication_date", mode="before")
    @classmethod
    def empty(cls, value):
        return None if value == "" else value

    @model_validator(mode="after")
    def validate_classification(self):
        if self.confirmed and (not self.stock_code or not self.report_period):
            raise ValueError("确认分类前请填写公司和报告期")
        expected = {"annual": (12, 31), "half_year": (6, 30), "q1": (3, 31), "q3": (9, 30)}
        if self.report_period and self.document_type in expected:
            if (self.report_period.month, self.report_period.day) != expected[self.document_type]:
                raise ValueError("报告期末与报告类型不一致")
            if self.publication_date and self.publication_date < self.report_period:
                raise ValueError("定期报告披露日期不能早于报告期末")
        return self


class ImportRequest(ContractModel):
    request_id: str = Field(min_length=1, max_length=100)
    metadata: Metadata = Field(default_factory=Metadata)
    url: str | None = Field(default=None, max_length=2000)
    relation: Literal["new", "revision", "supplement"] = "new"
    target_version_id: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def relationship(self):
        if (self.relation == "new") != (self.target_version_id is None):
            raise ValueError("修订或补充材料必须选择原版本；新披露不应指定原版本")
        if self.url:
            self.url = official_url(self.url)
        return self


class MetadataUpdate(ContractModel):
    base_revision: int = Field(ge=1)
    metadata: Metadata
    propagate_identity: bool = False


def _write():
    if not can_write(current_actor()):
        raise AccessDenied("当前账户只有查看权限")


def _metadata(connection, version_id: str) -> dict:
    row = connection.execute("SELECT * FROM disclosure_metadata WHERE version_id=? ORDER BY revision DESC LIMIT 1", (version_id,)).fetchone()
    if not row:
        raise DisclosureError("找不到此原始披露版本", 404)
    return {"revision": row["revision"], **json_load(row["metadata_json"]), "suggestions": json_load(row["suggestions_json"])}


def _version(connection, version_id: str, *, as_of: str | None = None) -> dict:
    row = connection.execute("""SELECT v.*,d.pages,d.parse_status,d.filename,d.parser_metadata_json
        FROM disclosure_versions v JOIN documents d ON d.id=v.document_id WHERE v.id=?""", (version_id,)).fetchone()
    if not row:
        raise DisclosureError("找不到此原始披露版本", 404)
    result = dict(row)
    result["metadata"] = _metadata(connection, version_id)
    meta = result["metadata"]
    if as_of and (not meta["confirmed"] or not meta.get("publication_date") or meta["publication_date"] > as_of):
        raise DisclosureError("此版本的披露日期未确认或晚于研究截止日", 404)
    result["parser_metadata"] = json_load(result.pop("parser_metadata_json"))
    result["pdf_url"] = f"/api/v1/disclosures/versions/{version_id}/pdf"
    if as_of:
        result["pdf_url"] += "?as_of=" + as_of
    result["availability_basis"] = "user_confirmed" if meta["confirmed"] and meta.get("publication_date") else "unconfirmed"
    result["classification_status"] = "confirmed" if meta["confirmed"] else "pending"
    return result


def _check_target(connection, request: ImportRequest, *, publishing=False):
    if not request.target_version_id:
        return None
    target = _version(connection, request.target_version_id)
    if not target["metadata"]["confirmed"] or not request.metadata.confirmed:
        raise DisclosureError("请先核对原版本及本次材料的公司、报告期和类型，再建立修订或补充关系")
    fields = IDENTITY_FIELDS if request.relation == "revision" else ("stock_code", "report_period")
    values = request.metadata.model_dump(mode="json")
    if any(values[field] != target["metadata"][field] for field in fields):
        raise DisclosureError("修订全文须同公司、报告期、类型和全文/摘要口径；更正公告请作为相关补充材料归档")
    if request.relation == "revision":
        latest = connection.execute("SELECT id FROM disclosure_versions WHERE disclosure_id=? ORDER BY version DESC LIMIT 1",
                                    (target["disclosure_id"],)).fetchone()[0]
        if latest != target["id"]:
            raise DisclosureError("原材料已有新版本，请刷新后以最新版本提交修订", 409)
        previous_date = target["metadata"].get("publication_date")
        if previous_date and request.metadata.publication_date and request.metadata.publication_date.isoformat() < previous_date:
            raise DisclosureError("修订披露日期不能早于被修订版本")
    return target


def enqueue(request: ImportRequest, *, data: bytes | None = None, filename: str = "原始披露.pdf") -> dict:
    _write()
    if (data is None) != bool(request.url):
        raise DisclosureError("请上传 PDF 或提供官方原文链接")
    sha = None
    if data is not None:
        validate_pdf(data)
        sha = hashlib.sha256(data).hexdigest()
    payload = request.model_dump(mode="json", exclude={"request_id"})
    identity = hashlib.sha256(json_dump({"request": payload, "sha256": sha}).encode()).hexdigest()
    with connect() as connection:
        old = connection.execute("SELECT id,request_hash FROM disclosure_imports WHERE request_id=?", (request.request_id,)).fetchone()
        if old:
            if old["request_hash"] != identity:
                raise DisclosureError("相同请求不能更换原文或分类", 409)
            return read_import(old["id"])
        _check_target(connection, request)
    if data is not None:
        documents._store_original(data, sha)
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        old = connection.execute("SELECT id,request_hash FROM disclosure_imports WHERE request_id=?", (request.request_id,)).fetchone()
        if old:
            if old["request_hash"] != identity:
                raise DisclosureError("相同请求不能更换原文或分类", 409)
            import_id = old["id"]
        else:
            _check_target(connection, request)
            import_id, job_id, now = str(uuid4()), str(uuid4()), utc_now()
            safe_filename = re.split(r"[/\\]", filename)[-1][:180] or "原始披露.pdf"
            connection.execute("""INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at,required_protocol)
                VALUES(?,'disclosure_import',?,'queued','等待归档原始披露',?,?,'disclosure-import-v1')""",
                               (job_id, json_dump({"import_id": import_id}), now, now))
            connection.execute("INSERT INTO disclosure_imports VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                               (import_id, request.request_id, identity, json_dump(payload), job_id, safe_filename, sha,
                                None, "downloaded" if sha else "queued", None, None, now))
    return read_import(import_id)


def read_import(import_id: str) -> dict:
    with connect() as connection:
        row = connection.execute("""SELECT i.*,j.state,j.message,j.progress FROM disclosure_imports i
            JOIN jobs j ON j.id=i.job_id WHERE i.id=?""", (import_id,)).fetchone()
    if not row:
        raise DisclosureError("找不到此次导入", 404)
    result = dict(row)
    result["request"] = json_load(result.pop("request_json"))
    result.pop("request_hash")
    return result


def recent_imports() -> dict:
    with connect() as connection:
        ids = [row[0] for row in connection.execute("SELECT id FROM disclosure_imports ORDER BY created_at DESC,rowid DESC LIMIT 30")]
    return {"items": [read_import(item) for item in ids]}


def retry(import_id: str) -> dict:
    _write()
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("""SELECT i.job_id,i.version_id,j.state FROM disclosure_imports i JOIN jobs j ON j.id=i.job_id
            WHERE i.id=?""", (import_id,)).fetchone()
        if not row:
            raise DisclosureError("找不到此次导入", 404)
        if row["state"] in {"queued", "running"}:
            return {"job_id": row["job_id"]}
        if row["version_id"] or row["state"] not in {"failed", "cancelled", "partial"}:
            raise DisclosureError("此导入已归档，请使用新导入获取新的原文版本", 409)
        job, now = str(uuid4()), utc_now()
        connection.execute("""INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at,retry_of,required_protocol)
            VALUES(?,'disclosure_import',?,'queued','等待重试原始披露归档',?,?,?,'disclosure-import-v1')""",
                           (job, json_dump({"import_id": import_id}), now, now, row["job_id"]))
        connection.execute("UPDATE disclosure_imports SET job_id=? WHERE id=?", (job, import_id))
    return {"job_id": job}


def suggestions(filename: str, text: str) -> dict:
    # Hints only; never establish company/date availability from a filename.
    combined = filename + "\n" + text[:12000]
    result = {}
    with connect() as connection:
        companies = connection.execute("SELECT stock_code,name FROM security_catalog").fetchall()
    explicit = re.findall(r"(?<!\d)(\d{6}\.(?:SH|SZ|BJ))\b", combined, re.I)
    labelled = re.findall(r"(?:股票|证券|公司)(?:代码|代碼)\s*[:：]?\s*(\d{6})(?!\d)", combined)
    codes = {r["stock_code"] for r in companies if r["stock_code"] in explicit or r["stock_code"][:6] in labelled}
    if not codes:
        codes = {r["stock_code"] for r in companies if len(r["name"]) >= 3 and r["name"] in text[:5000]}
    if len(codes) == 1:
        result["stock_code"] = next(iter(codes))
    match = re.search(r"(20\d{2})\s*年?\s*(半年度|年度|第一季度|第三季度|年报|中报)", combined)
    if match:
        kind, end = {"半年度": ("half_year", "06-30"), "年度": ("annual", "12-31"), "第一季度": ("q1", "03-31"),
                     "第三季度": ("q3", "09-30"), "年报": ("annual", "12-31"), "中报": ("half_year", "06-30")}[match[2]]
        result.update(document_type=kind, report_period=match[1] + "-" + end)
    result["document_form"] = "summary" if "摘要" in filename or "报告摘要" in text[:1000] else "full"
    return result


def publish(import_id: str, document_id: str, hints: dict, lease) -> bool:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if not connection.execute("SELECT 1 FROM jobs WHERE id=? AND state='running' AND lease_owner=? AND lease_expires_at>?",
                                  (lease.id, lease.owner, utc_now())).fetchone():
            return False
        row = connection.execute("SELECT * FROM disclosure_imports WHERE id=? AND job_id=?", (import_id, lease.id)).fetchone()
        if not row:
            return False
        if row["version_id"]:
            return True
        request = ImportRequest(request_id="publication", **json_load(row["request_json"]))
        meta = request.metadata.model_dump(mode="json")
        meta["title"] = meta["title"] or Path(row["filename"]).stem
        existing = connection.execute("SELECT id FROM disclosure_versions WHERE sha256=? ORDER BY created_at,id", (row["sha256"],)).fetchall()
        for item in existing:
            candidate = _version(connection, item["id"])
            # Repeated bytes cannot silently reclassify an existing source.
            unspecified = not meta["confirmed"] and not meta["stock_code"] and not meta["report_period"] and meta["document_type"] == "other"
            if unspecified or all(meta[k] == candidate["metadata"][k] for k in IDENTITY_FIELDS):
                if request.target_version_id:
                    target = _version(connection, request.target_version_id)
                    if candidate["disclosure_id"] != target["disclosure_id"]:
                        continue
                connection.execute("UPDATE disclosure_imports SET version_id=?,stage='completed',outcome='duplicate' WHERE id=?", (item["id"], import_id))
                return True
        if existing:
            raise DisclosureError("同一 PDF 已归档为其他分类，请打开原记录核对分类；不会覆盖已有归属", 409)
        target = _check_target(connection, request, publishing=True)
        relation = request.relation
        if not target and request.url and meta["confirmed"]:
            previous = connection.execute("SELECT id FROM disclosure_versions WHERE source_url=? ORDER BY created_at DESC,version DESC", (request.url,)).fetchall()
            for item in previous:
                candidate = _version(connection, item["id"])
                if candidate["metadata"]["confirmed"] and all(meta[k] == candidate["metadata"][k] for k in IDENTITY_FIELDS):
                    latest = connection.execute("SELECT id FROM disclosure_versions WHERE disclosure_id=? ORDER BY version DESC LIMIT 1",
                                                (candidate["disclosure_id"],)).fetchone()[0]
                    automatic = request.model_copy(update={"relation": "revision", "target_version_id": latest})
                    target = _check_target(connection, automatic, publishing=True)
                    relation = "revision"
                    break
        root = target["disclosure_id"] if target and relation == "revision" else str(uuid4())
        number = target["version"] + 1 if target and relation == "revision" else 1
        now, version_id = utc_now(), str(uuid4())
        if number == 1:
            connection.execute("INSERT INTO disclosures VALUES(?,?)", (root, now))
        connection.execute("INSERT INTO disclosure_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                           (version_id, root, number, document_id,
                            target["id"] if target and relation == "revision" else None,
                            target["id"] if target and relation == "supplement" else None,
                            "official_url" if request.url else "upload", request.url, row["final_url"], row["sha256"], now))
        connection.execute("INSERT INTO disclosure_metadata VALUES(?,1,?,?,?)",
                           (version_id, json_dump(meta), json_dump(hints), now))
        connection.execute("UPDATE documents SET material_kind='disclosure' WHERE id=?", (document_id,))
        connection.execute("UPDATE disclosure_imports SET version_id=?,stage='completed',outcome=? WHERE id=?",
                           (version_id, relation, import_id))
    return True


def list_versions(*, stock_code=None, report_period=None, document_type=None, document_form=None,
                  classification=None, query="", as_of=None, offset=0, limit=20, observed_by=None) -> dict:
    predicates = ["1=1"]
    params = []
    for field, value in (("stock_code", stock_code), ("report_period", report_period),
                         ("document_type", document_type), ("document_form", document_form)):
        if value:
            predicates.append(f"json_extract(m.metadata_json,'$.{field}')=?")
            params.append(value)
    if classification:
        predicates.append("json_extract(m.metadata_json,'$.confirmed')=?")
        params.append(int(classification == "confirmed"))
    if query:
        predicates.append("(instr(json_extract(m.metadata_json,'$.title'),?)>0 OR EXISTS(SELECT 1 FROM document_pages p WHERE p.document_id=v.document_id AND instr(p.text,?)>0))")
        params.extend([query, query])
    if as_of:
        date.fromisoformat(as_of)
        predicates.append("json_extract(m.metadata_json,'$.confirmed')=1 AND json_extract(m.metadata_json,'$.publication_date') IS NOT NULL AND json_extract(m.metadata_json,'$.publication_date')<=?")
        params.append(as_of)
    if observed_by:
        date.fromisoformat(observed_by)
        predicates.append("date(v.created_at,'+8 hours')<=?")
        params.append(observed_by)
    base = """FROM disclosure_versions v JOIN disclosure_metadata m ON m.version_id=v.id
        AND m.revision=(SELECT MAX(n.revision) FROM disclosure_metadata n WHERE n.version_id=v.id) WHERE """
    clause = " AND ".join(predicates)
    with connect() as connection:
        # Latest qualifying version per series; future versions do not hide older eligible ones.
        grouped = f"SELECT v.disclosure_id,MAX(v.version) selected {base}{clause} GROUP BY v.disclosure_id"
        total = connection.execute(f"SELECT COUNT(*) FROM ({grouped})", params).fetchone()[0]
        rows = connection.execute(f"""SELECT v.id FROM disclosure_versions v JOIN ({grouped}) chosen
            ON chosen.disclosure_id=v.disclosure_id AND chosen.selected=v.version
            ORDER BY v.created_at DESC,v.id DESC LIMIT ? OFFSET ?""", (*params, limit, offset)).fetchall()
        items = [_version(connection, row["id"], as_of=as_of) for row in rows]
    return {"items": items, "total": total, "offset": offset, "limit": limit,
            "note": "按已保存分类和人工确认的披露日期展示；未确认日期的资料不用于截止日过滤。"}


def detail(version_id: str, *, as_of=None) -> dict:
    with connect() as connection:
        result = _version(connection, version_id, as_of=as_of)
        history = connection.execute("SELECT id FROM disclosure_versions WHERE disclosure_id=? ORDER BY version DESC", (result["disclosure_id"],)).fetchall()
        result["versions"] = []
        for item in history:
            try:
                result["versions"].append(_version(connection, item["id"], as_of=as_of))
            except DisclosureError:
                continue
        related_ids = connection.execute("""SELECT id FROM disclosure_versions WHERE related_version_id IN
            (SELECT id FROM disclosure_versions WHERE disclosure_id=?)""", (result["disclosure_id"],)).fetchall()
        if result["related_version_id"]:
            related_ids = [*related_ids, (result["related_version_id"],)]
        result["related"] = []
        for item in related_ids:
            try:
                result["related"].append(_version(connection, item[0], as_of=as_of))
            except DisclosureError:
                continue
        result["metadata_history"] = [{"revision": r["revision"], "metadata": json_load(r["metadata_json"]), "created_at": r["created_at"]}
                                      for r in connection.execute("SELECT * FROM disclosure_metadata WHERE version_id=? ORDER BY revision DESC", (version_id,))]
        result["sources"] = [dict(row) for row in connection.execute("""SELECT id import_id,filename,final_url,
            json_extract(request_json,'$.url') source_url,created_at FROM disclosure_imports
            WHERE version_id=? ORDER BY created_at,id""", (version_id,))]
        for related in result["related"]:
            related["relationship_needs_review"] = any(related["metadata"][key] != result["metadata"][key]
                                                       for key in ("stock_code", "report_period"))
    return result


def update_metadata(version_id: str, payload: MetadataUpdate) -> dict:
    _write()
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        current = _version(connection, version_id)
        if current["metadata"]["revision"] != payload.base_revision:
            raise DisclosureError("分类已被修改，请刷新后重试", 409)
        metadata = payload.metadata.model_dump(mode="json")
        identity_changed = any(metadata[k] != current["metadata"][k] for k in IDENTITY_FIELDS)
        targets = [version_id]
        if identity_changed:
            targets = [row[0] for row in connection.execute("SELECT id FROM disclosure_versions WHERE disclosure_id=?", (current["disclosure_id"],))]
            if len(targets) > 1 and not payload.propagate_identity:
                raise DisclosureError("同系列版本须保持一致分类，请选择同步更新系列分类", 409)
        for target in targets:
            old = _metadata(connection, target)
            updated = metadata if target == version_id else {**{k: old[k] for k in Metadata.model_fields},
                        **{k: metadata[k] for k in IDENTITY_FIELDS}, "confirmed": False}
            validated = Metadata(**updated).model_dump(mode="json")
            connection.execute("INSERT INTO disclosure_metadata VALUES(?,?,?,?,?)",
                               (target, old["revision"] + 1, json_dump(validated), json_dump(old["suggestions"]), utc_now()))
    return detail(version_id)


def pdf_path(version_id: str, *, as_of=None):
    with connect() as connection:
        version = _version(connection, version_id, as_of=as_of)
        row = connection.execute("SELECT source_path,sha256 FROM documents WHERE id=?", (version["document_id"],)).fetchone()
    path = documents.original_snapshot(row["source_path"], row["sha256"])
    return path, version


def read_page(version_id: str, page: int, *, as_of=None, offset=0, limit=12000) -> dict:
    _, version = pdf_path(version_id, as_of=as_of)
    with connect() as connection:
        row = connection.execute("SELECT text FROM document_pages WHERE document_id=? AND page_number=?", (version["document_id"], page)).fetchone()
    if not row:
        raise DisclosureError("找不到此物理页", 404)
    text = row["text"]
    if offset > len(text):
        raise DisclosureError("读取位置超过本页文字长度")
    end = min(len(text), offset + limit)
    return {"source_type": "disclosure", "source_id": version_id, "document_id": version["document_id"],
            "first_observed_at": version["created_at"],
            "sha256": version["sha256"], "version": version["version"], "metadata_revision": version["metadata"]["revision"],
            "page_number": page, "page_count": version["pages"], "text": text[offset:end], "char_start": offset, "char_end": end,
            "next_offset": end if end < len(text) else None, "original_characters": len(text),
            "classification": version["metadata"], "availability_basis": version["availability_basis"], "pdf_url": version["pdf_url"]}


def search_pages(version_id: str, query: str, *, as_of=None, offset=0, limit=20) -> dict:
    _, version = pdf_path(version_id, as_of=as_of)
    with connect() as connection:
        total = connection.execute("SELECT COUNT(*) FROM document_pages WHERE document_id=? AND instr(lower(text),lower(?))>0",
                                   (version["document_id"], query)).fetchone()[0]
        rows = connection.execute("""SELECT page_number,text FROM document_pages WHERE document_id=? AND instr(lower(text),lower(?))>0
            ORDER BY page_number LIMIT ? OFFSET ?""", (version["document_id"], query, limit, offset)).fetchall()
    return {"items": [{"page_number": row["page_number"], "snippet": row["text"][max(0, row["text"].lower().find(query.lower()) - 80):
                                                                 max(0, row["text"].lower().find(query.lower()) - 80) + 400]}
                      for row in rows], "total": total, "offset": offset, "limit": limit}
