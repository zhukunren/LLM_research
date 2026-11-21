import base64
from datetime import date, datetime
from io import BytesIO
import json

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from apps.api.app import client_service_images, client_service_runtime, codex_runtime, codex_store, db, index_market, main, opening_plans, research_models, worker


PATH = "/api/v1/client-service/opening-plans"
PLAN_DATE = "2026-11-20"
BEFORE = "https://example.com/before"
AFTER = "https://example.com/after"
DATE_ONLY = "https://example.com/date-only"
UNOPENED = "https://example.com/unopened"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "opening-plans.db")
    monkeypatch.setattr(opening_plans, "now", lambda: datetime.fromisoformat("2026-11-20T16:00:00+08:00"))
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
    monkeypatch.setattr(research_models, "llm_settings", lambda: {
        "configured": True, "model": "gpt-6.1-sol", "reasoning_effort": "high",
    })
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {
        "account_tier": "paid", "allowed_models": [], "reasoning_efforts": {},
    })
    monkeypatch.setattr(research_models, "_discover", lambda _: ({"gpt-6.1-sol"}, "verified"))
    monkeypatch.setattr(index_market, "_read_cache", lambda: {"bars": [
        {"trade_date": "2026-11-18", "close": 3500, "source": "测试行情"},
        {"trade_date": "2026-11-19", "close": 3550, "source": "测试行情"},
        {"trade_date": "2026-11-20", "close": 3600, "source": "测试行情"},
    ]})
    with TestClient(main.app) as session:
        yield session


def mock_collection(monkeypatch, reply, *, opened=()):
    prompts = []

    def run(conversation_id, turn_id):
        manifest = client_service_runtime.prepare(conversation_id, turn_id)
        assert manifest["profile"] == "opening-plan"
        prompts.append(json.loads(client_service_runtime.prompt(conversation_id, turn_id, manifest["profile"])))
        if opened:
            actions = [{"type": "search"}, *({"type": "openPage", "url": url} for url in opened)]
            for sequence, action in enumerate(actions):
                codex_store.append_event(
                    conversation_id, turn_id, "test-thread", "test-turn", sequence,
                    "item/completed", {"item": {"type": "webSearch", "action": action}},
                )
        return {"response": json.dumps(reply, ensure_ascii=False), "thread_id": "test-thread",
                "codex_turn_id": "test-turn", "event_count": len(opened) + 1 if opened else 0,
                "model": "gpt-6.1-sol", "reasoning_effort": "high"}

    monkeypatch.setattr(codex_runtime, "run_conversation_turn", run)
    return prompts


def launch(client, day=PLAN_DATE, request_id="plan"):
    response = client.post(PATH, json={"request_id": request_id, "plan_date": day})
    assert response.status_code == 202, response.text
    return response.json()


def test_plan_freezes_preopen_data_and_only_accepts_supported_sections(client, monkeypatch):
    queued = launch(client)
    assert queued["state"] == "awaiting_agent"
    assert queued["cutoff"] == "2026-11-20T09:15:00+08:00"
    assert launch(client) == queued
    assert client.post(PATH, json={"request_id": "plan", "plan_date": "2026-11-23"}).status_code == 409
    prompts = mock_collection(monkeypatch, {
        "sections": {
            "overnight": {"text": "11月19日上证指数收于3550点，隔夜观察[市场原文](https://example.com/before)。",
                          "source_urls": [BEFORE], "uses_local_market": True},
            "judgment": {"text": "盘中观察量能变化。", "source_urls": [BEFORE]},
            "news": {"text": "盘前未知的消息。", "source_urls": [AFTER]},
            "ipo": {"text": "今日无新股。", "source_urls": [DATE_ONLY]},
            "direction_one": {"text": "只有摘要没有打开。", "source_urls": [BEFORE, UNOPENED]},
            "watch": {"text": "没有对应资料。"},
            "risk_control": {"text": "不能由模型设置仓位。", "uses_local_market": True},
        },
        "sources": [
            {"title": "隔夜市场原文", "url": BEFORE, "published_at": "2026-11-20T08:58:00+08:00"},
            {"title": "盘后文章", "url": AFTER, "published_at": "2026-11-20T09:16:00+08:00"},
            {"title": "只有日期的当日资料", "url": DATE_ONLY, "published_at": PLAN_DATE},
            {"title": "搜索摘要", "url": UNOPENED, "published_at": "2026-11-19"},
        ],
    }, opened=(BEFORE, AFTER, DATE_ONLY))
    assert not worker.execute_job(client_service=False)
    assert worker.execute_job(client_service=True)
    assert prompts[0]["A股已完成日线日期上限"] == "2026-11-19"
    assert prompts[0]["本地上证指数"]["close"] == "3550.00"
    result = client.get(PATH + "/plan").json()
    assert result["state"] == "succeeded"
    assert result["sections"] == {
        "overnight": "11月19日上证指数收于3550点，隔夜观察市场原文。",
        "judgment": "盘中观察量能变化。",
    }
    assert [source["url"] for source in result["sources"]] == [BEFORE]
    assert result["market"]["trade_date"] == "2026-11-19"
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1


@pytest.mark.parametrize("hour,trade_date", [(14, "2026-11-19"), (16, "2026-11-20")])
def test_future_plan_uses_only_already_closed_sessions(client, monkeypatch, hour, trade_date):
    clock = datetime.fromisoformat(f"2026-11-20T{hour}:00:00+08:00")
    monkeypatch.setattr(opening_plans, "now", lambda: clock)
    queued = launch(client, "2026-11-23")
    assert queued["cutoff"] == clock.isoformat()
    prompts = mock_collection(monkeypatch, {"sections": {}, "sources": []})
    assert worker.execute_job(client_service=True)
    result = client.get(PATH + "/plan").json()
    assert prompts[0]["本地上证指数"]["trade_date"] == trade_date
    assert result["state"] == "succeeded"
    assert result["sections"]["overnight"].startswith(trade_date)
    assert result["sources"] == []


def test_missing_data_and_cancellation_preserve_the_manual_template_path(client, monkeypatch):
    monkeypatch.setattr(index_market, "_read_cache", lambda: {})
    assert client.post(PATH, json={"plan_date": date.min.isoformat(), "request_id": "invalid"}).status_code == 422
    launch(client)
    mock_collection(monkeypatch, {"sections": {"overnight": {"text": "缺少行情。", "uses_local_market": True}}})
    assert worker.execute_job(client_service=True)
    result = client.get(PATH + "/plan").json()
    assert result["state"] == "no_evidence" and "sections" not in result
    launch(client, request_id="to-stop")
    assert client.post(PATH + "/to-stop/cancel").json()["state"] == "cancelled"
    assert launch(client, request_id="to-stop")["state"] == "cancelled"


def test_incomplete_collection_can_still_use_frozen_market_data(client, monkeypatch):
    launch(client)

    def timed_out(*_):
        raise codex_runtime.CodexRuntimeError("本回合已达到研究时间预算")

    monkeypatch.setattr(codex_runtime, "run_conversation_turn", timed_out)
    assert worker.execute_job(client_service=True)
    result = client.get(PATH + "/plan").json()
    assert result["state"] == "partial" and result["sources"] == []
    assert result["sections"] == {"overnight": "2026-11-19上证指数收于3550.00点。"}


def test_saved_day_and_default_template_have_independent_versions(client):
    editor = PATH + "/editor/" + PLAN_DATE
    initial = client.get(editor).json()
    assert initial["saved"] is None
    assert initial["template"]["content"]["theme"] == "soochow"
    template = {"revision": 0, "content": {"theme": "jade", "sections": {"risk_control": "盘中重新检查仓位。"}}}
    assert client.put(PATH + "/template", json=template).status_code == 200
    launch(client)
    entry = {"revision": 0, "content": {"theme": "gold", "sections": {"judgment": "当天的判断。"}},
             "collection_request_id": "plan"}
    assert client.put(PATH + "/editor/2026-11-23", json=entry).status_code == 422
    saved = client.put(editor, json=entry)
    assert saved.status_code == 200
    assert client.put(editor, json=entry).status_code == 409
    assert client.put(PATH + "/template", json={**template, "revision": 1, "content": {"theme": "ocean"}}).status_code == 200
    assert client.get(editor).json()["saved"] == saved.json()
    future = client.get(PATH + "/editor/2026-11-23").json()
    assert future["saved"] is None
    assert future["template"]["content"] == {"theme": "ocean", "sections": {}}


def test_opening_plan_image_uses_dedicated_art_and_keeps_long_sections_editable(client):
    content = {"plan_date": PLAN_DATE, "sections": {
        "judgment": "参考[公开公告](https://example.com/market)核对盘面。" * 26,
        "direction_one": "等待观察，满足条件后再判断。",
        "risk_control": "仅为版式测试。",
    }}
    draft = client.post(PATH + "/preview?draft=true", json=content)
    assert draft.status_code == 200, draft.text[:250]
    value = draft.json()
    assert value["draft"] is True
    image = Image.open(BytesIO(base64.b64decode(value["image"].split(",", 1)[1])))
    assert image.size == (1080, value["height"])
    assert image.height > 1660
    assert {region["key"] for region in value["regions"]} == set(content["sections"])
    assert all(region["y"] + region["height"] < image.height for region in value["regions"])
    area = (740, 178, 1080, 330)
    assert image.crop(area).tobytes() == client_service_images.themed_masthead("soochow", "opening-plan").crop(area).tobytes()
    assert image.crop(area).tobytes() != client_service_images.themed_masthead("soochow", "opening").crop(area).tobytes()
    clean = {**content, "sections": {**content["sections"], "judgment": "参考公开公告核对盘面。" * 26}}
    assert client.post(PATH + "/preview?draft=true", json=clean).json()["image_hash"] == value["image_hash"]
    assert client.post(PATH + "/preview", json=clean).json()["image_hash"] != value["image_hash"]
