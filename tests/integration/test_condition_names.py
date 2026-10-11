from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from apps.api.app import condition_language, db, main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'names.db')
    monkeypatch.setattr(condition_language, 'llm_settings', lambda: {'configured': False})
    with TestClient(main.app) as session:
        yield session


def payload(name='价格条件', **changes):
    return {'library': 'technical', 'name': name,
            'expression': {'op': 'indicator_compare', 'indicator': 'sma', 'field': 'close', 'window': 2, 'operator': 'gt', 'value': 10}, **changes}


def test_new_conditions_reject_duplicate_names_without_extra_assets(client):
    first = client.post('/api/v1/filters', json=payload()).json()
    duplicate = client.post('/api/v1/filters', json=payload(expression={**first['expression'], 'value': 20}))
    assert duplicate.status_code == 409
    assert duplicate.json()['code'] == 'condition_name_conflict'
    assert duplicate.json()['message'] == '已有同名条件'
    assert duplicate.json()['details'] is None
    assert len(client.get('/api/v1/filters?include_history=true').json()['items']) == 1


@pytest.mark.parametrize('name', ['  RSI 20  ', 'rsi 20', 'ＲＳＩ ２０', 'RSI   20'])
def test_names_normalize_edge_whitespace_width_and_case(client, name):
    assert client.post('/api/v1/filters', json=payload('RSI 20')).status_code == 200
    result = client.post('/api/v1/filters', json=payload(name))
    assert result.status_code == 409 and result.json()['message'] == '已有同名条件'


def test_same_name_cannot_be_created_in_another_condition_category(client):
    client.post('/api/v1/filters', json=payload('订单改善'))
    report = payload('订单改善', library='report', expression={'op': 'evidence_query', 'evaluation_mode': 'rubric',
        'combine': 'all', 'lookback_calendar_days': 30,
        'criteria': [{'id': 'orders', 'label': '订单', 'question': '订单是否增长？', 'signals': [], 'counter_signals': []}]})
    assert client.post('/api/v1/filters', json=report).status_code == 409


def test_editing_own_condition_keeps_history_and_cannot_take_another_name(client):
    first = client.post('/api/v1/filters', json=payload('原条件')).json()
    client.post('/api/v1/filters', json=payload('其他条件'))
    update = payload('原条件', id=first['id'], base_version=1)
    same = client.post('/api/v1/filters', json=update)
    assert same.status_code == 200 and same.json()['version'] == 2
    conflict = client.post('/api/v1/filters', json={**update, 'base_version': 2, 'name': '其他条件'})
    assert conflict.status_code == 409 and conflict.json()['message'] == '已有同名条件'
    assert client.get(f"/api/v1/filters/{first['id']}").json()['version'] == 2


def test_names_of_old_revisions_do_not_block_current_assets(client):
    first = client.post('/api/v1/filters', json=payload('曾用名称')).json()
    assert client.post('/api/v1/filters', json=payload('当前名称', id=first['id'], base_version=1)).status_code == 200
    assert client.post('/api/v1/filters', json=payload('曾用名称')).status_code == 200


def test_natural_language_save_rejects_duplicate_and_rolls_back_entire_batch(client):
    client.post('/api/v1/filters', json=payload('已有条件'))
    draft = client.post('/api/v1/condition-drafts', json={'prompt': '收盘价高于2日均线且近2个交易日涨幅大于5%'}).json()
    edits = {draft['conditions'][0]['key']: {'name': '本应一起回滚'}, draft['conditions'][1]['key']: {'name': '已有条件'}}
    response = client.post(f"/api/v1/condition-drafts/{draft['id']}/confirm", json={'edits': edits})
    assert response.status_code == 409 and response.json()['message'] == '已有同名条件'
    assert [item['name'] for item in client.get('/api/v1/filters').json()['items']] == ['已有条件']
    assert client.get(f"/api/v1/condition-drafts/{draft['id']}").json()['saved'] is None
    edits[draft['conditions'][1]['key']]['name'] = '更改后可保存'
    assert client.post(f"/api/v1/condition-drafts/{draft['id']}/confirm", json={'edits': edits}).status_code == 200


def test_same_name_inside_one_generated_batch_is_rejected(client):
    draft = client.post('/api/v1/condition-drafts', json={'prompt': '收盘价高于2日均线且近2个交易日涨幅大于5%'}).json()
    edits = {item['key']: {'name': '同一个名称'} for item in draft['conditions']}
    assert client.post(f"/api/v1/condition-drafts/{draft['id']}/confirm", json={'edits': edits}).status_code == 409
    assert not client.get('/api/v1/filters').json()['items']


def test_simultaneous_creations_allow_only_one_named_condition(client):
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: client.post('/api/v1/filters', json=payload('并发条件')), range(4)))
    assert sorted(response.status_code for response in responses) == [200, 409, 409, 409]
    assert len(client.get('/api/v1/filters').json()['items']) == 1


def test_empty_names_are_not_saved_and_nonempty_names_are_trimmed(client):
    assert client.post('/api/v1/filters', json=payload('   ')).status_code == 422
    saved = client.post('/api/v1/filters', json=payload('  简洁名称  ')).json()
    assert saved['name'] == '简洁名称'
