"""Prepare an isolated fourth-package demo from existing real source versions and an official archived PDF."""
from __future__ import annotations
import argparse
from datetime import datetime, timedelta
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--financial-db", type=Path, required=True)
    parser.add_argument("--responses", type=Path, required=True)
    parser.add_argument("--archive-result", type=Path, required=True)
    args = parser.parse_args()
    archive = json.loads(args.archive_result.read_text(encoding="utf-8"))
    old_environment = json.loads(Path(archive["environment"]).read_text(encoding="utf-8"))
    root = ROOT / "runtime" / "verification" / ("financial-research-" + uuid4().hex[:10])
    root.mkdir(parents=True, exist_ok=False)
    environment = {"LLMR_AUTH_MODE": "local", "LLMR_CONFIG_FILE": str(root / "isolated.ini"),
                   "LLMR_STATE_ROOT": str(root / "state"), "LLMR_DB_PATH": str(root / "state/app.db"),
                   "LLMR_UPLOAD_ROOT": str(root / "uploads"), "LLMR_ARTIFACT_ROOT": str(root / "artifacts")}
    os.environ.update(environment)
    (root / "environment.json").write_text(json.dumps(environment, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"verification_root": str(root)}, ensure_ascii=False), flush=True)
    (root / "state").mkdir()
    with sqlite3.connect(Path(old_environment["LLMR_DB_PATH"]).as_uri() + "?mode=ro", uri=True) as source, sqlite3.connect(environment["LLMR_DB_PATH"]) as target:
        source.backup(target)
    from apps.api.app import db, disclosures, financial_metrics, financial_facts, financial_research, financial_evidence
    from apps.api.app import research_projects, conversation_store, research_workspace, research_sources, research_shares, research_pdf, company_research, research_tracking
    from apps.api.app import financial_research_tools
    from apps.api.app.screening_tools import ToolContext
    from apps.api.app.financial_contracts import ZONE, timestamp
    from apps.api.app.storage import application_paths
    db.init_db()
    copied = {}
    with sqlite3.connect(args.financial_db.as_uri() + "?mode=ro", uri=True) as source, db.connect() as target:
        source.row_factory = sqlite3.Row
        source.execute("BEGIN")
        tables = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'financial_%'")} - {"financial_comparisons", "financial_evidence_links"}
        def copy(table, predicate=""):
            rows = source.execute("SELECT * FROM " + table + predicate).fetchall()
            if not rows:
                copied[table] = 0
                return
            columns = list(rows[0].keys())
            target.executemany("INSERT OR IGNORE INTO " + table + "(" + ",".join(columns) + ") VALUES(" + ",".join("?" for _ in columns) + ")", [tuple(row) for row in rows])
            copied[table] = len(rows)
        copy("jobs", " WHERE kind IN ('financial_probe','financial_sync')")
        copy("security_catalog")
        done = {"jobs", "security_catalog"}
        while tables:
            ready = [table for table in tables if {row[2] for row in source.execute("PRAGMA foreign_key_list(" + table + ")")} - {table} <= done]
            if not ready:
                raise RuntimeError("Financial fixture has unresolved dependencies: " + repr(tables))
            for table in ready:
                copy(table); done.add(table); tables.remove(table)
    response_target = application_paths().evidence_root / "financial-sources" / "responses"
    response_target.mkdir(parents=True, exist_ok=True)
    with db.connect() as connection:
        hashes = {row[0] for row in connection.execute("SELECT response_hash FROM financial_sync_observations")}
        hashes.update(row[0] for row in connection.execute("SELECT response_hash FROM financial_source_observations"))
    for value in hashes:
        source = args.responses / (value + ".json")
        if hashlib.sha256(source.read_bytes()).hexdigest() != value:
            raise RuntimeError("Raw response hash mismatch")
        shutil.copyfile(source, response_target / source.name)
    as_of = datetime.now(ZONE).date().isoformat()
    code = "000333.SZ"
    request = financial_metrics.FinancialQuery(stock_code=code, as_of=as_of, start_year=2021, basis="annual", mode="as_of",
        metrics=["revenue", "parent_net_profit", "operating_cashflow"])
    calculation = financial_metrics.freeze(request)
    point = next(row["values"]["revenue"] for row in calculation["rows"] if row["period"] == "2025-12-31")
    assert point["value"] is not None, point
    version_id = archive["version_id"]
    version = disclosures.detail(version_id, as_of=as_of)
    original, _ = disclosures.pdf_path(version_id, as_of=as_of)
    assert hashlib.sha256(original.read_bytes()).hexdigest() == archive["sha256"]
    hits = disclosures.search_pages(version_id, "利润表", as_of=as_of, limit=50)["items"]
    candidates = []
    for hit in hits:
        chunk = disclosures.read_page(version_id, hit["page_number"], as_of=as_of, limit=1000000)
        if "营业收入" in chunk["text"] and "2025" in chunk["text"]:
            candidates.append(chunk)
    if not candidates:
        raise RuntimeError("Cannot locate consolidated income statement")
    page = max(candidates, key=lambda item: len(item["text"]))
    lines = page["text"].splitlines()
    index = next(i for i, line in enumerate(lines) if "营业收入" in line)
    quote = "\n".join(lines[max(0, index - 1):index + 4])
    fact_id = point["input_fact_ids"][0]
    relation = financial_evidence.link(fact_id, financial_evidence.LinkRequest(version_id=version_id,
        metadata_revision=version["metadata"]["revision"], as_of=as_of, page_number=page["page_number"], quote=quote))
    assert relation["status"] == "document_related"
    proof = financial_evidence.financial(calculation["calculation_id"], "revenue", "2025-12-31")
    assert not proof["original_verified"], "Page matching must not become a human verification"
    token_candidates = []
    for token in re.findall(r"(?<![\d.,])\d[\d,]*(?:\.\d+)?(?![\d.,])", quote):
        try:
            number = Decimal(token.replace(",", ""))
            for unit, factor in (("元", Decimal(1)), ("千元", Decimal(1000)), ("万元", Decimal(10000)), ("亿元", Decimal(100000000))):
                tolerance = Decimal("0.5") * Decimal(10) ** number.as_tuple().exponent * factor
                if abs(number * factor - Decimal(point["value"])) <= tolerance:
                    token_candidates.append({"value": token, "unit_candidate": unit, "normalized_value": str(number * factor), "tolerance": str(tolerance)})
        except Exception:
            continue
    project = research_projects.create_project(research_projects.CreateProject(name="第四包隔离验收（真实数据）", request_id="project"))
    for stock in ("000333.SZ", "600519.SH", "300750.SZ"):
        research_projects.add_company(project["id"], stock)
    comparison_request = financial_research.ComparisonRequest(stock_codes=["000333.SZ", "600519.SH", "300750.SZ"],
        as_of=as_of, start_year=2021, metrics=["revenue", "parent_net_profit", "operating_cashflow"], project_id=project["id"])
    comparison = financial_research.save_comparison(comparison_request)
    body = "验收回放（非模型投资结论）：平台记录的美的集团2025年营业收入为 " + point["value"] + " 元。\n\n[独立数字依据](" + proof["citation_url"] + ")\n\n原文已定位关联，尚未发布为人工数值已核对。"
    note = research_projects.create_note(project["id"], research_projects.CreateNote(title="真实数值与原文关联验收", body=body,
        stock_code=code, request_id="note"))
    company_research.create_claim(project["id"], note["id"], company_research.CreateClaim(note_revision=1, stock_code=code,
        statement="保存平台记录值并核对原文", kind="fact", as_of=as_of, numeric_evidence=[proof["id"]], request_id="claim"))
    cid = conversation_store.create_conversation("screening", workflow_type="research")["id"]
    message = conversation_store.add_user_message(cid, "verification", 0, "隔离验收回放：核对已保存财务和原文，不生成投资结论。")
    conversation_store.start_turn(cid, message["turn_id"])
    research_workspace.prepare(cid, message["turn_id"])
    context = ToolContext(cid, message["turn_id"], 0, as_of=as_of, stock_codes=frozenset({code}), workflow_type="research")
    scoped = financial_research_tools.search_disclosures(financial_research_tools.SearchDisclosuresArgs(
        stock_code=code, as_of=as_of, report_period="2025-12-31", query="合并利润表"), context)
    assert any(item["version_id"] == version_id for item in scoped["items"])
    financial_research_tools.read_financial(financial_research_tools.FinancialEvidenceArgs(evidence_id=proof["id"]), context)
    conversation_store.finish_turn(cid, message["turn_id"], 0, "succeeded", body, {"source_refs": [financial_evidence.public_reference(proof["id"])]})
    conversation = conversation_store.get_conversation(cid)
    answer = next(item for item in reversed(conversation["messages"]) if item["role"] == "assistant")
    evidence = research_sources.answer_evidence(cid, answer["id"])
    assert any(item["kind"] == "financial" and point["value"] in item["excerpt"] for item in evidence["items"])
    shared = research_shares._snapshot(cid, answer["id"])
    (root / "share-snapshot.json").write_text(json.dumps(shared, ensure_ascii=False, indent=2), encoding="utf-8")
    exported = research_pdf.export_turn(cid, message["turn_id"])
    exported_path, _ = research_pdf.pdf_path(cid, exported["url"].rsplit("/", 1)[-1])
    from pypdf import PdfReader
    exported_text = "".join((pdf_page.extract_text() or "") for pdf_page in PdfReader(exported_path).pages)
    assert point["value"] in re.sub(r"\s+", "", exported_text)
    assert "financial-series-v1" in exported_text
    first_observation = min(timestamp(record["first_observed_at"]).astimezone(ZONE).date() for record in financial_facts.read_company(code)[0])
    historical = financial_metrics.calculate(request.model_copy(update={"as_of": first_observation - timedelta(days=1)}))
    assert all(value["value"] is None for row in historical["rows"] for value in row["values"].values())
    baseline = research_tracking.check(project["id"], code, research_tracking.CheckChanges(as_of=as_of, request_id="baseline"))
    repeat = research_tracking.check(project["id"], code, research_tracking.CheckChanges(as_of=as_of, request_id="repeat"))
    assert baseline["baseline"] and not repeat["changes"]
    report = {"status": "passed", "as_of": as_of, "project_id": project["id"], "stock_code": code,
        "conversation_id": cid, "turn_id": message["turn_id"], "comparison_id": comparison["id"], "proof_id": proof["id"],
        "official_version_id": version_id, "official_url": archive["official_url"], "sha256": archive["sha256"],
        "official_pdf": str(original), "physical_page": page["page_number"], "revenue": point["value"], "unit": point["unit"],
        "quote": quote, "unit_and_value_candidates": token_candidates, "original_status": relation["status"],
        "human_verification_published": False, "exported_pdf": str(exported_path), "raw_response_hashes": len(hashes), "copied": copied,
        "historical_cutoff_before_observation": (first_observation - timedelta(days=1)).isoformat(),
        "environment": str(root / "environment.json"), "note": "真实数据只读复制到隔离环境；回放和原文关联不伪称人工数值核验。"}
    (root / "environment.json").write_text(json.dumps(environment, ensure_ascii=False, indent=2), encoding="utf-8")
    (root / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
