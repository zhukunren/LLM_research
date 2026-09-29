import pytest
from fastapi.testclient import TestClient

from apps.api.app import db, main, market, pattern_adapter, screening_execution, conversation_service, news_sources
from apps.api.app.screening_contracts import ScreeningTaskRevision, ConditionDecision


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "cross-library.db")
    with TestClient(main.app) as session:
        with db.connect() as connection:
            connection.execute("INSERT INTO patterns(id,name,version,pattern_json,created_at) VALUES(?,?,?,?,?)",
                               ("shape", "上升走势", 1, db.json_dump(dict(target_bars=3, points=[1, 2, 3], representation="price_path")), db.utc_now()))
        yield session


def task():
    prompt = "形态相似且（资讯支持或研报不支持）"
    return ScreeningTaskRevision.model_validate(dict(
        task_id="cross", revision=1, original_user_messages=[prompt],
        conditions=[dict(condition_id=kind, library=kind, source_quote=prompt, description=kind,
                         expression=dict(pattern_id="shape", pattern_version=1, minimum_similarity=90) if kind == "pattern" else
                         dict(question=prompt, fact_requirement="actual", quantifier="exists")) for kind in ("pattern", "news", "report")],
        references=[dict(reference_id=kind, condition_id=kind) for kind in ("pattern", "news", "report")],
        logic_tree=dict(op="all", children=[dict(op="condition", reference_id="pattern"), dict(op="any", children=[
            dict(op="condition", reference_id="news"), dict(op="not", children=[dict(op="condition", reference_id="report")])])]),
        scope=dict(universe=dict(kind="explicit", stock_codes=["600000.SH", "600001.SH"]), as_of="2026-09-14"),
    ))


def test_saved_shape_and_cross_library_logic_use_the_same_frozen_inputs(client, monkeypatch):
    saved = task()
    assets = pattern_adapter.freeze_for_task(saved)
    # Editing the stored asset afterwards must not alter the already prepared run.
    with db.connect() as connection:
        connection.execute("UPDATE patterns SET pattern_json=? WHERE id='shape'", (db.json_dump(dict(target_bars=3, points=[3, 2, 1])),))
    bars = {code: [dict(trade_date=f"2026-09-{12+i}", close=value, quality_valid=True) for i, value in enumerate(values)]
            for code, values in [("600000.SH", [1, 2, 3]), ("600001.SH", [3, 2, 1])]}
    observed = []
    def scan(as_of, count, codes):
        observed.append((as_of, count, codes))
        return iter(bars.items())
    monkeypatch.setattr(market, "iter_recent_bars", scan)
    original = screening_execution.evaluate_reference
    def evaluate(condition, reference, stock_code, as_of):
        if condition["library"] == "pattern":
            return original(condition, reference, stock_code, as_of)
        return ConditionDecision(stock_code=stock_code, condition_id=condition["condition_id"], reference_id=reference["reference_id"],
                                 state="false", evaluation_status="completed", reason_code="condition_not_met", explanation="合成语义结果")
    monkeypatch.setattr(screening_execution, "evaluate_reference", evaluate)
    result = screening_execution.execute_snapshot(dict(task=saved.model_dump(mode="json"), pattern_assets=assets,
        execution_request={"request_id": "request"}, universe={"codes": list(bars)}, as_of="2026-09-14",
        effective_market_date="2026-09-14", source_manifests=[], tool_call_ids=[], model_metadata={}),
        run_id="run", active=lambda: True, progress=lambda *a: None)
    assert [item.state for item in result.stock_decisions] == ["true", "false"]
    assert result.stock_decisions[0].condition_decisions[0].actual_values["similarity"] == 100
    assert observed == [("2026-09-14", 3, list(bars))]


def test_news_attachment_is_validated_and_watchlist_context_preserves_separate_source_scopes(client):
    item = news_sources.import_items(news_sources.NewsImport(request_id="source", items=[news_sources.NewsItemInput(
        title="资讯", body="正文", source="合成", stock_codes=["600000.SH"])]))["items"][0]
    conversation = client.post("/api/v1/conversations", json={"entry_scope": "news"}).json()
    response = client.post(f"/api/v1/conversations/{conversation['id']}/messages", json=dict(
        client_message_id="with-source", base_revision=0, content="这条资讯并且形态相似",
        source_refs=[dict(kind="news_item", source_id=item["id"])]))
    assert response.status_code == 202
    assert response.json()["source_refs"][0]["title"] == "资讯"
    with db.connect() as connection:
        connection.execute("INSERT INTO watchlists(id,name,created_at) VALUES('pool','范围',?)", (db.utc_now(),))
        connection.execute("INSERT INTO watchlist_items(watchlist_id,stock_code,added_at) VALUES('pool','600000.SH',?)", (db.utc_now(),))
    payload = task().model_dump(mode="json")
    payload["scope"]["universe"] = dict(kind="watchlist", watchlist_id="pool", stock_codes=[])
    context = conversation_service._task_tool_context(conversation["id"], response.json()["turn_id"], 1,
        ScreeningTaskRevision.model_validate(payload), [dict(kind="news_item", source_id=item["id"]), dict(kind="report_page", source_id="report-1")])
    assert context.stock_codes == frozenset({"600000.SH"})
    assert context.allowed_news_ids == frozenset({item["id"]})
    assert context.allowed_document_ids == frozenset({"report-1"})


def test_missing_shape_version_is_rejected_before_execution(client):
    payload = task().model_dump(mode="json")
    payload["conditions"][0]["expression"]["pattern_version"] = 99
    with pytest.raises(ValueError, match="版本不存在"):
        pattern_adapter.freeze_for_task(ScreeningTaskRevision.model_validate(payload))
