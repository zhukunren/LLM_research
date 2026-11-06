from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from apps.api.app import condition_builder, db, main, market, news_adapter, report_adapter, worker


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "builder.db")
    monkeypatch.setattr(market, "cached_profile", lambda: {"available": True, "last_date": "2026-10-20"})
    monkeypatch.setattr(market, "source_fingerprint", lambda: ("fixture", 100, 1))
    bars = [{"trade_date": (date(2026, 10, 20) - timedelta(days=29-i)).isoformat(),
             "open": 10+i, "high": 12+i, "low": 9+i, "close": 11+i, "volume": 100., "amount": 1000., "quality_valid": True} for i in range(30)]
    monkeypatch.setattr(market, "get_bars", lambda code, as_of, count: [bar for bar in bars if bar["trade_date"] <= as_of][-count:])
    with TestClient(main.app) as session:
        yield session


def technical():
    return {"kind": "technical", "template_id": "above_sma", "template_version": 1, "parameters": {"window": 5}}


def trial(client, definition):
    response = client.post('/api/v1/condition-builder/preview', json={"definition": definition, "stock_code": "600000.SH", "as_of": "2026-10-20"})
    assert response.status_code == 200, response.text
    return response.json()


def save(client, preview, name="可复用样本条件", definition=None):
    return client.post('/api/v1/condition-builder/save', json={"builder_draft_id": preview["builder_draft_id"], "definition": definition or preview["definition"], "name": name})


def test_technical_trial_is_read_only_and_save_freezes_the_rule_and_its_sample(client):
    preview = trial(client, technical())
    assert preview['result']['state'] == 'true'
    assert client.get('/api/v1/filters').json()['items'] == []
    assert client.get('/api/v1/condition-drafts').json()['items'] == []
    response = save(client, preview)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved['asset_kind'] == 'filter'
    assert saved['reference']['version'] == 1
    assert saved['asset']['expression']['window'] == 5
    assert saved['asset']['provenance']['sample'] == {'stock_code': '600000.SH', 'as_of': '2026-10-20'}
    assert saved['asset']['provenance']['sample_state'] == 'true'
    assert client.post('/api/v1/strategies/validate', json={'tree': {'op': 'all', 'children': [saved['reference']]}}).json()['valid']
    with db.connect() as connection:
        assert connection.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 0


def test_save_is_atomic_idempotent_and_rejects_changed_rules(client):
    preview = trial(client, technical())
    changed = {**technical(), 'parameters': {'window': 10}}
    assert save(client, preview, definition=changed).status_code == 409
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: save(client, preview), range(5)))
    assert all(response.status_code == 200 for response in responses)
    assert len({response.json()['asset']['id'] for response in responses}) == 1
    assert len(client.get('/api/v1/filters?include_history=true').json()['items']) == 1
    assert save(client, preview, name='另一个名称').status_code == 409


@pytest.mark.parametrize('update', [
    {'parameters': {'window': True}}, {'parameters': {'window': 0}},
    {'template_id': 'trend_momentum', 'parameters': {'ma_window': 20, 'return_window': 5, 'threshold': 3}},
])
def test_rejects_invalid_parameters_or_multi_condition_templates(client, update):
    response = client.post('/api/v1/condition-builder/preview', json={'definition': {**technical(), **update}, 'stock_code': '600000.SH', 'as_of': '2026-10-20'})
    assert response.status_code == 422
    assert client.get('/api/v1/filters').json()['items'] == []


@pytest.mark.parametrize('kind', ['news', 'report'])
def test_evidence_conditions_preserve_semantics_evidence_and_reusable_date_window(client, monkeypatch, kind):
    adapter = news_adapter if kind == 'news' else report_adapter
    monkeypatch.setattr(adapter, 'llm_settings', lambda: {'configured': True})
    seen = []
    def analyze(request, stock_code, as_of, provider, **kwargs):
        seen.append((request.model_dump(), stock_code, as_of))
        return {'state': 'true', 'reason_code': 'condition_met', 'explanation': '原文支持实际实施。',
                'evidence': [{'source_id': 'source-one', 'page_number': 2, 'char_start': 0, 'char_end': 7, 'quote': '已实际实施回购'}], 'coverage': {'read': 1}}
    monkeypatch.setattr(adapter, 'analyze', analyze)
    definition = {'kind': kind, 'question': '核对已经实施的回购，排除仅有计划', 'fact_requirement': 'actual', 'event_requirement': 'in_progress' if kind == 'news' else 'any', 'lookback_calendar_days': 90, 'numeric_requirement': True, 'quantifier': 'all', 'minimum_independent_events': 2 if kind == 'news' else 1}
    preview = trial(client, definition)
    assert preview['result']['evidence'][0]['quote'] == '已实际实施回购'
    assert seen[0][0]['numeric_requirement'] is True
    assert seen[0][0]['fact_requirement'] == 'actual'
    assert seen[0][0]['quantifier'] == 'all'
    assert seen[0][0]['minimum_independent_events'] == (2 if kind == 'news' else 1)
    response = save(client, preview, name=f'{kind}实际回购条件')
    assert response.status_code == 200, response.text
    asset = response.json()['asset']
    assert asset['expression']['evaluation_mode'] == 'question'
    assert asset['expression']['lookback_calendar_days'] == 90
    assert 'terms' not in asset['expression']
    assert 'as_of' not in asset['expression']
    assert client.post('/api/v1/strategies/validate', json={'tree': {'op': 'all', 'children': [response.json()['reference']]}}).json()['valid']


def test_insufficient_evidence_stays_unknown_and_failures_are_not_empty_results(client, monkeypatch):
    definition = {'kind': 'news', 'question': '核对实际回购', 'fact_requirement': 'actual', 'lookback_calendar_days': 30}
    monkeypatch.setattr(news_adapter, 'llm_settings', lambda: {'configured': False})
    preview = trial(client, definition)
    assert preview['result']['state'] == 'unknown'
    assert '模型' in preview['result']['reason']
    assert save(client, preview).status_code == 200
    def broken(*args, **kwargs):
        raise RuntimeError('provider failed')
    monkeypatch.setattr(condition_builder, 'evaluate_question', broken)
    response = client.post('/api/v1/condition-builder/preview', json={'definition': definition, 'stock_code': '600000.SH', 'as_of': '2026-10-20'})
    assert response.status_code == 502


def test_pattern_condition_copies_a_fixed_template_without_modifying_the_source(client):
    payload = {'name': '原始上涨目标', 'input_type': 'drawing', 'representation': 'price_path', 'target_bars': 20, 'points': list(range(20)), 'params': {'min_similarity': 75, 'match_mode': 'current'}}
    original = client.post('/api/v1/patterns', json=payload).json()
    definition = {'kind': 'pattern', 'pattern_id': original['id'], 'pattern_version': 1, 'minimum_similarity': 82, 'match_mode': 'recent', 'recent_bars': 5}
    preview = trial(client, definition)
    response = save(client, preview, name='上涨形态匹配条件')
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved['asset_kind'] == 'pattern'
    assert saved['asset']['id'] != original['id']
    assert saved['asset']['points'] == original['points']
    assert saved['asset']['derivation']['source_pattern_version'] == 1
    assert saved['reference']['min_similarity'] == 82
    assert saved['reference']['recent_bars'] == 5
    assert saved['asset']['params']['match_mode'] == 'recent'
    source = next(item for item in client.get('/api/v1/patterns').json()['items'] if item['id'] == original['id'])
    assert source['params']['min_similarity'] == 75
    assert source['version'] == 1
    assert client.post('/api/v1/strategies/validate', json={'tree': {'op': 'all', 'children': [saved['reference']]}}).json()['valid']


def test_old_confirmation_endpoint_cannot_treat_a_builder_trial_as_a_language_draft(client):
    preview = trial(client, technical())
    assert client.post(f"/api/v1/condition-drafts/{preview['builder_draft_id']}/confirm", json={}).status_code == 422
    assert client.get('/api/v1/filters').json()['items'] == []


def test_legacy_shape_cannot_silently_ignore_a_recent_window_request(client):
    from apps.api.app.db import json_dump, utc_now
    with db.connect() as connection:
        content = {'input_type': 'drawing', 'representation': 'price_path', 'algorithm_version': 'normalized-path-v1', 'target_bars': 20, 'points': list(range(20)), 'params': {}}
        connection.execute('INSERT INTO patterns(id,name,version,pattern_json,created_at) VALUES(?,?,1,?,?)', ('old-shape', '旧目标', json_dump(content), utc_now()))
    definition = {'kind': 'pattern', 'pattern_id': 'old-shape', 'pattern_version': 1, 'minimum_similarity': 80, 'match_mode': 'recent', 'recent_bars': 10}
    response = client.post('/api/v1/condition-builder/preview', json={'definition': definition, 'stock_code': '600000.SH', 'as_of': '2026-10-20'})
    assert response.status_code == 422
    assert '旧版匹配算法' in response.text


def test_composition_evaluates_saved_questions_once_per_security_at_the_frozen_cutoff(monkeypatch):
    seen = []
    def evaluate(library, expression, code, as_of, **kwargs):
        seen.append((library, code, as_of, expression['lookback_calendar_days']))
        return {'state': 'true', 'reason': '已核对原文', 'evidence': [{'quote': '已实施'}]}
    monkeypatch.setattr(condition_builder, 'evaluate_question', evaluate)
    item = {'id': 'evidence', 'version': 1, 'library': 'news', 'name': '已实施回购', 'expression': condition_builder.question_expression(condition_builder.EvidenceDefinition(kind='news', question='核对实际实施', fact_requirement='actual', lookback_calendar_days=30))}
    node = {'op': 'filter_ref', 'filter_id': 'evidence', 'version': 1}
    state, details, _ = worker._eval_tree({'op': 'all', 'children': [node, node]}, '600000.SH', [], {('evidence', 1): item}, {}, {}, as_of='2026-09-30')
    assert state == 'true'
    assert len(details) == 2
    assert seen == [('news', '600000.SH', '2026-09-30', 30)]
