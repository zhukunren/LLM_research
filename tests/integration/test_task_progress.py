import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.api.app import conversation_store, db, task_api
from apps.api.app import research_projects, research_pdf_service


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tasks.db")
    db.init_db()
    app = FastAPI()
    app.include_router(task_api.router)
    with TestClient(app) as client:
        yield client


def add_job(job_id, kind, state="queued", at="2026-10-06T00:00:00+00:00"):
    with db.connect() as connection:
        connection.execute("INSERT INTO jobs(id,kind,payload_json,state,message,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                           (job_id, kind, '{"secret":"should-not-be-returned"}', state, "stderr=private failure details", at, at))


def test_tasks_show_every_background_work_type_and_correct_recovery_destination(client):
    for kind in ["data_sync", "report_metadata", "report_evaluation", "screening"]:
        add_job(kind, kind)
    items = client.get("/api/v1/tasks").json()["items"]
    assert len(items) == 4
    by_kind = {item["kind"]: item for item in items}
    assert by_kind["data_sync"]["destination"] == {"kind": "settings"}
    assert by_kind["report_metadata"]["destination"] == {"kind": "page", "page": "reports"}
    assert by_kind["screening"]["destination"] == {"kind": "page", "page": "conditions"}
    assert all(item["stage"] and item["action_label"] and item["state_label"] == "排队中" for item in items)
    assert "private" not in str(items) and "secret" not in str(items)


def test_turn_and_scan_have_original_conversation_destinations_and_turn_is_not_duplicated(client):
    cid = conversation_store.create_conversation("report", workflow_type="research")["id"]
    turn = conversation_store.add_user_message(cid, "question", 0, "核对订单证据")
    add_job("research", "research_turn")
    add_job("scan", "research_scan")
    with db.connect() as connection:
        connection.execute("INSERT INTO research_turn_jobs VALUES(?,?,?,?)", (turn["turn_id"], cid, "research", db.utc_now()))
        connection.execute("""INSERT INTO research_scans(id,conversation_id,turn_id,job_id,request_hash,name,as_of,status,snapshot_json,created_at)
            VALUES(?,?,?,?,?,'订单指标','2026-09-28','queued','{}',?)""", ("scan", cid, turn["turn_id"], "scan", "hash", db.utc_now()))
    result = client.get("/api/v1/tasks").json()
    assert result["active_count"] == 2 and len(result["items"]) == 2
    assert all(item["destination"] == {"kind": "conversation", "conversation_id": cid, "scope": "report"} for item in result["items"])
    assert {item["title"] for item in result["items"]} == {"核对订单证据", "订单指标"}


def test_active_filter_precedes_limit_and_recent_keeps_old_active_work_first(client):
    add_job("older-active", "data_sync", at="2026-10-01T00:00:00+00:00")
    add_job("new-completed", "report_metadata", "succeeded")
    add_job("new-failed", "report_evaluation", "failed")
    response = client.get("/api/v1/tasks?limit=1").json()
    assert [item["id"] for item in response["items"]] == ["job:older-active"]
    recent = client.get("/api/v1/tasks?active_only=false").json()
    assert recent["active_count"] == 1 and recent["items"][0]["id"] == "job:older-active"
    failed = next(item for item in recent["items"] if item["state"] == "failed")
    assert failed["state_label"] == "需重试" and "恢复" in failed["stage"]


def test_unqueued_request_is_visible_and_reading_progress_does_not_recover_or_submit(client):
    cid = conversation_store.create_conversation("screening", workflow_type="screening")["id"]
    turn = conversation_store.add_user_message(cid, "request", 0, "整理条件，先不执行")
    add_job("expired", "data_sync", "running")
    with db.connect() as connection:
        before = [tuple(row) for row in connection.execute("SELECT id,state,attempts FROM jobs")]
    first = client.get("/api/v1/tasks").json()
    second = client.get("/api/v1/tasks").json()
    assert first == second
    assert first["active_count"] == 2
    item = next(item for item in first["items"] if item["id"].startswith("turn:"))
    assert item["kind_label"] == "条件选股" and item["state"] == "queued"
    assert item["state_label"] == "待继续" and item["action_label"] == "继续处理"
    assert "尚未进入后台" in item["stage"]
    with db.connect() as connection:
        assert [tuple(row) for row in connection.execute("SELECT id,state,attempts FROM jobs")] == before
        assert connection.execute("SELECT state FROM conversation_turns WHERE id=?", (turn["turn_id"],)).fetchone()[0] == "awaiting_agent"
        assert connection.execute("SELECT count(*) FROM screening_task_runs").fetchone()[0] == 0


def test_recent_research_waiting_for_user_shows_requested_next_step(client):
    cid = conversation_store.create_conversation("report", workflow_type="research")["id"]
    turn = conversation_store.add_user_message(cid, "question", 0, "请比较公司")
    conversation_store.start_turn(cid, turn["turn_id"])
    conversation_store.finish_turn(cid, turn["turn_id"], 0, "awaiting_user", "想比较哪两家公司？", {})
    add_job("done", "research_turn", "succeeded")
    with db.connect() as connection:
        connection.execute("INSERT INTO research_turn_jobs VALUES(?,?,?,?)", (turn["turn_id"], cid, "done", db.utc_now()))
    item = client.get("/api/v1/tasks?active_only=false").json()["items"][0]
    assert item["state"] == "awaiting_user" and item["action_label"] == "补充要求"
    assert client.get("/api/v1/tasks?limit=0").status_code == 422


def test_project_report_job_opens_its_project_instead_of_an_unrelated_conversation(client):
    project = research_projects.create_project(research_projects.CreateProject(name="现金流研究", objective="核对证据", request_id="project-create"))
    research_pdf_service.enqueue_discovery("project", project["id"], "prepare-existing-reports")
    item = client.get("/api/v1/tasks").json()["items"][0]
    assert item["kind"] == "research_pdf" and item["kind_label"] == "报告生成"
    assert item["destination"] == {"kind": "project", "project_id": project["id"]}


def test_missing_dependencies_are_not_presented_as_running_evidence_analysis(client):
    add_job("unconfigured", "report_evaluation", "blocked_dependency")
    item = client.get("/api/v1/tasks?active_only=false").json()["items"][0]
    assert item["state_label"] == "待准备"
    assert "尚未就绪" in item["stage"] and "正在" not in item["stage"]
    assert item["action_label"] == "检查数据与服务" and item["destination"] == {"kind": "settings"}
