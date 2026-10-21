"""Fourth-package proof, temporal, comparison and project integration boundaries."""
from dataclasses import replace
import io
import json
import sqlite3

from fastapi.testclient import TestClient
import pytest
from reportlab.pdfgen.canvas import Canvas

from apps.api.app import db, main, market, worker, disclosures, financial_facts, financial_metrics, financial_evidence
from apps.api.app import financial_research, financial_research_tools, financial_contracts, research_workspace, conversation_store
from apps.api.app import research_projects, company_research, research_tracking, research_sources, research_materials
from apps.api.app.screening_tools import ToolContext, ToolDispatchError
from apps.api.app.security_context import LOCAL_ACTOR, actor_scope, AccessDenied

CODES = ["600519.SH", "000333.SZ", "300750.SZ"]
DAY = "2026-04-03"


def add_record(code=CODES[0], amount="123456.78", ann="20260330"):
    record = financial_contracts.normalize_record("income", {
        "ts_code": code, "end_date": "20251231", "ann_date": ann, "f_ann_date": ann,
        "report_type": "1", "comp_type": "1", "update_flag": "1", "revenue": amount,
        "n_income": "50000", "n_income_attr_p": "40000", "minority_gain": "10000", "oper_cost": "70000",
    }, observed_at="2026-04-02T10:00:00+08:00")
    with db.connect() as connection:
        financial_facts.materialize(connection, record)
    return financial_contracts.digest([record["id"], "revenue", financial_facts.NORMALIZATION_VERSION])


def query(code=CODES[0]):
    return financial_metrics.FinancialQuery(stock_code=code, as_of=DAY, start_year=2025, metrics=["revenue"], mode="as_of")


@pytest.fixture
def research(tmp_path, monkeypatch):
    monkeypatch.setenv("LLMR_AUTH_MODE", "local")
    monkeypatch.setenv("LLMR_CONFIG_FILE", str(tmp_path / "absent.ini"))
    monkeypatch.setenv("LLMR_STATE_ROOT", str(tmp_path / "state"))
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "proof.db")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "missing.parquet")
    monkeypatch.setattr(disclosures, "utc_now", lambda: "2026-04-02T08:00:00+00:00")
    with TestClient(main.app) as client:
        for code in CODES:
            add_record(code)
        stream = io.BytesIO()
        canvas = Canvas(stream)
        canvas.drawString(30, 750, "SYNTHETIC annual report 2025")
        canvas.showPage()
        canvas.drawString(30, 750, "Revenue 123.46 thousand CNY consolidated 2025")
        canvas.save()
        item = disclosures.enqueue(disclosures.ImportRequest(request_id="original", metadata=disclosures.Metadata(
            title="SYNTHETIC primary report", stock_code=CODES[0], report_period="2025-12-31", document_type="annual",
            document_form="full", publication_date="2026-03-31", confirmed=True)), data=stream.getvalue(), filename="600519.SH-2025.pdf")
        worker.execute_job(item["job_id"])
        result = disclosures.read_import(item["id"])
        assert result["state"] == "succeeded", result
        project = research_projects.create_project(research_projects.CreateProject(name="隔离财务验收", request_id="project"))
        for code in CODES:
            research_projects.add_company(project["id"], code)
        note = research_projects.create_note(project["id"], research_projects.CreateNote(title="收入判断", body="核对收入", stock_code=CODES[0], request_id="note"))
        yield {"client": client, "version": result["version_id"], "fact": add_record(), "project": project["id"], "note": note["id"]}


def verification(store, **changes):
    return financial_evidence.LinkRequest(version_id=store["version"], metadata_revision=1, as_of=DAY, page_number=2,
        quote="Revenue 123.46 thousand CNY consolidated 2025", reported_value="123.46", reported_unit="千元",
        report_period="2025-12-31", scope="consolidated", column_note="SYNTHETIC 2025 current consolidated column",
        manually_confirmed=True, **changes)


def test_original_link_is_not_numeric_verification_and_exact_decimal_rounding_is_explicit(research):
    related = financial_evidence.link(research["fact"], financial_evidence.LinkRequest(version_id=research["version"], metadata_revision=1, as_of=DAY))
    assert related["status"] == "document_related"
    verified = financial_evidence.link(research["fact"], verification(research))
    assert verified["status"] == "value_verified"
    assert verified["normalized_value"] == "123460" and verified["difference"] == "3.22" and verified["tolerance"] == "5"
    with db.connect() as connection, pytest.raises(sqlite3.IntegrityError, match="immutable"):
        connection.execute("UPDATE financial_evidence_links SET status='value_verified'")


def test_wrong_scope_period_token_and_unconfirmed_column_do_not_become_verified(research):
    original = verification(research).model_dump(mode="json")
    for changes in ({"scope": "parent"}, {"report_period": "2024-12-31"}, {"reported_value": "23.46"},
                    {"reported_value": "123.460"}, {"column_note": ""}, {"manually_confirmed": False}):
        with pytest.raises(financial_evidence.EvidenceError):
            financial_evidence.link(research["fact"], financial_evidence.LinkRequest(**(original | changes)))
    foreign = add_record(CODES[1])
    with pytest.raises(financial_evidence.EvidenceError, match="公司"):
        financial_evidence.link(foreign, verification(research))


def test_conflict_retains_both_values_and_independent_citations_survive_revisions(research):
    financial_evidence.link(research["fact"], verification(research))
    frozen = financial_metrics.freeze(query())
    old = financial_evidence.financial(frozen["calculation_id"], "revenue", "2025-12-31")
    assert old["original_verified"] and old["point"]["value"] == "123456.78"
    new_fact = add_record(amount="99999", ann="20260402")
    conflict = financial_evidence.link(new_fact, verification(research))
    assert conflict["status"] == "conflict" and conflict["source_value"] == "99999"
    assert financial_evidence.read(old["id"]) == old
    assert financial_metrics.calculate(query())["rows"][0]["values"]["revenue"]["value"] == "99999"
    client = research["client"]
    assert client.get(old["citation_url"]).status_code == 200
    assert "123456.78" in client.get(old["citation_url"]).text
    with db.connect() as connection, pytest.raises(sqlite3.IntegrityError, match="immutable"):
        connection.execute("DELETE FROM research_data_evidence")


def test_original_verification_does_not_invent_historical_provider_availability(research):
    financial_evidence.link(research["fact"], verification(research))
    strict = financial_metrics.calculate(query().model_copy(update={"as_of": __import__("datetime").date(2026, 3, 31)}))
    assert strict["rows"][0]["values"]["revenue"]["value"] is None


def test_comparison_is_aligned_saved_and_stale_preview_cannot_be_published(research):
    request = financial_research.ComparisonRequest(stock_codes=CODES, as_of=DAY, start_year=2025, metrics=["revenue"], project_id=research["project"])
    preview = financial_research.compare(request)
    saved = financial_research.save_comparison(request, preview["id"])
    assert all(item["rows"][0]["values"]["revenue"]["unit"] == "元" for item in saved["calculations"])
    add_record(amount="200000", ann="20260402")
    assert financial_research.read_comparison(saved["id"]) == saved
    with pytest.raises(financial_evidence.EvidenceError, match="变化"):
        financial_research.save_comparison(request, preview["id"])
    with pytest.raises(ValueError):
        financial_research.ComparisonRequest(stock_codes=CODES[:2], as_of=DAY)


def make_turn():
    cid = conversation_store.create_conversation("screening", workflow_type="research")["id"]
    message = conversation_store.add_user_message(cid, "request", 0, "核对财务，不创建筛选任务")
    conversation_store.start_turn(cid, message["turn_id"])
    return ToolContext(cid, message["turn_id"], 0, as_of=DAY, stock_codes=frozenset(CODES), workflow_type="research")


def test_turn_tools_read_frozen_financials_and_disclosures_instead_of_new_versions(research):
    context = make_turn()
    manifest = research_workspace.prepare(context.conversation_id, context.turn_id)
    with sqlite3.connect(manifest["sources"]["sqlite"]) as connection:
        assert connection.execute("SELECT COUNT(*) FROM financial_facts").fetchone()[0] > 0
        assert connection.execute("SELECT COUNT(*) FROM disclosure_pages").fetchone()[0] == 2
        assert not connection.execute("SELECT 1 FROM sqlite_master WHERE name='settings'").fetchone()
    args = financial_research_tools.FinancialArgs(stock_code=CODES[0], as_of=DAY, start_year=2025, metrics=["revenue"])
    first = financial_research_tools.get_financials(args, context)
    add_record(amount="200000", ann="20260402")
    later = financial_research_tools.get_financials(args, context)
    assert later == first
    citation = financial_research_tools.read_financial(financial_research_tools.FinancialEvidenceArgs(
        calculation_id=first["calculation_id"], metric="revenue", period="2025-12-31"), context)
    assert citation["point"]["value"] == "123456.78"
    live = financial_metrics.freeze(query())
    with pytest.raises(ToolDispatchError, match="本回合"):
        financial_research_tools.read_financial(financial_research_tools.FinancialEvidenceArgs(
            calculation_id=live["calculation_id"], metric="revenue", period="2025-12-31"), context)
    search = financial_research_tools.search_disclosures(financial_research_tools.SearchDisclosuresArgs(
        stock_code=CODES[0], as_of=DAY, report_period="2025-12-31", query="Revenue"), context)
    assert search["items"][0]["matched_physical_pages"] == [2]
    page = financial_research_tools.read_disclosure(financial_research_tools.ReadDisclosureArgs(
        stock_code=CODES[0], as_of=DAY, version_id=research["version"], page_number=2), context)
    assert page["kind"] == "disclosure" and "123.46" in page["text"]
    assert research["client"].get(page["citation_url"].replace("/view", "/pdf")).content.startswith(b"%PDF")


def test_numeric_claims_and_revision_impact_link_old_research_without_overwriting_it(research):
    old = financial_metrics.freeze(query())
    proof = financial_evidence.financial(old["calculation_id"], "revenue", "2025-12-31")
    claim = company_research.create_claim(research["project"], research["note"], company_research.CreateClaim(
        note_revision=1, stock_code=CODES[0], statement="合成收入判断", kind="fact", as_of=DAY,
        numeric_evidence=[proof["id"]], request_id="claim"))
    assert claim["numeric_evidence"][0]["source_id"] == proof["id"]
    research_tracking.check(research["project"], CODES[0], research_tracking.CheckChanges(as_of=DAY, request_id="baseline"))
    add_record(amount="200000", ann="20260402")
    changes = research_tracking.check(research["project"], CODES[0], research_tracking.CheckChanges(as_of=DAY, request_id="later"))["changes"]
    changed = next(item for item in changes if item.get("event") == "source_value_revision" and item.get("metric") == "revenue")
    assert changed["previous"]["point"]["value"] == "123456.78"
    assert changed["point"]["value"] == "200000"
    assert changed["affected_notes"][0]["note_id"] == research["note"]
    assert financial_evidence.read(proof["id"])["point"]["value"] == "123456.78"


def test_answer_evidence_and_material_search_include_frozen_numeric_and_primary_sources(research):
    old = financial_metrics.freeze(query())
    proof = financial_evidence.financial(old["calculation_id"], "revenue", "2025-12-31")
    with db.connect() as connection:
        collected = research_sources.collect(connection, "unused", None, "[收入依据](" + proof["citation_url"] + ")")
    assert collected["items"][0]["kind"] == "financial" and "123456.78" in collected["items"][0]["excerpt"]
    corpus = research_materials.snapshot(research["project"], [CODES[0]], DAY, questions=["Revenue consolidated 2025"])
    assert any(item["source_type"] == "disclosure" and item["page_number"] == 2 for item in corpus["companies"][CODES[0]]["chunks"])


def test_viewer_cannot_publish_links_and_workspace_cannot_read_other_users_evidence(research):
    saved = financial_metrics.freeze(query())
    proof = financial_evidence.financial(saved["calculation_id"], "revenue", "2025-12-31")
    with actor_scope(replace(LOCAL_ACTOR, role="viewer")):
        with pytest.raises(AccessDenied):
            financial_evidence.link(research["fact"], verification(research))
    with actor_scope(replace(LOCAL_ACTOR, legacy=False, user_id="other", tenant_id="other")):
        db.init_db()
        with pytest.raises(financial_evidence.EvidenceError):
            financial_evidence.read(proof["id"])


def test_saved_old_evidence_is_readable_in_a_new_turn_without_using_new_values(research):
    old = financial_metrics.freeze(query())
    proof = financial_evidence.financial(old["calculation_id"], "revenue", "2025-12-31")
    add_record(amount="200000", ann="20260402")
    context = make_turn()
    research_workspace.prepare(context.conversation_id, context.turn_id)
    read = financial_research_tools.read_financial(financial_research_tools.FinancialEvidenceArgs(evidence_id=proof["id"]), context)
    assert read["point"]["value"] == "123456.78"
    latest = financial_metrics.freeze(query())
    future_proof = financial_evidence.financial(latest["calculation_id"], "revenue", "2025-12-31")
    with pytest.raises(ToolDispatchError):
        financial_research_tools.read_financial(financial_research_tools.FinancialEvidenceArgs(evidence_id=future_proof["id"]), context)


def test_classification_changes_invalidate_live_verification_but_not_old_reference_or_pdf(research):
    checked = financial_evidence.link(research["fact"], verification(research))
    result = financial_metrics.freeze(query())
    proof = financial_evidence.financial(result["calculation_id"], "revenue", "2025-12-31")
    metadata = disclosures.detail(research["version"])["metadata"]
    payload = {key: metadata[key] for key in disclosures.Metadata.model_fields}
    payload["confirmed"] = False
    disclosures.update_metadata(research["version"], disclosures.MetadataUpdate(base_revision=1, metadata=disclosures.Metadata(**payload)))
    assert financial_evidence.links(research["fact"])[0]["current_status"] == "classification_changed"
    assert not financial_evidence.financial(result["calculation_id"], "revenue", "2025-12-31")["original_verified"]
    assert financial_evidence.read(proof["id"])["original_verified"]
    response = research["client"].get(proof["citation_url"].replace("/view", "/pdf") + "?link_id=" + checked["id"])
    assert response.status_code == 200 and response.content.startswith(b"%PDF")


def test_verification_retries_are_idempotent_and_a_fresh_review_can_resolve_conflict(research):
    request = verification(research)
    verified = financial_evidence.link(research["fact"], request)
    assert financial_evidence.link(research["fact"], request) == verified
    with pytest.raises(financial_evidence.EvidenceError, match="相同"):
        financial_evidence.link(research["fact"], request.model_copy(update={"column_note": "changed"}))
    related = financial_evidence.LinkRequest(version_id=research["version"], metadata_revision=1, as_of=DAY)
    financial_evidence.link(research["fact"], related)
    result = financial_metrics.freeze(query())
    assert financial_evidence.financial(result["calculation_id"], "revenue", "2025-12-31")["original_verified"]
    conflict = verification(research).model_copy(update={"reported_value": "2025", "reported_unit": "元"})
    assert financial_evidence.link(research["fact"], conflict)["status"] == "conflict"
    assert not financial_evidence.financial(result["calculation_id"], "revenue", "2025-12-31")["original_verified"]
    financial_evidence.link(research["fact"], verification(research))
    assert financial_evidence.financial(result["calculation_id"], "revenue", "2025-12-31")["original_verified"]


def test_historical_disclosure_selection_falls_back_to_observed_original_before_late_revision(research, monkeypatch):
    from apps.api.app import evidence_sources
    monkeypatch.setattr(disclosures, "utc_now", lambda: "2026-04-04T08:00:00+00:00")
    stream = io.BytesIO()
    canvas = Canvas(stream); canvas.drawString(30, 750, "SYNTHETIC revision Revenue 999.00"); canvas.save()
    item = disclosures.enqueue(disclosures.ImportRequest(request_id="late", relation="revision", target_version_id=research["version"],
        metadata=disclosures.Metadata(title="SYNTHETIC revision", stock_code=CODES[0], report_period="2025-12-31", document_type="annual",
            document_form="full", publication_date="2026-04-02", confirmed=True)), data=stream.getvalue(), filename="revision.pdf")
    worker.execute_job(item["job_id"])
    late = disclosures.read_import(item["id"])
    assert late["state"] == "succeeded", late
    assert disclosures.list_versions(stock_code=CODES[0], as_of=DAY)["items"][0]["id"] == late["version_id"]
    assert evidence_sources.list_disclosure_sources(CODES[0], DAY)["items"][0]["source_id"] == research["version"]
    with pytest.raises(evidence_sources.EvidenceSourceError, match="截止日后"):
        evidence_sources.read_disclosure_chunk(late["version_id"], 1, CODES[0], DAY)


def test_export_appendix_and_quality_keep_the_saved_numeric_values_after_sync(research):
    from apps.api.app import research_quality
    original = financial_metrics.freeze(query())
    proof = financial_evidence.financial(original["calculation_id"], "revenue", "2025-12-31")
    company_research.create_claim(research["project"], research["note"], company_research.CreateClaim(note_revision=1,
        stock_code=CODES[0], statement="合成财务判断", kind="fact", as_of=DAY, numeric_evidence=[proof["id"]], request_id="numeric"))
    add_record(amount="200000", ann="20260402")
    export = financial_evidence.append_citations("[收入](" + proof["citation_url"] + ")")
    assert "123456.78 元" in export and "200000" not in export
    assert "financial-series-v1" in export
    audit = research_quality.project_audit(research["project"])
    assert audit["metrics"]["valid_references"] == 1


def test_new_disclosure_revision_supersedes_old_conflict_without_leaking_into_cutoff(research, monkeypatch):
    fact = add_record(amount="99999", ann="20260402")
    old = financial_evidence.link(fact, verification(research))
    assert old["status"] == "conflict"
    frozen = financial_metrics.freeze(query())
    old_proof = financial_evidence.financial(frozen["calculation_id"], "revenue", "2025-12-31")
    monkeypatch.setattr(disclosures, "utc_now", lambda: "2026-04-04T08:00:00+00:00")
    stream = io.BytesIO()
    canvas = Canvas(stream); canvas.drawString(30, 750, "SYNTHETIC revision Revenue 99.999 thousand CNY"); canvas.save()
    item = disclosures.enqueue(disclosures.ImportRequest(request_id="revised-check", relation="revision", target_version_id=research["version"],
        metadata=disclosures.Metadata(title="SYNTHETIC revised annual", stock_code=CODES[0], report_period="2025-12-31", document_type="annual",
            document_form="full", publication_date="2026-04-02", confirmed=True)), data=stream.getvalue(), filename="revision.pdf")
    worker.execute_job(item["job_id"])
    version = disclosures.read_import(item["id"])["version_id"]
    request = verification(research).model_dump(mode="json") | {"version_id": version, "as_of": "2026-04-04", "page_number": 1,
        "quote": "SYNTHETIC revision Revenue 99.999 thousand CNY", "reported_value": "99.999"}
    assert financial_evidence.link(fact, financial_evidence.LinkRequest(**request))["status"] == "value_verified"
    latest = financial_evidence.links(fact, as_of=DAY, mode="latest")
    assert {value["current_status"] for value in latest} == {"value_verified", "superseded_document"}
    historical = financial_evidence.links(fact, as_of=DAY, mode="as_of")
    assert len(historical) == 1 and historical[0]["current_status"] == "conflict"
    assert financial_evidence.financial(frozen["calculation_id"], "revenue", "2025-12-31")["original_verified"] is False
    latest_calc = financial_metrics.freeze(query().model_copy(update={"mode": "latest"}))
    latest_proof = financial_evidence.financial(latest_calc["calculation_id"], "revenue", "2025-12-31")
    assert latest_proof["original_verified"] is True
    with pytest.raises(research_projects.ProjectError, match="截止日后"):
        company_research.create_claim(research["project"], research["note"], company_research.CreateClaim(note_revision=1,
            stock_code=CODES[0], statement="不能倒填历史依据", kind="fact", as_of=DAY, numeric_evidence=[latest_proof["id"]], request_id="late-original"))
    assert financial_evidence.read(old_proof["id"]) == old_proof
    response = research["client"].get("/api/v1/financial-facts/" + fact + "/original-evidence", params={"as_of": DAY, "mode": "as_of"})
    assert response.status_code == 200 and len(response.json()["items"]) == 1
