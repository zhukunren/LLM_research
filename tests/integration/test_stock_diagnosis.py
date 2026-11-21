from datetime import datetime
import json

from fastapi.testclient import TestClient
import pytest

from apps.api.app import (
    client_service_runtime, codex_runtime, codex_store, db, main, market,
    research_models, stock_diagnosis, worker,
)
from apps.api.app.client_service_disclosure import FIXED_DISCLOSURE


PATH = "/api/v1/client-service/stock-diagnoses"
CUTOFF = datetime.fromisoformat("2026-11-20T14:00:00+08:00")
SOURCE = "https://example.com/stock-disclosure"


@pytest.fixture
def diagnosis_client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    monkeypatch.setattr(stock_diagnosis, "now", lambda: CUTOFF)
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
    monkeypatch.setattr(research_models, "llm_settings", lambda: {
        "configured": True, "model": "gpt-6.1-sol", "reasoning_effort": "high",
    })
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {
        "account_tier": "paid", "allowed_models": [], "reasoning_efforts": {},
    })
    monkeypatch.setattr(research_models, "_discover", lambda _: ({"gpt-6.1-sol"}, "verified"))

    def bars(code, as_of, limit):
        assert (code, as_of, limit) == ("600519.SH", "2026-11-19", 180)
        return [
            {"trade_date": "2026-11-18", "close": 10.0, "volume": 100, "quality_valid": True},
            {"trade_date": "2026-11-19", "close": 10.5, "volume": 120, "quality_valid": True},
            {"trade_date": "2026-11-20", "close": 12.0, "volume": 200, "quality_valid": True},
        ]

    monkeypatch.setattr(market, "get_bars", bars)
    db.init_db()
    with db.connect() as connection:
        connection.executemany("INSERT INTO security_catalog VALUES(?,?,?,?,?,?)", [
            ("600519.SH", "测试股份", "", "", "SH", db.utc_now()),
            ("000001.SH", "上证指数", "", "", "指数", db.utc_now()),
        ])
    with TestClient(main.app) as client:
        yield client


def _reply(*, published_at=None):
    return {
        "buy": {"support": ["连续收盘价回升时，可以观察趋势能否延续。"], "oppose": ["只有两天数据，难以判断反弹是否持续。"]},
        "stop_loss": {"support": ["若持仓的风险超过原定上限，控制损失有依据。"], "oppose": ["短期波动本身不足以判断趋势已经改变。"]},
        "limitations": ["样本较短。"],
        "sources": [{"title": "原文", "url": SOURCE, "published_at": published_at}] if published_at else [],
    }


def _mock_runtime(monkeypatch, reply, *, opened=False):
    def run(conversation_id, turn_id):
        manifest = client_service_runtime.prepare(conversation_id, turn_id)
        assert manifest["profile"] == "stock-diagnosis"
        assert "支持和反对" in manifest["instructions"]
        prompt = client_service_runtime.prompt(conversation_id, turn_id, manifest["profile"])
        assert '"data_end":"2026-11-19"' in prompt
        assert '"close":12.0' not in prompt
        if opened:
            for sequence, action in enumerate([{"type": "search"}, {"type": "openPage", "url": SOURCE}]):
                codex_store.append_event(conversation_id, turn_id, "test-thread", "test-turn", sequence,
                                         "item/completed", {"item": {"type": "webSearch", "action": action}})
        return {
            "response": json.dumps(reply, ensure_ascii=False), "thread_id": "test-thread", "codex_turn_id": "test-turn",
            "event_count": 2 if opened else 0, "model": "gpt-6.1-sol", "reasoning_effort": "high",
        }
    monkeypatch.setattr(codex_runtime, "run_conversation_turn", run)


def test_diagnosis_queues_once_in_service_and_returns_both_views(diagnosis_client, monkeypatch):
    payload = {"request_id": "diagnosis-1", "code": "600519"}
    response = diagnosis_client.post(PATH, json=payload)
    assert response.status_code == 202
    queued = response.json()
    assert queued["code"] == "600519.SH"
    assert queued["data_date"] == "2026-11-19"
    assert queued["state"] == "awaiting_agent"
    replay = diagnosis_client.post(PATH, json={**payload, "code": " 600519.sh "})
    assert replay.status_code == 202 and replay.json() == queued
    assert diagnosis_client.post(PATH, json={**payload, "code": "000001"}).status_code == 409
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1

    reply = _reply(published_at="2026-11-20T13:00:00+08:00")
    _mock_runtime(monkeypatch, reply, opened=True)
    assert not worker.execute_job(client_service=False)
    assert worker.execute_job(client_service=True)
    result = diagnosis_client.get(PATH + "/diagnosis-1").json()
    assert result["state"] == "succeeded"
    assert result["buy"] == reply["buy"] and result["stop_loss"] == reply["stop_loss"]
    assert result["sources"] == reply["sources"]
    assert result["risk_disclosure"] == FIXED_DISCLOSURE["risk"]
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM jobs WHERE kind='research_pdf'").fetchone()[0] == 0
    assert diagnosis_client.get("/api/v1/conversations?exclude_intelligence=true").json()["items"] == []


@pytest.mark.parametrize("problem", ["missing_view", "unopened_source", "later_source"])
def test_diagnosis_blocks_incomplete_or_unverified_results(diagnosis_client, monkeypatch, problem):
    assert diagnosis_client.post(PATH, json={"request_id": "invalid-result", "code": "600519.SH"}).status_code == 202
    reply = _reply(published_at={"unopened_source": "2026-11-19", "later_source": "2026-11-20T14:01:00+08:00"}.get(problem))
    if problem == "missing_view":
        reply["stop_loss"].pop("oppose")
    _mock_runtime(monkeypatch, reply, opened=problem == "later_source")
    assert worker.execute_job(client_service=True)
    result = diagnosis_client.get(PATH + "/invalid-result").json()
    assert result["state"] == "failed"
    assert "buy" not in result and "stop_loss" not in result


def test_diagnosis_rejects_unknown_stocks_and_can_be_cancelled(diagnosis_client):
    for code in ("000001.SH", "999999"):
        assert diagnosis_client.post(PATH, json={"request_id": "not-a-stock", "code": code}).status_code == 404
    payload = {"request_id": "cancel-diagnosis", "code": "600519"}
    assert diagnosis_client.post(PATH, json=payload).status_code == 202
    cancelled = diagnosis_client.post(PATH + "/cancel-diagnosis/cancel")
    assert cancelled.status_code == 200 and cancelled.json()["state"] == "cancelled"
    assert diagnosis_client.post(PATH, json=payload).json()["state"] == "cancelled"
    assert not worker.execute_job(client_service=True)
