from io import BytesIO
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
