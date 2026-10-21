"""Immutable numeric citations and explicit, page-located primary-document verification."""
from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation, localcontext
from html import escape
import json
import re
from typing import Literal
from uuid import uuid4

from pydantic import Field

from .db import connect, utc_now
from . import disclosures, documents, financial_facts, evidence_sources
from .financial_contracts import canonical, digest, decimal_text, timestamp, ZONE
from .screening_contracts import ContractModel
from .security_context import AccessDenied, can_write, current_actor


class EvidenceError(ValueError):
    def __init__(self, message, status=422):
        self.status = status
        super().__init__(message)


def writable():
    if not can_write(current_actor()):
        raise AccessDenied("当前账户只有查看权限")


class LinkRequest(ContractModel):
    request_id: str = Field(default_factory=lambda: str(uuid4()), min_length=1, max_length=100)
    version_id: str = Field(min_length=1, max_length=100)
    metadata_revision: int = Field(ge=1)
    as_of: date
    page_number: int | None = Field(None, ge=1, le=5000)
    quote: str = Field("", max_length=3000)
    start_hint: int | None = Field(None, ge=0)
    reported_value: str | None = Field(None, max_length=80)
    reported_unit: Literal["元", "千元", "万元", "亿元", "%", "倍"] = "元"
    report_period: date | None = None
    scope: Literal["consolidated", "parent", "unknown"] = "consolidated"
    currency: Literal["CNY"] = "CNY"
    column_note: str = Field("", max_length=500)
    manually_confirmed: bool = False


def _number(value: str) -> Decimal:
    text = value.strip().replace("，", ",").replace("−", "-")
    if text.startswith("(") and text.endswith(")"):
        text = "-" + text[1:-1]
    if "," in text and not re.fullmatch(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?", text):
        raise EvidenceError("千位分隔符格式无效")
    text = text.replace(",", "")
    if not re.fullmatch(r"-?\d+(?:\.\d+)?", text):
        raise EvidenceError("请输入原文单元格的十进制数字，零值与空白应区分")
    result = Decimal(text)
    if not result.is_finite():
        raise EvidenceError("原文数值无效")
    return result


def link(fact_id: str, request: LinkRequest) -> dict:
    writable()
    signature = digest(request.model_dump(mode="json"))
    def previous(connection):
        row = connection.execute("SELECT payload_json FROM financial_evidence_links WHERE fact_id=? AND json_extract(payload_json,'$.request_id')=?", (fact_id, request.request_id)).fetchone()
        if row:
            value = json.loads(row[0])
            if value.get("request_signature") != signature:
                raise EvidenceError("相同核对请求不能更改原文或数值", 409)
            return value
        return None
    with connect() as connection:
        old = previous(connection)
        if old:
            return old
    try:
        source = financial_facts.provenance(fact_id)
        version = disclosures.detail(request.version_id, as_of=request.as_of.isoformat())
    except (LookupError, disclosures.DisclosureError) as exc:
        raise EvidenceError(str(exc), 404) from exc
    record, fact, metadata = source["record"], source["fact"], version["metadata"]
    if metadata["revision"] != request.metadata_revision:
        raise EvidenceError("披露分类已变化，请重新读取原文后关联", 409)
    if not metadata["confirmed"] or metadata["stock_code"] != record["stock_code"] or metadata["report_period"] != record["report_period"]:
        raise EvidenceError("原文与事实的公司或报告期不一致，不能自动关联")
    if not record.get("public_date") or record["public_date"] > request.as_of.isoformat():
        raise EvidenceError("源事实晚于关联截止日")
    payload = {"fact_id": fact_id, "version_id": request.version_id, "metadata_revision": metadata["revision"],
               "request_id": request.request_id, "request_signature": signature,
               "as_of": request.as_of.isoformat(), "document": {k: version[k] for k in ("id", "disclosure_id", "document_id", "sha256", "version", "pages", "metadata", "created_at", "source_kind", "source_url", "final_url")},
               "status": "document_related", "verification_method": "document_identity_only",
               "page_number": request.page_number, "reviewer_user_id": current_actor().user_id}
    if request.page_number is not None:
        chunk = disclosures.read_page(request.version_id, request.page_number, as_of=request.as_of.isoformat(), limit=1000000)
        chunk["stock_code"] = record["stock_code"]
        if request.quote:
            try:
                located = evidence_sources.locate_quote(chunk, request.quote, start_hint=request.start_hint)
            except evidence_sources.EvidenceSourceError as exc:
                raise EvidenceError(str(exc)) from exc
            payload.update(quote=located["quote"], quote_start=located["char_start"], quote_end=located["char_end"])
    if request.manually_confirmed:
        if request.reported_value is None or not request.quote or not request.page_number or not request.column_note.strip():
            raise EvidenceError("数值核对必须提供物理页、精确原文、单元格数值和期间列说明")
        if request.report_period is None or request.report_period.isoformat() != record["report_period"] or request.scope != record["scope"]:
            raise EvidenceError("数值核对的期间或合并范围与事实不同")
        if metadata["document_form"] != "full" or metadata["document_type"] not in {"annual", "half_year", "q1", "q3"}:
            raise EvidenceError("数值核对须使用对应定期报告全文，摘要或更正说明只能关联文档")
        if fact["status"] != "reported" or fact["currency"] not in {None, request.currency}:
            raise EvidenceError("源值缺失或币种未确认，不能标为数值已核对")
        value = _number(request.reported_value)
        # A full token must occur exactly in the located quotation. Substrings
        # such as 123 in 1234 cannot pass as the selected source cell.
        tokens = re.findall(r"(?<![\d.,，])(?:\(-?[\d,，]+(?:\.\d+)?\)|[-−]?\d[\d,，]*(?:\.\d+)?)(?![\d.,，])", payload["quote"])
        if not any(_number(token) == value and _number(token).as_tuple().exponent == value.as_tuple().exponent for token in tokens):
            raise EvidenceError("提供的单元格数值不在已定位的原文摘录中")
        factor = {"元": Decimal(1), "千元": Decimal(1000), "万元": Decimal(10000), "亿元": Decimal(100000000), "%": Decimal(1), "倍": Decimal(1)}[request.reported_unit]
        if (fact["unit"] == "元" and request.reported_unit in {"%", "倍"}) or (fact["unit"] != "元" and fact["unit"] != request.reported_unit):
            raise EvidenceError("原文单位与源事实单位不兼容")
        with localcontext() as context:
            context.prec = 80
            normalized = value * factor
            tolerance = Decimal("0.5") * Decimal(10) ** value.as_tuple().exponent * factor
            difference = normalized - Decimal(fact["value"])
        payload.update(status="value_verified" if abs(difference) <= tolerance else "conflict",
                       verification_method="manual_column_and_scope_with_decimal_check",
                       reported_value=request.reported_value, reported_unit=request.reported_unit,
                       normalized_value=decimal_text(normalized), source_value=fact["value"], unit=fact["unit"],
                       currency=request.currency, report_period=request.report_period.isoformat(), scope=request.scope,
                       column_note=request.column_note.strip(), difference=decimal_text(difference), tolerance=decimal_text(tolerance))
    elif request.reported_value is not None:
        raise EvidenceError("提供数值时须明确确认已人工核对期间列、单位、币种和合并范围")
    payload["id"] = digest(payload)
    with connect() as connection:
        # Recheck the metadata under the publication lock.
        connection.execute("BEGIN IMMEDIATE")
        old = previous(connection)
        if old:
            return old
        if disclosures._metadata(connection, request.version_id)["revision"] != metadata["revision"]:
            raise EvidenceError("披露分类已变化，关联未发布", 409)
        connection.execute("INSERT OR IGNORE INTO financial_evidence_links VALUES(?,?,?,?,?,?,?,?)",
                           (payload["id"], fact_id, request.version_id, metadata["revision"], request.as_of.isoformat(), payload["status"], canonical(payload), utc_now()))
    return payload


def links(fact_id: str, *, connection=None, as_of=None, mode="latest") -> list[dict]:
    if connection is None:
        with connect() as source:
            return links(fact_id, connection=source, as_of=as_of, mode=mode)
    results, seen = [], set()
    for row in connection.execute("SELECT payload_json,created_at FROM financial_evidence_links WHERE fact_id=? ORDER BY rowid DESC", (fact_id,)):
        value = json.loads(row["payload_json"])
        document = value["document"]
        if as_of:
            public_date = document["metadata"].get("publication_date")
            observed = document.get("created_at")
            observed_day = timestamp(observed).astimezone(ZONE).date().isoformat() if observed else None
            if not public_date or public_date > as_of or mode == "as_of" and (not observed_day or observed_day > as_of):
                continue
        series = connection.execute("SELECT disclosure_id,version FROM disclosure_versions WHERE id=?", (value["version_id"],)).fetchone()
        if series:
            document.update(disclosure_id=series["disclosure_id"], version=series["version"])
        current = disclosures._metadata(connection, value["version_id"])
        value.update(created_at=row["created_at"], classification_current=current["revision"] == value["metadata_revision"])
        if value["version_id"] in seen:
            value["current_status"] = "superseded_check"
        elif not value["classification_current"]:
            value["current_status"] = "classification_changed"
        else:
            value["current_status"] = value["status"]
        if value["status"] in {"value_verified", "conflict"}:
            seen.add(value["version_id"])
        results.append(value)
    latest = {}
    for value in results:
        document = value["document"]
        if value["classification_current"] and document.get("disclosure_id"):
            key = document["disclosure_id"]
            latest[key] = max(latest.get(key, 0), document["version"])
    for value in results:
        document = value["document"]
        if value["classification_current"] and document.get("disclosure_id") and document["version"] < latest[document["disclosure_id"]]:
            value["current_status"] = "superseded_document"
    return results


def _persist(payload: dict) -> dict:
    payload = {k: v for k, v in payload.items() if k not in {"id", "citation_url"}}
    key = digest(payload)
    with connect() as connection:
        connection.execute("INSERT OR IGNORE INTO research_data_evidence VALUES(?,?,?,?,?,?)",
                           (key, payload["kind"], payload["stock_code"], payload["as_of"], canonical(payload), utc_now()))
        created_at = connection.execute("SELECT created_at FROM research_data_evidence WHERE id=?", (key,)).fetchone()[0]
    return {**payload, "id": key, "created_at": created_at, "citation_url": f"/api/v1/research-evidence/{key}/view"}


def read(evidence_id: str) -> dict:
    with connect() as connection:
        row = connection.execute("SELECT payload_json,created_at FROM research_data_evidence WHERE id=?", (evidence_id,)).fetchone()
    if not row:
        raise EvidenceError("找不到此独立研究依据", 404)
    return {**json.loads(row[0]), "id": evidence_id, "created_at": row["created_at"], "citation_url": f"/api/v1/research-evidence/{evidence_id}/view"}


def append_citations(content: str) -> str:
    """Export the immutable excerpts with the answer, even without a live chat."""
    from .research_sources import markdown_links
    values, seen = [], set()
    for _, url in markdown_links(content):
        match = re.fullmatch(r"/api/v1/research-evidence/([a-f0-9]{64})/view", url)
        if match and match[1] not in seen and len(values) < 20:
            try:
                payload = read(match[1])
            except EvidenceError:
                continue
            seen.add(match[1]); values.append("### " + payload["title"] + "\n\n" + excerpt(payload)[:18000].replace("\n", "\n\n"))
    return content + ("\n\n## 数字与披露依据快照\n\n以下为保存版本的有界摘录，全量依据仍可通过对应引用标识核对。\n\n" + "\n\n".join(values) if values else "")


def financial(calculation_id: str, metric: str, period: str, *, captured_links=None, captured_inputs=None) -> dict:
    from . import financial_metrics
    try:
        calculation = financial_metrics.read_calculation(calculation_id)
    except LookupError as exc:
        raise EvidenceError(str(exc), 404) from exc
    point = next((row["values"].get(metric) for row in calculation["rows"] if row["period"] == period), None)
    if point is None:
        raise EvidenceError("计算快照中没有此指标与报告期", 404)
    inputs, original = [], []
    for fact_id in point["input_fact_ids"]:
        source = captured_inputs[fact_id] if captured_inputs is not None else financial_facts.provenance(fact_id)
        input_links = links(fact_id, as_of=calculation["request"]["as_of"], mode=calculation["request"]["mode"]) if captured_links is None else [item for item in captured_links if item["fact_id"] == fact_id]
        # Freeze exact source values and raw rows, never a later live calculation.
        inputs.append({"fact_id": fact_id, "fact": source["fact"], "record": {key: value for key, value in source["record"].items() if key != "facts"},
                       "observations": source["observations"], "pilot_observations": source["pilot_observations"]})
        original.extend(input_links)
    verified = bool(inputs) and not any(item.get("current_status", item["status"]) == "conflict" for item in original) and all(any(link["fact_id"] == item["fact_id"] and link.get("current_status", link["status"]) == "value_verified" for link in original) for item in inputs)
    label = next((item["label"] for item in calculation["metrics"] if item["code"] == metric), metric)
    payload = {"kind": "financial", "stock_code": calculation["request"]["stock_code"], "as_of": calculation["request"]["as_of"],
               "title": f"{calculation['request']['stock_code']} {period} {label}", "calculation_id": calculation_id,
               "formula_version": calculation["formula_version"], "normalization_version": calculation["normalization_version"],
               "request": calculation["request"], "metric_label": label, "point": {**point, "original_verified": verified},
               "inputs": inputs, "original_links": original, "original_verified": verified,
               "historical_note": "原文数值核对不自动补全供应商历史修订链；严格历史查询仍要求首次观察时间不晚于截止日。"}
    return _persist(payload)


def disclosure(version_id: str, stock_code: str, as_of: str, page=1, offset=0, limit=12000) -> dict:
    chunk = disclosures.read_page(version_id, page, as_of=as_of, offset=offset, limit=limit)
    return disclosure_chunk(chunk, stock_code, as_of)


def disclosure_chunk(chunk: dict, stock_code: str, as_of: str) -> dict:
    if chunk["classification"]["stock_code"] != stock_code:
        raise EvidenceError("披露不属于指定公司", 404)
    return _persist({"kind": "disclosure", "stock_code": stock_code, "as_of": as_of,
                     "title": chunk["classification"]["title"], **chunk, "original_verified": False})


def excerpt(payload: dict) -> str:
    if payload["kind"] == "disclosure":
        return f"{payload['title']} · {payload['stock_code']} · 物理页 {payload['page_number']} · SHA256 {payload['sha256']}\n首次归档 {payload.get('first_observed_at', '未知')} · 读取口径 {payload.get('read_mode', 'publication_date_only')} · 数值尚未核验\n{payload['text']}"
    point = payload["point"]
    lines = [f"{payload['title']}：{point['value'] if point['value'] is not None else '空值'} {point['unit']} · {point['reason']}",
             f"依据保存时间 {payload.get('created_at', '未知')}",
             f"截止 {payload['as_of']} · 请求口径 {payload['request']['basis']} · 实际口径 {point.get('actual_basis', payload['request']['basis'])} · 版本模式 {payload['request']['mode']}",
             f"公式 {point.get('formula')} · 公式版本 {payload['formula_version']} · 计算 {payload['calculation_id']}"]
    for item in payload["inputs"]:
        fact, record = item["fact"], item["record"]
        lines.append(f"输入 {item['fact_id']} · {record['report_period']} · {record['family']}.{fact['source_field']} · 原值 {fact['raw_value']} {fact['raw_unit']} · 标准值 {fact['value']} {fact['unit']} · {record['scope']} · 公告 {record['public_date']} · 首次观察 {record['first_observed_at']} · 源版本 {record['id']}")
    for item in payload["original_links"]:
        lines.append(f"原文关联 {item['id']} · {item.get('current_status', item['status'])} · PDF {item['document']['sha256']} · 首次归档 {item['document'].get('created_at', '未知')} · 物理页 {item.get('page_number')} · {item.get('quote', '')}")
        if item["document"].get("source_url"):
            lines.append("原始来源 " + item["document"]["source_url"])
    lines.extend(["原文全部输入已核对" if payload["original_verified"] else "原文未全部核对", payload["historical_note"]])
    return "\n".join(lines)


def public_reference(evidence_id: str) -> dict:
    payload = read(evidence_id)
    return {"kind": payload["kind"], "source_id": evidence_id, "title": payload["title"], "stock_code": payload["stock_code"],
            "url": payload["citation_url"], "excerpt": excerpt(payload), "excerpt_kind": "frozen_financial" if payload["kind"] == "financial" else "original_text",
            "data_snapshot": payload}


def pdf_path(evidence_id: str, link_id: str | None = None):
    payload = read(evidence_id)
    if payload["kind"] == "financial":
        link = next((item for item in payload["original_links"] if item["id"] == link_id), None)
        if not link:
            raise EvidenceError("此数字依据未包含指定原文", 404)
        payload = link["document"]
    with connect() as connection:
        row = connection.execute("SELECT source_path,sha256 FROM documents WHERE id=?", (payload["document_id"],)).fetchone()
    if not row or row["sha256"] != payload["sha256"]:
        raise EvidenceError("保存的 PDF 原件不匹配", 409)
    return documents.original_snapshot(row["source_path"], row["sha256"])


def view(evidence_id: str) -> str:
    payload = read(evidence_id)
    original = f'<a href="/api/v1/research-evidence/{evidence_id}/pdf#page={payload["page_number"]}">打开原 PDF 物理页 {payload["page_number"]}</a>' if payload["kind"] == "disclosure" else ""
    if payload["kind"] == "financial":
        original = "<ul>" + "".join(f'<li><a href="/api/v1/research-evidence/{evidence_id}/pdf?link_id={item["id"]}#page={item.get("page_number") or 1}">{escape(item["document"]["metadata"]["title"])} · {escape(item.get("current_status", item["status"]))} · 物理页 {item.get("page_number") or 1}</a></li>' for item in payload["original_links"]) + "</ul>"
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>' + escape(payload["title"]) + '</title><style>body{max-width:1100px;margin:32px auto;padding:20px;font:16px/1.8 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#174f78}</style><h1>' + escape(payload["title"]) + '</h1><p>不可覆盖的研究依据 · ' + escape(evidence_id) + '</p>' + original + '<pre>' + escape(excerpt(payload)) + '</pre></html>'
