from datetime import datetime
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
import pytest

from apps.api.app import (codex_runtime, codex_store, conversation_store, db, intelligence,
                          jobs, main, market, research_models, screening_tools)
from apps.api.app.intelligence_contracts import PublishBrief, StartBrief


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "intelligence.db")
    monkeypatch.setattr(market, "STOCK_FILE", tmp_path / "missing.parquet")
    monkeypatch.setattr(intelligence, "research_web_search_mode", lambda: "live")
    monkeypatch.setattr(intelligence, "now", lambda: datetime.fromisoformat("2026-10-20T10:00:00+08:00"))
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
    monkeypatch.setattr(research_models, "llm_settings", lambda: {"model": "gpt-6-luna", "reasoning_effort": "high", "configured": True})
    monkeypatch.setattr(research_models, "research_model_settings", lambda: {"account_tier": "free", "allowed_models": [], "reasoning_efforts": {}})
    monkeypatch.setattr(research_models, "_discover", lambda settings: ({"gpt-6-luna"}, "verified"))
    with TestClient(main.app) as session:
        yield session


def start(client, request="brief-1", **extra):
    response = client.post("/api/v1/intelligence/runs", json={"request_id": request, **extra})
    assert response.status_code == 202, response.text
    return response.json()


def running(run):
    turn = conversation_store.get_turn(run["conversation_id"], run["turn_id"])
    lease = jobs.claim(turn["job"]["id"])
    conversation_store.start_turn(run["conversation_id"], run["turn_id"])
    return SimpleNamespace(conversation_id=run["conversation_id"], turn_id=run["turn_id"]), lease


def source(run, source_id="source-1", published="2026-10-20T08:00:00+08:00"):
    with db.connect() as connection:
        connection.execute("""INSERT INTO intelligence_sources(id,run_id,url,title,text,sha256,retrieved_at,publisher_date)
            VALUES(?,?,?,?,?,?,?,?)""", (source_id, run["id"], "https://example.com/" + source_id, "公司正式公告",
                "2026年10月20日\n公司公告：本期新增订单已完成签署，交付将在下一季度开始。\n另一项资料仍需核对。", "test-hash", db.utc_now(), published))


def deliverable(source_id="source-1", **changes):
    payload = {
        "title": "市场简报：订单与交付变化", "summary": "已核对订单公告，交付节奏仍需进一步跟踪。",
        "coverage": "检索公司公开公告并读取保存的正式原文；未覆盖全部市场。",
        "items": [{
            "event_key": "company-order-contract", "title": "公司签署新增订单", "event_date": "2026-10-20",
            "facts": "本期新增订单已经签署，交付将在下一季度开始。",
            "analysis": "交付安排可能影响收入确认节奏，仍需核对后续披露。",
            "ranking_reason": "订单已签署，有原始公告支持。", "next_check": "核对后续交付和回款披露。",
            "evidence": [{"source_id": source_id, "quote": "本期新增订单已完成签署，交付将在下一季度开始。"}],
        }],
    }
    payload.update(changes)
    return PublishBrief.model_validate(payload)


def test_opening_desk_does_not_launch_and_input_freezes(client):
    result = client.get("/api/v1/intelligence").json()
    assert result["total"] == 0 and result["items"] == []
    with db.connect() as connection:
        assert connection.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0
    run = start(client, scope={"markets": ["US", "CN"], "lookback_hours": 72, "industries": ["半导体"]})
    assert run["state"] == "queued" and run["scope"]["markets"] == ["CN", "US"]
    assert run["cutoff_at"] == "2026-10-20T10:00:00+08:00"
    assert run["window_start"] == "2026-10-17T10:00:00+08:00"
    assert "publish_intelligence_brief" in conversation_store.get_conversation(run["conversation_id"])["messages"][0]["content"]
    assert client.get("/api/v1/intelligence").json()["default_scope"] == run["scope"]
    assert client.get(f"/api/v1/intelligence/runs/{run['id']}").json()["result"] is None
    assert client.get("/api/v1/conversations?exclude_intelligence=true").json()["items"] == []
    task = client.get("/api/v1/tasks").json()["items"][0]
    assert task["destination"] == {"kind": "intelligence", "brief_id": run["id"], "brief_kind": "market"}
    assert "执行契约" not in task["title"]


def test_concurrent_submit_is_one_intent_and_conflicting_retry_rejected(client):
    payload = StartBrief(request_id="same-request")
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: intelligence.start(payload), range(4)))
    assert len({run["id"] for run in results}) == 1
    assert client.post("/api/v1/intelligence/runs", json={"request_id": "same-request", "scope": {"lookback_hours": 168}}).status_code == 409
    with db.connect() as connection:
        assert connection.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1


def test_result_requires_real_quotes_and_keeps_immutable_history(client):
    run = start(client)
    context, lease = running(run)
    source(run)
    bad = deliverable()
    bad.items[0].evidence[0].quote = "原文并没有这段文字，但是模型想把它作为证据保存。"
    with pytest.raises(intelligence.IntelligenceError, match="引用未能定位"):
        intelligence.publish(bad, context)
    assert intelligence.detail(run["id"])["result"] is None
    published = intelligence.publish(deliverable(), context)
    assert published["state"] == "succeeded"
    saved = intelligence.detail(run["id"])
    evidence = saved["result"]["items"][0]["evidence"][0]
    assert evidence["quote_verified"] and evidence["time_status"] == "within_window"
    snapshot = client.get(f"/api/v1/intelligence/runs/{run['id']}/evidence/source-1").json()
    assert snapshot["text"][evidence["quote_start"]:evidence["quote_end"]] == evidence["quote"]
    assert intelligence.publish(deliverable(), context)["idempotent_replay"]
    with pytest.raises(intelligence.IntelligenceError, match="不能覆盖"):
        intelligence.publish(deliverable(summary="这是一段内容不同的总结，不能覆盖已保存版本。"), context)
    conversation_store.finish_turn(context.conversation_id, context.turn_id, 0, "succeeded", "成果已保存", {})
    lease.finish("succeeded", "完成")
    next_run = start(client, "next")
    assert next_run["previous_id"] == run["id"] and next_run["version"] == 2
    next_context, _ = running(next_run)
    source(next_run, "source-2")
    intelligence.publish(deliverable("source-2"), next_context)
    assert intelligence.detail(next_run["id"])["result"]["items"][0]["change"] == "unchanged"
    assert intelligence.detail(run["id"])["result"] == saved["result"]
    export = client.get(f"/api/v1/intelligence/runs/{run['id']}/export")
    assert export.status_code == 200 and "公司正式公告" in export.text and "V1" in export.text


def test_sources_bound_to_run_and_future_material_rejected(client):
    first, second = start(client), start(client, "another")
    context, _ = running(second)
    source(first)
    with pytest.raises(intelligence.IntelligenceError, match="本次执行"):
        intelligence.publish(deliverable(), context)
    source(second, "future-source", "2026-10-20T11:00:00+08:00")
    with pytest.raises(intelligence.IntelligenceError, match="晚于"):
        intelligence.publish(deliverable("future-source"), context)
    assert client.get(f"/api/v1/intelligence/runs/{second['id']}/evidence/source-1").status_code == 404


def test_date_only_remains_partial_and_missing_output_not_success(client):
    run = start(client)
    context, _ = running(run)
    with pytest.raises(intelligence.IntelligenceError, match="结构化成果"):
        intelligence.require_deliverable(context.conversation_id, context.turn_id)
    source(run, published="2026-10-20")
    intelligence.publish(deliverable(), context)
    saved = intelligence.detail(run["id"])
    assert saved["state"] == "partial" and saved["result"]["items"][0]["verification"] == "time_pending"


def test_no_updates_requires_a_successful_read_or_search_and_actual_progress(client):
    run = start(client)
    context, _ = running(run)
    empty = deliverable(items=[], no_updates_reason="按已确认范围检索后，没有发现能由可靠原文支持的实质更新。")
    with pytest.raises(intelligence.IntelligenceError, match="未记录成功"):
        intelligence.publish(empty, context)
    codex_store.append_event(context.conversation_id, context.turn_id, "thread", "turn", 1, "item/completed",
                             {"item": {"type": "webSearch", "action": {"type": "search"}}})
    detail = intelligence.detail(run["id"])
    assert detail["search_count"] == 1 and any("已完成一次" in event["message"] for event in detail["activity"])
    intelligence.publish(empty, context)
    assert intelligence.detail(run["id"])["result"]["items"] == []


def test_unavailable_runtime_can_resume_original_cutoff_and_cancel(client, monkeypatch):
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": False, "reason": "模型服务暂不可用"})
    run = start(client)
    assert run["state"] == "blocked" and run["error"]
    monkeypatch.setattr(codex_runtime, "availability", lambda: {"available": True})
    resumed = client.post(f"/api/v1/intelligence/runs/{run['id']}/resume").json()
    assert resumed["state"] == "queued" and resumed["cutoff_at"] == run["cutoff_at"]
    stopped = client.post(f"/api/v1/intelligence/runs/{run['id']}/cancel").json()
    assert stopped["state"] == "cancelled"
    retry = start(client, "retry", retry_of=run["id"], scope=run["scope"])
    assert retry["cutoff_at"] == run["cutoff_at"] and retry["retry_of"] == run["id"]


def test_range_validation_and_schema(client):
    assert client.post("/api/v1/intelligence/runs", json={"request_id": "bad", "cutoff_at": "2026-10-20T11:00:00+08:00"}).status_code == 422
    assert client.post("/api/v1/intelligence/runs", json={"request_id": "bad", "scope": {"markets": []}}).status_code == 422
    assert client.post("/api/v1/intelligence/runs", json={"request_id": "bad", "cutoff_at": "2026-10-20T09:00:00"}).status_code == 422
    schema = next(tool.input_schema for tool in screening_tools.registry.tools_for_codex() if tool.name == "publish_intelligence_brief")
    assert "items" in schema["properties"]


def test_capture_freezes_server_read_text_and_rejects_changed_quotes(client, monkeypatch, tmp_path):
    from apps.api.app import research_external
    from apps.api.app.intelligence_contracts import CaptureBriefSource, ReadBriefSource
    run = start(client)
    context, _ = running(run)
    original = tmp_path / "original.txt"
    original.write_text("公司公告：本期新增订单已完成签署，交付将在下一季度开始。这是实际保存的来源正文。", encoding="utf-8")
    monkeypatch.setattr(research_external, "capture_page", lambda *args: {
        "url": "https://example.com/original", "title": "实际原文", "text_path": str(original),
        "publisher_declared_date": "2026-10-20T08:00:00+08:00", "retrieved_at": db.utc_now()})
    monkeypatch.setattr(research_external, "_source_file", lambda context, path: original)
    captured = intelligence._capture_source(CaptureBriefSource(url="https://example.com/original"), context)
    original.write_text("外部缓存随后发生修改，不应改变成果证据。", encoding="utf-8")
    chunk = intelligence.read_source(ReadBriefSource(source_id=captured["source_id"]), context)
    assert "本期新增订单已完成签署" in chunk["text"]
    intelligence.publish(deliverable(captured["source_id"]), context)
    assert "本期新增订单已完成签署" in intelligence.evidence(run["id"], captured["source_id"])["text"]


def test_another_workspace_cannot_read_or_retry_a_brief(client, tmp_path):
    from apps.api.app.security_context import ActorContext, actor_scope
    from apps.api.app.storage import storage_paths
    from dataclasses import asdict
    run = start(client)
    paths = storage_paths(project_root=tmp_path, database_path=tmp_path / "different.db")
    with actor_scope(ActorContext("different-user", "different-tenant", workspace={key: str(value) for key, value in asdict(paths).items()})):
        db.init_db()
        with pytest.raises(intelligence.IntelligenceError) as missing:
            intelligence.detail(run["id"])
        assert missing.value.status == 404
        with pytest.raises(intelligence.IntelligenceError):
            intelligence.start(StartBrief(request_id="other-user", retry_of=run["id"]))
        assert intelligence.list_runs()["items"] == []


def test_source_capture_runs_in_data_worker_and_remains_bound_to_turn(client, monkeypatch, tmp_path):
    from threading import Thread
    from time import sleep
    from apps.api.app import research_external, worker
    from apps.api.app.intelligence_contracts import CaptureBriefSource
    run = start(client)
    context, _ = running(run)
    original = tmp_path / "worker-original.txt"
    original.write_text("公司公告：本期新增订单已完成签署，交付将在下一季度开始。这是后台实际保存的完整来源正文。", encoding="utf-8")
    monkeypatch.setattr(research_external, "capture_page", lambda *args: {
        "url": "https://example.com/data-worker", "title": "后台读取的原文", "text_path": str(original),
        "publisher_declared_date": "2026-10-20T08:00:00+08:00", "retrieved_at": db.utc_now()})
    monkeypatch.setattr(research_external, "_source_file", lambda context, path: original)
    def consume():
        for _ in range(80):
            if worker.execute_job(kinds=("intelligence_source",)):
                return
            sleep(.05)
    reader = Thread(target=consume)
    reader.start()
    result = intelligence.capture_source(CaptureBriefSource(url="https://example.com/data-worker"), context)
    reader.join(timeout=5)
    assert result["source_id"] and "后台实际保存" in result["text"]
    with db.connect() as connection:
        assert connection.execute("SELECT state FROM jobs WHERE kind='intelligence_source'").fetchone()[0] == "succeeded"
    assert all(item["kind"] != "intelligence_source" for item in client.get("/api/v1/tasks").json()["items"])


def test_staged_schema_without_publication_column_upgrades_without_losing_history(client):
    run = start(client)
    with db.connect() as connection:
        connection.execute("ALTER TABLE intelligence_sources DROP COLUMN publisher_date")
        connection.execute("DELETE FROM schema_migrations WHERE version='044_intelligence_source_publication.sql'")
    db.init_db()
    db.init_db()
    with db.connect() as connection:
        assert "publisher_date" in {row[1] for row in connection.execute("PRAGMA table_info(intelligence_sources)")}
    assert intelligence.detail(run["id"])["cutoff_at"] == run["cutoff_at"]


def advisor_run(client, kind="stock-analysis", request="advisor-1", **advisor):
    with db.connect() as connection:
        connection.execute("INSERT OR IGNORE INTO security_catalog VALUES('600519.SH','贵州茅台','','','SH',?)", (db.utc_now(),))
    scope = {"stock_code": "600519.SH", **advisor}
    if kind == "closing":
        scope.pop("stock_code", None)
    return start(client, request, kind=kind, scope={"advisor": scope, "max_items": 5})


def advisor_result(stock_code="600519.SH", verdict="conditional", **changes):
    value = {
        "stock_code": stock_code, "verdict": verdict, "conclusion": "目前的证据支持继续研究，须核对后续经营兑现后再判断行动。",
        "effective_date": "2026-10-20",
        "supporting_points": [{"title": "订单具备原始依据", "explanation": "已签署订单提供了经营线索，收入兑现仍需要进一步确认。", "evidence_keys": ["company-order-contract"]}],
        "contrary_points": [], "risks": ["交付和回款可能不及预期。"], "invalidation_conditions": ["若已披露的交付安排发生实质变化，应重新检验判断。"],
        "action_conditions": ["先核对交付进度和估值口径，再结合客户期限形成建议。"],
        "suitability": "以中期研究为前提，客户风险承受信息尚未提供。",
        "client_copy": "这家公司出现了可以核对的订单线索，但订单不等于收入兑现，建议先核对交付与估值，再结合您的持有期限讨论。",
        "full_copy": "本次研究先核对公司订单原文。现有依据可以支持继续跟踪，不能直接推出盈利已经增长。需要验证交付、回款与估值，若交付安排改变，应重新评估原有判断。",
    }
    value.update(changes)
    return value


def test_adviser_catalog_and_selected_stock_are_required(client):
    catalog = client.get("/api/v1/intelligence?kind=stock-analysis").json()
    assert {"closing", "stock-analysis", "stock-rationale"} <= {kind["id"] for kind in catalog["kinds"]}
    for payload in [
        {"request_id": "missing", "kind": "stock-analysis"},
        {"request_id": "missing", "kind": "stock-rationale", "scope": {"advisor": {"stock_code": "UNKNOWN"}}},
        {"request_id": "missing", "kind": "stock-analysis", "scope": {"advisor": {"stock_code": "600000.SH"}}},
        {"request_id": "missing", "kind": "stock-analysis", "scope": {"markets": ["US"], "advisor": {"stock_code": "600519.SH"}}},
    ]:
        assert client.post("/api/v1/intelligence/runs", json=payload).status_code == 422
    with db.connect() as connection:
        assert connection.execute("SELECT count(*) FROM conversations").fetchone()[0] == 0


def test_diagnosis_freezes_stock_and_user_inputs_without_treating_them_as_evidence(client, monkeypatch):
    calls = []
    def bars(code, as_of, limit):
        calls.append((code, as_of))
        return [{"trade_date": "2026-10-17", "close": 98, "quality_valid": True}, {"trade_date": "2026-10-19", "close": 100, "quality_valid": True}]
    monkeypatch.setattr(market, "get_bars", bars)
    run = advisor_run(client, position="holding", holding_cost=105, horizon="long", question="现在是否可以买入？", recommendation_background="已向客户提及，需要核对逻辑")
    assert calls == [("600519.SH", "2026-10-19")]
    context = run["advisor_context"]
    assert context["stock"]["stock_code"] == "600519.SH" and context["advisor"]["holding_cost"] == 105
    assert context["actual_market_date"] == "2026-10-19" and len(context["market_source_ids"]) == 1
    assert run["source_count"] == 1
    conversation = conversation_store.get_conversation(run["conversation_id"])
    assert conversation["research_scope"]["stock_codes"] == ["600519.SH"]
    assert "read_advisor_context" in conversation["messages"][0]["content"]
    assert "未经核验" in conversation["messages"][0]["content"]
    assert client.get("/api/v1/intelligence?kind=stock-analysis").json()["legacy"] == []


def test_stock_report_accepts_historical_fundamental_evidence_and_exports_drafts(client):
    run = advisor_run(client, kind="stock-rationale")
    context, _ = running(run)
    source(run, published="2025-04-01T08:00:00+08:00")
    payload = deliverable().model_dump(mode="json")
    payload["items"][0]["analysis_dimension"] = "business"
    payload["advisor_report"] = advisor_result()
    intelligence.publish(PublishBrief.model_validate(payload), context)
    saved = intelligence.detail(run["id"])
    assert saved["result"]["advisor_report"]["verdict"] == "conditional"
    assert saved["result"]["items"][0]["evidence"][0]["time_status"] == "before_window"
    exported = client.get("/api/v1/intelligence/runs/" + run["id"] + "/export").text
    assert "客户沟通短稿" in exported and "完整稿" in exported and "判断失效条件" in exported
    assert saved["advisor_context"]["advisor"]["stock_code"] == "600519.SH"


def test_report_requires_bound_stock_and_real_support_references(client):
    run = advisor_run(client, kind="stock-rationale")
    context, _ = running(run)
    source(run)
    payload = deliverable().model_dump(mode="json")
    payload["items"][0]["analysis_dimension"] = "business"
    for report, message in [
        (advisor_result(stock_code="600000.SH"), "股票与已选对象不一致"),
        (advisor_result(supporting_points=[{"title": "伪造支持理由", "explanation": "这个理由没有任何本轮核验的证据主题可以支持。", "evidence_keys": ["invented"]}]), "不属于本次成果"),
    ]:
        payload["advisor_report"] = report
        with pytest.raises(intelligence.IntelligenceError, match=message):
            intelligence.publish(PublishBrief.model_validate(payload), context)
    payload["advisor_report"] = None
    with pytest.raises(intelligence.IntelligenceError, match="advisor_report"):
        intelligence.publish(PublishBrief.model_validate(payload), context)
    assert intelligence.detail(run["id"])["result"] is None


def test_medium_term_positive_recommendation_cannot_use_only_technical_topics(client):
    run = advisor_run(client, kind="stock-rationale")
    context, _ = running(run)
    source(run)
    payload = deliverable().model_dump(mode="json")
    first = payload["items"][0]
    first["analysis_dimension"] = "technical"
    payload["items"].append({**first, "event_key": "price-topic-two", "title": "另一个技术主题"})
    payload["advisor_report"] = advisor_result(verdict="support", supporting_points=[
        {"title": "技术条件之一", "explanation": "这里描述第一个技术条件及其数据口径。", "evidence_keys": [first["event_key"]]},
        {"title": "技术条件之二", "explanation": "这里描述第二个技术条件及其数据口径。", "evidence_keys": ["price-topic-two"]},
    ])
    with pytest.raises(intelligence.IntelligenceError, match="不能仅由技术走势支持"):
        intelligence.publish(PublishBrief.model_validate(payload), context)


def test_closing_date_is_frozen_and_intraday_cannot_claim_a_completed_close(client):
    old = advisor_run(client, kind="closing", trade_date="2026-10-19")
    assert old["cutoff_at"].startswith("2026-10-19T23:59:59")
    run = advisor_run(client, kind="closing", request="intraday", trade_date="2026-10-20")
    context, _ = running(run)
    source(run)
    payload = deliverable().model_dump(mode="json")
    payload["items"][0]["analysis_dimension"] = "market"
    payload["advisor_report"] = advisor_result(stock_code=None, verdict="review", session_status="closed",
        closing_review={"turnover": None, "events": [], "scope_notes": "盘中数据仅供观察，不当作正式收盘。"},
        client_copy="盘面回顾：当前尚未收盘，已有资料只能作为盘中参考。热点板块：板块表现仍需等待收盘确认。明日观察：先核对正式行情和公告再判断。市场有风险，投资需谨慎。")
    with pytest.raises(intelligence.IntelligenceError, match="尚未收盘"):
        intelligence.publish(PublishBrief.model_validate(payload), context)
    payload["advisor_report"]["session_status"] = "not_closed"
    intelligence.publish(PublishBrief.model_validate(payload), context)
    saved = intelligence.detail(run["id"])
    assert saved["state"] == "partial" and saved["result"]["advisor_report"]["session_status"] == "not_closed"


def test_pdf_originals_can_be_frozen_with_page_numbers_for_stock_research(client, monkeypatch, tmp_path):
    from reportlab.pdfgen.canvas import Canvas
    from apps.api.app import research_external
    from apps.api.app.intelligence_contracts import CaptureBriefSource
    original = tmp_path / "annual-report.pdf"
    canvas = Canvas(str(original))
    canvas.setTitle("Company annual report")
    canvas.drawString(40, 750, "Revenue was 100 million. Cash collection and order delivery require further verification.")
    canvas.save()
    run = advisor_run(client)
    context, _ = running(run)
    monkeypatch.setattr(research_external, "download_source", lambda *args: {"url": "https://example.com/annual-report.pdf", "path": str(original), "retrieved_at": db.utc_now()})
    monkeypatch.setattr(research_external, "_source_file", lambda *args: original)
    captured = intelligence._capture_source(CaptureBriefSource(url="https://example.com/annual-report.pdf"), context)
    assert "第1页" in captured["text"] and "Revenue was 100 million." in captured["text"]
    assert captured["publisher_date"] is None  # PDF creation time is not a publication date.
    original.unlink()
    assert "Revenue was 100 million." in intelligence.evidence(run["id"], captured["source_id"])["text"]


def test_frozen_market_source_can_be_cited_and_cannot_be_overwritten(client, monkeypatch):
    monkeypatch.setattr(market, "get_bars", lambda *args: [
        {"trade_date": "2026-10-17", "close": 98, "quality_valid": True},
        {"trade_date": "2026-10-19", "close": 100, "quality_valid": True}])
    run = advisor_run(client)
    context, _ = running(run)
    source_id = run["advisor_context"]["market_source_ids"][0]
    payload = deliverable(source_id).model_dump(mode="json")
    payload["items"][0].update(analysis_dimension="technical", facts="最近一条有效日线收盘价为100，须核对行情日期与口径。")
    payload["items"][0]["evidence"] = [{"source_id": source_id, "quote": "交易日期：2026-10-19\n收盘价：100.0", "source_type": "market_data"}]
    payload["advisor_report"] = advisor_result(verdict="watch")
    intelligence.publish(PublishBrief.model_validate(payload), context)
    saved = intelligence.detail(run["id"])
    assert saved["result"]["items"][0]["evidence"][0]["time_status"] == "frozen_market"
    with pytest.raises(Exception, match="immutable"):
        with db.connect() as connection:
            connection.execute("UPDATE intelligence_advisor_context SET context_json='{}' WHERE run_id=?", (run["id"],))


def test_pdf_quote_feedback_distinguishes_skipped_rows_and_repeated_passages():
    from apps.api.app.intelligence_contracts import BriefCitation
    saved = {"id": "pdf-source", "title": "财报原文", "url": "https://example.com/report.pdf",
             "text": "第5页\n营业收入为一百万元，比上年增长百分之十。\n利润总额为三十万元。\n归属股东利润为二十万元。\n第8页\n营业收入为一百万元，比上年增长百分之十。",
             "publisher_date": None, "retrieved_at": "2026-10-20T09:00:00+08:00", "sha256": "test"}
    cutoff = datetime.fromisoformat("2026-10-20T10:00:00+08:00")
    with pytest.raises(intelligence.IntelligenceError, match="连续原文"):
        intelligence._citation(saved, BriefCitation(source_id="pdf-source", quote="营业收入为一百万元，比上年增长百分之十。\n归属股东利润为二十万元。"), cutoff, cutoff)
    with pytest.raises(intelligence.IntelligenceError, match="重复出现"):
        intelligence._citation(saved, BriefCitation(source_id="pdf-source", quote="营业收入为一百万元，比上年增长百分之十。"), cutoff, cutoff)
    verified = intelligence._citation(saved, BriefCitation(source_id="pdf-source", quote="第5页\n营业收入为一百万元，比上年增长百分之十。"), cutoff, cutoff)
    assert verified["quote_verified"] and verified["quote_start"] == 0


def test_new_closing_task_freezes_default_review_and_requires_it_before_publication(client):
    run = advisor_run(client, kind="closing")
    policy = run["advisor_context"]["closing_policy"]
    assert policy["preferred_turnover_scope"] == "SH_SZ" and policy["event_timezone"] == "Asia/Shanghai"
    prompt = conversation_store.get_conversation(run["conversation_id"])["messages"][0]["content"]
    assert "同一范围的前一交易日" in prompt and "夏令时" in prompt and "个股宽度" in prompt
    assert not run["scope"]["focus"]  # These requirements do not depend on a one-off user prompt.
    context, _ = running(run)
    source(run)
    payload = deliverable().model_dump(mode="json")
    payload["items"][0]["analysis_dimension"] = "market"
    payload["advisor_report"] = advisor_result(stock_code=None, verdict="review", session_status="not_closed")
    with pytest.raises(intelligence.IntelligenceError, match="closing_review"):
        intelligence.publish(PublishBrief.model_validate(payload), context)
    payload["advisor_report"].update(closing_review={"turnover": None, "events": [], "scope_notes": "未确认收盘成交额，客户稿省略该数字。"},
        client_copy="盘面回顾：当前尚未收盘，暂不使用盘中数字代替收盘数据。热点板块：已有公开资料仍需继续核对。明日观察：等待正式数据及公告后再判断。市场有风险，投资需谨慎。")
    intelligence.publish(PublishBrief.model_validate(payload), context)
    assert intelligence.publish(PublishBrief.model_validate(payload), context)["idempotent_replay"] is True
    exported = client.get(f"/api/v1/intelligence/runs/{run['id']}/export").text
    assert "行情口径与事件北京时间" in exported and "未确认收盘成交额" in exported
