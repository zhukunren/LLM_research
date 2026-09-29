import base64
from io import BytesIO
from pypdf import PdfWriter

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from apps.api.app import db, documents, main, market, patterns, report_evidence, worker
from apps.api.app.main import app


def test_filter_versions_and_formal_dependency_block(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    monkeypatch.setattr(market, "cached_profile", lambda: {
        "available": True,
        "last_date": "2026-09-14",
        "formal_blockers": ["复权口径未确认", "成交量单位未确认"],
    })
    with TestClient(app) as client:
        response = client.post("/api/v1/filters", json={
            "library": "technical", "name": "收盘价高于 SMA 3", "description": "",
            "expression": {"op": "indicator_compare", "indicator": "sma", "field": "close", "window": 3, "operator": "lt", "compare_field": "close"},
        })
        assert response.status_code == 200
        first = response.json()
        updated = client.post("/api/v1/filters", json={
            "id": first["id"], "library": "technical", "name": "收盘价高于 SMA 4", "description": "新版本",
            "expression": {"op": "indicator_compare", "indicator": "sma", "field": "close", "window": 4, "operator": "lt", "compare_field": "close"},
        }).json()
        assert updated["version"] == 2
        assert client.get(f"/api/v1/filters/{first['id']}?version=1").json()["expression"]["window"] == 3

        strategy = client.post("/api/v1/strategies", json={
            "name": "固定版本策略", "top_n": 10,
            "tree": {"op": "all", "children": [{"op": "filter_ref", "filter_id": first["id"], "version": 1, "score_weight": 2}]},
        })
        assert strategy.status_code == 200
        assert strategy.json()["tree"]["children"][0]["version"] == 1

        blocked = client.post("/api/v1/screening-runs", json={
            "strategy_id": strategy.json()["id"], "strategy_version": 1, "as_of": "2026-09-14", "mode": "formal",
        })
        assert blocked.status_code == 200
        assert blocked.json()["status"] == "blocked_dependency"
        assert blocked.json()["blockers"]


def test_unsupported_filter_node_is_rejected(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    with TestClient(app) as client:
        response = client.post("/api/v1/filters", json={
            "library": "technical", "name": "invalid", "expression": {"op": "sql", "query": "select 1"},
        })
        assert response.status_code == 422
        assert response.json()["code"] == "invalid_filter"


def test_screenshot_source_is_stored_and_retrievable(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    monkeypatch.setattr(patterns, "PATTERN_UPLOAD_DIR", tmp_path / "pattern-images")
    monkeypatch.setattr(main, "PATTERN_UPLOAD_DIR", tmp_path / "pattern-images")
    image = Image.new("RGB", (300, 180), "white")
    ImageDraw.Draw(image).line([(10, 140), (290, 50)], fill=(215, 30, 25), width=4)
    stream = BytesIO()
    image.save(stream, format="PNG")
    source = stream.getvalue()
    with TestClient(app) as client:
        response = client.post("/api/v1/patterns", json={
            "name": "截图路径", "input_type": "screenshot", "representation": "price_path",
            "target_bars": 10, "points": [index / 9 for index in range(10)],
            "source_image_base64": base64.b64encode(source).decode("ascii"),
            "source_image_mime": "image/png", "source_image_filename": "chart.png",
        })
        assert response.status_code == 200
        saved = response.json()
        assert "source_image_base64" not in saved
        assert saved["source_image"]["sha256"]
        restored = client.get(f"/api/v1/patterns/{saved['id']}/source-image?version=1")
        assert restored.status_code == 200
        assert restored.content == source


def test_pdf_upload_is_indexed_inside_configured_upload_root(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    upload_root = tmp_path / "report-uploads"
    monkeypatch.setattr(main, "REPORT_UPLOAD_DIR", upload_root)
    monkeypatch.setattr(documents, "REPORT_UPLOAD_DIR", upload_root)
    monkeypatch.setattr(documents, "REPORT_DIR", tmp_path / "no-local-reports")
    pdf = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.write(pdf)
    pdf.seek(0)
    with TestClient(app) as client:
        response = client.post("/api/v1/documents/upload", files={"file": ("sample.pdf", pdf.getvalue(), "application/pdf")})
        assert response.status_code == 200
        assert response.json()["result"]["status"] == "no_text"
        assert response.json()["result"]["filename"] == "sample.pdf"
        assert len(list(upload_root.glob("*.pdf"))) == 1


def test_report_rubric_evaluation_flows_into_strategy_with_citations(tmp_path, monkeypatch) -> None:
    from uuid import uuid4

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    monkeypatch.setattr(market, "cached_profile", lambda: {"available": True, "last_date": "2026-09-25", "bytes": 100, "sha256": "snapshot"})
    monkeypatch.setattr(worker, "cached_profile", lambda: {"available": True, "last_date": "2026-09-25", "bytes": 100, "sha256": "snapshot"})
    monkeypatch.setattr(worker, "llm_settings", lambda: {"configured": True, "model": "test-contract-model"})
    monkeypatch.setattr(report_evidence, "_completion", lambda _criteria, _pages: {
        "subject_name": "示例科技",
        "criteria_results": [{
            "criterion_id": "fundamental_improvement", "state": "true", "summary": "订单和毛利率均有改善证据",
            "evidence": [{"page": 1, "quote": "公司本期毛利率同比提升 4.2 个百分点，订单保持增长。", "evidence_type": "reported_fact", "period": "本期", "claim": "毛利率和订单改善"}],
        }],
    })
    monkeypatch.setattr(worker, "iter_recent_bars", lambda _as_of, _limit: iter([("600000.SH", [{
        "trade_date": "2026-09-25", "open": 10.0, "high": 10.2, "low": 9.8, "close": 10.1,
        "volume": 100.0, "amount": 1010.0, "quality_valid": True,
    }])]))

    evaluation_id, eval_job_id, filter_id, doc_id = [str(uuid4()) for _ in range(4)]
    strategy_id, screen_run_id, screen_job_id = [str(uuid4()) for _ in range(3)]
    now = db.utc_now()
    rubric = {
        "op": "evidence_query", "evaluation_mode": "rubric", "combine": "all", "lookback_calendar_days": 365,
        "criteria": [{"id": "fundamental_improvement", "label": "基本面改善", "question": "是否改善？", "signals": ["订单", "毛利率"], "counter_signals": ["订单下降"]}],
    }
    filter_dsl = {"schema_version": "1.0", "kind": "report", "name": "基本面改善", "description": "", "expression": rubric}
    strategy = {"schema_version": "1.0", "name": "研报证据策略", "tree": {"op": "all", "children": [{"op": "filter_ref", "filter_id": filter_id, "version": 1, "score_weight": 2}]}, "top_n": 10}

    db.init_db()
    with db.connect() as connection:
        connection.execute(
            "INSERT INTO filters(id,library,name,description,version,dsl_json,created_at) VALUES(?,?,?,?,?,?,?)",
            (filter_id, "report", "基本面改善", "", 1, db.json_dump(filter_dsl), now),
        )
        connection.execute(
            """INSERT INTO documents(id,sha256,filename,title,publication_date,market,stock_code,pages,extracted_chars,parse_status,source_path,imported_at,stock_code_status,stock_code_confirmed_at,available_at,available_at_status,available_at_confirmed_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (doc_id, "doc-hash", "report.pdf", "示例科技研报", "2026-09-20", "SH", "600000.SH", 1, 34, "indexed", "test", now, "confirmed", now, "2026-09-20", "confirmed", now),
        )
        connection.execute(
            "INSERT INTO document_pages(document_id,page_number,text) VALUES(?,?,?)",
            (doc_id, 1, "公司本期毛利率同比提升 4.2 个百分点，订单保持增长。"),
        )
        connection.execute(
            """INSERT INTO report_evaluation_runs(id,filter_id,filter_version,as_of,lookback_start,model,prompt_version,status,coverage_json,result_json,job_id,created_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (evaluation_id, filter_id, 1, "2026-09-25", "2025-09-25", "test-contract-model", report_evidence.PROMPT_VERSION, "queued", "{}", "{}", eval_job_id, now),
        )
        connection.execute(
            "INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (eval_job_id, "report_evaluation", db.json_dump({"evaluation_run_id": evaluation_id, "filter_id": filter_id, "filter_version": 1}), "queued", "test", now, now),
        )

    worker.execute_report_evaluation(eval_job_id)
    with db.connect() as connection:
        evaluation = connection.execute("SELECT status,result_json FROM report_evaluation_runs WHERE id=?", (evaluation_id,)).fetchone()
        assert evaluation[0] == "succeeded"
        assert db.json_load(evaluation[1])["by_security"]["600000.SH"]["state"] == "true"
        connection.execute(
            "INSERT INTO strategies(id,name,version,strategy_json,created_at) VALUES(?,?,?,?,?)",
            (strategy_id, strategy["name"], 1, db.json_dump(strategy), now),
        )
        connection.execute(
            "INSERT INTO screening_runs(id,strategy_id,strategy_version,as_of,mode,status,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
            (screen_run_id, strategy_id, 1, "2026-09-25", "exploratory", "queued", "{}", now),
        )
        connection.execute(
            "INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (screen_job_id, "screening", db.json_dump({"run_id": screen_run_id, "strategy_id": strategy_id, "strategy_version": 1}), "queued", "test", now, now),
        )

    worker.execute_screening(screen_job_id)
    with db.connect() as connection:
        screen = connection.execute("SELECT status,result_json FROM screening_runs WHERE id=?", (screen_run_id,)).fetchone()
    screen_result = db.json_load(screen[1])
    assert screen[0] == "succeeded"
    result = screen_result["results"][0]
    assert result["stock_code"] == "600000.SH"
    assert result["details"][0]["state"] == "true"
    assert result["details"][0]["assessments"][0]["criteria"][0]["evidence"][0]["page"] == 1


def test_report_rubric_draft_and_model_dependency_are_explicit(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    monkeypatch.setattr(main, "llm_settings", lambda: {"configured": False, "model": ""})
    with TestClient(app) as client:
        draft = client.post("/api/v1/filters/draft", json={
            "library": "report", "prompt": "基本面改善，行业景气度提升，关注订单和毛利率",
        })
        assert draft.status_code == 200
        expression = draft.json()["expression"]
        assert expression["evaluation_mode"] == "rubric"
        assert len(expression["criteria"]) == 2
        assert "毛利率" in expression["criteria"][0]["question"]

        with db.connect() as connection:
            connection.execute(
                """INSERT INTO documents(id,sha256,filename,title,publication_date,market,stock_code,pages,extracted_chars,parse_status,source_path,imported_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                ("binding-doc", "sha256-binding-doc", "report.pdf", "示例报告", "2026-09-21", "SH", "600000.SH", 1, 20, "indexed", "test", db.utc_now()),
            )
        binding = client.post("/api/v1/documents/binding-doc/security-binding", json={"stock_code": "600000.SH"})
        assert binding.status_code == 200
        assert binding.json()["binding_status"] == "confirmed"
        availability = client.post("/api/v1/documents/binding-doc/confirm-availability", json={"available_at": "2026-09-22"})
        assert availability.status_code == 200
        assert availability.json()["availability_status"] == "confirmed"
        listed_document = client.get("/api/v1/documents").json()["items"][0]
        assert listed_document["stock_code_status"] == "confirmed"
        assert listed_document["available_at_status"] == "confirmed"

        saved = client.post("/api/v1/filters", json={
            "library": "report", "name": draft.json()["name"], "description": draft.json()["description"], "expression": expression,
        })
        assert saved.status_code == 200
        evaluation = client.post(
            f"/api/v1/filters/{saved.json()['id']}/evaluate-reports?version=1",
            json={"as_of": "2026-09-25"},
        )
        assert evaluation.status_code == 200
        assert evaluation.json()["status"] == "blocked_dependency"
        stored = client.get(f"/api/v1/report-evaluations/{evaluation.json()['id']}")
        assert stored.json()["coverage"]["state"] == "blocked_dependency"
        assert "未配置文本模型" in stored.json()["coverage"]["message"]


def test_strict_report_search_requires_confirmed_available_date(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    now = db.utc_now()
    with TestClient(app) as client:
        with db.connect() as connection:
            for doc_id, status, available_at in [
                ("candidate-date", "filename_candidate", "2026-09-10"),
                ("future-date", "confirmed", "2026-09-20"),
                ("confirmed-date", "confirmed", "2026-09-10"),
            ]:
                connection.execute(
                    """INSERT INTO documents(id,sha256,filename,title,publication_date,market,stock_code,pages,extracted_chars,parse_status,source_path,imported_at,available_at,available_at_status)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (doc_id, f"hash-{doc_id}", f"{doc_id}.pdf", doc_id, available_at, "SH", "600000.SH", 1, 20, "indexed", "test", now, available_at, status),
                )
                connection.execute("INSERT INTO document_pages(document_id,page_number,text) VALUES(?,?,?)", (doc_id, 1, "订单同比增长"))
        result = client.post("/api/v1/documents/search", json={"query": "订单", "as_of": "2026-09-14"})
        assert result.status_code == 200
        assert [item["document_id"] for item in result.json()["items"]] == ["confirmed-date"]
