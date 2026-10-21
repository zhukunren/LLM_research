import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from apps.api.app import company_research, db, jobs, main, market, news_sources, research_matrices, research_projects, worker


@pytest.fixture
def workbench(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "workbench.db")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "missing.parquet")
    monkeypatch.setattr(research_matrices, "llm_settings", lambda: {"configured": True})
    with TestClient(main.app) as client:
        project = research_projects.create_project(research_projects.CreateProject(name="同业核验", request_id="project"))
        codes, records = ["600519.SH", "000858.SZ"], []
        for index, code in enumerate(codes):
            research_projects.add_company(project["id"], code)
            records.append(news_sources.import_items(news_sources.NewsImport(request_id="news-" + code, items=[news_sources.NewsItemInput(
                title="合成公司披露", body=f"合成资料：本期订单金额为{index + 10}亿元。尚未披露客户名单。", source="隔离验收资料",
                available_at="2026-09-10T10:00:00+08:00", stock_codes=[code])]))["items"][0])
        note = research_projects.create_note(project["id"], research_projects.CreateNote(title="订单兑现", body="核对订单", stock_code=codes[0], validation_plan="订单是否交付", invalidation_condition="大额订单取消", request_id="note"))
        yield client, project["id"], codes, records, note


def create_matrix(client, pid, codes, request="matrix"):
    response = client.post(f"/api/v1/research-projects/{pid}/matrices", json={"name": "订单对比", "stock_codes": codes,
        "questions": [{"id": "orders", "label": "订单", "prompt": "订单金额及口径是什么？"}], "request_id": request})
    assert response.status_code == 200, response.text
    return response.json()


def start(client, pid, matrix, mode="manual", request="run", day="2026-09-10"):
    response = client.post(f"/api/v1/research-projects/{pid}/matrices/{matrix['id']}/runs", json={"as_of": day, "mode": mode, "request_id": request})
    assert response.status_code == 200, response.text
    return response.json()


def test_company_page_combines_saved_questions_claims_and_current_note_version(workbench):
    client, pid, codes, records, note = workbench
    company_research.create_claim(pid, note["id"], company_research.CreateClaim(note_revision=1, stock_code=codes[0], statement="需核对订单", kind="inference", as_of="2026-09-10", request_id="claim",
        evidence=[company_research.EvidenceReference(kind="news", source_id=records[0]["id"], quote="本期订单金额为10亿元。")]))
    data = client.get(f"/api/v1/research-projects/{pid}/companies/{codes[0]}?as_of=2026-09-10").json()
    assert data["research"]["notes"][0]["validation_plan"] == "订单是否交付"
    assert data["research"]["claims"][0]["needs_revalidation"] is False
    research_projects.update_note(pid, note["id"], research_projects.UpdateNote(title="已修订", stock_code=codes[0], base_revision=1))
    data = client.get(f"/api/v1/research-projects/{pid}/companies/{codes[0]}?as_of=2026-09-10").json()
    assert data["research"]["claims"][0]["needs_revalidation"] is True


def test_manual_matrix_retains_evidence_and_review_history_and_detects_conflicts(workbench):
    client, pid, codes, records, _ = workbench
    matrix = create_matrix(client, pid, codes)
    run = start(client, pid, matrix)
    url = f"/api/v1/research-projects/{pid}/matrices/{matrix['id']}/runs/{run['id']}"
    payload = {"stock_code": codes[0], "question_id": "orders", "base_revision": 0, "answer": "合成订单10亿元", "status": "evidence_found", "request_id": "review",
               "evidence": [{"kind": "news", "source_id": records[0]["id"], "quote": "本期订单金额为10亿元。"}]}
    saved = client.post(url + "/review", json=payload)
    assert saved.status_code == 200, saved.text
    assert saved.json()["summary"]["reviewed"] == 1
    assert saved.json()["cells"][0]["review_revision"] == 1
    assert client.post(url + "/review", json=payload).json()["cells"][0]["review_revision"] == 1
    assert client.post(url + "/review", json={**payload, "answer": "更改"}).status_code == 409
    assert client.post(url + "/review", json={**payload, "request_id": "stale"}).status_code == 409
    bad = {**payload, "stock_code": codes[1], "request_id": "cross-company"}
    assert client.post(url + "/review", json=bad).status_code == 422
    read = client.get(url + f"/evidence?stock_code={codes[0]}&question_id=orders&index=0").json()
    assert read["quote"] in read["text"] and read["snapshot"]
    assert read["semantic_support_verified"] is False
    with db.connect() as connection:
        assert json.loads(connection.execute("SELECT result_json FROM research_matrix_runs WHERE id=?", (run["id"],)).fetchone()[0])["cells"][0]["status"] == "pending"
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("UPDATE research_matrix_cell_reviews SET payload_json='{}'")
    exported = client.get(url + "/export")
    assert exported.status_code == 200 and exported.content.startswith(b"PK")
    from io import BytesIO
    from openpyxl import load_workbook
    book = load_workbook(BytesIO(exported.content))
    assert book["对比结果"]["B2"].value == "合成订单10亿元"


def test_assisted_matrix_freezes_inputs_and_finishes_via_real_job_lease(workbench, monkeypatch):
    client, pid, codes, _, _ = workbench
    def generate(_instructions, payload, **_kwargs):
        data = json.loads(payload)
        source = data["sources"][0]
        return {"answers": [{"question_id": "orders", "answer": source["text"], "status": "evidence_found", "evidence": [{"source_key": source["key"], "quote": source["text"]}]}]}
    monkeypatch.setattr(research_matrices.model_client, "complete_json", generate)
    matrix = create_matrix(client, pid, codes)
    run = start(client, pid, matrix, "assisted")
    assert run["status"] == "queued" and run["job_id"]
    assert worker.execute_job(run["job_id"])
    result = client.get(f"/api/v1/research-projects/{pid}/matrices/{matrix['id']}/runs").json()["items"][0]
    assert result["status"] == "succeeded" and result["summary"]["located"] == 2
    assert all(not cell["semantic_support_verified"] for cell in result["cells"])
    assert all("text" not in cell["evidence"][0] for cell in result["cells"])
    assert start(client, pid, matrix, "assisted")["id"] == run["id"]


def test_invalid_generated_citations_never_become_verified_cells(workbench, monkeypatch):
    client, pid, codes, _, _ = workbench
    monkeypatch.setattr(research_matrices.model_client, "complete_json", lambda *_args, **_kwargs: {"answers": [{"question_id": "orders", "answer": "无据结论", "status": "evidence_found", "evidence": [{"source_key": "not-owned", "quote": "凭空引用"}]}]})
    matrix = create_matrix(client, pid, codes)
    run = start(client, pid, matrix, "assisted")
    worker.execute_job(run["job_id"])
    result = client.get(f"/api/v1/research-projects/{pid}/matrices/{matrix['id']}/runs").json()["items"][0]
    assert result["summary"]["located"] == 0
    assert all(cell["status"] == "needs_review" for cell in result["cells"])


def test_cancelled_generation_cannot_publish_a_late_result(workbench, monkeypatch):
    client, pid, codes, _, _ = workbench
    matrix = create_matrix(client, pid, codes)
    run = start(client, pid, matrix, "assisted")
    def cancel(*_args, **_kwargs):
        jobs.cancel(run["job_id"])
        return {"answers": [{"question_id": "orders", "answer": "late", "status": "not_found", "evidence": []}]}
    monkeypatch.setattr(research_matrices.model_client, "complete_json", cancel)
    worker.execute_job(run["job_id"])
    result = client.get(f"/api/v1/research-projects/{pid}/matrices/{matrix['id']}/runs").json()["items"][0]
    assert result["status"] == "cancelled" and result["finished_at"]
    assert all(not cell["answer"] for cell in result["cells"])


def test_tracking_baselines_new_and_revised_materials_and_persists_human_review(workbench):
    client, pid, codes, records, _ = workbench
    url = f"/api/v1/research-projects/{pid}/companies/{codes[0]}/changes"
    baseline = client.post(url, json={"as_of": "2026-09-10", "request_id": "first"})
    assert baseline.status_code == 200, baseline.text
    assert baseline.json()["baseline"] and not baseline.json()["changes"]
    news_sources.import_items(news_sources.NewsImport(request_id="revision", items=[news_sources.NewsItemInput(title="后续版本", body="合成订单调整为9亿元。", source="隔离验收资料",
        available_at="2026-09-11T10:00:00+08:00", stock_codes=[codes[0]])]), base_id=records[0]["id"])
    check = client.post(url, json={"as_of": "2026-09-11", "request_id": "second"}).json()
    assert not check["baseline"] and len(check["changes"]) == 1
    assert check["changes"][0]["type"] == "updated" and check["unreviewed_count"] == 1
    assert check["review_questions"][0]["validation_plan"] == "订单是否交付"
    key = check["changes"][0]["key"]
    reviewed = client.post(f"/api/v1/research-projects/{pid}/change-checks/{check['id']}/review", json={"change_key": key, "comment": "核对后再更新论点"})
    assert reviewed.status_code == 200, reviewed.text
    assert reviewed.json()["unreviewed_count"] == 0
    assert client.post(url, json={"as_of": "2026-09-11", "request_id": "second"}).json()["id"] == check["id"]
    assert client.post(url, json={"as_of": "2026-09-10", "request_id": "backward"}).status_code == 409
    assert client.post(url, json={"as_of": "2026-09-11", "request_id": "third"}).json()["changes"] == []


def test_project_quality_reports_stale_claims_and_preserves_semantic_review_boundary(workbench):
    client, pid, codes, records, note = workbench
    company_research.create_claim(pid, note["id"], company_research.CreateClaim(note_revision=1, stock_code=codes[0], statement="需核对订单", kind="inference", as_of="2026-09-10", request_id="claim",
        evidence=[company_research.EvidenceReference(kind="news", source_id=records[0]["id"], quote="本期订单金额为10亿元。")]))
    first = client.get(f"/api/v1/research-projects/{pid}/quality").json()
    assert first["metrics"]["references"] == first["metrics"]["valid_references"] == 1
    assert not first["semantic_support_verified"]
    research_projects.update_note(pid, note["id"], research_projects.UpdateNote(title="修订笔记", base_revision=1, stock_code=codes[0]))
    current = client.get(f"/api/v1/research-projects/{pid}/quality").json()
    assert current["metrics"]["stale_claims"] == 1
    assert current["issues"][0]["code"] == "note_revision_changed"


def test_matrix_changes_do_not_report_date_only_changes_or_lose_explicit_reviews(workbench):
    client, pid, codes, _, _ = workbench
    matrix = create_matrix(client, pid, codes)
    original = start(client, pid, matrix)
    next_run = start(client, pid, matrix, request="later", day="2026-09-11")
    assert next_run["previous_run_id"] == original["id"]
    assert next_run["changes"] == []


def test_comparison_selects_relevant_later_report_pages_and_preserves_absolute_offsets(workbench):
    client, pid, codes, _, _ = workbench
    with db.connect() as connection:
        connection.execute("""INSERT INTO documents(id,sha256,filename,title,stock_code,stock_code_status,available_at,available_at_status,pages,extracted_chars,parse_status,source_path,imported_at)
            VALUES('late-page','hash','report.pdf','合成年度报告',?,'confirmed','2026-09-09','confirmed',5,9000,'indexed','unused','2026-09-09')""", (codes[0],))
        connection.executemany("INSERT INTO document_pages VALUES('late-page',?,?)", [(page, "一般背景内容。") for page in range(1, 5)])
        connection.execute("INSERT INTO document_pages VALUES('late-page',5,?)", ("背景。" * 2500 + "客户集中度需要核验。",))
    matrix = client.post(f"/api/v1/research-projects/{pid}/matrices", json={"name": "客户核验", "stock_codes": [codes[0]], "questions": [{"id": "clients", "label": "客户", "prompt": "客户集中度是什么？"}], "request_id": "late-page"}).json()
    run = start(client, pid, matrix)
    with db.connect() as connection:
        inputs = json.loads(connection.execute("SELECT inputs_json FROM research_matrix_runs WHERE id=?", (run["id"],)).fetchone()[0])
    chunk = next(item for item in inputs["corpus"]["companies"][codes[0]]["chunks"] if item["source_id"] == "late-page" and item["page_number"] == 5)
    assert chunk["char_start"] > 0 and "客户集中度需要核验。" in chunk["text"]
    payload = {"stock_code": codes[0], "question_id": "clients", "base_revision": 0, "answer": "需核验", "status": "evidence_found", "request_id": "quote", "evidence": [{"kind": "report", "source_id": "late-page", "page_number": 5, "offset": chunk["char_start"], "quote": "客户集中度需要核验。"}]}
    saved = client.post(f"/api/v1/research-projects/{pid}/matrices/{matrix['id']}/runs/{run['id']}/review", json=payload)
    assert saved.status_code == 200, saved.text
    reference = saved.json()["cells"][0]["evidence"][0]
    assert reference["quote_start"] == 7500 and reference["page_number"] == 5


def test_interrupted_comparison_resumes_completed_companies_using_original_inputs(workbench, monkeypatch):
    client, pid, codes, _, _ = workbench
    matrix = create_matrix(client, pid, codes)
    run = start(client, pid, matrix, "assisted")
    calls = []
    def generate(_instructions, payload, **_kwargs):
        data = json.loads(payload)
        calls.append((data["stock_code"], [source["text"] for source in data["sources"]]))
        if len(calls) == 2:
            raise SystemExit("simulated worker interruption")
        chunk = data["sources"][0]
        return {"answers": [{"question_id": "orders", "answer": "已核对", "status": "evidence_found", "evidence": [{"source_key": chunk["key"], "quote": chunk["text"]}]}]}
    monkeypatch.setattr(research_matrices.model_client, "complete_json", generate)
    with pytest.raises(SystemExit):
        worker.execute_job(run["job_id"])
    news_sources.import_items(news_sources.NewsImport(request_id="arrived-after-snapshot", items=[news_sources.NewsItemInput(title="新入库", body="不可混入原运行的后到资料。", source="隔离验收", stock_codes=[codes[1]], available_at="2026-09-10T12:00:00+08:00")]))
    with db.connect() as connection:
        connection.execute("UPDATE jobs SET lease_expires_at='2000-01-01' WHERE id=?", (run["job_id"],))
    worker.execute_job(run["job_id"])
    result = client.get(f"/api/v1/research-projects/{pid}/matrices/{matrix['id']}/runs").json()["items"][0]
    assert [call[0] for call in calls] == [codes[0], codes[1], codes[1]]
    assert all("后到资料" not in text for text in calls[-1][1])
    assert result["status"] == "succeeded" and result["summary"]["located"] == 2


def test_excel_export_keeps_formulas_and_control_characters_as_safe_text(workbench):
    from io import BytesIO
    from openpyxl import load_workbook
    client, pid, codes, _, _ = workbench
    matrix = create_matrix(client, pid, codes)
    run = start(client, pid, matrix)
    root = f"/api/v1/research-projects/{pid}/matrices/{matrix['id']}/runs/{run['id']}"
    saved = client.post(root + "/review", json={"stock_code": codes[0], "question_id": "orders", "base_revision": 0, "answer": "=1+1\u0000", "status": "needs_review", "request_id": "control"})
    assert saved.status_code == 200, saved.text
    response = client.get(root + "/export")
    assert response.status_code == 200
    cell = load_workbook(BytesIO(response.content))["对比结果"]["B2"]
    assert cell.data_type == "s" and cell.value == "=1+1\\u0000"


@pytest.mark.parametrize("first_chunk_length", [64, 2000])
def test_comparison_keeps_each_company_at_the_same_historical_cutoff(workbench, first_chunk_length):
    client, pid, codes, records, _ = workbench
    news_sources.import_items(news_sources.NewsImport(request_id="first-company-length", items=[news_sources.NewsItemInput(
        title="首家公司资料", body="合成订单" + "甲" * (first_chunk_length - 4), source="隔离验收",
        available_at="2026-09-10T11:00:00+08:00", stock_codes=[codes[0]])]), base_id=records[0]["id"])
    future = news_sources.import_items(news_sources.NewsImport(request_id="future-revision", items=[news_sources.NewsItemInput(
        title="截止日后修订", body="未来才披露的订单金额为99亿元。", source="隔离验收",
        available_at="2026-09-11T10:00:00+08:00", stock_codes=[codes[1]])]), base_id=records[1]["id"])["items"][0]
    matrix = create_matrix(client, pid, codes)
    run = start(client, pid, matrix)
    with db.connect() as connection:
        inputs = json.loads(connection.execute("SELECT inputs_json FROM research_matrix_runs WHERE id=?", (run["id"],)).fetchone()[0])
    second = inputs["corpus"]["companies"][codes[1]]
    assert second["coverage"]["news"] == 1
    assert {item["source_id"] for item in second["chunks"]} == {records[1]["id"]}
    assert all(item["source_id"] != future["id"] and "99亿元" not in item["text"] for item in second["chunks"])


def test_tracking_detects_corrected_report_dates_without_a_pdf_content_change(workbench):
    client, pid, codes, _, _ = workbench
    with db.connect() as connection:
        connection.execute("""INSERT INTO documents(id,sha256,filename,title,stock_code,stock_code_status,available_at,available_at_status,pages,extracted_chars,parse_status,source_path,imported_at)
            VALUES('corrected-date','same-pdf','report.pdf','研报原日期',?,'confirmed','2026-09-09','confirmed',1,0,'indexed','unused','2026-09-10')""", (codes[0],))
    url = f"/api/v1/research-projects/{pid}/companies/{codes[0]}/changes"
    assert client.post(url, json={"as_of": "2026-09-10", "request_id": "baseline"}).status_code == 200
    with db.connect() as connection:
        connection.execute("UPDATE documents SET available_at='2026-09-08',title='首次可得日期已核正' WHERE id='corrected-date'")
    result = client.post(url, json={"as_of": "2026-09-10", "request_id": "corrected"}).json()
    changed = next(item for item in result["changes"] if item["key"] == "report:corrected-date")
    assert changed["type"] == "updated" and changed["previous"]["available_at"] == "2026-09-09"


def test_quality_does_not_accept_empty_generated_conclusions_and_manual_fix_clears_old_warning(workbench, monkeypatch):
    client, pid, codes, records, _ = workbench
    def empty_answer(_instructions, payload, **_kwargs):
        chunk = json.loads(payload)["sources"][0]
        return {"answers": [{"question_id": "orders", "answer": "", "status": "evidence_found", "evidence": [{"source_key": chunk["key"], "quote": chunk["text"]}]}]}
    monkeypatch.setattr(research_matrices.model_client, "complete_json", empty_answer)
    matrix = create_matrix(client, pid, codes)
    run = start(client, pid, matrix, "assisted")
    worker.execute_job(run["job_id"])
    root = f"/api/v1/research-projects/{pid}/matrices/{matrix['id']}/runs"
    generated = client.get(root).json()["items"][0]
    assert all(cell["status"] == "needs_review" for cell in generated["cells"])
    assert client.get(f"/api/v1/research-projects/{pid}/quality").json()["metrics"]["needs_review_cells"] == 2
    fixed = client.post(root + f"/{run['id']}/review", json={"stock_code": codes[0], "question_id": "orders", "base_revision": 0,
        "answer": "本期订单10亿元", "status": "evidence_found", "request_id": "fixed",
        "evidence": [{"kind": "news", "source_id": records[0]["id"], "quote": "本期订单金额为10亿元。"}]}).json()
    assert fixed["cells"][0]["status"] == "evidence_found" and not fixed["cells"][0].get("validation_note")


def test_quality_links_can_load_a_matrix_outside_the_recent_catalog(workbench):
    client, pid, codes, _, _ = workbench
    original = create_matrix(client, pid, codes)
    with db.connect() as connection:
        definition = connection.execute("SELECT definition_json FROM research_matrices WHERE id=?", (original["id"],)).fetchone()[0]
        connection.executemany("INSERT INTO research_matrices VALUES(?,?,?,?,?,?)", [
            (f"recent-{index}", pid, f"新矩阵{index}", definition, f"recent-{index}", "2026-10-15") for index in range(100)])
    root = f"/api/v1/research-projects/{pid}/matrices"
    assert len(client.get(root).json()["items"]) == 100
    response = client.get(root, params={"include_matrix": original["id"]})
    assert response.status_code == 200, response.text
    assert original["id"] in {item["id"] for item in response.json()["items"]}
    assert client.get(root, params={"include_matrix": "not-in-this-project"}).status_code == 404


def test_change_history_reads_the_recorded_news_version_after_same_day_revision(workbench):
    client, pid, codes, records, _ = workbench
    root = f"/api/v1/research-projects/{pid}/companies/{codes[0]}/changes"
    client.post(root, json={"as_of": "2026-09-09", "request_id": "before"})
    original = client.post(root, json={"as_of": "2026-09-10", "request_id": "original"}).json()
    key = next(item["key"] for item in original["changes"] if item.get("source_id") == records[0]["id"])
    news_sources.import_items(news_sources.NewsImport(request_id="same-day-revision", items=[news_sources.NewsItemInput(
        title="当日已修订", body="同日稍后把订单修订为9亿元。", source="隔离验收", stock_codes=[codes[0]],
        available_at="2026-09-10T14:00:00+08:00")]), base_id=records[0]["id"])
    url = f"/api/v1/research-projects/{pid}/change-checks/{original['id']}/sources/{key}"
    read = client.get(url)
    assert read.status_code == 200, read.text
    assert read.json()["source_id"] == records[0]["id"] and read.json()["source_version"] == 1
    assert "本期订单金额为10亿元" in read.json()["text"]
    assert client.get(url, params={"offset": 3}).json()["char_start"] == 3
    assert client.get(url, params={"page": 2}).status_code == 422
    assert client.get(url.rsplit('/', 1)[0] + '/news:foreign').status_code == 404


def test_concurrent_change_checks_do_not_publish_an_older_capture_after_a_newer_one(workbench, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from itertools import count
    from threading import Event
    from apps.api.app import research_tracking
    _, pid, codes, _, _ = workbench
    first_captured, release_first, second_finished = Event(), Event(), Event()
    captures = count(1)

    def capture(*_args):
        version = next(captures)
        if version == 1:
            first_captured.set()
            assert release_first.wait(10)
        return {"sample": {"category": "research", "title": f"采集版本{version}", "fingerprint": str(version)}}, {"reports": 0, "news": 0}, []

    monkeypatch.setattr(research_tracking, "_record_inventory", capture)
    def check(request_id):
        result = research_tracking.check(pid, codes[0], research_tracking.CheckChanges(as_of="2026-09-10", request_id=request_id))
        if request_id == "second":
            second_finished.set()
        return result

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(check, "first")
        assert first_captured.wait(5)
        second = pool.submit(check, "second")
        try:
            second_finished.wait(2)
        finally:
            release_first.set()
        first.result(timeout=10)
        second.result(timeout=10)
    latest = research_tracking.list_checks(pid, codes[0])["items"][0]
    assert latest["changes"][0]["title"] == "采集版本2"


def test_comparison_retrieves_evidence_for_every_question_in_a_long_report(workbench):
    from apps.api.app import research_materials
    _, pid, codes, _, _ = workbench
    pages = [(1, "营业收入100亿元，同比增长10%。"), (2, "经营活动产生的现金流量净额80亿元。"),
        (3, "酒类业务毛利率90%。"), (4, "2025年经营计划与发展目标：稳健发展。可能面对的风险：需求恢复不及预期。")]
    with db.connect() as connection:
        connection.execute("""INSERT INTO documents(id,sha256,filename,title,stock_code,stock_code_status,available_at,available_at_status,pages,extracted_chars,parse_status,source_path,imported_at)
            VALUES('multi-topic','multi-topic-hash','annual.pdf','完整年度报告',?,'confirmed','2026-09-09','confirmed',4,200,'indexed','unused','2026-09-10')""", (codes[0],))
        connection.executemany("INSERT INTO document_pages VALUES('multi-topic',?,?)", pages)
    corpus = research_materials.snapshot(pid, [codes[0]], "2026-09-10", questions=[
        "营业收入和同比增速是多少？", "经营活动产生的现金流量净额是多少？", "酒类业务毛利率是多少？", "2025年经营目标和经营风险是什么？"])
    chunks = corpus["companies"][codes[0]]["chunks"]
    assert {item["page_number"] for item in chunks if item["source_id"] == 'multi-topic'} == {1, 2, 3, 4}
    assert len(chunks) <= research_materials.MAX_CHUNKS
    assert all(len(item["text"]) <= research_materials.MAX_TEXT for item in chunks)
