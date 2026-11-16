from datetime import timedelta
import base64
import hashlib
from dataclasses import asdict
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import requests

from apps.api.app import client_service_robots as robots, client_service as service, db
from apps.api.app.client_service_api import router

WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only-secret-key'


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'robots.db')
    db.init_db()
    app = FastAPI(); app.include_router(router)
    calls = []
    class Session:
        trust_env = True
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, **kwargs):
            calls.append((url, kwargs))
            assert self.trust_env is False
            return SimpleNamespace(status_code=200, json=lambda: {'errcode': 0})
    monkeypatch.setattr(robots.requests, 'Session', Session)
    return TestClient(app), calls


def create(client, **values):
    response = client.post('/api/v1/client-service/robots', json={'name': '测试群', 'webhook': WEBHOOK, **values})
    assert response.status_code == 201
    return response.json()


def test_robot_crud_masks_secrets_and_checks_revision(setup):
    client, calls = setup
    robot = create(client)
    listing = client.get('/api/v1/client-service/robots')
    assert 'test-only-secret-key' not in listing.text and 'webhook_key' not in listing.text
    assert calls == []
    saved = client.put('/api/v1/client-service/robots/' + robot['id'], json={'name': '更名群', 'webhook': None, 'revision': 0, 'enabled': False})
    assert saved.status_code == 200 and saved.json()['revision'] == 1
    assert client.put('/api/v1/client-service/robots/' + robot['id'], json={'name': '冲突', 'revision': 0}).status_code == 409
    with db.connect() as connection:
        assert connection.execute('SELECT webhook_key FROM client_service_robots').fetchone()[0] == 'test-only-secret-key'
    assert client.post('/api/v1/client-service/robots/' + robot['id'] + '/send', json={'request_id': 'disabled', 'kind': 'test'}).status_code == 422
    assert client.post('/api/v1/client-service/robots/' + robot['id'] + '/archive', json={'revision': 1}).status_code == 200
    assert client.get('/api/v1/client-service/robots').json()['items'] == []


@pytest.mark.parametrize('url', [
    'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=123456789',
    'https://127.0.0.1/cgi-bin/webhook/send?key=123456789',
    'https://qyapi.weixin.qq.com.evil.test/cgi-bin/webhook/send?key=123456789',
    'https://user@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=123456789',
    'https://qyapi.weixin.qq.com:444/cgi-bin/webhook/send?key=123456789',
    WEBHOOK + '&key=othersecret', WEBHOOK + '#fragment',
])
def test_only_canonical_wecom_webhooks_are_accepted(setup, url):
    client, calls = setup
    response = client.post('/api/v1/client-service/robots', json={'name': 'test', 'webhook': url})
    assert response.status_code == 422 and url not in response.text and not calls


def test_delivery_is_idempotent_and_does_not_follow_redirects(setup):
    client, calls = setup
    robot = create(client)
    endpoint = '/api/v1/client-service/robots/' + robot['id'] + '/send'
    body = {'request_id': 'send-once', 'kind': 'test'}
    first = client.post(endpoint, json=body)
    assert first.status_code == 200 and first.json()['state'] == 'sent'
    assert client.post(endpoint, json=body).json()['id'] == first.json()['id']
    assert len(calls) == 1
    assert calls[0][0] == 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send'
    assert calls[0][1]['allow_redirects'] is False
    other = create(client, name='另一个群')
    assert client.post('/api/v1/client-service/robots/' + other['id'] + '/send', json=body).status_code == 409
    assert 'test-only-secret-key' not in client.get('/api/v1/client-service/robots/deliveries').text


def test_network_timeout_is_unknown_without_automatic_retry_or_secret_leak(setup, monkeypatch):
    client, _ = setup
    robot = create(client)
    calls = []
    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, *args, **kwargs):
            calls.append(1)
            raise requests.Timeout(WEBHOOK)
    monkeypatch.setattr(robots.requests, 'Session', Session)
    endpoint = '/api/v1/client-service/robots/' + robot['id'] + '/send'
    body = {'request_id': 'timeout', 'kind': 'test'}
    response = client.post(endpoint, json=body)
    assert response.json()['state'] == 'unknown' and WEBHOOK not in response.text
    assert client.post(endpoint, json=body).json()['state'] == 'unknown'
    assert len(calls) == 1


def test_send_requires_ready_card_and_matching_revision(setup, monkeypatch):
    client, calls = setup
    robot = create(client)
    endpoint = '/api/v1/client-service/robots/' + robot['id'] + '/send'
    card = {'revision': 2, 'state': 'running', 'market': None}
    monkeypatch.setattr(service, 'detail', lambda _: card)
    body = {'request_id': 'version', 'kind': 'image', 'card_id': '00000000-0000-4000-8000-000000000001', 'revision': 1}
    assert client.post(endpoint, json=body).status_code == 409
    body['revision'] = 2
    assert client.post(endpoint, json=body).status_code == 422
    assert not calls
    card.update(state='ready', market={'summary': 'test'})
    monkeypatch.setattr(robots, 'render_card', lambda _: b'png-test')
    assert client.post(endpoint, json=body).json()['state'] == 'sent'
    image = calls[0][1]['json']['image']
    assert base64.b64decode(image['base64']) == b'png-test'
    assert image['md5'] == hashlib.md5(b'png-test').hexdigest()


def test_text_byte_limit_is_checked_without_truncating_customer_copy(setup, monkeypatch):
    client, calls = setup
    robot = create(client)
    monkeypatch.setattr(service, 'detail', lambda _: {'revision': 0, 'state': 'ready', 'market': {'summary': 'test'}})
    monkeypatch.setattr(robots, 'card_text', lambda _: '测' * 683)
    response = client.post('/api/v1/client-service/robots/' + robot['id'] + '/send', json={'request_id': 'too-long', 'kind': 'text', 'card_id': '00000000-0000-4000-8000-000000000001', 'revision': 0})
    assert response.status_code == 422 and not calls


def test_robot_data_is_isolated_between_workspaces(setup, tmp_path):
    from apps.api.app.security_context import ActorContext, actor_scope
    from apps.api.app.storage import storage_paths
    client, _ = setup
    robot = create(client)
    workspace = asdict(storage_paths(project_root=tmp_path, database_path=tmp_path / 'other.db'))
    with actor_scope(ActorContext('other-user', 'other-tenant', workspace={key: str(value) for key,value in workspace.items()})):
        db.init_db()
        assert robots.list_robots()['items'] == []
        with pytest.raises(Exception) as error:
            robots.update_robot(robot['id'], robots.RobotInput(name='other', revision=0))
        assert error.value.status_code == 404


def test_rate_limit_prevents_twenty_first_request(setup):
    client, calls = setup
    robot = create(client)
    endpoint = '/api/v1/client-service/robots/' + robot['id'] + '/send'
    for i in range(20):
        assert client.post(endpoint, json={'request_id': f'rate-{i}', 'kind': 'test'}).json()['state'] == 'sent'
    assert client.post(endpoint, json={'request_id': 'rate-over', 'kind': 'test'}).status_code == 429
    assert len(calls) == 20


def test_provider_rejections_are_recorded_without_echoing_secret(setup, monkeypatch):
    client, _ = setup
    robot = create(client)
    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, *args, **kwargs):
            return SimpleNamespace(status_code=200, json=lambda: {'errcode': 93000, 'errmsg': WEBHOOK})
    monkeypatch.setattr(robots.requests, 'Session', Session)
    result = client.post('/api/v1/client-service/robots/' + robot['id'] + '/send', json={'request_id': 'rejected', 'kind': 'test'})
    assert result.json()['state'] == 'failed' and '93000' in result.text
    assert WEBHOOK not in result.text
