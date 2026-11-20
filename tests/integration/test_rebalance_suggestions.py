from datetime import datetime
import json

from fastapi.testclient import TestClient
import pytest

from apps.api.app import client_service_runtime, codex_runtime, codex_store, db, main, rebalance_suggestions, research_models, worker


PATH = "/api/v1/client-service/rebalance-suggestions"
CODE = "603650.SH"
CUTOFF = datetime.fromisoformat("2026-11-20T16:00:00+08:00")
QUOTE = "前三季度营收增长，电子材料是主要贡献来源。"
WEB_REPORT = "https://example.com/report"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "suggestions.db")
    monkeypatch.setattr(rebalance_suggestions, "now", lambda: CUTOFF)
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
    monkeypatch.setattr(research_models, "llm_settings", lambda: {
        "configured": True, "model": "gpt-6.1-sol", "reasoning_effort": "high",
    })
    monkeypatch.setattr(research_models, "_discover", lambda _: ({"gpt-6.1-sol"}, "verified"))
    db.init_db()
    with db.connect() as connection:
        connection.execute(
            "INSERT INTO security_catalog VALUES (?,?,?,?,?,?)", (CODE, "样例股份", "", "", "SH", db.utc_now()),
        )
    with TestClient(main.app) as session:
        yield session


def add_report(document_id, publication, *, code=CODE, available_status="confirmed"):
    with db.connect() as connection:
        connection.execute(
            """INSERT INTO documents
               (id,sha256,filename,title,publication_date,stock_code,pages,extracted_chars,parse_status,
                source_path,imported_at,stock_code_status,available_at,available_at_status,metadata_status,metadata_json)
               VALUES (?, ?, ?, '样例股份季度点评', ?, ?, 1, ?, 'indexed', '', ?, 'confirmed', ?, ?, 'ready', ?)""",
            (document_id, document_id, document_id + ".pdf", publication, code, len(QUOTE),
             db.utc_now(), publication, available_status, db.json_dump({"fields": {
                 "broker": {"value": "样例证券"}, "analysts": {"value": "示例作者"},
             }})),
        )
        connection.execute("INSERT INTO document_pages VALUES (?,1,?)", (document_id, QUOTE))


def mock_collection(monkeypatch, reply, *, report_ids=(), opened=False):
    def run(conversation_id, turn_id):
        manifest = client_service_runtime.prepare(conversation_id, turn_id)
        assert manifest["profile"] == "rebalance-suggestion"
        prompt = json.loads(client_service_runtime.prompt(conversation_id, turn_id, manifest["profile"]))
        assert prompt["股票代码"] == CODE and prompt["调仓场景"] == "开仓买入"
        assert tuple(report["document_id"] for report in prompt["本地研报"]) == report_ids
        assert "仓位变化" not in prompt and "参考价格" not in prompt
        if opened:
            for sequence, action in enumerate(({"type": "search"}, {"type": "openPage", "url": WEB_REPORT})):
                codex_store.append_event(
                    conversation_id, turn_id, "test-thread", "test-turn", sequence,
                    "item/completed", {"item": {"type": "webSearch", "action": action}},
                )
        return {
            "response": json.dumps(reply, ensure_ascii=False), "thread_id": "test-thread", "codex_turn_id": "test-turn",
            "event_count": 2 if opened else 0, "model": "gpt-6.1-sol", "reasoning_effort": "high",
        }
    monkeypatch.setattr(codex_runtime, "run_conversation_turn", run)


def enqueue(client):
    payload = {"request_id": "sample", "code": "603650", "direction": "开仓买入"}
    response = client.post(PATH, json=payload)
    assert response.status_code == 202, response.text
    assert response.json()["state"] == "awaiting_agent"
    return payload


def test_collects_confirmed_local_report_and_formats_editable_basis(client, monkeypatch):
    add_report("current", "2026-10-29")
    add_report("future", "2026-11-21")
    add_report("undated", "2026-11-19", available_status="unknown")
    add_report("other-stock", "2026-11-19", code="688012.SH")
    payload = enqueue(client)
    assert client.post(PATH, json={**payload, "code": "603650.SH"}).status_code == 202
    assert client.post(PATH, json={**payload, "direction": "止盈调出"}).status_code == 409
    mock_collection(monkeypatch, {
        "reason": "考虑到[电子材料](https://example.com/data)是营收增长的主要贡献来源，跟踪后续表现。",
        "report": {"document_id": "current", "quote": QUOTE, "authors": "错误名字"},
    }, report_ids=("current",))
    assert not worker.execute_job(client_service=False)
    assert worker.execute_job(client_service=True)
    result = client.get(PATH + "/sample").json()
    assert result["state"] == "succeeded", result
    assert result["reason"] == "考虑到电子材料是营收增长的主要贡献来源，跟踪后续表现。"
    assert result["basis"] == "参考研报：《样例股份季度点评》 研报作者：样例证券 示例作者，发布日期 2026年10月29日。"
    assert result["report"]["document_id"] == "current"
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1


@pytest.mark.parametrize("opened,published,expected", [
    (True, "2026-11-19", "succeeded"),
    (False, "2026-11-19", "no_evidence"),
    (True, "2026-11-21", "no_evidence"),
])
def test_web_report_requires_opened_nonfuture_source(client, monkeypatch, opened, published, expected):
    enqueue(client)
    mock_collection(monkeypatch, {
        "reason": "经营情况可以继续观察。",
        "report": {"url": WEB_REPORT, "title": "样例股份研究", "broker": "样例证券", "authors": "示例作者",
                   "publication_date": published, "quote": QUOTE},
    }, opened=opened)
    assert worker.execute_job(client_service=True)
    result = client.get(PATH + "/sample").json()
    assert result["state"] == expected
    if expected == "succeeded":
        assert result["report"]["url"] == WEB_REPORT
        assert WEB_REPORT not in result["basis"]
    else:
        assert "reason" not in result and "basis" not in result


def test_rejects_a_quote_absent_from_the_local_report(client, monkeypatch):
    add_report("current", "2026-10-29")
    enqueue(client)
    mock_collection(monkeypatch, {
        "reason": "需要观察经营情况。",
        "report": {"document_id": "current", "quote": "这是研报原文中不存在的论据。"},
    }, report_ids=("current",))
    assert worker.execute_job(client_service=True)
    assert client.get(PATH + "/sample").json()["state"] == "no_evidence"
