from __future__ import annotations

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from apps.api.app import db, main, market, news_sources, research_projects, codex_runtime, conversation_store, research_tools
from apps.api.app.screening_tools import ToolContext, ToolDispatchError


@pytest.fixture
def research(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "company.db")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "missing.parquet")
    with TestClient(main.app) as client:
        project = research_projects.create_project(research_projects.CreateProject(name="经营兑现", request_id="project"))
        research_projects.add_company(project["id"], "600519.SH")
        note = research_projects.create_note(project["id"], research_projects.CreateNote(title="经营假设", request_id="note", stock_code="600519.SH"))
        record = news_sources.import_items(news_sources.NewsImport(request_id="news", items=[news_sources.NewsItemInput(
            title="合成经营资讯", body="这是合成资料。经营现金流需要与收入交叉核验。\n原文 🔎 包含换行。", source="合成来源",
            available_at="2026-09-10T10:00:00+08:00", stock_codes=["600519.SH"])]))["items"][0]
        with db.connect() as connection:
            connection.execute(
                """INSERT INTO documents(id,sha256,filename,title,stock_code,stock_code_status,available_at,
                   available_at_status,pages,extracted_chars,parse_status,source_path,imported_at)
                   VALUES('report','file-hash','source.pdf','合成研报','600519.SH','confirmed','2026-09-10','confirmed',2,100,'indexed','unused','2026-09-10')"""
            )
            connection.executemany("INSERT INTO document_pages VALUES('report',?,?)", [(1, "报告第一页。"), (2, "这是第二页的合成原文。经营\n现金流需核验。")])
        yield client, project["id"], note, record


def claim(note, record, **changes):
    return {"note_revision": note["revision"], "stock_code": "600519.SH", "statement": "现金流改善尚待核验", "kind": "inference", "as_of": "2026-09-10", "request_id": "claim",
            "evidence": [{"kind": "news", "source_id": record["id"], "quote": "经营现金流需要与收入交叉核验。", "stance": "supports"}], **changes}


def test_company_dossier_uses_explicit_date_and_preserves_market_quality_boundaries(research, monkeypatch):
    client, pid, _, _ = research
    monkeypatch.setattr(market, "get_bars", lambda *args: [{"trade_date": "2026-09-09", "quality_valid": False}])
    dossier = client.get(f"/api/v1/research-projects/{pid}/companies/600519.SH?as_of=2026-09-10").json()
    assert dossier["market_as_of"] == "2026-09-09" and dossier["invalid_bars"] == 1
    assert dossier["market_quality"]["price_basis"] == "unknown"
    assert dossier["news"]["total"] == 1 and dossier["reports"]["total"] == 1 and dossier["note_count"] == 1
    assert client.get(f"/api/v1/research-projects/{pid}/companies/600000.SH?as_of=2026-09-10").status_code == 404
    assert client.get(f"/api/v1/research-projects/{pid}/companies/600519.SH").status_code == 422
    cid = conversation_store.create_conversation("screening", project_id=pid)["id"]
    preview = research_tools.read_project_company(research_tools.ReadProjectCompanyArgs(stock_code="600519.SH", as_of="2026-09-10"), ToolContext(conversation_id=cid, turn_id="preview", task_revision=0))
    assert preview["preview_only"] and preview["news"]["preview_limit"] == 5
    assert preview["news"]["next_offset"] is None
    values = iter([("first",), ("changed",)])
    monkeypatch.setattr(market, "source_fingerprint", lambda: next(values))
    monkeypatch.setattr(market, "cached_profile", lambda: {})
    assert client.get(f"/api/v1/research-projects/{pid}/companies/600519.SH?as_of=2026-09-10").status_code == 409


def test_sources_select_news_version_available_on_research_day_in_shanghai(research):
    client, pid, _, original = research
    late = news_sources.import_items(news_sources.NewsImport(request_id="revision", items=[news_sources.NewsItemInput(
        title="后续修订", body="这是较晚的修订。", source="合成来源", stock_codes=["600519.SH"],
        available_at="2026-09-11T00:01:00+08:00")]), base_id=original["id"])["items"][0]
    root = f"/api/v1/research-projects/{pid}/companies/600519.SH"
    old = client.get(root + "/sources?kind=news&as_of=2026-09-10").json()
    assert old["items"][0]["source_id"] == original["id"]
    current = client.get(root + "/sources?kind=news&as_of=2026-09-11").json()
    assert current["items"][0]["source_id"] == late["id"]
    assert client.get(root + f"/source?kind=news&source_id={late['id']}&as_of=2026-09-10").status_code == 422
    with db.connect() as connection:
        connection.execute("UPDATE documents SET available_at_status='filename_candidate' WHERE id='report'")
    assert client.get(root + "/sources?kind=report&as_of=2026-09-10").json()["items"] == []
    assert client.get(root + "/source?kind=report&source_id=report&as_of=2026-09-10").status_code == 422


def test_claim_is_source_located_idempotent_and_bound_to_note_version(research):
    client, pid, note, record = research
    url = f"/api/v1/research-projects/{pid}/notes/{note['id']}/claims"
    payload = claim(note, record)
    saved = client.post(url, json=payload)
    assert saved.status_code == 200, saved.text
    saved = saved.json()
    assert saved["verification"] == "quote_located" and saved["semantic_support_verified"] is False
    assert saved["evidence"][0]["quote"] == payload["evidence"][0]["quote"]
    assert "text" not in saved["evidence"][0]
    assert client.post(url, json=payload).json()["id"] == saved["id"]
    assert client.post(url, json={**payload, "statement": "不同内容"}).status_code == 409
    research_projects.update_note(pid, note["id"], research_projects.UpdateNote(title=note["title"], body="新判断", stock_code="600519.SH", base_revision=1))
    assert client.post(url, json=payload).json()["id"] == saved["id"]
    assert client.post(url, json={**payload, "request_id": "new-old-note"}).status_code == 409
    assert client.get(url).json()["items"][0]["note_revision"] == 1
    cid = conversation_store.create_conversation("screening", project_id=pid)["id"]
    request = conversation_store.add_user_message(cid, "question", 0, "核对当前假设，先不筛选。")
    context = ToolContext(conversation_id=cid, turn_id=request["turn_id"], task_revision=0)
    prompt = json.loads(codex_runtime._prompt(cid, request["turn_id"]))
    assert prompt["research_project"]["recent_claims"][0]["semantic_support_verified"] is False
    assert prompt["research_project"]["recent_claims"][0]["id"] == saved["id"]
    evidence = research_tools.read_saved_research_evidence(research_tools.ReadSavedEvidenceArgs(claim_id=saved["id"]), context)
    assert evidence["quote"] in evidence["text"] and evidence["snapshot"] is True
    other = research_projects.create_project(research_projects.CreateProject(name="其他项目", request_id="other-read"))
    research_projects.link_conversation(cid, pid)  # Same assignment can be safely replayed while a turn is active.
    other_cid = conversation_store.create_conversation("screening", project_id=other["id"])["id"]
    with pytest.raises(ToolDispatchError):
        research_tools.read_saved_research_evidence(research_tools.ReadSavedEvidenceArgs(claim_id=saved["id"]), ToolContext(conversation_id=other_cid, turn_id="none", task_revision=0))
    with db.connect() as connection:
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("UPDATE research_claims SET statement='changed' WHERE id=?", (saved["id"],))


@pytest.mark.parametrize("change", [
    {"evidence": [{"kind": "news", "source_id": "absent", "quote": "不存在的引用"}]},
    {"evidence": []},
    {"kind": "certain"},
    {"as_of": "2026-09-09"},
    {"evidence": [{"kind": "report", "source_id": "report", "page_number": 1, "quote": "第二页的合成原文"}]},
    {"stock_code": "600000.SH"},
])
def test_bad_claims_never_publish_partial_evidence(research, change):
    client, pid, note, record = research
    url = f"/api/v1/research-projects/{pid}/notes/{note['id']}/claims"
    response = client.post(url, json=claim(note, record, **change))
    assert response.status_code in {422, 404}, response.text
    assert client.get(url).json()["total"] == 0


def test_frozen_report_text_survives_source_changes_and_is_project_scoped(research):
    client, pid, note, record = research
    payload = claim(note, record, kind="forecast", evidence=[{"kind": "report", "source_id": "report", "page_number": 2, "quote": "经营 现金流需核验。", "stance": "contradicts"}])
    url = f"/api/v1/research-projects/{pid}/notes/{note['id']}/claims"
    response = client.post(url, json=payload)
    assert response.status_code == 200, response.text
    saved = response.json()
    endpoint = f"/api/v1/research-projects/{pid}/claims/{saved['id']}/evidence/0"
    before = client.get(endpoint).json()
    assert before["quote"] == "经营\n现金流需核验。" and before["source_sha256"] == "file-hash"
    with db.connect() as connection:
        connection.execute("UPDATE document_pages SET text='后续变化' WHERE document_id='report' AND page_number=2")
    assert client.get(endpoint).json() == before
    assert before["text"][before["quote_start"] - before["char_start"]:before["quote_end"] - before["char_start"]] == before["quote"]
    other = research_projects.create_project(research_projects.CreateProject(name="其他研究", request_id="other"))
    assert client.get(endpoint.replace(pid, other["id"])).status_code == 404
    assert client.get(endpoint[:-1] + "-1").status_code == 404


def test_repeated_quotes_require_a_location_hint_and_preserve_unicode_offsets(research):
    client, pid, note, record = research
    record = news_sources.import_items(news_sources.NewsImport(request_id="repeated", items=[news_sources.NewsItemInput(
        title="重复文字", body="🔎核验结果。\n🔎核验结果。", source="合成资料", stock_codes=["600519.SH"],
        available_at="2026-09-10T10:00:00+08:00")]))["items"][0]
    payload = claim(note, record, evidence=[{"kind": "news", "source_id": record["id"], "quote": "🔎核验结果。", "stance": "context"}])
    url = f"/api/v1/research-projects/{pid}/notes/{note['id']}/claims"
    assert client.post(url, json=payload).status_code == 422
    payload["evidence"][0]["start_hint"] = 7
    saved = client.post(url, json=payload)
    assert saved.status_code == 200, saved.text
    assert saved.json()["evidence"][0]["quote_start"] == 7
