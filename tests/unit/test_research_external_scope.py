"""External research pages must obey their frozen scope before being exposed."""
from dataclasses import replace
import json
from types import SimpleNamespace

import pytest

from apps.api.app import conversation_store, db, market, research_tools, screening_service, settings
from apps.api.app.screening_contracts import ScreeningTaskRevision
from apps.api.app.screening_tools import ToolContext, ToolDispatchError


@pytest.fixture
def provider(monkeypatch):
    state = SimpleNamespace(rows=[], calls=[])
    monkeypatch.setattr(research_tools.tushare_sync, "create_client", lambda: object())

    def query(_client, api_name, **params):
        state.calls.append((api_name, params))
        return state.rows

    monkeypatch.setattr(research_tools.tushare_sync, "_query", query)
    return state


def scope(**updates):
    return replace(ToolContext("unit", "unit-turn", 0, workflow_type="research",
                              as_of="2026-09-14", stock_codes=frozenset({"600000.SH"})), **updates)


def query(api="daily", params=None, context=None, **options):
    return research_tools.query_tushare(research_tools.TushareQueryArgs(
        api_name=api, params=params if params is not None else {"ts_code": "600000.SH"},
        save_to_file=False, **options,
    ), context or scope())


@pytest.mark.parametrize("api,key,value", [
    ("daily", "trade_date", "20260915"), ("daily", "start_date", "20260915"),
    ("daily", "end_date", "20260915"), ("income", "ann_date", "20260915"),
    ("forecast", "ann_date", "2026-09-15"),
])
def test_explicit_dates_after_cutoff_are_rejected_before_network(provider, api, key, value):
    with pytest.raises(ToolDispatchError) as error:
        query(api, {"ts_code": "600000.SH", key: value})
    assert error.value.code == "date_outside_research_scope"
    assert provider.calls == []


def test_multi_security_request_cannot_expand_the_research_universe(provider):
    with pytest.raises(ToolDispatchError) as error:
        query(params={"ts_code": "600000.SH,600001.SH"})
    assert error.value.code == "security_outside_research_scope"
    assert provider.calls == []


@pytest.mark.parametrize("api", ["daily", "weekly", "monthly", "adj_factor", "daily_basic", "moneyflow", "index_daily", "income", "balancesheet", "cashflow", "forecast", "express"])
def test_supported_range_end_is_pinned_and_date_fields_are_checked(provider, api):
    field = "trade_date" if api in research_tools.TUSHARE_MARKET_DATE_APIS else "ann_date"
    provider.rows = [{"ts_code": "600000.SH", field: "20260914"},
                     {"ts_code": "600000.SH", field: "20260915"}]
    result = query(api)
    assert provider.calls[0][1]["end_date"] == "20260914"
    assert len(result["items"]) == 1 and result["received"] == 2
    assert result["scope_validation"]["excluded_scope_counts"]["date_after_cutoff"] == 1


def test_future_forecast_period_is_not_mistaken_for_a_future_announcement(provider):
    provider.rows = [{"ts_code": "600000.SH", "ann_date": "20260901", "end_date": "20261231"}]
    result = query("forecast", {"ts_code": "600000.SH", "period": "20261231"})
    assert result["params"]["period"] == "20261231"
    assert result["params"]["end_date"] == "20260914"
    assert result["returned"] == 1
    assert result["scope_validation"]["historical_revision_verified"] is False


@pytest.mark.parametrize("api", ["fina_indicator", "dividend"])
def test_announcement_cutoff_is_not_injected_as_a_reporting_period(provider, api):
    provider.rows = [{"ts_code": "600000.SH", "ann_date": "20260901", "end_date": "20261231"}]
    result = query(api)
    assert "end_date" not in provider.calls[0][1]
    assert result["returned"] == 1
    if api == "fina_indicator":
        result = query(api, {"ts_code": "600000.SH", "end_date": "20261231"})
        assert result["returned"] == 1


def test_actual_later_financial_or_dividend_announcement_is_excluded(provider):
    provider.rows = [{"ts_code": "600000.SH", "ann_date": "20260901", "f_ann_date": "20260915"}]
    assert query("income")["returned"] == 0
    provider.rows = [{"ts_code": "600000.SH", "ann_date": "20260901", "imp_ann_date": "20260915"}]
    assert query("dividend")["returned"] == 0


def test_missing_or_invalid_record_dates_are_not_claimed_as_verified(provider):
    provider.rows = [{"ts_code": "600000.SH", "end_date": "20260630"},
                     {"ts_code": "600000.SH", "ann_date": "not-a-date"}]
    result = query("fina_indicator")
    validation = result["scope_validation"]
    assert result["items"] == [] and validation["status"] == "no_verified_rows"
    assert validation["record_dates_verified"] is False
    assert validation["excluded_scope_counts"]["missing_date"] == 1
    assert validation["excluded_scope_counts"]["invalid_date"] == 1


def test_filtered_artifact_matches_preview_scope_and_keeps_raw_page_counts(provider, tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "external.db")
    db.init_db()
    cid = conversation_store.create_conversation("technical", workflow_type="research")["id"]
    user = conversation_store.add_user_message(cid, "external", 0, "研究行情")
    conversation_store.start_turn(cid, user["turn_id"])
    context = replace(scope(), conversation_id=cid, turn_id=user["turn_id"])
    monkeypatch.setattr(settings, "research_mode_settings", lambda *_: {"max_output_file_bytes": 1000000})
    stored = {}

    def write_output(_cid, _path, content):
        stored.update(json.loads(content))
        return {"path": str(tmp_path / "mock-artifact.json")}

    monkeypatch.setattr(research_tools.research_workspace, "write_output", write_output)
    provider.rows = [
        {"ts_code": "600000.SH", "trade_date": "20260914", "close": 1},
        {"ts_code": "600000.SH", "trade_date": "20260913", "close": 2},
        {"ts_code": "600000.SH", "trade_date": "20260915", "close": 3},
        {"ts_code": "600001.SH", "trade_date": "20260914", "close": 4},
        {"ts_code": "600000.SH", "close": 5},
        {"trade_date": "20260914", "close": 6},
    ]
    result = research_tools.query_tushare(research_tools.TushareQueryArgs(
        api_name="daily", params={"ts_code": "600000.SH"}, limit=1, save_to_file=True,
    ), context)
    assert result["returned"] == 1 and result["received"] == 6 and result["matched"] == 2
    assert result["truncated"] is True and len(stored["items"]) == 2
    assert stored["items"] == provider.rows[:2]
    assert stored["received"] == 6 and stored["scope_validation"] == result["scope_validation"]
    assert result["scope_validation"]["excluded_total"] == 4


@pytest.mark.parametrize("api", ["trade_cal", "stock_basic", "index_basic"])
def test_catalogs_stay_readable_without_claiming_historical_qualification(provider, api):
    provider.rows = [{"ts_code": "600001.SH", "cal_date": "20261004"}]
    result = query(api, {})
    assert provider.calls[0][1] == {} and result["items"] == provider.rows
    assert result["scope_validation"]["status"] == "directory_only"
    assert result["scope_validation"]["record_dates_verified"] is False


def test_news_uses_local_publication_dates_and_cannot_fake_security_binding(provider):
    provider.rows = [{"datetime": "2026-09-14 23:59:00", "title": "within"},
                     {"datetime": "2026-09-14T20:00:00+00:00", "title": "next local day"}]
    result = query("news", {"source": "sina", "start_date": "2026-09-01 00:00:00"}, context=scope(stock_codes=None))
    assert provider.calls[0][1]["src"] == "sina"
    assert provider.calls[0][1]["end_date"] == "2026-09-14 23:59:59"
    assert [item["title"] for item in result["items"]] == ["within"]
    with pytest.raises(ToolDispatchError) as error:
        query("news", {"src": "sina", "start_date": "2026-09-01 00:00:00"})
    assert error.value.code == "tushare_security_scope_unverifiable"


def test_a_completed_research_turn_cannot_authorize_an_old_plan_after_workflow_switch(monkeypatch):
    monkeypatch.setattr(conversation_store, "get_conversation", lambda *_args, **_kwargs: {
        "id": "cid", "workflow_type": "screening", "task_revision": 1,
        "turns": [{"id": "research-turn"}],
    })
    monkeypatch.setattr(conversation_store, "get_turn", lambda *_: {
        "id": "research-turn", "workflow_type": "research", "state": "succeeded",
        "user_message_id": "research-message", "result": {},
    })
    monkeypatch.setattr(screening_service, "_existing_request", lambda *_: None)
    monkeypatch.setattr(conversation_store, "get_pending_execute_message", lambda *_: None)
    monkeypatch.setattr(conversation_store, "get_user_message", lambda *_: {"id": "research-message", "content": "研究这家公司"})

    def old_task_must_not_be_read(*_):
        pytest.fail("research turn reached the old screening task")

    monkeypatch.setattr(conversation_store, "get_task_revision", old_task_must_not_be_read)
    with pytest.raises(screening_service.ScreeningServiceError) as error:
        screening_service.enqueue_turn("cid", "research-turn", button_authorized=True, button_revision=1, button_request_id="button")
    assert error.value.code == "screening_workflow_required"


def test_switching_to_research_during_freezing_prevents_the_final_business_write(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "workflow-race.db")
    db.init_db()
    cid = conversation_store.create_conversation("technical", workflow_type="screening")["id"]
    prompt = "收盘价高于20日均线，先不执行"
    user = conversation_store.add_user_message(cid, "plan", 0, prompt)
    task = ScreeningTaskRevision.model_validate({
        "task_id": cid, "revision": 1, "original_user_messages": [prompt],
        "conditions": [{"condition_id": "ma", "library": "technical", "source_quote": "收盘价高于20日均线",
                        "expression": {"op": "indicator_compare", "window": 20}, "description": "收盘价高于20日均线"}],
        "references": [{"reference_id": "r1", "condition_id": "ma"}],
        "logic_tree": {"op": "condition", "reference_id": "r1"},
        "scope": {"as_of": "2026-09-14", "universe": {"kind": "all_a_shares"}},
    })
    conversation_store.save_task_revision(cid, 0, user["message_id"], task)
    conversation_store.finish_turn(cid, user["turn_id"], 1, "succeeded", "选股草案已整理。", {"task_revision": 1})
    monkeypatch.setattr(market, "daily_bar_source_available", lambda *_: True)
    monkeypatch.setattr(market, "cached_profile", lambda: {"available": True, "last_date": "2026-09-14"})
    monkeypatch.setattr(market, "latest_market_date", lambda *_: "2026-09-14")
    monkeypatch.setattr(market, "security_codes", lambda *_: ["600000.SH"])
    calls = 0

    def fingerprint():
        nonlocal calls
        calls += 1
        if calls == 2:
            conversation_store.update_workflow(cid, workflow_type="research")
        return ("synthetic.parquet", 100, 1)

    monkeypatch.setattr(market, "source_fingerprint", fingerprint)
    with pytest.raises(screening_service.ScreeningServiceError) as error:
        screening_service.enqueue_turn(cid, user["turn_id"], button_authorized=True, button_revision=1, button_request_id="race")
    assert error.value.code == "execution_state_changed"
    with db.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM screening_task_runs").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM execution_requests").fetchone()[0] == 0
