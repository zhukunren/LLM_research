from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from apps.api.app import db, main, market, observation_market, saved_screening_tasks, screening_execution, security_catalog, worker
from apps.api.app.screening_contracts import ScreeningTaskRevision


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "observation.db")
    path = tmp_path / "bars.parquet"
    monkeypatch.setattr(market, "STOCK_FILE", path)
    dates = []
    day = date(2026, 7, 1)
    while len(dates) < 26:
        if day.weekday() < 5:
            dates.append(day)
        day += timedelta(days=1)
    rows = []
    for code in ("600000.SH", "600001.SH", "600002.SH"):
        for n, day in enumerate(dates):
            if code == "600001.SH" and n == 5:
                continue
            close = 10.0 + n
            rows.append(dict(stock_code=code, trade_date=datetime.combine(day, datetime.min.time()),
                open=close, high=close + 1, low=close - 1, close=close, volume=100., amount=1000.))
    pq.write_table(pa.Table.from_pylist(rows), path)
    monkeypatch.setattr(market, "cached_profile", lambda: {"available": True, "last_date": dates[-1].isoformat(), "price_basis": "forward_adjusted"})
    monkeypatch.setattr(security_catalog, "names", lambda: {"600000.SH": "测试甲", "600001.SH": "测试乙"})
    def evaluate(condition, reference, stock_code, as_of):
        return {"stock_code": stock_code, "condition_id": condition["condition_id"], "reference_id": reference["reference_id"],
                "state": "unknown" if stock_code == "600002.SH" else "true", "evaluation_status": "completed",
                "reason_code": "data_missing" if stock_code == "600002.SH" else "condition_met", "explanation": "测试判断依据", "data_as_of": as_of}
    monkeypatch.setattr(screening_execution, "evaluate_reference", evaluate)
    observation_market._cohort_prices.cache_clear()
    with TestClient(main.app) as client:
        task = ScreeningTaskRevision.model_validate({
            "task_id": "source", "revision": 1, "original_user_messages": ["价格条件"],
            "conditions": [{"condition_id": "c", "library": "technical", "source_quote": "价格条件",
                "description": "收盘价高于均线", "expression": {"op": "indicator_compare", "window": 20}}],
            "references": [{"reference_id": "r", "condition_id": "c"}],
            "logic_tree": {"op": "condition", "reference_id": "r"},
            "scope": {"universe": {"kind": "all_a_shares"}, "as_of": dates[0].isoformat()}, "unresolved": [],
        })
        saved = saved_screening_tasks.save_task(task, name="趋势观察")
        yield client, saved, dates, path


def execute(setup, request_id="execute-1", as_of=None):
    client, saved, dates, _ = setup
    response = client.post(f"/api/v1/observation/saved-tasks/{saved['id']}/execute", json={
        "request_id": request_id, "version": 1, "as_of": as_of or dates[0].isoformat()})
    assert response.status_code == 202, response.text
    return response.json()


def completed(setup):
    queued = execute(setup)
    assert worker.execute_job(queued["job_id"])
    return queued["run_id"]


def test_partial_note_edit_preserves_other_fields_and_rejects_stale_notes(setup):
    client, _, _, _ = setup
    run_id = completed(setup)
    url = f'/api/v1/observation/runs/{run_id}/notes/600000.SH'
    assert client.put(url, json={'status': 'watching', 'note': '保留原备注'}).status_code == 200
    response = client.patch(url, json={'status': 'priority'})
    assert response.status_code == 200
    assert response.json()['note'] == '保留原备注'
    response = client.patch(url, json={'note': '新备注', 'expected_note': '保留原备注'})
    assert response.status_code == 200 and response.json()['status'] == 'priority'
    assert client.patch(url, json={'note': '迟到修改', 'expected_note': '保留原备注'}).status_code == 409
    assert client.patch(url, json={}).status_code == 422
    assert client.patch(url, json={'status': None}).status_code == 422
    assert client.patch(url.replace('600000.SH', 'absent'), json={'status': 'ended'}).status_code == 404


def test_entry_metrics_use_each_start_date_and_close_based_drawdown(tmp_path, monkeypatch):
    path = tmp_path / 'metric-bars.parquet'
    closes = [10., 12., 9., 11.]
    rows = [dict(stock_code='600000.SH', trade_date=datetime(2026, 7, day),
                 open=close, high=close + 1, low=close - 1, close=close, volume=100., amount=1000.)
            for day, close in enumerate(closes, start=1)]
    pq.write_table(pa.Table.from_pylist(rows), path)
    monkeypatch.setattr(market, 'STOCK_FILE', path)
    result = observation_market.entry_metrics([
        ('research', '600000.SH', '2026-07-01', False),
        ('screening', '600000.SH', '2026-07-02', True),
        ('missing', '600000.SH', '2026-06-30', True),
    ], '2026-07-04')
    assert result['research']['return_latest'] == pytest.approx(10)
    assert result['research']['max_drawdown'] == pytest.approx(-25)
    assert result['screening']['return_latest'] == pytest.approx((11 / 12 - 1) * 100)
    assert result['screening']['max_drawdown'] == pytest.approx(-25)
    assert result['missing']['return_latest'] is None
    assert result['missing']['metric_reason'] == '信号日缺少有效收盘价'


def test_unified_entries_include_manual_and_screening_with_owner_filters(setup):
    client, _, dates, _ = setup
    with db.connect() as connection:
        connection.execute("INSERT INTO security_catalog VALUES('600000.SH','测试甲','','','SH','2026-07-01')")
    manual = client.post('/api/v1/observation/quick-add', json={'request_id': 'manual-observation', 'stock_code': '600000.SH'})
    assert manual.status_code == 200, manual.text
    run_id = completed(setup)
    listing = client.get('/api/v1/observation/entries').json()
    assert listing['total'] == 3
    assert listing['summary']['research_count'] == 1
    assert listing['summary']['screening_count'] == 2
    assert listing['summary']['priced_count'] == 2
    assert {(item['kind'], item['stock_code']) for item in listing['items']} == {
        ('candidate', '600000.SH'), ('screening', '600000.SH'), ('screening', '600001.SH')}
    quick_list = client.get('/api/v1/observation/entries?include_metrics=false').json()
    assert quick_list['total'] == 3 and 'return_latest' not in quick_list['items'][0]
    manual_only = client.get('/api/v1/observation/entries?owner=manual').json()
    assert manual_only['total'] == 1 and manual_only['summary']['priced_count'] == 0
    assert manual_only['items'][0]['metric_reason'] == '起算日之后暂无行情'
    assert client.get('/api/v1/observation/entries?query=600000.SH').json()['total'] == 2
    batch = client.get(f'/api/v1/observation/entries?owner=run:{run_id}').json()
    assert batch['total'] == 2
    assert batch['summary']['screening_count'] == 2 and batch['summary']['research_count'] == 0
    assert batch['summary']['average_return'] == pytest.approx(250)
    assert batch['summary']['worst_drawdown'] == pytest.approx(0)
    assert all(item['return_latest'] == pytest.approx(250) and item['max_drawdown'] == pytest.approx(0) for item in batch['items'])
    assert all(item['joined_at'] and item['basis_date'] == dates[0].isoformat() for item in batch['items'])
    assert all(item['owner_label'].startswith('趋势观察 · ') for item in batch['items'])
    assert client.get('/api/v1/observation/entries?query=趋势观察').json()['total'] == 2
    owners = client.get('/api/v1/observation/owners').json()['items']
    assert {item['value'] for item in owners} == {'manual', f'run:{run_id}'}
    assert client.get('/api/v1/observation/entries?owner=unknown').status_code == 422


def test_manual_observation_metrics_start_when_added_to_pool(setup):
    client, _, dates, _ = setup
    with db.connect() as connection:
        connection.execute("INSERT INTO security_catalog VALUES('600000.SH','测试甲','','','SH','2026-07-01')")
    created = client.post('/api/v1/observation/quick-add', json={'request_id': 'manual-start', 'stock_code': '600000.SH'})
    assert created.status_code == 200
    joined_at = dates[4].isoformat() + 'T09:00:00Z'
    with db.connect() as connection:
        connection.execute('UPDATE manual_observation_candidates SET created_at=?,updated_at=? WHERE id=?',
                           (joined_at, joined_at, created.json()['id']))
    response = client.get('/api/v1/observation/entries?owner=manual').json()
    item = response['items'][0]
    assert item['joined_at'] == joined_at and item['basis_date'] == dates[4].isoformat()
    assert item['base_date'] == dates[4].isoformat()
    assert item['return_latest'] == pytest.approx((35 / 14 - 1) * 100)
    assert response['summary']['priced_count'] == 1


def test_saved_execution_is_idempotent_and_freezes_version_and_price(setup):
    client, saved, dates, _ = setup
    assert client.get('/api/v1/observation/runs').json()['total'] == 0
    with ThreadPoolExecutor(max_workers=2) as pool:
        a, b = list(pool.map(lambda _: execute(setup), range(2)))
    assert a["run_id"] == b["run_id"]
    assert worker.execute_job(a["job_id"])
    run_id = a["run_id"]
    snapshot = client.get(f"/api/v1/observation/runs/{run_id}/snapshot").json()
    assert snapshot["snapshot"]["observation"]["asset_version"] == 1
    assert snapshot["snapshot"]["observation"]["historical_replay"] is True
    assert snapshot["snapshot"]["observation"]["reference_prices"]["600000.SH"]["close"] == 10
    assert set(snapshot['results']) == {'600000.SH', '600001.SH', '600002.SH'}
    assert snapshot['results']['600002.SH']['state'] == 'unknown'
    task = ScreeningTaskRevision.model_validate(saved["task"])
    task.conditions[0].description = "更改后的条件"
    saved_screening_tasks.save_task(task, name="新名称", asset_id=saved["id"])
    assert client.get(f"/api/v1/observation/runs/{run_id}/snapshot").json() == snapshot
    changed = client.post(f"/api/v1/observation/saved-tasks/{saved['id']}/execute", json={"request_id": "execute-1", "version": 1, "as_of": dates[1].isoformat()})
    assert changed.status_code == 409
    assert client.get('/api/v1/observation/runs').json()['total'] == 1
    assert execute(setup, 'execute-2')['run_id'] != run_id


def test_market_horizons_missing_bars_and_note_do_not_change_cohort_statistics(setup):
    client, _, dates, _ = setup
    run_id = completed(setup)
    base = f'/api/v1/observation/runs/{run_id}'
    perf = client.get(base + '/performance')
    assert perf.status_code == 200, perf.text
    value = perf.json()
    a, b = value['items']
    assert a['days'] == 25
    assert a['returns']['5'] == pytest.approx(50)
    assert b['returns']['5'] is None  # missing fifth market session is not replaced by sixth
    assert value['summary']['5']['count'] == 1
    assert a['return_latest'] == pytest.approx(250)
    assert a['peak_return'] == pytest.approx(260)
    before = client.get(base + '/snapshot').json()
    saved = client.put(base + '/notes/600000.SH', json={'status': 'ended', 'note': '观察已完成'})
    assert saved.status_code == 200, saved.text
    after = client.get(base + '/performance').json()
    assert after['summary'] == value['summary']
    assert after['items'][0]['note'] == '观察已完成'
    assert client.get(base + '/snapshot').json() == before
    assert client.put(base + '/notes/600002.SH', json={'status': 'priority'}).status_code == 404
    assert client.put(base + '/notes/600000.SH', json={'status': 'invalid'}).status_code == 422
    selection = client.get(base + '/chart/600000.SH?view=selection').json()
    observation = client.get(base + '/chart/600000.SH').json()
    assert selection['bars'][-1]['trade_date'] == dates[0].isoformat()
    assert observation['bars'][-1]['trade_date'] == dates[-1].isoformat()
    assert observation['markers'][0]['current'] is True


def test_unknown_adjustment_and_unmatured_periods_stay_missing(setup, monkeypatch):
    client, _, dates, _ = setup
    run_id = completed(setup)
    path = f'/api/v1/observation/runs/{run_id}/performance'
    monkeypatch.setattr(market, 'cached_profile', lambda: {'available': True, 'last_date': dates[3].isoformat(), 'price_basis': 'forward_adjusted'})
    value = client.get(path).json()
    assert value['items'][0]['days'] == 3
    assert value['summary']['5']['count'] == 0
    assert value['summary']['5']['average'] is None
    monkeypatch.setattr(market, 'cached_profile', lambda: {'available': True, 'last_date': dates[-1].isoformat(), 'price_basis': 'unknown'})
    value = client.get(path).json()
    assert value['items'][0]['latest_close'] == 35
    assert value['items'][0]['return_latest'] is None
    assert value['summary']['latest']['count'] == 0
    assert '复权' in value['warning']


def test_repeated_selection_retains_both_events_and_history_pagination(setup):
    client, _, dates, _ = setup
    first = completed(setup)
    second = execute(setup, 'second', dates[1].isoformat())
    assert worker.execute_job(second['job_id'])
    chart = client.get(f"/api/v1/observation/runs/{second['run_id']}/chart/600000.SH").json()
    assert {marker['run_id'] for marker in chart['markers']} == {first, second['run_id']}
    assert sum(marker['current'] for marker in chart['markers']) == 1
    result = client.get('/api/v1/observation/runs?limit=1').json()
    assert result['total'] == 2 and len(result['items']) == 1
    assert client.get('/api/v1/observation/runs?query=不存在').json()['total'] == 0


def test_missing_signal_bar_does_not_shift_market_calendar(setup):
    _, _, dates, path = setup
    rows = [row for row in pq.read_table(path).to_pylist() if row['trade_date'].date() != dates[0]]
    pq.write_table(pa.Table.from_pylist(rows), path)
    value = observation_market.cohort_prices(['600000.SH'], dates[0].isoformat(), dates[-1].isoformat())
    assert value['days'] == 25
    assert value['prices']['600000.SH']['base_close'] is None
    assert value['prices']['600000.SH']['close_5'] == 15


def test_rejected_scope_does_not_modify_saved_task_or_create_run(setup):
    client, saved, dates, _ = setup
    response = client.post(f"/api/v1/observation/saved-tasks/{saved['id']}/execute", json={
        'request_id': 'bad-scope', 'version': 1, 'as_of': dates[0].isoformat(),
        'universe': {'kind': 'explicit', 'stock_codes': []}})
    assert response.status_code == 422
    assert client.get('/api/v1/observation/runs').json()['total'] == 0
    assert saved_screening_tasks.get_task(saved['id'])['task'] == saved['task']


def test_chart_keeps_old_signal_beyond_500_bars_and_masks_invalid_prices(setup):
    _, _, _, path = setup
    start = date(2020, 1, 1)
    rows = []
    for n in range(620):
        rows.append(dict(stock_code='600000.SH', trade_date=datetime.combine(start + timedelta(days=n), datetime.min.time()),
            open=10., close=10., high=11. if n != 4 else 9., low=9., volume=10., amount=100.))
    pq.write_table(pa.Table.from_pylist(rows), path)
    bars = observation_market.chart_bars('600000.SH', start.isoformat(), (start + timedelta(days=619)).isoformat())
    assert len(bars) == 620
    assert bars[0]['trade_date'] == start.isoformat()
    assert bars[4]['quality_valid'] is False
    assert bars[4]['close'] is None
