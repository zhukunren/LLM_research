from io import BytesIO
import json
import sqlite3

from fastapi.testclient import TestClient
from pypdf import PdfReader
import pytest

from apps.api.app import codex_runtime, conversation_store as store, db, jobs, main
from apps.api.app import research_pdf as pdf, research_pdf_service as service, research_projects as projects, research_workspace as workspace, worker


@pytest.fixture
def case(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "jobs.db")
    db.init_db()
    cid = store.create_conversation("report", workflow_type="research")["id"]
    message = store.add_user_message(cid, "first", 0, "核对经营依据")
    store.start_turn(cid, message["turn_id"])
    return cid, message["turn_id"]


def drain():
    for _ in range(30):
        if not worker.execute_job(kinds=("research_pdf",)):
            return
    raise AssertionError("PDF discovery did not converge")


def test_completed_text_and_note_save_never_wait_for_layout(case, monkeypatch):
    cid, tid = case
    def forbidden(*args, **kwargs):
        raise AssertionError("Save/read paths must never render")
    monkeypatch.setattr(pdf, "render_document", forbidden)
    monkeypatch.setattr(codex_runtime, "run_conversation_turn", lambda *_: {"thread_id": "thread", "codex_turn_id": "turn", "event_count": 0, "model": "test", "response": "正文已完成", "files": []})
    assert codex_runtime.process_conversation_turn(cid, tid)["state"] == "succeeded"
    with TestClient(main.app) as client:
        project = client.post("/api/v1/research-projects", json={"name": "经营判断", "request_id": "project"}).json()
        payload = {"title": "现金流", "body": "仍需核验", "request_id": "note"}
        note = client.post(f"/api/v1/research-projects/{project['id']}/notes", json=payload).json()
        repeat = client.post(f"/api/v1/research-projects/{project['id']}/notes", json=payload).json()
        assert note["pdf"]["status"] == "queued" and note["pdf"]["url"] is None
        assert repeat["pdf"]["id"] == note["pdf"]["id"]
        assert client.get(f"/api/v1/research-projects/{project['id']}/files").status_code == 200
        assert client.get(f"/api/v1/conversations/{cid}/research-files").status_code == 200
    assert not pdf._root(cid, create=False).exists()
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM research_pdf_exports WHERE source_kind='note'").fetchone()[0] == 1
        assert conn.execute("SELECT count(*) FROM research_note_versions").fetchone()[0] == 1


def test_read_lists_do_not_discover_legacy_inputs_or_submit_jobs(case, monkeypatch):
    cid, tid = case
    store.finish_turn(cid, tid, 0, "succeeded", "此前已保存的研究正文", {})
    root = workspace.directory(cid) / "outputs"
    root.mkdir(parents=True)
    (root / "legacy.md").write_text("历史文件", encoding="utf-8")
    monkeypatch.setattr(workspace, "list_outputs", lambda *_: (_ for _ in ()).throw(AssertionError("No workspace scan on GET")))
    with TestClient(main.app) as client:
        assert client.get(f"/api/v1/conversations/{cid}/research-files").json()["items"] == []
        queued = client.post(f"/api/v1/conversations/{cid}/research-pdf-jobs", json={"request_id": "generate"}).json()
        repeat = client.post(f"/api/v1/conversations/{cid}/research-pdf-jobs", json={"request_id": "generate"}).json()
        assert queued["status"] == "queued" and repeat["id"] == queued["id"]
    assert not pdf._root(cid, create=False).exists()
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1


def test_worker_discovery_preserves_original_and_frozen_file_after_later_edit(case):
    cid, tid = case
    store.finish_turn(cid, tid, 0, "succeeded", "研究正文", {})
    root = workspace.directory(cid) / "outputs"
    root.mkdir(parents=True)
    source = root / "original.md"
    source.write_text("第一份原件全文", encoding="utf-8")
    queued = service.enqueue_discovery("conversation", cid, "first-discovery")
    worker.execute_job(queued["job_id"])
    pending = next(item for item in service.list_exports("conversation", cid) if item.get("source_kind") == "file")
    source.write_text("新回合的文件内容", encoding="utf-8")
    worker.execute_job(pending["job_id"])
    first = next(item for item in service.list_exports("conversation", cid) if item.get("source_kind") == "file")
    with TestClient(main.app) as client:
        content = client.get(first["url"]).content
        text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(content)).pages)
        assert "第一份原件全文" in text and "新回合的文件内容" not in text
        assert source.read_text(encoding="utf-8") == "新回合的文件内容"
        service.enqueue_discovery("conversation", cid, "second-discovery")
        drain()
        latest = next(item for item in service.list_exports("conversation", cid) if item.get("source_kind") == "file")
        assert latest["url"] != first["url"]
        assert client.get(first["url"]).content == content


def test_failed_pdf_has_independent_idempotent_retry_and_get_never_retries(case, monkeypatch):
    cid, tid = case
    store.finish_turn(cid, tid, 0, "succeeded", "已经接受的正文", {})
    item = service.enqueue_turn(cid, tid)
    original = pdf.render_document
    monkeypatch.setattr(pdf, "render_document", lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("排版暂时失败")))
    worker.execute_job(item["job_id"])
    with TestClient(main.app) as client:
        failed = next(row for row in client.get(f"/api/v1/conversations/{cid}/research-files").json()["items"] if row.get("source_kind") == "turn")
        assert failed["status"] == "failed" and "排版暂时失败" in failed["message"]
        with db.connect() as conn:
            before = conn.execute("SELECT count(*) FROM jobs").fetchone()[0]
        assert client.get(f"/api/v1/conversations/{cid}/research-files").status_code == 200
        with db.connect() as conn:
            assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == before
        monkeypatch.setattr(pdf, "render_document", original)
        retry = client.post(failed["retry_url"]).json()
        assert retry["status"] == "queued" and retry["job_id"] != failed["job_id"]
        assert client.post(failed["retry_url"]).json()["job_id"] == retry["job_id"]
        assert jobs.retry(failed["job_id"])["job_id"] == retry["job_id"]
        worker.execute_job(retry["job_id"])
        assert store.get_turn(cid, tid)["state"] == "succeeded"
        assert store.get_turn(cid, tid)["response_text"] == "已经接受的正文"
        ready = next(row for row in client.get(f"/api/v1/conversations/{cid}/research-files").json()["items"] if row.get("source_kind") == "turn")
        assert ready["status"] == "succeeded" and client.get(ready["url"]).status_code == 200
        assert not list(pdf._root(cid).glob("*.partial"))


def test_note_revision_queue_snapshots_are_immutable_even_when_new_revision_saved(case):
    project = projects.create_project(projects.CreateProject(name="证据", request_id="project"))
    first = projects.create_note(project["id"], projects.CreateNote(title="初始", body="第一版全文", request_id="note"))
    second = projects.update_note(project["id"], first["id"], projects.UpdateNote(base_revision=1, title="修改", body="第二版全文"))
    with db.connect() as conn:
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute("UPDATE research_pdf_exports SET snapshot_json='{}' WHERE id=?", (first["pdf"]["id"],))
    worker.execute_job(first["pdf"]["job_id"])
    worker.execute_job(second["pdf"]["job_id"])
    history = projects.note_history(project["id"], first["id"])
    with TestClient(main.app) as client:
        old_bytes = client.get(history[1]["pdf"]["url"]).content
        old_text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(old_bytes)).pages)
        assert "第一版全文" in old_text and "第二版全文" not in old_text
        assert len(client.get(f"/api/v1/research-projects/{project['id']}/files").json()["items"]) == 1
        assert client.get(history[0]["pdf"]["url"]).content != old_bytes


def test_expired_pdf_lease_recovers_without_duplicate_export(case):
    cid, tid = case
    store.finish_turn(cid, tid, 0, "succeeded", "断点恢复正文", {})
    item = service.enqueue_turn(cid, tid)
    lease = jobs.claim(item["job_id"])
    with db.connect() as conn:
        conn.execute("UPDATE jobs SET lease_expires_at='2000-01-01' WHERE id=?", (lease.id,))
    assert worker.execute_job(item["job_id"])
    result = next(row for row in service.list_exports("conversation", cid) if row.get("source_kind") == "turn")
    assert result["status"] == "succeeded" and result["id"] == item["id"]
    with db.connect() as conn:
        assert conn.execute("SELECT attempts FROM jobs WHERE id=?", (item["job_id"],)).fetchone()[0] == 2


def test_existing_cached_pdfs_are_readable_without_backfill(case, monkeypatch):
    cid, tid = case
    store.finish_turn(cid, tid, 0, "succeeded", "已有PDF", {})
    saved = pdf.export_turn(cid, tid)
    monkeypatch.setattr(pdf, "render_document", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("no renderer")))
    with TestClient(main.app) as client:
        items = client.get(f"/api/v1/conversations/{cid}/research-files").json()["items"]
        assert items[0]["url"] == saved["url"] and items[0]["status"] == "succeeded"
        assert client.get(saved["url"]).status_code == 200
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM research_pdf_exports").fetchone()[0] == 0


def test_old_template_pdf_never_hides_new_failed_generation(case, monkeypatch):
    cid, tid = case
    store.finish_turn(cid, tid, 0, "succeeded", "原有正文", {})
    old = pdf.export_turn(cid, tid)
    monkeypatch.setattr(pdf, "TEMPLATE_VERSION", "future-template")
    queued = service.enqueue_turn(cid, tid)
    items = service.list_exports("conversation", cid)
    assert next(row for row in items if row.get("id") == queued["id"])["status"] == "queued"
    assert next(row for row in items if row.get("url") == old["url"])["previous"] is True
    monkeypatch.setattr(pdf, "render_document", lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("新版模板生成失败")))
    worker.execute_job(queued["job_id"])
    items = service.list_exports("conversation", cid)
    failed = next(row for row in items if row.get("id") == queued["id"])
    assert failed["status"] == "failed" and failed["url"] is None and failed["retry_url"]
    assert next(row for row in items if row.get("url") == old["url"])["status"] == "succeeded"


def test_note_pdf_status_is_read_only_and_checks_exact_revision(case):
    project = projects.create_project(projects.CreateProject(name="版本", request_id="project"))
    note = projects.create_note(project["id"], projects.CreateNote(title="记录", body="正文", request_id="note"))
    with TestClient(main.app) as client:
        url = f"/api/v1/research-projects/{project['id']}/notes/{note['id']}/pdf-status"
        assert client.get(url + "?revision=1").json()["pdf"]["id"] == note["pdf"]["id"]
        assert client.get(url + "?revision=2").status_code == 404
        assert client.get(url.replace(note["id"], "missing")).status_code == 404
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1


def test_queued_answer_freezes_embedded_image_before_a_later_turn_overwrites_it(case):
    from hashlib import sha256
    from PIL import Image
    cid, tid = case
    root = workspace.directory(cid) / "outputs"
    root.mkdir(parents=True)
    original = root / "chart.png"
    Image.new("RGB", (10, 10), "red").save(original)
    expected = sha256(original.read_bytes()).hexdigest()
    store.finish_turn(cid, tid, 0, "succeeded", "# 判断\n\n![原始图](outputs/chart.png)", {})
    queued = service.enqueue_turn(cid, tid)
    Image.new("RGB", (10, 10), "blue").save(original)
    with db.connect() as conn:
        snapshot = db.json_load(conn.execute("SELECT snapshot_json FROM research_pdf_exports WHERE id=?", (queued["id"],)).fetchone()[0])
    assert snapshot["images"]["outputs/chart.png"]["sha256"] == expected
    assert pdf._frozen_image_resolver(cid, snapshot["images"])("outputs/chart.png").read_bytes() != original.read_bytes()
    worker.execute_job(queued["job_id"])
    assert next(item for item in service.list_exports("conversation", cid) if item.get("id") == queued["id"])["status"] == "succeeded"


def test_queue_registration_failure_never_turns_successful_text_into_failure(case, monkeypatch):
    cid, tid = case
    monkeypatch.setattr(codex_runtime, "run_conversation_turn", lambda *_: {"thread_id": "thread", "codex_turn_id": "turn", "event_count": 0, "model": "test", "response": "应保留的正文", "files": []})
    def broken(*args, **kwargs):
        raise RuntimeError("queue temporarily unavailable")
    monkeypatch.setattr(service, "enqueue_turn", broken)
    result = codex_runtime.process_conversation_turn(cid, tid)
    assert result["state"] == "succeeded" and result["response_text"] == "应保留的正文"
    assert store.get_conversation(cid)["messages"][-1]["content"] == "应保留的正文"


def test_legacy_project_pdf_lists_and_downloads_without_job_metadata(case, monkeypatch):
    project = projects.create_project(projects.CreateProject(name="迁移前专题", request_id="legacy-project"))
    note = projects.create_note(project["id"], projects.CreateNote(title="旧研究笔记", body="迁移前完整研究正文", request_id="legacy-note"))
    cached = pdf.export_note(project["id"], note["id"])
    # Model an authentic pre-job cache: the real PDF and old manifest exist,
    # while no export/job rows or new owner metadata exist.
    assert "conversation_id" not in cached
    with db.connect() as connection:
        connection.execute("DELETE FROM research_pdf_exports WHERE id=?", (note["pdf"]["id"],))
        connection.execute("DELETE FROM jobs WHERE id=?", (note["pdf"]["job_id"],))
    monkeypatch.setattr(pdf, "render_document", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("GET cannot render a PDF")))
    with TestClient(main.app) as client:
        endpoint = f"/api/v1/research-projects/{project['id']}/files"
        response = client.get(endpoint)
        assert response.status_code == 200
        items = response.json()["items"]
        assert len(items) == 1 and items[0]["url"] == cached["url"]
        assert items[0]["conversation_id"] == "" and items[0]["project_id"] == project["id"]
        assert items[0]["status"] == "succeeded"
        assert client.get(endpoint).json()["items"] == items
        download = client.get(cached["url"])
        assert download.status_code == 200
        assert "迁移前完整研究正文" in "\n".join(page.extract_text() for page in PdfReader(BytesIO(download.content)).pages)
    with db.connect() as connection:
        assert connection.execute("SELECT count(*) FROM research_pdf_exports").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0


def test_replacement_project_pdf_keeps_previous_report_until_success(case, monkeypatch):
    project = projects.create_project(projects.CreateProject(name="原专题名", request_id="replacement-project"))
    note = projects.create_note(project["id"], projects.CreateNote(title="完整研究笔记", body="排队、失败、重试期间均可读取的原研究正文", request_id="replacement-note"))
    assert worker.execute_job(note["pdf"]["job_id"])
    old = service.list_exports("project", project["id"])[0]
    projects.update_project(project["id"], projects.UpdateProject(base_revision=1, name="修改后的专题名"))
    renderer = pdf.render_document
    with TestClient(main.app) as client:
        endpoint = f"/api/v1/research-projects/{project['id']}/files"
        old_bytes = client.get(old["url"]).content
        queued = client.post(f"/api/v1/research-projects/{project['id']}/notes/{note['id']}/pdf-jobs", json={}).json()
        assert queued["id"] != note["pdf"]["id"] and queued["status"] == "queued"
        monkeypatch.setattr(pdf, "render_document", lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("替换报告排版失败")))
        response = client.get(endpoint)
        assert response.status_code == 200
        items = response.json()["items"]
        assert client.get(endpoint).json()["items"] == items
        pending = next(item for item in items if item.get("id") == queued["id"])
        previous = next(item for item in items if item.get("url") == old["url"])
        assert pending["status"] == "queued" and pending["url"] is None
        assert previous["previous"] and previous["status"] == "succeeded"
        assert previous["conversation_id"] == "" and previous["project_id"] == project["id"]
        assert client.get(old["url"]).content == old_bytes
        assert worker.execute_job(queued["job_id"])
        failed_items = client.get(endpoint).json()["items"]
        failed = next(item for item in failed_items if item.get("id") == queued["id"])
        assert failed["status"] == "failed" and failed["url"] is None
        assert next(item for item in failed_items if item.get("url") == old["url"])["previous"]
        assert client.get(old["url"]).content == old_bytes
        monkeypatch.setattr(pdf, "render_document", renderer)
        retry = client.post(failed["retry_url"]).json()
        assert worker.execute_job(retry["job_id"])
        completed = client.get(endpoint).json()["items"]
        assert len(completed) == 1 and completed[0]["status"] == "succeeded"
        assert completed[0]["url"] != old["url"]
        current_text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(client.get(completed[0]["url"]).content)).pages)
        assert "修改后的专题名" in current_text and "原研究正文" in current_text
        assert client.get(old["url"]).content == old_bytes


def test_equal_time_legacy_pdf_choice_is_independent_of_manifest_order(case, monkeypatch):
    project = projects.create_project(projects.CreateProject(name="首次专题名", request_id="tie-project"))
    note = projects.create_note(project["id"], projects.CreateNote(title="同名笔记", body="真实PDF排序检查", request_id="tie-note"))
    first = pdf.export_note(project["id"], note["id"])
    projects.update_project(project["id"], projects.UpdateProject(base_revision=1, name="第二次专题名"))
    second = pdf.export_note(project["id"], note["id"])
    assert first["url"] != second["url"]
    for cached in (first, second):
        manifest = pdf._root(project["id"], project=True) / (cached["url"].rsplit("/", 1)[-1].removesuffix(".pdf") + ".json")
        metadata = json.loads(manifest.read_text(encoding="utf-8"))
        metadata["modified_at"] = 1000.0
        manifest.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
    with db.connect() as connection:
        connection.execute("DELETE FROM research_pdf_exports WHERE id=?", (note["pdf"]["id"],))
        connection.execute("DELETE FROM jobs WHERE id=?", (note["pdf"]["job_id"],))
    cached_items = pdf.cached_deliverables(project["id"], project=True)
    calls = []
    def alternate_order(*_args, **_kwargs):
        calls.append(True)
        return list(reversed(cached_items)) if len(calls) % 2 else cached_items
    monkeypatch.setattr(pdf, "cached_deliverables", alternate_order)
    with TestClient(main.app) as client:
        endpoint = f"/api/v1/research-projects/{project['id']}/files"
        items = client.get(endpoint).json()["items"]
        assert client.get(endpoint).json()["items"] == items
        assert len(items) == 1 and items[0]["url"] == min(first["url"], second["url"])
        assert client.get(items[0]["url"]).status_code == 200
