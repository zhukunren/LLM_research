from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from apps.api.app import conversation_store, db, main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'history.db')
    with TestClient(main.app) as session:
        yield session


def create(client):
    response = client.post('/api/v1/conversations', json={'entry_scope': 'screening', 'workflow_type': 'research'})
    assert response.status_code == 200, response.text
    return response.json()['id']


def test_rename_pin_survive_reload_without_changing_messages_or_recency(client):
    first, second = create(client), create(client)
    question = conversation_store.add_user_message(first, 'question', 0, '原始研究问题')
    conversation_store.start_turn(first, question['turn_id'])
    conversation_store.finish_turn(first, question['turn_id'], 0, 'succeeded', '研究答复', {})
    before = client.get(f'/api/v1/conversations/{first}').json()
    response = client.patch(f'/api/v1/conversations/{first}', json={'title': '  新名称  ', 'pinned': True})
    assert response.status_code == 200
    db.init_db()
    after = client.get(f'/api/v1/conversations/{first}').json()
    assert after['title'] == '新名称' and after['pinned'] is True
    assert after['messages'] == before['messages'] and after['updated_at'] == before['updated_at']
    items = client.get('/api/v1/conversations?workflow_type=research&state=active').json()['items']
    assert items[0]['id'] == first and items[0]['title'] == '新名称'
    assert any(item['id'] == second for item in items)
    assert client.patch(f'/api/v1/conversations/{first}', json={'pinned': False}).status_code == 200
    assert not client.get(f'/api/v1/conversations/{first}').json()['pinned']


@pytest.mark.parametrize('changes', [{}, {'title': '   '}, {'title': 'x' * 121}, {'title': None}, {'pinned': None}, {'state': None}, {'state': 'deleted'}, {'deleted_at': 'now'}])
def test_invalid_history_changes_are_rejected(client, changes):
    cid = create(client)
    assert client.patch(f'/api/v1/conversations/{cid}', json=changes).status_code == 422
    assert client.get(f'/api/v1/conversations/{cid}').json()['state'] == 'active'


def test_archive_restore_and_deleted_history_filters(client):
    cid = create(client)
    url = f'/api/v1/conversations/{cid}'
    assert client.patch(url, json={'state': 'archived'}).status_code == 200
    assert client.get('/api/v1/conversations?state=active').json()['items'] == []
    assert client.get('/api/v1/conversations?state=archived').json()['items'][0]['id'] == cid
    assert client.get(url).status_code == 200
    assert client.post(url + '/messages', json={'client_message_id': 'archived', 'base_revision': 0, 'content': '追问'}).status_code == 409
    assert client.patch(url, json={'state': 'active'}).status_code == 200
    assert client.get('/api/v1/conversations?state=active').json()['items'][0]['id'] == cid
    assert client.delete(url).status_code == 204
    assert client.get('/api/v1/conversations').json()['items'] == []
    for method, suffix, payload in [('get', '', None), ('get', '/export', None), ('patch', '', {'state': 'active'}), ('patch', '/project', {'project_id': None})]:
        assert client.request(method, url + suffix, **({'json': payload} if payload is not None else {})).status_code == 404


def test_active_research_cannot_be_archived_or_deleted(client):
    cid = create(client)
    url = f'/api/v1/conversations/{cid}'
    conversation_store.add_user_message(cid, 'active', 0, '继续研究')
    assert client.patch(url, json={'state': 'archived'}).status_code == 409
    assert client.delete(url).status_code == 409
    assert client.patch(url, json={'title': '研究中也能命名', 'pinned': True}).status_code == 200
    assert client.get(url).json()['state'] == 'active'


def test_project_uses_renamed_title_and_keeps_saved_notes_after_deletion(client):
    project = client.post('/api/v1/research-projects', json={'name': '测试项目', 'request_id': 'project'}).json()
    cid = create(client)
    url = f'/api/v1/conversations/{cid}'
    turn = conversation_store.add_user_message(cid, 'question', 0, '研究问题')
    conversation_store.start_turn(cid, turn['turn_id'])
    conversation_store.finish_turn(cid, turn['turn_id'], 0, 'succeeded', '需要保留的研究证据', {})
    answer = conversation_store.get_conversation(cid)['messages'][-1]
    assert client.patch(url + '/project', json={'project_id': project['id']}).status_code == 200
    assert client.post(f"/api/v1/research-projects/{project['id']}/notes/from-message", json={'message_id': answer['id']}).status_code == 200
    assert client.patch(url, json={'title': '重命名研究'}).status_code == 200
    detail_url = f"/api/v1/research-projects/{project['id']}"
    assert client.get(detail_url).json()['conversations'][0]['title'] == '重命名研究'
    assert client.delete(url).status_code == 204
    detail = client.get(detail_url).json()
    assert detail['conversations'] == []
    assert detail['notes'][0]['body'] == '需要保留的研究证据'
    assert client.get('/api/v1/research-projects').json()['items'][0]['conversation_count'] == 0


def test_export_includes_entire_conversation_in_order(client):
    cid = create(client)
    with db.connect() as connection:
        for index in range(105):
            connection.execute('INSERT INTO conversation_messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)',
                               (f'message-{index}', cid, 'user' if index % 2 == 0 else 'assistant', f'第{index}条消息', db.utc_now()))
    client.patch(f'/api/v1/conversations/{cid}', json={'title': '完整对话'})
    response = client.get(f'/api/v1/conversations/{cid}/export')
    assert response.status_code == 200
    assert response.headers['content-type'].startswith('text/markdown')
    assert '.md' in response.headers['content-disposition']
    assert response.text.startswith('# 完整对话\n')
    assert '第0条消息' in response.text and '第104条消息' in response.text
    assert response.text.index('第0条消息') < response.text.index('第104条消息')
    assert response.text.count('## ') == 105
