from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from apps.api.app import conversation_store, db, main, market, runtime_executor, screening_runner, worker
from apps.api.app.screening_templates import TEMPLATES


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'templates.db')
    monkeypatch.setattr(market, 'cached_profile', lambda: {'available': True, 'last_date': '2026-09-14'})
    monkeypatch.setattr(market, 'daily_bar_source_available', lambda: True)
    monkeypatch.setattr(market, 'source_fingerprint', lambda: ('synthetic.parquet', 1000, 1))
    monkeypatch.setattr(market, 'latest_market_date', lambda _: '2026-09-14')
    monkeypatch.setattr(market, 'security_codes', lambda _: ['600000.SH', '600001.SH', '600002.SH'])
    monkeypatch.setattr(runtime_executor, 'readiness', lambda: {'ready': True, 'backend': 'local_python'})
    # Run the exact published source through the real runner's immutable frames.
    # Only subprocess transport is bypassed; results are not mocked.
    monkeypatch.setattr(runtime_executor, 'execute_program', lambda **kw: screening_runner._execute({key: kw[key] for key in ('source_code', 'context', 'frames', 'params')}))
    with TestClient(main.app) as session:
        yield session


def setup_plan(client, template_id='above_sma', params=None, workflow='screening'):
    cid = client.post('/api/v1/conversations', json={'entry_scope': 'screening', 'workflow_type': workflow}).json()['id']
    msg = {}
    template = next(t for t in TEMPLATES if t['id'] == template_id)
    payload = {'base_revision': 0, 'client_message_id': 'template-message', 'version': 1, 'parameters': params or {k: v['default'] for k, v in template['parameters'].items()}, 'as_of': '2026-09-14', 'universe': {'kind': 'all_a_shares'}}
    return cid, msg, f'/api/v1/conversations/{cid}/screening-templates/{template_id}', payload


@pytest.mark.parametrize('template_id', ['above_sma', 'return_above', 'ma_cross'])
def test_full_deterministic_lifecycle(client, monkeypatch, template_id):
    cid, msg, url, payload = setup_plan(client, template_id)
    created = client.post(url, json=payload)
    assert created.status_code == 201, created.text
    msg = {'turn_id': created.json()['turn_id']}
    task = created.json()['task']
    assert task['conditions'][0]['program']['source_code'].startswith('def screen(')
    with db.connect() as connection:
        assert connection.execute('SELECT count(*) FROM jobs').fetchone()[0] == 0
    assert client.get(f'/api/v1/conversations/{cid}/screening-runs').json()['items'] == []
    current = client.get(f'/api/v1/conversations/{cid}').json()
    assert current['turns'][0]['result']['execution_authorized'] is False
    assert not current['pending_execution']
    replay = client.post(url, json=payload)
    assert replay.status_code == 201 and replay.json()['idempotent_replay']
    assert len(client.get(f'/api/v1/conversations/{cid}').json()['messages']) == len(current['messages'])
    assert client.post(url, json={**payload, 'parameters': {**payload['parameters'], next(iter(payload['parameters'])): 4}}).status_code == 409
    execute_url = f"/api/v1/conversations/{cid}/turns/{msg['turn_id']}/execute"
    assert client.post(execute_url, json={'action': 'message'}).status_code == 409
    assert client.post(execute_url, json={'action': 'button', 'revision': 2, 'request_id': 'wrong'}).status_code == 409
    confirmation = {'action': 'button', 'revision': 1, 'request_id': 'confirmed'}
    queued = client.post(execute_url, json=confirmation)
    assert queued.status_code == 202, queued.text
    assert client.post(execute_url, json=confirmation).json()['run_id'] == queued.json()['run_id']
    def bars(_date, limit, codes):
        def rows(prices):
            return [{'trade_date': (date(2026, 9, 14) - timedelta(days=len(prices)-1-i)).isoformat(), 'close': price, 'quality_valid': True} for i, price in enumerate(prices)]
        winning = [10.] * (limit-1) + [12.]
        losing = [10.] * (limit-1) + [8.]
        return [('600000.SH', rows(winning)), ('600001.SH', rows(losing)), ('600002.SH', [])]
    monkeypatch.setattr(market, 'iter_recent_bars', bars)
    assert worker.execute_job(queued.json()['job_id'])
    result_url = f"/api/v1/conversations/{cid}/screening-runs/{queued.json()['run_id']}"
    run = client.get(result_url).json()
    assert run['status'] == 'partial', run
    decisions = client.get(result_url + '/decisions').json()['items']
    assert {item['stock_code']: item['state'] for item in decisions} == {'600000.SH': 'true', '600001.SH': 'false', '600002.SH': 'unknown'}
    assert all(d['reason_code'] != 'unsupported_capability' for item in decisions for d in item['condition_decisions'])


@pytest.mark.parametrize('changes', [
    {'parameters': {'window': 0}}, {'parameters': {'window': 10**400}}, {'parameters': {'window': 2.5}}, {'parameters': {'window': True}},
    {'parameters': {'window': 20, 'code': 1}}, {'source_code': 'anything'}, {'version': 99},
    {'as_of': '2026-10-01'}, {'as_of': 'bad'}, {'universe': {'kind': 'watchlist', 'watchlist_id': 'missing'}},
])
def test_invalid_payload_never_publishes(client, changes):
    cid, _, url, payload = setup_plan(client)
    assert client.post(url, json={**payload, **changes}).status_code == 422
    assert client.get(f'/api/v1/conversations/{cid}').json()['task_revision'] == 0


def test_research_running_archived_and_stale_guards(client):
    cid, _, url, payload = setup_plan(client, workflow='research')
    assert client.post(url, json=payload).status_code == 409
    assert client.get(f'/api/v1/conversations/{cid}').json()['task_revision'] == 0
    cid, msg, url, payload = setup_plan(client)
    msg = conversation_store.add_user_message(cid, 'other', 0, '另一条消息')
    conversation_store.start_turn(cid, msg['turn_id'])
    assert client.post(url, json=payload).status_code == 409


def test_atomic_publication_rolls_back(client, monkeypatch):
    cid, _, url, payload = setup_plan(client)
    def fail(*args, **kwargs):
        raise conversation_store.ConversationConflict('publish failed')
    monkeypatch.setattr(conversation_store, 'finish_turn', fail)
    assert client.post(url, json=payload).status_code == 409
    assert client.get(f'/api/v1/conversations/{cid}').json()['task_revision'] == 0


def test_invalid_then_changed_valid_input_has_no_orphan_turn(client):
    cid, _, url, payload = setup_plan(client)
    assert client.post(url, json={**payload, 'parameters': {'window': 1}}).status_code == 422
    current = client.get(f'/api/v1/conversations/{cid}').json()
    assert current['messages'] == [] and current['turns'] == []
    response = client.post(url, json={**payload, 'client_message_id': 'corrected', 'parameters': {'window': 10}})
    assert response.status_code == 201
    assert client.get(f'/api/v1/conversations/{cid}').json()['task_revision'] == 1


def test_archived_stale_requests_do_not_add_messages(client):
    cid, _, url, payload = setup_plan(client)
    assert client.post(url, json=payload).status_code == 201
    before = client.get(f'/api/v1/conversations/{cid}').json()
    assert client.post(url, json={**payload, 'client_message_id': 'stale'}).status_code == 409
    assert len(client.get(f'/api/v1/conversations/{cid}').json()['messages']) == len(before['messages'])
    with db.connect() as connection:
        connection.execute("UPDATE conversations SET state='archived' WHERE id=?", (cid,))
    assert client.post(url, json={**payload, 'base_revision': 1, 'client_message_id': 'archived'}).status_code == 409


def test_runtime_unavailable_blocks_execution_but_not_plan(client, monkeypatch):
    monkeypatch.setattr(runtime_executor, 'readiness', lambda: {'ready': False, 'reason': '运行时未安装'})
    cid, _, url, payload = setup_plan(client)
    plan = client.post(url, json=payload)
    assert plan.status_code == 201
    execute = client.post(f"/api/v1/conversations/{cid}/turns/{plan.json()['turn_id']}/execute", json={'action': 'button', 'revision': 1, 'request_id': 'runtime-check'})
    assert execute.status_code == 503 and execute.json()['code'] == 'runtime_unavailable'
    assert client.get(f'/api/v1/conversations/{cid}/screening-runs').json()['items'] == []
