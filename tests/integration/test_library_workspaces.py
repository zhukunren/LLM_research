import pytest
from fastapi.testclient import TestClient

from apps.api.app import condition_language, db, main, market, pattern_language, worker


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "libraries.db")
    monkeypatch.setattr(condition_language, "llm_settings", lambda: {"configured": False})
    monkeypatch.setattr(pattern_language, "llm_settings", lambda: {"configured": False})
    with TestClient(main.app) as client:
        yield client


def test_library_drafts_are_separate_and_conditions_can_be_combined(client):
    technical = client.post("/api/v1/condition-drafts", json={"library": "technical", "prompt": "RSI14小于30"}).json()
    news = client.post("/api/v1/condition-drafts", json={"library": "news", "prompt": "近30个自然日资讯包含“回购”"}).json()
    assert technical["status"] == news["status"] == "ready"
    assert [d["id"] for d in client.get("/api/v1/condition-drafts?library=news").json()["items"]] == [news["id"]]
    assert [d["id"] for d in client.get("/api/v1/condition-drafts?library=technical").json()["items"]] == [technical["id"]]
    saved = [client.post(f"/api/v1/condition-drafts/{draft['id']}/confirm", json={}).json() for draft in [technical, news]]
    assert saved[1]["filters"][0]["library"] == "news"
    assert saved[1]["filters"][0]["contract"]["availability"] == "unavailable"
    response = client.post("/api/v1/strategies", json={"name": "跨库组合", "tree": {"op": "all", "children": [value["tree"] for value in saved]}})
    assert response.status_code == 200
    assert len(response.json()["tree"]["children"]) == 2
    conflict = client.post("/api/v1/condition-drafts", json={"library": "news", "previous_draft_id": technical["id"], "prompt": "近30个自然日资讯包含“回购”"})
    assert conflict.status_code == 422


def test_existing_unscoped_single_library_drafts_remain_available(client):
    legacy = client.post("/api/v1/condition-drafts", json={"prompt": "RSI14小于30"}).json()
    assert legacy["id"] in {d["id"] for d in client.get("/api/v1/condition-drafts?library=technical").json()["items"]}
    assert client.get("/api/v1/condition-drafts?library=report").json()["items"] == []
    refined = client.post("/api/v1/condition-drafts", json={"library": "technical", "prompt": "RSI14小于40", "previous_draft_id": legacy["id"]})
    assert refined.status_code == 200
    assert refined.json()["original_prompt"] == legacy["prompt"]


def test_report_context_preserves_verified_origin_without_requiring_report_keyword(client, monkeypatch):
    prompt = "公司订单实际增长"
    captured = []
    def completion(instructions, text, **kwargs):
        captured.append(instructions)
        return {"conditions": [{"key": "c1", "name": "订单增长", "library": "report", "source_quote": prompt,
            "expression": {"op": "evidence_query", "evaluation_mode": "rubric", "combine": "all", "lookback_calendar_days": 365,
                "criteria": [{"id": "orders", "label": "订单增长", "question": "是否有实际订单增长证据？", "signals": ["实际新增订单"], "counter_signals": ["订单下降"]}]}}],
            "tree": {"op": "condition", "key": "c1"}, "issues": [], "assumptions": []}
    monkeypatch.setattr(condition_language, "llm_settings", lambda: {"configured": True, "model": "fixture"})
    monkeypatch.setattr(condition_language, "complete_json", completion)
    with db.connect() as connection:
        connection.execute("INSERT INTO documents(id,sha256,filename,title,pages,extracted_chars,parse_status,source_path,imported_at) VALUES('source','hash','source.pdf','来源研报',1,20,'indexed','fixture',?)", (db.utc_now(),))
        connection.execute("INSERT INTO document_pages VALUES('source',1,'公司披露订单增长。')")
    response = client.post("/api/v1/condition-drafts", json={"library": "report", "prompt": prompt, "source_document_id": "source", "source_page": 1})
    assert response.status_code == 200
    draft = response.json()
    assert draft["status"] == "ready"
    assert "用户已明确选择以研报为依据" in captured[0]
    saved = client.post(f"/api/v1/condition-drafts/{draft['id']}/confirm", json={}).json()
    assert saved["filters"][0]["provenance"]["source_document"] == {"document_id": "source", "title": "来源研报", "sha256": "hash", "page": 1}
    invalid = client.post("/api/v1/condition-drafts", json={"library": "report", "prompt": prompt, "source_document_id": "source", "source_page": 2})
    assert invalid.status_code == 404


def test_model_cannot_silently_file_a_condition_into_another_library(client, monkeypatch):
    candidate = condition_language.local_plan("RSI14小于30")
    monkeypatch.setattr(condition_language, "llm_settings", lambda: {"configured": True, "model": "fixture"})
    monkeypatch.setattr(condition_language, "complete_json", lambda *a, **k: candidate)
    draft = client.post("/api/v1/condition-drafts", json={"library": "report", "prompt": "RSI14小于30"}).json()
    assert draft["status"] == "needs_clarification"
    assert "其他资料库" in draft["issues"][0]["text"]


def test_literal_news_keywords_are_not_mistaken_for_unavailable_numeric_fields(client):
    draft = client.post("/api/v1/condition-drafts", json={"library": "news", "prompt": "近30个自然日资讯包含“市值管理”"}).json()
    assert draft["status"] == "ready"
    assert draft["conditions"][0]["expression"]["terms"] == ["市值管理"]


def test_forecasts_cannot_replace_explicit_actual_results_in_a_report_plan(client, monkeypatch):
    prompt = "主营收入实际增长，区分已实现业绩和未来预测"
    monkeypatch.setattr(condition_language, "llm_settings", lambda: {"configured": True, "model": "fixture"})
    monkeypatch.setattr(condition_language, "complete_json", lambda *a, **k: {"conditions": [{"key": "c1", "name": "收入", "library": "report", "source_quote": prompt, "expression": {"op": "evidence_query", "evaluation_mode": "rubric", "combine": "any", "lookback_calendar_days": 365, "criteria": [{"id": "actual", "label": "实际收入增长", "question": "实际收入是否增长？"}, {"id": "forecast", "label": "未来预测", "question": "是否存在未来收入预测？"}]}}], "tree": {"op": "condition", "key": "c1"}, "issues": [], "assumptions": []})
    draft = client.post("/api/v1/condition-drafts", json={"library": "report", "prompt": prompt}).json()
    assert draft["status"] == "needs_clarification"
    assert "不能用“任一满足”" in draft["issues"][0]["text"]
    assert client.post(f"/api/v1/condition-drafts/{draft['id']}/confirm", json={}).status_code == 422


def test_indicator_browser_receives_real_dated_series_and_missing_values(client, monkeypatch):
    bars = [{"trade_date": f"2026-09-{day:02}", "close": value, "quality_valid": day != 14} for day, value in [(12, 10.), (13, 12.), (14, 14.)]]
    monkeypatch.setattr(market, "get_bars", lambda *_: bars)
    result = client.post("/api/v1/indicators/preview", json={"stock_code": "600000.SH", "indicator": "sma", "window": 2, "as_of": "2026-09-14"}).json()
    assert result["series"] == [{"date": "2026-09-12", "value": None}, {"date": "2026-09-13", "value": 11.}, {"date": "2026-09-14", "value": None}]
    assert result["current"] is None
    assert result["chart"]["placement"] == "overlay"
    assert result["chart"]["lines"][0]["id"] == "sma"


def test_indicator_preview_classifies_overlay_and_sub_chart_indicators(client, monkeypatch):
    bars = [{"trade_date": f"2026-09-{day:02}", "open": float(day), "high": float(day + 2),
             "low": float(day - 1), "close": float(day + 1), "volume": 100.0, "quality_valid": True}
            for day in range(1, 41)]
    monkeypatch.setattr(market, "get_bars", lambda *_: bars)
    rsi = client.post("/api/v1/indicators/preview", json={"stock_code": "600000.SH", "indicator": "rsi", "window": 14, "as_of": "2026-09-14"}).json()
    macd = client.post("/api/v1/indicators/preview", json={"stock_code": "600000.SH", "indicator": "macd_hist", "window": 9, "as_of": "2026-09-14"}).json()
    bollinger = client.post("/api/v1/indicators/preview", json={"stock_code": "600000.SH", "indicator": "bollinger", "window": 20, "as_of": "2026-09-14"}).json()
    assert rsi["chart"]["placement"] == "pane"
    assert rsi["chart"]["reference_lines"] == [30, 70]
    assert [line["id"] for line in macd["chart"]["lines"]] == ["macd_dif", "macd_dea"]
    assert macd["chart"]["histogram"]["id"] == "macd_hist"
    assert [line["id"] for line in bollinger["chart"]["lines"]] == ["bollinger_upper", "bollinger_middle", "bollinger_lower"]


def test_natural_language_shape_can_be_confirmed_and_referenced_as_condition(client):
    draft = client.post("/api/v1/patterns/draft", json={"prompt": "近30个交易日的双底形态，相似度不低于85%"}).json()
    assert draft["status"] == "ready"
    assert draft["shape"] == "double_bottom"
    assert len(draft["points"]) == 30
    assert draft["min_similarity"] == 85
    saved = client.post("/api/v1/patterns", json={"name": draft["name"], "input_type": "natural_language", "source_draft_id": draft["id"], "representation": "price_path", "target_bars": 30, "points": draft["points"], "params": {"min_similarity": 85}})
    assert saved.status_code == 200, saved.text
    pattern = saved.json()
    assert pattern["provenance"]["prompt"] == draft["prompt"]
    strategy = client.post("/api/v1/strategies", json={"name": "文字形态组合", "tree": {"op": "pattern_ref", "pattern_id": pattern["id"], "version": 1, "min_similarity": 85}})
    assert strategy.status_code == 200
    assert client.get("/api/v1/patterns").json()["items"][0]["provenance"]["draft_id"] == draft["id"]
    bars = [{"close": 100 + value * 10, "trade_date": f"2026-08-{i+1:02}", "quality_valid": True} for i, value in enumerate(draft["points"])]
    state, details, _ = worker._eval_tree({"op": "pattern_ref", "pattern_id": pattern["id"], "version": 1, "min_similarity": 85}, "600000.SH", bars, {}, {(pattern["id"], 1): pattern}, {})
    assert state == "true"
    assert details[0]["provenance"]["original_prompt"] == draft["prompt"]
    assert details[0]["threshold"] == 85


@pytest.mark.parametrize("prompt", ["近5个交易日的双底", "近30个交易日的双底形态，相似度不低于101%", "近40个交易日的头肩顶", "近30个交易日双底而且放量突破颈线"])
def test_unexpressible_shapes_are_not_silently_replaced_by_templates(client, prompt):
    draft = client.post("/api/v1/patterns/draft", json={"prompt": prompt}).json()
    assert draft["status"] == "needs_clarification"
    assert draft["points"] == []
    assert draft["issues"]


def test_shape_missing_origin_or_invalid_similarity_cannot_be_saved(client):
    payload = {"name": "未确认形态", "input_type": "natural_language", "representation": "price_path", "target_bars": 10, "points": [i / 9 for i in range(10)]}
    assert client.post("/api/v1/patterns", json=payload).status_code == 422
    assert client.post("/api/v1/patterns", json={**payload, "input_type": "drawing", "params": {"min_similarity": 101}}).status_code == 422
