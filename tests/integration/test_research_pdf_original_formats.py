from io import BytesIO

from fastapi.testclient import TestClient
from pypdf import PdfReader
import pytest

from apps.api.app import conversation_store as store, db, main, research_models, settings, worker
from apps.api.app import research_pdf_service as service, research_workspace as workspace


@pytest.fixture
def case(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "original-formats.db")
    config = lambda: {"configured": False, "model": "gpt-6-luna", "reasoning_effort": "high"}
    monkeypatch.setattr(settings, "llm_settings", config)
    monkeypatch.setattr(research_models, "llm_settings", config)
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {"account_tier": "free", "allowed_models": [], "reasoning_efforts": {}})
    db.init_db()
    cid = store.create_conversation("report", workflow_type="research")["id"]
    root = workspace.directory(cid) / "outputs"
    root.mkdir(parents=True)
    return cid, root


def test_original_office_deliverables_do_not_fail_discovery_and_branded_answer_pdf_still_renders(case):
    cid, root = case
    files = {"数据表.xlsx": b"original spreadsheet", "结论.docx": b"original document", "汇报.PPTX": b"original slides"}
    for name, data in files.items():
        (root / name).write_bytes(data)
    turn = store.add_user_message(cid, "research", 0, "生成表格与研究结论")
    store.start_turn(cid, turn["turn_id"])
    store.finish_turn(cid, turn["turn_id"], 0, "succeeded", "已生成可编辑文件，原始证据仍需持续核对。", {})
    discovery = service.enqueue_discovery("conversation", cid, "native-files")
    assert worker.execute_job(discovery["job_id"])
    with db.connect() as connection:
        row = service._row(connection, discovery["id"])
        result = db.json_load(row["item_json"])["discovery"]
        assert row["job_state"] == "succeeded"
        assert result["unsupported"] == result["errors"] == []
        assert "格式暂不支持" not in row["job_message"]
        assert connection.execute("SELECT COUNT(*) FROM research_pdf_exports WHERE source_kind='file'").fetchone()[0] == 0
    pending, = service.list_exports("conversation", cid)
    assert pending["source_kind"] == "turn" and pending["status"] == "queued"
    assert worker.execute_job(pending["job_id"])
    with TestClient(main.app) as client:
        exports = client.get(f"/api/v1/conversations/{cid}/research-files").json()["items"]
        assert len(exports) == 1 and exports[0]["status"] == "succeeded"
        pdf = client.get(exports[0]["url"])
        assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF-")
        text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(pdf.content)).pages)
        assert "张家港营业部" in text and "已生成可编辑文件" in text
        originals = client.get(f"/api/v1/conversations/{cid}/generated-files").json()["items"]
        assert {item["name"] for item in originals} == set(files)
        assert all(client.get(item["url"]).content == files[item["name"]] for item in originals)


def test_discovery_keeps_real_unsupported_formats_and_capture_failures(case):
    cid, root = case
    (root / "complete.xlsx").write_bytes(b"original")
    (root / "unsupported.bin").write_bytes(b"binary")
    (root / "broken.md").write_bytes(b"\xff")
    discovery = service.enqueue_discovery("conversation", cid, "mixed-inputs")
    assert worker.execute_job(discovery["job_id"])
    item, = service.list_exports("conversation", cid)
    assert item["status"] == "partial" and item["retry_url"]
    assert item["discovery"]["unsupported"] == ["unsupported.bin"]
    assert item["discovery"]["errors"][0]["source"] == "broken.md"


def historical_discovery(cid, unsupported, errors, state="partial"):
    item = service.enqueue_discovery("conversation", cid, "old-discovery")
    with db.connect() as connection:
        connection.execute("UPDATE research_pdf_exports SET item_json=? WHERE id=?", (
            db.json_dump({"discovery": {"queued": 0, "existing": 1, "unsupported": unsupported, "errors": errors, "active_workspaces_skipped": []}}), item["id"]))
        connection.execute("UPDATE jobs SET state=?,message=? WHERE id=?", (state, "2 个文件格式暂不支持，原件保留。", item["job_id"]))
    return item


def test_historical_office_only_partial_is_hidden_on_get_without_mutating_or_retrying(case):
    cid, _ = case
    item = historical_discovery(cid, ["tables/data.xlsx", "notes/report.DOCX", "slides.pptx"], [])
    with db.connect() as connection:
        before = dict(service._row(connection, item["id"]))
    with TestClient(main.app) as client:
        for _ in range(2):
            response = client.get(f"/api/v1/conversations/{cid}/research-files")
            assert response.status_code == 200 and response.json()["items"] == []
    with db.connect() as connection:
        assert dict(service._row(connection, item["id"])) == before
        assert connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1


@pytest.mark.parametrize("unsupported,errors,state", [
    (["native.xlsx", "unknown.zip"], [], "partial"),
    (["native.docx"], [{"source": "report.md", "message": "读取失败"}], "partial"),
    ([], [], "partial"),
    (["native.pptx"], [], "failed"),
    (["native.xlsx"], None, "partial"),
])
def test_historical_real_or_unexplained_failures_remain_visible(case, unsupported, errors, state):
    cid, _ = case
    original = historical_discovery(cid, unsupported, errors, state)
    item, = service.list_exports("conversation", cid)
    assert item["id"] == original["id"] and item["status"] == state and item["retry_url"]
