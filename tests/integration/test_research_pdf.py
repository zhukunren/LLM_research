from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfReader
import pytest

from apps.api.app import conversation_store as store, db, main, research_pdf as pdf, research_projects as projects, research_workspace as workspace
from apps.api.app.screening_contracts import ResearchScope


@pytest.fixture
def research(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "pdf.db")
    db.init_db()
    cid = store.create_conversation("screening", workflow_type="research")["id"]
    store.update_research_scope(cid, 0, ResearchScope(as_of="2026-09-14", stock_codes=["600519.SH"]))
    msg = store.add_user_message(cid, "request", 0, "研究订单兑现", research_scope_revision=1)
    store.start_turn(cid, msg["turn_id"])
    root = workspace.directory(cid) / "outputs"
    root.mkdir(parents=True)
    return cid, msg["turn_id"], root


def read(item, cid):
    path, _ = pdf.pdf_path(cid, item["url"].rsplit("/", 1)[-1])
    return PdfReader(path)


def assert_branded(reader):
    assert len(reader.pages) >= 2
    for page in reader.pages:
        text = page.extract_text()
        assert "张家港营业部" in text
        assert "共 " in text and " 页" in text
        assert page.images


def test_completed_answer_is_a_cached_branded_pdf_with_frozen_scope(research):
    cid, tid, root = research
    Image.new("RGB", (300, 180), "white").save(root / "chart.png")
    body = "# 订单研究\n\n事实、预测与推断需要区分。\n\n![原始实验图](outputs/chart.png)\n\n| 项目 | 数值 |\n| --- | --- |\n| 样例数据 | 20% |\n\n[原文](https://example.com/source)"
    store.finish_turn(cid, tid, 0, "succeeded", body, {})
    first = pdf.export_turn(cid, tid)
    assert_branded(read(first, cid))
    text = "\n".join(page.extract_text() for page in read(first, cid).pages)
    assert "2026-09-14" in text and "600519.SH" in text
    assert "20%" in text and "https://example.com/source" in text and "原始实验图" in text
    store.update_research_scope(cid, 1, ResearchScope(as_of="2026-10-05", stock_codes=["600000.SH"]))
    Image.new("RGB", (300, 180), "red").save(root / "chart.png")
    assert pdf.export_turn(cid, tid) == first
    with TestClient(main.app) as client:
        response = client.get(first["url"])
        assert response.status_code == 200 and response.content.startswith(b"%PDF-")
        assert response.headers["content-type"] == "application/pdf"
        assert all(item["media_type"] == "application/pdf" for item in client.get(f"/api/v1/conversations/{cid}/research-files").json()["items"])


@pytest.mark.parametrize("name,content", [("note.md", "# 中文笔记\n\n保留原文判断。"), ("table.csv", "公司,金额\n示例,123\n"), ("data.json", '{"实际数值":123}'), ("page.html", "<script>never_execute()</script><p>原文内容</p>")])
def test_legacy_inputs_deliver_pdf_and_preserve_original(research, name, content):
    cid, tid, root = research
    path = root / name
    path.write_text(content, encoding="utf-8")
    item = pdf.export_file(cid, name)
    assert item["name"] == name + ".pdf" and item["template_version"] == pdf.TEMPLATE_VERSION
    assert_branded(read(item, cid))
    assert path.read_text(encoding="utf-8") == content
    with TestClient(main.app) as client:
        response = client.get(f"/api/v1/conversations/{cid}/research-files/{name}")
        assert response.status_code == 200 and response.headers["content-type"] == "application/pdf"
        assert response.headers["content-disposition"].startswith("attachment")


def test_existing_pdf_preserves_original_pages_inside_branded_wrapper(research):
    cid, tid, root = research
    path = root / "original.pdf"
    pdf.render_document(path, title="原始报告", content="# 原始依据\n\n全文应保留。", metadata={})
    original = path.read_bytes()
    item = pdf.export_file(cid, path.name)
    converted = read(item, cid)
    assert_branded(converted)
    assert len(converted.pages) == len(PdfReader(BytesIO(original)).pages) + 1
    assert "全文应保留" in "\n".join(page.extract_text() for page in converted.pages)
    assert path.read_bytes() == original


def test_tables_repeat_headers_and_keep_the_last_row_across_pages(research):
    cid, tid, root = research
    path = root / "long.csv"
    path.write_text("股票,实验判据,指标说明\n" + "\n".join(f"公司{i},未知,这是完整保留的中文指标与验证事项{i}" for i in range(150)), encoding="utf-8")
    reader = read(pdf.export_file(cid, path.name), cid)
    assert len(reader.pages) > 3
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert "公司149" in text and text.count("股票") >= 3
    assert_branded(reader)


def test_pdf_and_chart_routes_enforce_conversation_and_path_boundaries(research, tmp_path):
    cid, tid, root = research
    (root / "note.md").write_text("原文", encoding="utf-8")
    (root / "bad.svg").write_text('<svg onload="alert(1)"></svg>', encoding="utf-8")
    Image.new("RGB", (10, 10), "white").save(root / "chart.png")
    item = pdf.export_file(cid, "note.md")
    other = store.create_conversation("screening", workflow_type="research")["id"]
    with TestClient(main.app) as client:
        assert client.get(item["url"].replace(cid, other)).status_code == 404
        assert client.get(f"/api/v1/conversations/{cid}/research-assets/bad.svg").status_code == 404
        assert client.get(f"/api/v1/conversations/{cid}/research-assets/chart.png").headers["content-type"] == "image/png"
    with pytest.raises(workspace.WorkspaceError):
        pdf.export_file(cid, "../../pdf.db")
    linked = root / "linked.md"
    external = tmp_path / "outside.md"
    external.write_text("不可读取", encoding="utf-8")
    import os
    os.link(external, linked)
    with pytest.raises(workspace.WorkspaceError):
        pdf.export_file(cid, "linked.md")


def test_notes_export_requested_revision_and_project_only_pdfs(research):
    cid, tid, root = research
    project = projects.create_project(projects.CreateProject(name="证据项目", objective="核对订单", request_id="project"))
    note = projects.create_note(project["id"], projects.CreateNote(title="订单判断", body="原始判断", validation_plan="核对回款", invalidation_condition="经营现金流恶化", request_id="note"))
    latest = projects.update_note(project["id"], note["id"], projects.UpdateNote(base_revision=1, title="订单判断", body="最新反方证据", validation_plan="核对回款", invalidation_condition="经营现金流恶化", status="challenged"))
    with TestClient(main.app) as client:
        url = f"/api/v1/research-projects/{project['id']}/notes/{note['id']}/pdf"
        old = client.get(url + "?revision=1")
        new = client.get(url + "?revision=2")
        assert old.status_code == new.status_code == 200
        old_text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(old.content)).pages)
        new_text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(new.content)).pages)
        assert "原始判断" in old_text and "最新反方证据" not in old_text
        assert "最新反方证据" in new_text and "核对回款" in new_text and "经营现金流恶化" in new_text
        items = client.get(f"/api/v1/research-projects/{project['id']}/files").json()["items"]
        assert len(items) == 1 and items[0]["name"].endswith("-v2.pdf")
        other = projects.create_project(projects.CreateProject(name="其他项目", request_id="other"))
        assert client.get(items[0]["url"].replace(project["id"], other["id"])).status_code == 404
        assert client.get(url + "?revision=9").status_code == 404
    assert projects.get_project(project["id"])["notes"][0]["revision"] == latest["revision"] == 2


def test_atomic_generation_failure_is_visible_and_never_publishes_partial_pdf(research, monkeypatch):
    cid, tid, root = research
    (root / "note.md").write_text("研究正文", encoding="utf-8")
    def broken(path, **kwargs):
        path.write_bytes(b"partial")
        raise ValueError("排版失败")
    monkeypatch.setattr(pdf, "render_document", broken)
    with TestClient(main.app) as client:
        response = client.get(f"/api/v1/conversations/{cid}/research-files/note.md")
        assert response.status_code == 503 and "排版失败" in response.text
    assert not list(pdf._root(cid).glob("*.pdf"))
    assert not list(pdf._root(cid).glob("*.partial"))


def test_fixed_template_is_available_without_mutating_business_data(research):
    cid, tid, root = research
    with TestClient(main.app) as client:
        response = client.get("/api/v1/conversations/research-pdf-template")
        assert response.status_code == 200
        assert response.headers["content-disposition"].startswith("inline")
        assert_branded(PdfReader(BytesIO(response.content)))
    assert store.get_turn(cid, tid)["state"] == "running"


def test_codex_completion_queues_fixed_pdf_after_publishing_answer(research, monkeypatch):
    from apps.api.app import codex_runtime, worker
    cid, tid, root = research
    monkeypatch.setattr(codex_runtime, "run_conversation_turn", lambda *_: {"thread_id": "test-thread", "codex_turn_id": "test-turn", "event_count": 1, "model": "test-model", "response": "# 订单验证\n\n下一步核对现金流，区分事实与预测。", "files": []})
    turn = codex_runtime.process_conversation_turn(cid, tid)
    assert turn["state"] == "succeeded" and turn["result"]["pdf_error"] is None
    assert turn["result"]["files"] == [] and turn["result"]["pdf_status"] == "queued"
    item = next(item for item in pdf.list_deliverables(cid) if item.get("source_kind") == "turn")
    assert item["status"] == "queued" and item["url"] is None
    assert worker.execute_job(item["job_id"])
    item = next(item for item in pdf.list_deliverables(cid) if item.get("source_kind") == "turn")
    assert item["media_type"] == "application/pdf" and item["template_version"] == pdf.TEMPLATE_VERSION
    assert_branded(read(item, cid))
    assert store.get_conversation(cid)["task_revision"] == 0


def test_pdf_failure_preserves_answer_and_requires_a_separate_retry(research, monkeypatch):
    from apps.api.app import codex_runtime, worker, research_pdf_service
    cid, tid, root = research
    answer = "# 研究判断\n\n原答复必须保留。"
    monkeypatch.setattr(codex_runtime, "run_conversation_turn", lambda *_: {"thread_id": "test-thread", "codex_turn_id": "test-turn", "event_count": 1, "model": "test-model", "response": answer, "files": []})
    renderer = pdf.render_document
    def fail(*_, **kwargs):
        raise ValueError("暂时无法生成")
    monkeypatch.setattr(pdf, "render_document", fail)
    turn = codex_runtime.process_conversation_turn(cid, tid)
    assert turn["state"] == "succeeded" and turn["response_text"] == answer
    assert turn["result"]["files"] == [] and turn["result"]["pdf_error"] is None
    item = next(item for item in pdf.list_deliverables(cid) if item.get("source_kind") == "turn")
    assert worker.execute_job(item["job_id"])
    failed = next(item for item in pdf.list_deliverables(cid) if item.get("source_kind") == "turn")
    assert failed["status"] == "failed" and "暂时无法生成" in failed["message"]
    monkeypatch.setattr(pdf, "render_document", renderer)
    assert next(item for item in pdf.list_deliverables(cid) if item.get("source_kind") == "turn")["status"] == "failed"
    retry = research_pdf_service.retry_export("conversation", cid, item["id"])
    worker.execute_job(retry["job_id"])
    assert_branded(read(next(item for item in pdf.list_deliverables(cid) if item.get("source_kind") == "turn"), cid))
    assert store.get_turn(cid, tid)["response_text"] == answer


def test_note_save_queues_pdf_without_waiting_and_keeps_earlier_versions(research):
    from apps.api.app import worker
    with TestClient(main.app) as client:
        project = client.post('/api/v1/research-projects', json={'name': '自动 PDF', 'request_id': 'auto-project'}).json()
        note = client.post(f"/api/v1/research-projects/{project['id']}/notes", json={'title': '验证判断', 'body': '保留研究内容', 'request_id': 'auto-note'}).json()
        assert note['pdf']['media_type'] == 'application/pdf'
        assert note['pdf']['status'] == 'queued' and note['pdf']['url'] is None
        worker.execute_job(note['pdf']['job_id'])
        note['pdf'] = client.get(f"/api/v1/research-projects/{project['id']}").json()['notes'][0]['pdf']
        assert client.get(note['pdf']['url']).status_code == 200
        changed = client.patch(f"/api/v1/research-projects/{project['id']}/notes/{note['id']}", json={'base_revision': 1, 'title': '验证判断', 'body': '第二版研究内容'}).json()
        assert changed['pdf']['name'].endswith('-v2.pdf')
        worker.execute_job(changed['pdf']['job_id'])
        changed['pdf'] = client.get(f"/api/v1/research-projects/{project['id']}").json()['notes'][0]['pdf']
        assert note['pdf']['url'] != changed['pdf']['url']
        assert client.get(note['pdf']['url']).status_code == 200
