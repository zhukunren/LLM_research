import base64
from datetime import datetime
from io import BytesIO
import json

from fastapi.testclient import TestClient
from PIL import Image, ImageColor
import pytest

from apps.api.app import client_service_images, client_service_runtime, codex_runtime, codex_store, db, main, rebalance_card, rebalance_quotes, rebalance_suggestions, research_models, worker


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
    monkeypatch.setattr(research_models, "_discover", lambda _: ({"gpt-6.1-sol", "gpt-6.2-astra", "gpt-6.2-sol"}, "verified"))
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {
        "account_tier": "paid", "allowed_models": [], "reasoning_efforts": {},
    })
    monkeypatch.setattr(rebalance_suggestions, "daily_context", lambda *_: None)
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


@pytest.mark.parametrize("mode,model,effort,tier", [
    ("instant", "gpt-6.2-astra", "low", "fast"),
    ("deep", "gpt-6.2-sol", "max", "default"),
])
def test_freezes_the_selected_mode_and_supports_a_reason_without_a_report(client, monkeypatch, mode, model, effort, tier):
    body = {"request_id": "mode-sample", "code": CODE, "direction": "开仓买入", "mode": mode}
    assert client.post(PATH, json=body).status_code == 202
    assert client.post(PATH, json={**body, "mode": "deep" if mode == "instant" else "instant"}).status_code == 409
    with db.connect() as connection:
        saved = connection.execute("""SELECT s.conversation_id,s.turn_id,t.model_id,t.reasoning_effort,s.service_tier
            FROM client_rebalance_suggestions s JOIN conversation_turns t ON t.id=s.turn_id""").fetchone()
    assert tuple(saved)[2:] == (model, effort, tier)
    assert client_service_runtime.prepare(saved["conversation_id"], saved["turn_id"])["service_tier"] == tier
    mock_collection(monkeypatch, {"reason": "若后续经营数据支持原有判断，再考虑这次调整。"})
    assert worker.execute_job(client_service=True)
    result = client.get(PATH + "/mode-sample").json()
    assert result["state"] == "succeeded" and result["report"] is None and result["basis"] == ""


def test_public_disclosure_becomes_evidence_without_a_broker_report(client, monkeypatch):
    enqueue(client)
    mock_collection(monkeypatch, {
        "reason": "公司公告中的经营变化可作为本次观察的依据。",
        "sources": [{"title": "公司经营公告", "url": WEB_REPORT, "published_at": "2026-11-19", "quote": QUOTE}],
    }, opened=True)
    assert worker.execute_job(client_service=True)
    result = client.get(PATH + "/sample").json()
    assert result["state"] == "succeeded" and result["report"] is None
    assert result["sources"][0]["url"] == WEB_REPORT
    assert result["basis"] == "参考资料：《公司经营公告》（2026-11-19）"
    assert WEB_REPORT not in result["reason"] and WEB_REPORT not in result["basis"]


def test_quote_uses_the_correct_ticker_and_reports_the_actual_price_time(client, monkeypatch):
    tick = [""] * 31
    tick[2], tick[3], tick[30] = "603650", "46.70", "20261120103030"
    monkeypatch.setattr(rebalance_quotes, "now", lambda: datetime.fromisoformat("2026-11-20T10:31:00+08:00"))
    monkeypatch.setattr(rebalance_quotes, "tencent_quote_rows", lambda symbols: {symbols[0]: tick})
    response = client.get(PATH + "/quote", params={"code": "603650"})
    assert response.status_code == 200
    assert response.json() == {"code": CODE, "price": "46.70", "kind": "live", "source": "腾讯行情",
                               "observed_at": "2026-11-20T10:30:30+08:00"}
    tick[2] = "600519"
    monkeypatch.setattr(rebalance_quotes, "daily_context", lambda *_: {"trade_date": "2026-11-19", "close": "45.60"})
    fallback = client.get(PATH + "/quote", params={"code": CODE}).json()
    assert fallback["kind"] == "close" and fallback["price"] == "45.60" and fallback["source"] == "本地日线"
    tick[2], tick[30] = "603650", "20261118150000"
    assert client.get(PATH + "/quote", params={"code": CODE}).json() == fallback


def test_rebalance_preview_changes_background_and_exposes_editable_regions(client):
    for theme in client_service_images.THEMES:
        path = rebalance_card.rebalance_artwork_path(theme)
        assert path.parent.name == "rebalance-themes" and path.is_file()
        assert path != client_service_images.artwork_path(theme)
        with Image.open(path) as illustration:
            assert illustration.width >= 1080 and illustration.width / illustration.height > 2.4
    draft = {"theme": "river", "product": "丰收成长尊享", "code": CODE, "name": "样例股份", "direction": "开仓买入",
             "before": "0%", "after": "5", "price": "46.70", "reason": "阅读[公告](https://example.com/report)。"}
    first = client.post(PATH + "/preview", json=draft)
    assert first.status_code == 200, first.text[:300]
    value = first.json()
    first_row = next(region for region in value["regions"] if region["key"] == "name")
    with Image.open(BytesIO(base64.b64decode(value["image"].split(",", 1)[1]))) as image:
        assert image.size == (value["width"], value["height"])
        assert image.getpixel((0, first_row["y"] - 35)) == ImageColor.getrgb(client_service_images.THEMES["river"]["paper"])
    assert {region["key"] for region in value["regions"]} == {"product", "name", "code", "direction", "before", "after", "price", "reason"}
    assert client.post(PATH + "/preview", json={**draft, "reason": "阅读公告。"}).json()["image_hash"] == value["image_hash"]
    assert client.post(PATH + "/preview", json={**draft, "theme": "jade"}).json()["image_hash"] != value["image_hash"]
