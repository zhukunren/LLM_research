import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.api.app import conversation_store, db, market, observation_api


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "observations.db")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "absent-market.parquet")
    db.init_db()
    with db.connect() as connection:
        connection.execute("INSERT INTO security_catalog VALUES('600519.SH','贵州茅台','','','SH','2026-10-04')")
        connection.execute("INSERT INTO security_catalog VALUES('600036.SH','招商银行','','','SH','2026-10-04')")
        connection.execute("INSERT INTO research_projects(id,name,request_id,created_at,updated_at) VALUES('project','盈利研究','project','2026-10-04','2026-10-04')")
        for cid, workflow in (("research", "research"), ("screening", "screening"), ("other", "research")):
            connection.execute("INSERT INTO conversations(id,entry_scope,workflow_type,project_id,research_scope_json,research_scope_revision,created_at,updated_at) VALUES(?,'report',?,'project',?,9,'2026-10-04','2026-10-04')", (cid, workflow, db.json_dump({"as_of": "2026-10-03"})))
            connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,client_message_id,created_at) VALUES(?,?,'user','只研究，暂不筛选','question','2026-10-01')", (cid + '-question', cid))
            connection.execute("INSERT INTO conversation_turns(id,conversation_id,user_message_id,base_revision,state,workflow_type,research_scope_json,research_scope_revision,created_at,updated_at,response_text) VALUES(?,?,?,0,'succeeded',?,?,2,'2026-10-01','2026-10-01',' 原研究答复：经营改善仍需验证。 ')", (cid + '-turn', cid, cid + '-question', workflow, db.json_dump({"as_of": "2026-09-30", "universe": {"kind": "stocks", "stock_codes": ["600519.SH"]}})))
            connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,client_message_id,source_refs_json,created_at) VALUES(?,?,'assistant',' 原研究答复：经营改善仍需验证。 ',?,'[]','2026-10-01')", (cid + '-answer', cid, "assistant:" + cid + "-turn"))
    app = FastAPI()
    app.include_router(observation_api.router)
    with TestClient(app) as session:
        yield session


def payload(**overrides):
    return {"request_id": "watch-1", "conversation_id": "research", "source_message_id": "research-answer", "stock_code": "600519.SH", "note": "核对现金流", "verification": "下一期公告", "invalidation": "现金流持续恶化", **overrides}


def test_candidate_sort_and_plan_filter_apply_before_pagination(client):
    first = client.post("/api/v1/observation/research-candidates", json=payload(verification="")).json()
    second = client.post("/api/v1/observation/research-candidates", json=payload(request_id="later", stock_code="600036.SH")).json()
    assert client.patch(f"/api/v1/observation/research-candidates/{first['id']}", json={"revision": 1, "status": "priority"}).status_code == 200
    assert client.patch(f"/api/v1/observation/research-candidates/{second['id']}", json={"revision": 1, "note": "最新记录"}).status_code == 200
    response = client.get("/api/v1/observation/research-candidates?limit=1&sort=priority").json()
    assert response["total"] == 2 and response["items"][0]["id"] == first["id"]
    plans = client.get("/api/v1/observation/research-candidates?needs_verification=true&sort=verification").json()
    assert plans["total"] == 1 and plans["items"][0]["id"] == first["id"]
    client.patch(f"/api/v1/observation/research-candidates/{first['id']}", json={"revision": 2, "status": "ended"})
    assert client.get("/api/v1/observation/research-candidates?needs_verification=true").json()["total"] == 0
    assert client.get("/api/v1/observation/research-candidates?sort=invalid").status_code == 422


def test_candidate_freezes_real_source_and_creates_no_screening_run(client):
    response = client.post("/api/v1/observation/research-candidates", json=payload())
    assert response.status_code == 200, response.text
    item = response.json()
    assert item["source_kind"] == "research_candidate" and item["status"] == "watching"
    assert item["name"] == "贵州茅台" and item["stock_code"] == "600519.SH"
    assert item["source_text"] == " 原研究答复：经营改善仍需验证。 "
    assert item["project_id"] == "project" and item["as_of"] == "2026-09-30"
    assert item["source_scope_revision"] == 2 and item["source_scope_status"] == "frozen"
    with db.connect() as connection:
        assert connection.execute("SELECT count(*) FROM screening_task_runs").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM screening_task_revisions").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0


def test_known_candidate_read_is_independent_of_list_and_changes_nothing(client):
    first = client.post("/api/v1/observation/research-candidates", json=payload()).json()
    second = client.post("/api/v1/observation/research-candidates", json=payload(request_id="watch-2", stock_code="600036.SH")).json()
    listing = client.get("/api/v1/observation/research-candidates?limit=1&sort=updated").json()
    assert listing["items"][0]["id"] == second["id"]
    with db.connect() as connection:
        before = [tuple(row) for row in connection.execute("SELECT * FROM research_observation_candidates ORDER BY id")]
    response = client.get(f"/api/v1/observation/research-candidates/{first['id']}")
    assert response.status_code == 200, response.text
    assert response.json() == first
    assert client.get("/api/v1/observation/research-candidates/unknown-id").status_code == 404
    assert client.get("/api/v1/observation/research-candidates/unknown-id").json()["detail"]["code"] == "research_candidate_error"
    with db.connect() as connection:
        assert [tuple(row) for row in connection.execute("SELECT * FROM research_observation_candidates ORDER BY id")] == before
        assert connection.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0


def test_add_retry_is_idempotent_and_changed_payload_conflicts(client):
    first = client.post("/api/v1/observation/research-candidates", json=payload()).json()
    repeated = client.post("/api/v1/observation/research-candidates", json=payload()).json()
    assert repeated["id"] == first["id"]
    assert client.post("/api/v1/observation/research-candidates", json=payload(note="不同请求内容")).status_code == 409
    with db.connect() as connection:
        assert connection.execute("SELECT count(*) FROM research_observation_candidates").fetchone()[0] == 1


@pytest.mark.parametrize("changes,status", [
    ({"conversation_id": "screening", "source_message_id": "screening-answer"}, 422),
    ({"source_message_id": "research-question"}, 404),
    ({"source_message_id": "other-answer"}, 404),
    ({"stock_code": "999999.SH"}, 422),
    ({"stock_code": "../not-stock"}, 422),
])
def test_invalid_sources_and_unrecognized_stock_never_create_candidate(client, changes, status):
    response = client.post("/api/v1/observation/research-candidates", json=payload(**changes))
    assert response.status_code == status, response.text
    with db.connect() as connection:
        assert connection.execute("SELECT count(*) FROM research_observation_candidates").fetchone()[0] == 0


def test_unverifiable_legacy_message_cannot_become_candidate(client):
    with db.connect() as connection:
        connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES('legacy','research','assistant','旧研究文字','2026-09-01')")
    response = client.post("/api/v1/observation/research-candidates", json=payload(source_message_id="legacy"))
    assert response.status_code == 409
    assert client.get("/api/v1/observation/research-candidates").json()["total"] == 0


@pytest.mark.parametrize("state", ["failed", "cancelled", "running", "awaiting_agent", "awaiting_user"])
def test_only_successful_research_turn_can_supply_candidate(client, state):
    with db.connect() as connection:
        connection.execute("UPDATE conversation_turns SET state=? WHERE id='research-turn'", (state,))
    response = client.post("/api/v1/observation/research-candidates", json=payload())
    assert response.status_code == 409, response.text
    assert client.get("/api/v1/observation/research-candidates").json()["total"] == 0


def test_real_failed_turn_system_reply_is_not_research_evidence(client):
    cid = conversation_store.create_conversation("report", workflow_type="research")["id"]
    message = conversation_store.add_user_message(cid, "failed-research", 0, "研究公司")
    conversation_store.start_turn(cid, message["turn_id"])
    assert conversation_store.fail_turn(cid, message["turn_id"], "连接失败，没有研究结果")
    source = conversation_store.get_conversation(cid)["messages"][-1]
    response = client.post("/api/v1/observation/research-candidates", json=payload(conversation_id=cid, source_message_id=source["id"]))
    assert response.status_code == 409, response.text
    assert client.get("/api/v1/observation/research-candidates").json()["total"] == 0


@pytest.mark.parametrize("key", ["assistant:missing-turn", "assistant:other-turn", "unbound-modern", None])
def test_missing_foreign_or_unbound_modern_turn_cannot_bypass_success_guard(client, key):
    with db.connect() as connection:
        connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,client_message_id,created_at) VALUES('unbound','research','assistant',' 原研究答复：经营改善仍需验证。 ',?,'2026-10-02')", (key,))
    response = client.post("/api/v1/observation/research-candidates", json=payload(source_message_id="unbound"))
    assert response.status_code == 409, response.text
    assert client.get("/api/v1/observation/research-candidates").json()["total"] == 0


def test_successful_turn_cannot_lend_provenance_to_different_reply(client):
    with db.connect() as connection:
        connection.execute("UPDATE conversation_turns SET response_text='与助手消息不匹配的正文' WHERE id='research-turn'")
    response = client.post("/api/v1/observation/research-candidates", json=payload())
    assert response.status_code == 409, response.text


@pytest.mark.parametrize("state,ambiguous,expected", [("succeeded", False, 200), ("failed", False, 409), ("succeeded", True, 409)])
def test_legacy_unbound_reply_requires_one_recorded_successful_completion(client, state, ambiguous, expected):
    with db.connect() as connection:
        connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES('legacy','research','assistant','旧研究判断仍需核验','2026-09-01')")
        for index in range(2 if ambiguous else 1):
            question_id = f"legacy-question-{index}"
            connection.execute("INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES(?,'research','user','旧研究要求','2026-09-01')", (question_id,))
            connection.execute("INSERT INTO conversation_turns(id,conversation_id,user_message_id,base_revision,state,workflow_type,response_text,created_at,updated_at) VALUES(?,'research',?,0,?,'research','旧研究判断仍需核验','2026-09-01','2026-09-01')", (f"legacy-turn-{index}", question_id, state))
    response = client.post("/api/v1/observation/research-candidates", json=payload(source_message_id="legacy"))
    assert response.status_code == expected, response.text
    if expected == 200:
        item = response.json()
        assert item["scope"] is None and item["as_of"] is None
        assert item["source_scope_status"] == "unknown" and item["source_scope_revision"] is None
    else:
        assert client.get("/api/v1/observation/research-candidates").json()["total"] == 0


def test_patch_revision_protects_newer_edit_and_source_snapshot(client):
    item = client.post("/api/v1/observation/research-candidates", json=payload()).json()
    endpoint = "/api/v1/observation/research-candidates/" + item["id"]
    response = client.patch(endpoint, json={"revision": 1, "status": "priority", "verification": "增加反方公告验证"})
    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated["revision"] == 2 and updated["status"] == "priority"
    assert updated["source_text"] == item["source_text"] and updated["scope"] == item["scope"]
    assert client.patch(endpoint, json={"revision": 1, "note": "迟到修改"}).status_code == 409
    assert client.patch(endpoint, json={"revision": 2, "stock_code": "600036.SH"}).status_code == 422
    assert client.patch(endpoint, json={"revision": 2, "source_text": "伪造来源"}).status_code == 422
    assert client.patch(endpoint, json={"revision": 2, "note": None}).status_code == 422
    assert client.patch(endpoint, json={"revision": 2}).status_code == 422
    assert client.post("/api/v1/observation/research-candidates", json=payload()).json()["revision"] == 2
    with db.connect() as connection:
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("UPDATE research_observation_candidates SET source_text='rewritten' WHERE id=?", (item["id"],))


def test_search_status_and_pagination_are_independent_of_screening(client):
    first = client.post("/api/v1/observation/research-candidates", json=payload()).json()
    second = client.post("/api/v1/observation/research-candidates", json=payload(request_id="watch-2", stock_code="600036.SH", note="银行分红验证")).json()
    client.patch("/api/v1/observation/research-candidates/" + first["id"], json={"revision": 1, "status": "ended"})
    all_items = client.get("/api/v1/observation/research-candidates?limit=1").json()
    assert all_items["total"] == 2 and len(all_items["items"]) == 1
    next_page = client.get("/api/v1/observation/research-candidates?limit=1&offset=1").json()
    assert next_page["items"][0]["id"] != all_items["items"][0]["id"]
    assert client.get("/api/v1/observation/research-candidates?query=招商&status=watching").json()["items"][0]["id"] == second["id"]
    assert client.get("/api/v1/observation/research-candidates?query=银行分红").json()["total"] == 1
    assert client.get("/api/v1/observation/research-candidates?status=invalid").status_code == 422
    assert client.get("/api/v1/observation/research-candidates?offset=-1").status_code == 422


def test_concurrent_retry_creates_one_candidate(client):
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post("/api/v1/observation/research-candidates", json=payload()), range(2)))
    assert all(response.status_code == 200 for response in responses)
    assert responses[0].json()["id"] == responses[1].json()["id"]
    assert client.get("/api/v1/observation/research-candidates").json()["total"] == 1


def test_local_market_recognition_reads_fixture_parquet_without_catalog_mapping(client, tmp_path, monkeypatch):
    import pyarrow as pa
    import pyarrow.parquet as pq
    path = tmp_path / "candidate-market.parquet"
    # Synthetic price fixture for a real security; this is API acceptance, not
    # a claimed return or a stock-selection evaluation result.
    pq.write_table(pa.Table.from_pylist([{
        "stock_code": "600036.SH", "trade_date": datetime(2026, 9, 30),
        "open": 10.0, "high": 11.0, "low": 9.0, "close": 10.5,
        "volume": 100.0, "amount": 1000.0,
    }]), path)
    monkeypatch.setattr(market, "STOCK_FILE", path)
    with db.connect() as connection:
        connection.execute("DELETE FROM security_catalog WHERE stock_code='600036.SH'")
    before = path.read_bytes()
    response = client.post("/api/v1/observation/research-candidates", json=payload(stock_code="600036.SH"))
    assert response.status_code == 200, response.text
    assert response.json()["stock_code"] == "600036.SH" and response.json()["name"] == ""
    assert path.read_bytes() == before
    with db.connect() as connection:
        assert not connection.execute("SELECT 1 FROM security_catalog WHERE stock_code='600036.SH'").fetchone()


def test_retry_remains_bound_to_original_project_and_scope_after_conversation_changes(client):
    item = client.post("/api/v1/observation/research-candidates", json=payload()).json()
    with db.connect() as connection:
        connection.execute("UPDATE conversations SET project_id=NULL,research_scope_json=?,research_scope_revision=20,workflow_type='screening' WHERE id='research'", (db.json_dump({"as_of": "2026-10-04"}),))
    repeated = client.post("/api/v1/observation/research-candidates", json=payload())
    assert repeated.status_code == 200
    assert repeated.json()["id"] == item["id"]
    assert repeated.json()["project_id"] == "project"
    assert repeated.json()["as_of"] == "2026-09-30" and repeated.json()["source_scope_revision"] == 2
