import csv
import io
from datetime import date

import pytest
from fastapi.testclient import TestClient
from apps.api.app import conversation_store, db, main, market, product_api, security_catalog, worker
from apps.api.app.screening_contracts import ScreeningTaskRevision


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'product.db')
    monkeypatch.setattr(market, 'cached_profile', lambda: {'available': True, 'last_date': '2026-09-28'})
    with TestClient(main.app) as client:
        yield client


def make_task(client):
    cid = client.post('/api/v1/conversations', json={'entry_scope': 'screening', 'workflow_type': 'screening'}).json()['id']
    message = client.post(f'/api/v1/conversations/{cid}/messages', json={'client_message_id': 'first', 'base_revision': 0, 'content': '收盘价高于20日均线'}).json()
    task = ScreeningTaskRevision.model_validate({
        'task_id': cid, 'revision': 1, 'original_user_messages': ['收盘价高于20日均线'],
        'conditions': [{'condition_id': 'ma', 'library': 'technical', 'source_quote': '收盘价高于20日均线', 'description': '收盘价高于20日均线', 'expression': {'op': 'indicator_compare', 'window': 20}}],
        'references': [{'reference_id': 'r', 'condition_id': 'ma'}], 'logic_tree': {'op': 'condition', 'reference_id': 'r'},
        'scope': {'universe': {'kind': 'all_a_shares'}, 'as_of': '2026-09-14'}, 'unresolved': [],
    })
    conversation_store.save_task_revision(cid, 0, message['message_id'], task)
    conversation_store.finish_turn(cid, message['turn_id'], 1, 'succeeded', '已整理条件', {'ready_to_execute': False})
    return cid, message, task


def make_results(client):
    cid, message, task = make_task(client)
    now = db.utc_now()
    snapshot = {'task': task.model_dump(mode='json'), 'universe': {'kind': 'all_a_shares', 'codes': [f'{600000+i}.SH' for i in range(50)]}}
    with db.connect() as connection:
        connection.execute("INSERT INTO execution_requests VALUES('request',?,?,?,?,?,'{}',?)", (cid, message['turn_id'], 1, message['message_id'], 'once', now))
        connection.execute("INSERT INTO jobs(id,kind,payload_json,state,created_at,updated_at) VALUES('job','screening_task',?, 'running',?,?)", (db.json_dump({'run_id': 'run'}), now, now))
        connection.execute("INSERT INTO screening_task_runs(id,conversation_id,task_revision,execution_request_id,job_id,as_of,status,execution_version,snapshot_json,result_json,created_at) VALUES('run',?,1,'request','job','2026-09-14','running','screening-task-v1',?,'{}',?)", (cid, db.json_dump(snapshot), now))
        for i in range(50):
            code = f'{600000+i}.SH'
            state = 'true' if i < 45 else 'false' if i < 48 else 'unknown'
            value = {'stock_code': code, 'state': state, 'condition_decisions': [{'explanation': '=test formula' if i == 0 else '来自历史计算'}]}
            connection.execute("INSERT INTO screening_task_decisions VALUES('run',?,?,'completed','ok',?)", (code, state, db.json_dump(value)))
        connection.execute("UPDATE jobs SET state='succeeded' WHERE id='job'")
        connection.execute("INSERT INTO security_catalog VALUES('600000.SH','浦发银行','pufayinhang','pfyh','SH',?)", (now,))
        connection.execute("INSERT INTO screening_runs(id,strategy_id,strategy_version,as_of,mode,status,result_json,created_at) VALUES('legacy','legacy-strategy',1,'2026-09-13','exploratory','succeeded','{}',?)", (now,))
    return cid


def test_export_and_copy_cover_every_matching_stock_and_search_names(client):
    cid = make_results(client)
    base = f'/api/v1/conversations/{cid}/screening-runs/run'
    codes = client.get(base + '/codes').json()
    assert codes['total'] == 45 and len(codes['items']) == 45
    assert '600045.SH' not in codes['items']
    rows = list(csv.reader(io.StringIO(client.get(base+'/export').text.lstrip('\ufeff'))))
    assert len(rows) == 46 and rows[1][1] == '浦发银行'
    assert rows[1][-1] == "'=test formula"
    assert {row[2] for row in rows[1:]} == {'符合'}
    assert client.get(base+'/codes?state=true&query=600049').json()['items'] == []
    for query in ('浦发', 'pfyh', 'pufa', '600000'):
        assert client.get(base+'/decisions', params={'query': query}).json()['total'] == 1
    assert client.get(base+'/codes?state=wrong').status_code == 422
    assert client.get('/api/v1/conversations/another/screening-runs/run/export').status_code == 404
    records = client.get('/api/v1/screening-history').json()['items']
    assert {item['kind'] for item in records} == {'legacy', 'conversation'}
    assert next(item for item in records if item['id'] == 'run')['name'] == '收盘价高于20日均线'


def test_scope_edit_is_atomic_idempotent_and_preserves_history(client, monkeypatch):
    cid = make_results(client)
    body = {'base_revision': 1, 'client_message_id': 'scope-edit', 'universe': {'kind': 'explicit', 'stock_codes': ['600000.SH']}, 'as_of': '2026-09-28'}
    url = f'/api/v1/conversations/{cid}/scope'
    response = client.post(url, json=body)
    assert response.status_code == 200, response.text
    assert client.post(url, json=body).json()['revision'] == 2
    task = client.get(f'/api/v1/conversations/{cid}/revisions/2').json()
    assert task['scope']['as_of'] == '2026-09-28'
    assert task['conditions'][0]['description'] == '收盘价高于20日均线'
    assert client.get(f'/api/v1/conversations/{cid}/screening-runs/run').json()['as_of'] == '2026-09-14'
    assert not client.get(f'/api/v1/conversations/{cid}').json()['pending_execution']
    assert client.post(url, json={**body, 'as_of': '2026-10-01'}).status_code == 422
    assert client.post(url, json={**body, 'as_of': '2026-09-27'}).status_code == 409
    def fail(*args, **kwargs):
        raise conversation_store.ConversationStoreError('synthetic rollback')
    monkeypatch.setattr(conversation_store, 'finish_turn', fail)
    before = client.get(f'/api/v1/conversations/{cid}').json()
    failed = client.post(url, json={**body, 'base_revision': 2, 'client_message_id': 'rollback'})
    assert failed.status_code == 409
    after = client.get(f'/api/v1/conversations/{cid}').json()
    assert after['task_revision'] == before['task_revision'] and after['messages'] == before['messages']


def test_data_update_reuses_pending_job_and_reports_partial_failure(client, monkeypatch):
    from apps.api.app import tushare_sync
    monkeypatch.setattr(security_catalog, 'refresh', lambda: 10)
    monkeypatch.setattr(tushare_sync, 'sync_tushare', lambda **kwargs: {'stages': {'market': {'status': 'up_to_date'}, 'news': {'status': 'failed'}}})
    first = client.post('/api/v1/maintenance/refresh').json()['job_id']
    assert client.post('/api/v1/maintenance/refresh').json()['job_id'] == first
    worker.execute_job(first)
    result = client.get('/api/v1/maintenance/status').json()['job']
    assert result['state'] == 'partial' and result['result']['names']['count'] == 10
    assert result['result']['news']['status'] == 'failed'
    assert client.post('/api/v1/maintenance/refresh').json()['job_id'] != first


def test_reuse_latest_date_changes_only_new_revision(client):
    cid, _, _ = make_task(client)
    saved = client.post(f'/api/v1/conversations/{cid}/saved-screening-tasks', json={'name': '趋势观察', 'request_id': 'save'}).json()
    new = client.post('/api/v1/conversations', json={'entry_scope': 'screening', 'workflow_type': 'screening'}).json()['id']
    message = client.post(f'/api/v1/conversations/{new}/messages', json={'client_message_id': 'reuse', 'base_revision': 0, 'content': '按2026-09-28行情复用方案'}).json()
    response = client.post(f'/api/v1/conversations/{new}/saved-screening-tasks/{saved["id"]}/reuse', json={'source_message_id': message['message_id'], 'base_revision': 0, 'version': 1, 'as_of': '2026-09-28'})
    assert response.status_code == 201, response.text
    assert client.get(f'/api/v1/conversations/{new}/revisions/1').json()['scope']['as_of'] == '2026-09-28'
    assert client.get(f'/api/v1/saved-screening-tasks/{saved["id"]}').json()['task']['scope']['as_of'] == '2026-09-14'
    assert client.get(f'/api/v1/conversations/{new}/screening-runs').json()['items'] == []
