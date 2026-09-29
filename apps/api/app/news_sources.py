from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
import json
import re
from typing import Any
from uuid import uuid4

from pydantic import ConfigDict, Field, field_validator, model_validator

from .db import connect, json_dump, json_load, utc_now
from .evidence_sources import EvidenceSourceError
from .screening_contracts import ContractModel

LOCAL_ZONE = timezone(timedelta(hours=8))


class NewsItemInput(ContractModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)
    title: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=200_000)
    source: str = Field(min_length=1, max_length=300)
    published_at: datetime | None = None
    available_at: datetime | None = None
    stock_codes: list[str] = Field(default_factory=list, max_length=100)
    event_key: str | None = Field(default=None, max_length=200)

    @field_validator("title", "body", "source")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("资讯标题、来源和正文不能为空白")
        return value

    @field_validator("published_at", "available_at")
    @classmethod
    def timezone_required(cls, value):
        if value is not None:
            if value.tzinfo is None:
                raise ValueError("资讯时间须含时区，例如 +08:00")
            return value.astimezone(timezone.utc)
        return value

    @field_validator("stock_codes")
    @classmethod
    def valid_codes(cls, values):
        if len(values) != len(set(values)) or any(not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", item) for item in values):
            raise ValueError("资讯证券代码重复或格式无效")
        return sorted(values)

    @model_validator(mode="after")
    def dates_ordered(self):
        if self.published_at and self.available_at and self.available_at < self.published_at:
            raise ValueError("首次可用时间不能早于发布时间")
        return self


class NewsImport(ContractModel):
    request_id: str = Field(min_length=1, max_length=100)
    items: list[NewsItemInput] = Field(min_length=1, max_length=100)


class NewsRevision(ContractModel):
    request_id: str = Field(min_length=1, max_length=100)
    item: NewsItemInput


class NewsError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422):
        self.code, self.status = code, status
        super().__init__(message)


def _canonical(item: NewsItemInput):
    data = item.model_dump(mode="json")
    for key in ("published_at", "available_at"):
        value = getattr(item, key)
        data[key] = value.isoformat() if value else None
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _record(row):
    return dict(id=row["id"], root_id=row["root_id"], version=row["version"],
                **json_load(row["payload_json"]), created_at=row["created_at"])


def import_items(request: NewsImport, *, base_id: str | None = None) -> dict[str, Any]:
    payloads = [_canonical(item) for item in request.items]
    identity = json_dump(dict(base_id=base_id, payloads=payloads))
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        old = connection.execute("SELECT * FROM news_import_requests WHERE request_id=?", (request.request_id,)).fetchone()
        if old:
            if old["request_json"] != identity:
                raise NewsError("request_conflict", "同一导入请求不能用于不同内容", 409)
            return dict(**json_load(old["result_json"]), replay=True)
        base = None
        if base_id:
            if len(request.items) != 1:
                raise NewsError("invalid_revision", "修改资讯只接受一条新正文")
            base = connection.execute("SELECT * FROM news_records WHERE id=?", (base_id,)).fetchone()
            if not base:
                raise NewsError("news_not_found", "找不到要修改的资讯", 404)
            latest = connection.execute("SELECT MAX(version) FROM news_records WHERE root_id=?", (base["root_id"],)).fetchone()[0]
            if latest != base["version"]:
                raise NewsError("revision_conflict", "资讯已有较新版本，请刷新后编辑", 409)
        result = {"items": [], "created": 0, "duplicates": 0}
        for item, payload in zip(request.items, payloads):
            duplicate = (base if base["payload_json"] == payload else None) if base else connection.execute(
                "SELECT * FROM news_records WHERE payload_json=? ORDER BY created_at DESC LIMIT 1", (payload,)).fetchone()
            if duplicate:
                result["items"].append(_record(duplicate))
                result["duplicates"] += 1
                continue
            record_id = str(uuid4())
            root_id, version = (base["root_id"], base["version"] + 1) if base else (record_id, 1)
            data = json.loads(payload)
            connection.execute("""INSERT INTO news_records(id,root_id,version,title,body,source,published_at,
                available_at,stock_codes_json,event_key,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (record_id, root_id, version, item.title, item.body, item.source, data["published_at"],
                 data["available_at"], json_dump(item.stock_codes), item.event_key, payload, utc_now()))
            result["items"].append(_record(connection.execute("SELECT * FROM news_records WHERE id=?", (record_id,)).fetchone()))
            result["created"] += 1
        connection.execute("INSERT INTO news_import_requests VALUES(?,?,?)", (request.request_id, identity, json_dump(result)))
    return dict(**result, replay=False)


def get_item(item_id: str) -> dict:
    with connect() as connection:
        row = connection.execute("SELECT * FROM news_records WHERE id=?", (item_id,)).fetchone()
    if not row:
        raise NewsError("news_not_found", "找不到资讯", 404)
    return _record(row)


def browse(*, query: str = "", stock_code: str | None = None, start_date: date | None = None,
           end_date: date | None = None, offset: int = 0, limit: int = 30) -> dict:
    if start_date and end_date and start_date > end_date:
        raise NewsError("invalid_date_range", "结束日期不能早于开始日期")
    predicates = ["n.version=(SELECT MAX(v.version) FROM news_records v WHERE v.root_id=n.root_id)"]
    params: list[Any] = []
    if query:
        predicates.append("(instr(n.title,?)>0 OR instr(n.body,?)>0)")
        params.extend([query, query])
    if stock_code:
        predicates.append("EXISTS(SELECT 1 FROM json_each(n.stock_codes_json) WHERE value=?)")
        params.append(stock_code)
    if start_date:
        start_at = datetime.combine(start_date, time.min, LOCAL_ZONE).astimezone(timezone.utc).isoformat()
        predicates.append("n.available_at>=?")
        params.append(start_at)
    if end_date:
        end_at = datetime.combine(end_date + timedelta(days=1), time.min, LOCAL_ZONE).astimezone(timezone.utc).isoformat()
        predicates.append("n.available_at<?")
        params.append(end_at)
    where = " AND ".join(predicates)
    with connect() as connection:
        total = connection.execute(f"SELECT COUNT(*) FROM news_records n WHERE {where}", params).fetchone()[0]
        rows = connection.execute(f"SELECT n.* FROM news_records n WHERE {where} ORDER BY COALESCE(n.available_at,n.published_at,n.created_at) DESC,n.created_at DESC,n.id LIMIT ? OFFSET ?",
                                  [*params, limit, offset]).fetchall()
        external_sync = connection.execute(
            "SELECT EXISTS(SELECT 1 FROM news_records WHERE source LIKE 'Tushare news/%')"
        ).fetchone()[0]
    items = []
    for row in rows:
        item = _record(row)
        item["snippet"] = item.pop("body")[:300]
        items.append(item)
    return dict(items=items, total=total, offset=offset,
                next_offset=offset + len(rows) if offset + len(rows) < total else None,
                external_sync=bool(external_sync))


def _window(as_of, lookback_days):
    try:
        cutoff = date.fromisoformat(as_of)
    except (TypeError, ValueError) as exc:
        raise EvidenceSourceError("invalid_cutoff", "资讯读取需要有效截止日") from exc
    if lookback_days is not None and (type(lookback_days) is not int or not 1 <= lookback_days <= 3650):
        raise EvidenceSourceError("invalid_lookback", "资讯回溯天数无效")
    end = datetime.combine(cutoff + timedelta(days=1), time(), LOCAL_ZONE).astimezone(timezone.utc).isoformat()
    start = datetime.combine(cutoff - timedelta(days=lookback_days), time(), LOCAL_ZONE).astimezone(timezone.utc).isoformat() if lookback_days else None
    return start, end


def list_news_sources(stock_code: str, as_of: str, *, lookback_days=None, offset=0, limit=30, allowed_source_ids=None) -> dict:
    if not isinstance(stock_code, str) or not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", stock_code):
        raise EvidenceSourceError("invalid_security", "资讯读取必须指定明确证券")
    if type(offset) is not int or type(limit) is not int or offset < 0 or not 1 <= limit <= 50:
        raise EvidenceSourceError("invalid_page", "资讯分页范围无效")
    start, end = _window(as_of, lookback_days)
    predicates = ["n.available_at IS NOT NULL", "n.available_at<?",
                  "EXISTS(SELECT 1 FROM json_each(n.stock_codes_json) WHERE value=?)",
                  "n.version=(SELECT MAX(v.version) FROM news_records v WHERE v.root_id=n.root_id AND v.available_at<?)",
                  "NOT EXISTS(SELECT 1 FROM news_records v WHERE v.root_id=n.root_id AND v.version>n.version AND v.available_at IS NULL)"]
    params = [end, stock_code, end]
    if start:
        predicates.append("n.available_at>=?")
        params.append(start)
    if allowed_source_ids is not None:
        predicates.append("n.id IN (" + ",".join("?" for _ in allowed_source_ids) + ")" if allowed_source_ids else "0")
        params.extend(sorted(allowed_source_ids))
    where = " AND ".join(predicates)
    with connect() as connection:
        total = connection.execute(f"SELECT COUNT(*) FROM news_records n WHERE {where}", params).fetchone()[0]
        rows = connection.execute(f"SELECT n.* FROM news_records n WHERE {where} ORDER BY n.available_at DESC,n.id LIMIT ? OFFSET ?",
                                  [*params, limit, offset]).fetchall()
    return dict(items=[dict(source_type="news", source_id=row["id"], title=row["title"], stock_code=stock_code,
                            publication_at=row["published_at"], available_at=row["available_at"], page_count=1,
                            event_key=row["event_key"] or row["root_id"]) for row in rows], total=total,
                offset=offset, next_offset=offset+len(rows) if offset+len(rows)<total else None,
                coverage=dict(scope="eligible_local_news", read_pages=0, corpus_read_complete=False))


def read_news_chunk(source_id: str, page_number: int, stock_code: str, as_of: str, *, offset=0, limit=12000, lookback_days=None) -> dict:
    if type(page_number) is not int or page_number != 1 or type(offset) is not int or type(limit) is not int or offset < 0 or not 1 <= limit <= 12000:
        raise EvidenceSourceError("invalid_chunk", "资讯段落或读取范围无效")
    eligible = list_news_sources(stock_code, as_of, lookback_days=lookback_days, allowed_source_ids={source_id}, limit=1)
    if not eligible["items"]:
        raise EvidenceSourceError("source_ineligible", "资讯不符合本次证券、日期或版本范围")
    item = get_item(source_id)
    text = item["body"]
    if offset > len(text):
        raise EvidenceSourceError("offset_out_of_range", "资讯读取位置超过正文长度")
    end = min(len(text), offset + limit)
    return dict(**eligible["items"][0], page_number=1, char_start=offset, char_end=end, text=text[offset:end],
                original_characters=len(text), next_offset=end if end<len(text) else None,
                coverage=dict(read_characters=end-offset, page_complete=offset==0 and end==len(text), corpus_read_complete=False))
