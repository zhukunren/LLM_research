"""Versioned material changes and explicit human review, without automatic thesis decisions."""
from __future__ import annotations

from datetime import date
from uuid import uuid4

from pydantic import Field

from . import company_research, news_sources, research_materials, research_projects, financial_metrics, financial_facts, financial_evidence, documents
from .db import connect, json_dump, json_load, utc_now
from .screening_contracts import ContractModel
from .security_context import current_actor


class CheckChanges(ContractModel):
    as_of: date
    request_id: str = Field(min_length=1, max_length=100)


class ReviewChange(ContractModel):
    change_key: str = Field(min_length=1, max_length=200)
    comment: str = Field(default="", max_length=4000)


def _payload(connection, row) -> dict:
    value = dict(row)
    snapshot = json_load(value.pop("snapshot_json"))
    changes = json_load(value.pop("changes_json"))
    reviews = {review["change_key"]: dict(review) for review in connection.execute("SELECT change_key,comment,reviewer_user_id,created_at FROM research_change_reviews WHERE check_id=?", (row["id"],))}
    value["changes"] = [{**change, "review": reviews.get(change["key"])} for change in changes]
    value["baseline"] = snapshot["baseline"]
    value["coverage"] = snapshot["coverage"]
    value["review_questions"] = snapshot["review_questions"]
    value["unreviewed_count"] = sum(change["key"] not in reviews for change in changes)
    value["note"] = "这些是已接入资料和保存研究的变化；对论点的影响需人工复核，没有变化不代表市场没有新事件。"
    return value


def _record_inventory(project_id, code, as_of):
    corpus = research_materials.snapshot(project_id, [code], as_of)["companies"][code]
    context = company_research.research_context(project_id, code, as_of)
    inventory = {key: {**item, "category": "material"} for key, item in corpus["inventory"].items()}
    # Track numeric changes separately from source flags or model wording.
    records, facts = financial_facts.read_company(code)
    schemas = {record["id"]: record["schema_hash"] for record in records}
    labels = {item["code"]: item["label"] for item in financial_metrics.catalog()}
    metrics = ["revenue", "parent_net_profit", "operating_cashflow", "assets", "liabilities", "gross_margin", "cash_conversion"]
    numeric_targets, input_targets = {}, {}
    with connect() as connection:
        evidence = {row["id"]: json_load(row["payload_json"]) for row in connection.execute(
            "SELECT id,payload_json FROM research_data_evidence WHERE stock_code=? AND kind='financial'", (code,))}
        notes = [dict(row) for row in connection.execute("SELECT id,title,body FROM research_notes WHERE project_id=?", (project_id,))]
        for note in notes:
            ids = {key for key in evidence if key in note["body"]}
            for claim in connection.execute("SELECT id,numeric_evidence_json FROM research_claims WHERE note_id=?", (note["id"],)):
                ids.update(item["source_id"] for item in json_load(claim["numeric_evidence_json"]) if item["source_id"] in evidence)
            for key in ids:
                saved = evidence[key]
                target = (saved["request"]["basis"], saved["point"]["period"], saved["point"]["metric"])
                numeric_targets.setdefault(target, []).append({"note_id": note["id"], "title": note["title"], "evidence_id": key,
                    "url": f"/api/v1/research-evidence/{key}/view"})
                for item in saved["inputs"]:
                    input_targets.setdefault(item["fact_id"], []).append({"note_id": note["id"], "title": note["title"], "evidence_id": key,
                        "url": f"/api/v1/research-evidence/{key}/view"})
        linked = connection.execute("""SELECT DISTINCT f.id,f.report_period,f.metric_code FROM financial_facts f
            JOIN financial_evidence_links l ON l.fact_id=f.id WHERE f.stock_code=?""", (code,)).fetchall()
        for fact in linked:
            for link in financial_evidence.links(fact["id"], connection=connection, as_of=as_of, mode="as_of"):
                state = link["current_status"]
                if state == "superseded_check":
                    continue
                key = "original:" + fact["id"] + ":" + link["version_id"]
                inventory[key] = {"category": "financial_evidence", "title": fact["report_period"] + " " + fact["metric_code"] + " 原文核对",
                    "available_at": "", "original_check": link, "event": "original_value_conflict" if state == "conflict" else "original_classification_changed" if state == "classification_changed" else "original_check_changed",
                    "fingerprint": research_materials.fingerprint(json_dump([state, link.get("normalized_value"), link.get("difference"), link["metadata_revision"]])),
                    "affected_notes": input_targets.get(fact["id"], [])}
    for basis in ("annual", "quarter", "ttm"):
        result = financial_metrics.calculate(financial_metrics.FinancialQuery(stock_code=code, as_of=as_of,
            basis=basis, mode="as_of", metrics=metrics), records=records, facts=facts)
        for row in result["rows"]:
            for metric, point in row["values"].items():
                value_signature = [point["value"], point["status"], point["unit"], point["currency"], point.get("comparability")]
                schema_signature = sorted({schemas[rid] for rid in point["source_record_ids"]})
                inventory[f"financial:{basis}:{row['period']}:{metric}"] = {
                    "category": "financial", "title": f"{row['period']} {basis} {labels[metric]}", "available_at": "",
                    "basis": basis, "metric": metric, "period": row["period"], "point": point,
                    "formula_version": result["formula_version"], "normalization_version": result["normalization_version"], "schema_signature": schema_signature,
                    "value_fingerprint": research_materials.fingerprint(json_dump(value_signature)),
                    "fingerprint": research_materials.fingerprint(json_dump([value_signature, schema_signature, result["formula_version"], result["normalization_version"]])),
                    "affected_notes": numeric_targets.get((basis, row["period"], metric), [])}
    for item in inventory.values():
        if item.get("source_type") == "disclosure":
            affected = [note for (basis, period, metric), notes in numeric_targets.items() if period == item.get("report_period") for note in notes]
            for claim in context["claims"]:
                if any(reference["source_type"] == "disclosure" and reference.get("classification", {}).get("report_period") == item.get("report_period") for reference in claim["evidence"]):
                    affected.append({"note_id": claim["note_id"], "title": claim["statement"], "claim_id": claim["id"]})
            item["affected_notes"] = list({note["note_id"]: note for note in affected}.values())
    for note in context["notes"]:
        inventory["note:" + note["id"]] = {"category": "research", "title": note["title"], "note_id": note["id"],
            "revision": note["revision"], "status": note["status"], "available_at": note["updated_at"],
            "fingerprint": research_materials.fingerprint(json_dump(note))}
    for claim in context["claims"]:
        inventory["claim:" + claim["id"]] = {"category": "research", "title": claim["statement"], "claim_id": claim["id"],
            "note_id": claim["note_id"], "available_at": claim["created_at"], "needs_revalidation": claim["needs_revalidation"],
            "fingerprint": research_materials.fingerprint(json_dump(claim))}
    questions = [{"note_id": note["id"], "title": note["title"], "revision": note["revision"],
        "validation_plan": note["validation_plan"], "invalidation_condition": note["invalidation_condition"]} for note in context["notes"]]
    return inventory, corpus["coverage"], questions


def check(project_id: str, code: str, payload: CheckChanges) -> dict:
    as_of = payload.as_of.isoformat()
    with connect() as connection:
        company_research._require_company(connection, project_id, code, writable=True)
        existing = connection.execute("SELECT * FROM research_tracking_checks WHERE project_id=? AND stock_code=? AND request_id=?", (project_id, code, payload.request_id)).fetchone()
        if existing:
            if existing["as_of"] != as_of:
                raise research_projects.ProjectError("相同检查请求不能更改截止日。", 409)
            return _payload(connection, existing)
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        company_research._require_company(connection, project_id, code, writable=True)
        existing = connection.execute("SELECT * FROM research_tracking_checks WHERE project_id=? AND stock_code=? AND request_id=?", (project_id, code, payload.request_id)).fetchone()
        if existing:
            if existing["as_of"] != as_of:
                raise research_projects.ProjectError("相同检查请求不能更改截止日。", 409)
            return _payload(connection, existing)
        prior = connection.execute("SELECT * FROM research_tracking_checks WHERE project_id=? AND stock_code=? ORDER BY rowid DESC LIMIT 1", (project_id, code)).fetchone()
        if prior and prior["as_of"] > as_of:
            raise research_projects.ProjectError("资料变化检查的截止日不能早于上次检查。可在公司资料中读取较早日期。", 409)
        # Serialise capture and publication so two simultaneous checks cannot
        # commit an older inventory after a newer one or mix note/material edits.
        inventory, coverage, questions = _record_inventory(project_id, code, as_of)
        old = json_load(prior["snapshot_json"])["inventory"] if prior else {}
        changes = []
        if prior:
            for key, item in inventory.items():
                previous = old.get(key)
                if previous is None and item["category"] == "financial" and item["point"]["value"] is None and not item["point"]["input_fact_ids"]:
                    continue
                if previous is None or any(previous.get(field) != item.get(field) for field in ("fingerprint", "title", "available_at", "page_count")):
                    event = item.get("event") or ("new_disclosure" if item.get("source_type") == "disclosure" and previous is None else "source_change")
                    if item["category"] == "financial":
                        event = "formula_change" if previous and previous.get("formula_version") != item["formula_version"] else "contract_change" if item["point"]["status"] == "scope_or_contract_conflict" or previous and (previous.get("normalization_version") != item["normalization_version"] or previous.get("schema_signature") != item["schema_signature"] and previous.get("value_fingerprint") == item["value_fingerprint"]) else "derived_metric_change" if item["basis"] in {"quarter", "ttm"} else "source_value_revision"
                    changes.append({"key": key, "type": "added" if previous is None else "updated", "event": event, **item,
                        "previous": previous, "semantic_impact_verified": False})
            if coverage.get("inventory_complete", True):
                for key, item in old.items():
                    if key not in inventory and item["category"] == "material":
                        changes.append({"key": key, "type": "unavailable", **item, "previous": item, "semantic_impact_verified": False})
        check_id, now = str(uuid4()), utc_now()
        snapshot = {"inventory": inventory, "baseline": prior is None, "coverage": coverage, "review_questions": questions,
                    "prior_check_id": prior["id"] if prior else None}
        connection.execute("INSERT INTO research_tracking_checks VALUES(?,?,?,?,?,?,?,?)", (check_id, project_id, code, as_of, json_dump(snapshot), json_dump(changes), payload.request_id, now))
        return _payload(connection, connection.execute("SELECT * FROM research_tracking_checks WHERE id=?", (check_id,)).fetchone())


def list_checks(project_id: str, code: str, *, limit: int = 20) -> dict:
    with connect() as connection:
        company_research._require_company(connection, project_id, code)
        rows = connection.execute("SELECT * FROM research_tracking_checks WHERE project_id=? AND stock_code=? ORDER BY rowid DESC LIMIT ?", (project_id, code, limit)).fetchall()
        return {"items": [_payload(connection, row) for row in rows]}


def source(project_id: str, check_id: str, change_key: str, page: int = 1, offset: int = 0) -> dict:
    """Read the explicit version recorded by this check, even after later news revisions."""
    with connect() as connection:
        research_projects._require_project(connection, project_id)
        check = connection.execute("SELECT * FROM research_tracking_checks WHERE id=? AND project_id=?", (check_id, project_id)).fetchone()
        change = next((item for item in json_load(check["changes_json"]) if item["key"] == change_key), None) if check else None
        if not change or change.get("category") != "material" or not change.get("source_id"):
            raise research_projects.ProjectError("找不到该检查记录中的原文资料。", 404)
        if change["source_type"] == "disclosure":
            doc = connection.execute("SELECT source_path,sha256 FROM documents WHERE id=?", (change["document_id"],)).fetchone()
            if not doc or doc["sha256"] != change["source_sha256"]:
                raise research_projects.ProjectError("保存的披露原件不可用", 409)
            documents.original_snapshot(doc["source_path"], doc["sha256"])
            row = connection.execute("SELECT text FROM document_pages WHERE document_id=? AND page_number=?", (change["document_id"], page)).fetchone()
            if not row or offset < 0 or offset > len(row[0]):
                raise research_projects.ProjectError("原文页码或位置无效")
            text, end = row[0], min(len(row[0]), offset + 12000)
            return {"source_type": "disclosure", "source_id": change["source_id"], "stock_code": check["stock_code"],
                    "title": change["title"], "available_at": change["available_at"], "publication_at": change["available_at"],
                    "page_count": change["page_count"], "page_number": page, "text": text[offset:end], "char_start": offset, "char_end": end,
                    "original_characters": len(text), "next_offset": end if end < len(text) else None,
                    "source_sha256": doc["sha256"], "source_version": change["source_version"], "as_of": check["as_of"]}
        if change["source_type"] == "news":
            item = connection.execute("SELECT * FROM news_records WHERE id=?", (change["source_id"],)).fetchone()
            if not item or research_materials.fingerprint(f"{item['id']}:{item['version']}") != change["fingerprint"]:
                raise research_projects.ProjectError("保存的资讯版本不可用。", 409)
            _, cutoff_end = news_sources._window(check["as_of"], None)
            if check["stock_code"] not in json_load(item["stock_codes_json"]) or not item["available_at"] or item["available_at"] >= cutoff_end:
                raise research_projects.ProjectError("保存的资讯不符合本次证券或截止日。", 409)
            text = item["body"]
            if page != 1 or offset < 0 or offset > len(text):
                raise research_projects.ProjectError("资讯页码或读取位置无效。")
            chunk_end = min(len(text), offset + 12000)
            return {"source_type": "news", "source_id": item["id"], "stock_code": check["stock_code"], "title": item["title"],
                "available_at": item["available_at"], "publication_at": item["published_at"], "page_count": 1, "page_number": 1,
                "text": text[offset:chunk_end], "char_start": offset, "char_end": chunk_end, "original_characters": len(text),
                "next_offset": chunk_end if chunk_end < len(text) else None, "source_version": item["version"],
                "source_sha256": research_materials.fingerprint(text), "as_of": check["as_of"]}
    return company_research.source(project_id, check["stock_code"], change["source_type"], change["source_id"], page, check["as_of"], offset)


def review(project_id: str, check_id: str, payload: ReviewChange) -> dict:
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        research_projects._require_project(connection, project_id, writable=True)
        row = connection.execute("SELECT * FROM research_tracking_checks WHERE id=? AND project_id=?", (check_id, project_id)).fetchone()
        if not row or not any(item["key"] == payload.change_key for item in json_load(row["changes_json"])):
            raise research_projects.ProjectError("找不到这项资料变化。", 404)
        old = connection.execute("SELECT comment FROM research_change_reviews WHERE check_id=? AND change_key=?", (check_id, payload.change_key)).fetchone()
        if old and old[0] != payload.comment:
            raise research_projects.ProjectError("该项已保存复核记录，请保留原记录。", 409)
        connection.execute("INSERT OR IGNORE INTO research_change_reviews VALUES(?,?,?,?,?,?)", (str(uuid4()), check_id, payload.change_key, payload.comment, current_actor().user_id, utc_now()))
        return _payload(connection, row)
