from __future__ import annotations

import json
import sqlite3
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.api.app import db, dynamic_indicators as di, market, program_conditions, runtime_executor, screening_runner
from apps.api.app.dynamic_indicator_api import router
from tests.unit.test_dynamic_indicators import SOURCE, bars, definition


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'indicators.db')
    monkeypatch.setattr(runtime_executor, 'WORK_ROOT', tmp_path / 'program-runs')
    db.init_db()
    records = bars()
    profile = {'available': True, 'last_date': records[-1]['trade_date'], 'sha256': 'fixture-source', 'price_basis': 'unadjusted', 'volume_unit': 'share', 'amount_unit': 'CNY'}
    monkeypatch.setattr(market, 'cached_profile', lambda: dict(profile))
    monkeypatch.setattr(market, 'source_fingerprint', lambda: ('fixture', 100, 1))
    monkeypatch.setattr(market, 'get_bars', lambda code, as_of, limit: [row.copy() for row in records if row['trade_date'] <= as_of][-limit:] if code == '600000.SH' else [])
    monkeypatch.setattr(market, 'latest_market_date', lambda as_of: max((row['trade_date'] for row in records if row['trade_date'] <= as_of), default=None))
    # Most tests exercise the exact runner conversion in process. One test below
    # uses real child processes, readiness probes, serialization and cancellation.
    def execute(**kwargs):
        if not kwargs.get('is_active', lambda: True)():
            raise runtime_executor.RuntimeCancelled('cancelled')
        result = screening_runner._execute(kwargs)
        return json.loads(json.dumps(result, allow_nan=False, default=screening_runner._json_default))
    monkeypatch.setattr(runtime_executor, 'execute_program', execute)
    application = FastAPI()
    application.include_router(router)
    with TestClient(application) as client:
        yield client, records, profile


def preview(client, raw=None, **updates):
    request = {'definition': raw or definition(), 'stock_code': '600000.SH', 'as_of': '2026-01-12', 'conversation_id': 'conversation-1'}
    request.update(updates)
    return client.post('/api/v1/dynamic-indicators/preview', json=request)


def save(client, trial, request_id='save-1', **updates):
    return client.post('/api/v1/dynamic-indicators/save', json={'trial_id': trial['trial_id'], 'confirmed': True, 'request_id': request_id, **updates})


def test_real_runtime_full_numeric_preview_and_frozen_screening_parity(setup, monkeypatch):
    client, rows, _ = setup
    # Recover the real executor from its module without reloading its WORK_ROOT.
    import importlib.util
    spec = importlib.util.spec_from_file_location('apps.api.app._real_indicator_executor', runtime_executor.__file__)
    real = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(real)
    real.WORK_ROOT = runtime_executor.WORK_ROOT
    monkeypatch.setattr(runtime_executor, 'execute_program', real.execute_program)
    response = preview(client)
    assert response.status_code == 200, response.text
    trial = response.json()
    assert trial['series']['trend'] == [None, None] + [float(i) for i in range(2, 12)]
    assert trial['validation']['saveable'] is True
    assert len(trial['validation']['prefix_checks']) == 3
    assert trial['validation']['causality_proven'] is False
    saved = save(client, trial).json()
    response = client.post(f"/api/v1/dynamic-indicators/{saved['id']}/condition", json={'version': 1, 'output': 'trend', 'operator': 'gt', 'threshold': 10})
    assert response.status_code == 200, response.text
    frozen = response.json()
    assert frozen['saved'] is False and frozen['execution_authorized'] is False
    assert saved['id'] in frozen['condition']['program']['source_code']
    assert saved['code_hash'] in frozen['condition']['program']['source_code']
    result = program_conditions.evaluate_batch(frozen['condition'], {}, ['600000.SH'], {'600000.SH': rows}, as_of='2026-01-12', effective_market_date='2026-01-12')
    assert result['600000.SH']['state'] == 'true'
    assert result['600000.SH']['metrics']['trend'] == trial['series']['trend'][-1]


def test_immutable_versions_pinned_reuse_overrides_and_concurrent_idempotency(setup):
    client, _, profile = setup
    trial = preview(client).json()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: save(client, trial), range(5)))
    assert all(result.status_code == 201 for result in results)
    first = results[0].json()
    assert all(result.json() == first for result in results)
    assert save(client, trial, name='changed').status_code == 409
    second_trial = client.post('/api/v1/dynamic-indicators/preview', json={'indicator_id': first['id'], 'version': 1, 'parameter_overrides': {'window': 4}, 'stock_code': '600000.SH', 'as_of': '2026-01-12'}).json()
    assert second_trial['definition']['program']['parameters']['window'] == 4
    assert second_trial['origin'] == {'indicator_id': first['id'], 'version': 1}
    second = save(client, second_trial, 'save-2', indicator_id=first['id'], base_version=1).json()
    assert second['version'] == 2
    assert first['code_hash'] == second['code_hash']
    assert first['definition_hash'] != second['definition_hash']
    assert save(client, trial, 'save-old', indicator_id=first['id'], base_version=1).status_code == 409
    assert client.get(f"/api/v1/dynamic-indicators/{first['id']}/versions/1").json() == first
    assert client.get(f"/api/v1/dynamic-indicators/{first['id']}").json() == second
    assert len(client.get('/api/v1/dynamic-indicators').json()['items']) == 1
    assert len(client.get('/api/v1/dynamic-indicators?include_history=true').json()['items']) == 2
    assert len(client.get(f"/api/v1/dynamic-indicators/{first['id']}/versions").json()['items']) == 2
    for table in ('dynamic_indicator_versions', 'dynamic_indicator_trials'):
        with pytest.raises(sqlite3.IntegrityError, match='immutable'), db.connect() as connection:
            connection.execute(f'DELETE FROM {table}')
        with pytest.raises(sqlite3.IntegrityError, match='immutable'), db.connect() as connection:
            connection.execute(f"UPDATE {table} SET created_at='changed'")
    profile['sha256'] = 'changed-after-save'
    # Completed requests replay their original result despite later source changes.
    assert save(client, trial).json() == first


def test_persisted_trial_is_conversation_scoped_and_server_context_wins(setup):
    client, _, _ = setup
    trial = di.preview_indicator({'definition': definition(), 'stock_code': '600000.SH', 'as_of': '2026-01-12', 'conversation_id': 'untrusted-id'}, conversation_id='actual-id', turn_id='turn-1')
    assert trial['conversation_id'] == 'actual-id'
    assert trial['turn_id'] == 'turn-1'
    summary = client.get('/api/v1/dynamic-indicators/trials?conversation_id=actual-id').json()['items'][0]
    assert summary['trial_id'] == trial['trial_id']
    assert summary['name'] == trial['definition']['name']
    assert 'chart' not in summary and 'series' not in summary and 'definition' not in summary
    assert client.get('/api/v1/dynamic-indicators/trials?conversation_id=untrusted-id').json()['items'] == []
    assert client.get(f"/api/v1/dynamic-indicators/trials/{trial['trial_id']}").json() == trial
    assert client.get('/api/v1/dynamic-indicators/trials/not-there').status_code == 404


@pytest.mark.parametrize('source', [
    "def compute(context, frames, params):\n return {'dates':{c:list(f['trade_date']) for c,f in frames.items()},'series':{c:{'trend':[None,None]+[float(f['close'][-1])]*(len(f['close'])-2)} for c,f in frames.items()}}",
    "def compute(context, frames, params):\n return {'dates':{c:list(f['trade_date']) for c,f in frames.items()},'series':{c:{'trend':[None,None]+[float(len(f['close']))]*(len(f['close'])-2)} for c,f in frames.items()}}",
])
def test_lookahead_or_global_length_dependent_sources_fail_without_saveable_trial(setup, source):
    client, _, _ = setup
    raw = definition()
    raw['program']['source_code'] = source
    response = preview(client, raw)
    assert response.status_code == 422
    assert response.json()['detail']['code'] == 'indicator_lookahead_detected'
    assert client.get('/api/v1/dynamic-indicators/trials').json()['items'] == []


def test_all_null_and_uncompared_warmup_are_visible_but_not_saveable(setup):
    client, _, _ = setup
    raw = definition()
    raw['program']['parameters']['window'] = 20
    trial = preview(client, raw).json()
    assert trial['validation']['saveable'] is False
    assert trial['validation']['numeric_count'] == {'trend': 0}
    assert save(client, trial).status_code == 422
    raw['program']['parameters']['window'] = 12
    raw['program']['required_history_bars'] = 12
    trial = preview(client, raw).json()
    assert trial['validation']['numeric_count'] == {'trend': 1}
    assert trial['validation']['saveable'] is False


@pytest.mark.parametrize('change', ['fingerprint', 'basis', 'input', 'calendar'])
def test_stale_trial_context_cannot_be_saved(setup, monkeypatch, change):
    client, rows, profile = setup
    trial = preview(client).json()
    if change == 'fingerprint':
        monkeypatch.setattr(market, 'source_fingerprint', lambda: ('fixture', 100, 2))
    elif change == 'basis':
        profile['price_basis'] = 'forward_adjusted'
    elif change == 'input':
        rows[5]['close'] = 3.5
    else:
        monkeypatch.setattr(market, 'latest_market_date', lambda _: '2026-01-13')
    response = save(client, trial)
    assert response.status_code == 409
    assert response.json()['detail']['code'] == 'indicator_stale_trial'
    assert not client.get('/api/v1/dynamic-indicators').json()['items']


def test_stale_stock_and_quality_gaps_are_explicit(setup, monkeypatch):
    client, rows, _ = setup
    rows[5]['quality_valid'] = False
    trial = preview(client).json()
    assert trial['chart']['bars'][5]['quality_valid'] is False
    assert trial['series']['trend'][5:8] == [None, None, None]
    assert trial['validation']['saveable'] is True
    monkeypatch.setattr(market, 'latest_market_date', lambda _: '2026-01-13')
    trial = preview(client).json()
    assert trial['validation']['stale'] is True
    assert trial['validation']['saveable'] is False
    assert save(client, trial).status_code == 422


def test_full_series_not_truncated_and_mixed_charts_keep_alignment(setup):
    client, records, profile = setup
    records[:] = bars(160)
    profile['last_date'] = records[-1]['trade_date']
    raw = definition()
    raw['program']['source_code'] = SOURCE.replace("series[code] = {'trend': values}", "series[code] = {'trend': values, 'momentum': [None if x is None else x * 0.01 for x in values]}")
    raw['outputs'].append({'name': 'momentum', 'label': '动量', 'unit': '%', 'placement': 'pane', 'kind': 'histogram'})
    trial = preview(client, raw, as_of=profile['last_date']).json()
    assert len(trial['dates']) == len(trial['series']['trend']) == 160
    assert [chart['placement'] for chart in trial['charts']] == ['overlay', 'pane']
    assert all(len(chart['bars']) == 160 for chart in trial['charts'])
    assert len(trial['charts'][1]['histogram']['values']) == 160


def test_invalid_override_is_422_not_server_error(setup):
    client, _, _ = setup
    for override in ({'window': True}, {'window': '5'}, {'window': 100}, {'other': 5}):
        response = preview(client, parameter_overrides=override)
        assert response.status_code == 422, response.text


def test_saved_comparison_supports_crosses_and_unknown_missing_stock(setup):
    client, rows, _ = setup
    trial = preview(client).json()
    saved = save(client, trial).json()
    condition = di.build_condition(saved['id'], {'version': 1, 'output': 'trend', 'operator': 'cross_above', 'threshold': 10})
    assert condition['provenance']['required_input_bars'] == 12
    result = program_conditions.evaluate_batch(condition['condition'], {}, ['600000.SH', '600001.SH'], {'600000.SH': rows, '600001.SH': rows[:-1]}, as_of='2026-01-12', effective_market_date='2026-01-12')
    assert result['600000.SH']['state'] == 'true'
    assert result['600001.SH']['state'] == 'unknown'
    assert client.post(f"/api/v1/dynamic-indicators/{saved['id']}/condition", json={'version': 1, 'output': 'missing', 'operator': 'gt', 'threshold': 1}).status_code == 422
    assert client.post(f"/api/v1/dynamic-indicators/{saved['id']}/condition", json={'version': 1, 'output': 'trend', 'operator': 'gt', 'threshold': True}).status_code == 422


def test_cancelled_preview_persists_no_trial(setup):
    client, _, _ = setup
    with pytest.raises(runtime_executor.RuntimeCancelled):
        di.preview_indicator({'definition': definition(), 'stock_code': '600000.SH', 'as_of': '2026-01-12'}, is_active=lambda: False)
    assert not client.get('/api/v1/dynamic-indicators/trials').json()['items']


def test_frozen_condition_rejects_changed_parameters(setup):
    client, rows, _ = setup
    saved = save(client, preview(client).json()).json()
    condition = di.build_condition(saved['id'], {'version': 1, 'output': 'trend', 'operator': 'gt', 'threshold': 1})['condition']
    with pytest.raises(ValueError, match='固定版本的参数'):
        program_conditions.evaluate_batch(condition, {'parameter_overrides': {'window': 4}}, ['600000.SH'], {'600000.SH': rows}, as_of='2026-01-12', effective_market_date='2026-01-12')


def test_numpy_scalar_and_tuple_outputs_match_preview_and_screening(setup):
    client, rows, _ = setup
    raw = definition()
    raw['program']['source_code'] = SOURCE.replace("series[code] = {'trend': values}", "series[code] = {'trend': tuple(np.float64(x) if x is not None else None for x in values)}")
    trial_response = preview(client, raw)
    assert trial_response.status_code == 200, trial_response.text
    trial = trial_response.json()
    saved = save(client, trial).json()
    condition = di.build_condition(saved['id'], {'version': 1, 'output': 'trend', 'operator': 'gt', 'threshold': 10})['condition']
    result = program_conditions.evaluate_batch(condition, {}, ['600000.SH'], {'600000.SH': rows}, as_of='2026-01-12', effective_market_date='2026-01-12')
    assert result['600000.SH']['state'] == 'true'
    assert result['600000.SH']['metrics']['trend'] == trial['series']['trend'][-1]


def test_overlay_histogram_is_rejected_instead_of_silently_disappearing(setup):
    client, _, _ = setup
    raw = definition()
    raw['outputs'][0]['kind'] = 'histogram'
    response = preview(client, raw)
    assert response.status_code == 422


@pytest.mark.parametrize('key,new_value', [('price_basis', 'forward_adjusted'), ('volume_unit', 'lots'), ('amount_unit', 'thousand_CNY')])
def test_saved_condition_rejects_semantic_data_context_drift_at_build_and_execute(setup, key, new_value):
    client, rows, profile = setup
    saved = save(client, preview(client).json()).json()
    payload = {'version': 1, 'output': 'trend', 'operator': 'gt', 'threshold': 10}
    condition = di.build_condition(saved['id'], payload)['condition']
    profile[key] = new_value
    with pytest.raises(di.IndicatorError, match='口径或单位'):
        di.build_condition(saved['id'], payload)
    with pytest.raises(ValueError, match='口径或单位'):
        program_conditions.evaluate_batch(condition, {}, ['600000.SH'], {'600000.SH': rows}, as_of='2026-01-12', effective_market_date='2026-01-12')


def test_saved_condition_allows_new_source_data_with_same_semantics(setup):
    client, rows, profile = setup
    saved = save(client, preview(client).json()).json()
    profile['sha256'] = 'new-bars-same-units-and-basis'
    condition = di.build_condition(saved['id'], {'version': 1, 'output': 'trend', 'operator': 'gt', 'threshold': 10})['condition']
    result = program_conditions.evaluate_batch(condition, {}, ['600000.SH'], {'600000.SH': rows}, as_of='2026-01-12', effective_market_date='2026-01-12')
    assert result['600000.SH']['state'] == 'true'


def test_http_disconnection_cancels_execution_callback_without_persisting(setup, monkeypatch):
    import asyncio
    from fastapi import HTTPException
    from apps.api.app import dynamic_indicator_api

    client, _, _ = setup
    class DisconnectedRequest:
        async def is_disconnected(self):
            return True
    observed = []
    def cancelled_compute(payload, **kwargs):
        observed.append(kwargs['is_active']())
        if not kwargs['is_active']():
            raise runtime_executor.RuntimeCancelled('cancelled')
        raise AssertionError('Disconnected request must stop before work')
    monkeypatch.setattr(di, 'preview_indicator', cancelled_compute)
    payload = di.PreviewIndicatorRequest.model_validate({'definition': definition(), 'stock_code': '600000.SH', 'as_of': '2026-01-12'})
    with pytest.raises(HTTPException) as error:
        asyncio.run(dynamic_indicator_api.preview_indicator(payload, DisconnectedRequest()))
    assert error.value.status_code == 409
    assert observed == [False]
    assert not client.get('/api/v1/dynamic-indicators/trials').json()['items']


def test_http_disconnect_during_execution_stops_worker_and_never_persists(setup, monkeypatch):
    import asyncio
    import threading
    import time
    from fastapi import HTTPException
    from apps.api.app import dynamic_indicator_api

    client, _, _ = setup
    started = threading.Event()
    cancelled = threading.Event()
    class DisconnectAfterStart:
        async def is_disconnected(self):
            return started.is_set()
    def slow_execution(**kwargs):
        started.set()
        deadline = time.monotonic() + 3
        while kwargs['is_active']() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert not kwargs['is_active'](), 'HTTP cancellation did not reach compute worker'
        cancelled.set()
        raise runtime_executor.RuntimeCancelled('cancelled during execution')
    monkeypatch.setattr(runtime_executor, 'execute_program', slow_execution)
    payload = di.PreviewIndicatorRequest.model_validate({'definition': definition(), 'stock_code': '600000.SH', 'as_of': '2026-01-12'})
    with pytest.raises(HTTPException) as error:
        asyncio.run(dynamic_indicator_api.preview_indicator(payload, DisconnectAfterStart()))
    assert error.value.status_code == 409
    assert started.is_set() and cancelled.is_set()
    assert not client.get('/api/v1/dynamic-indicators/trials').json()['items']


def test_cancellation_after_prefix_checks_prevents_late_persist(setup, monkeypatch):
    import threading
    client, _, _ = setup
    stopped = threading.Event()
    checks = di._prefix_checks
    def cancel_after_checks(*args, **kwargs):
        result = checks(*args, **kwargs)
        stopped.set()
        return result
    monkeypatch.setattr(di, '_prefix_checks', cancel_after_checks)
    with pytest.raises(runtime_executor.RuntimeCancelled):
        di.preview_indicator({'definition': definition(), 'stock_code': '600000.SH', 'as_of': '2026-01-12'}, is_active=lambda: not stopped.is_set())
    assert not client.get('/api/v1/dynamic-indicators/trials').json()['items']


def test_maximum_source_size_still_fits_frozen_screening_program(setup):
    client, _, _ = setup
    raw = definition()
    raw['program']['source_code'] += '#' + ('x' * (25_999 - len(raw['program']['source_code'])))
    assert len(raw['program']['source_code']) == 26_000
    trial = preview(client, raw).json()
    saved = save(client, trial).json()
    frozen = di.build_condition(saved['id'], {'version': 1, 'output': 'trend', 'operator': 'gt', 'threshold': 10})
    assert len(frozen['condition']['program']['source_code']) < 32_000
