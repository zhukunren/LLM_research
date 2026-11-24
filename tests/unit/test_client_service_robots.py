from datetime import timedelta
import time
import base64
import hashlib
from dataclasses import asdict
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import requests

from apps.api.app import client_service_robots as robots, client_service as service, db
from apps.api.app import client_service_archive as archive
from apps.api.app.client_service_api import router
from apps.api.app.client_service_disclosure import disclosure_lines
from apps.api.app.rebalance_card import RebalanceCard

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
    other = create(client, name='另一个群', webhook=WEBHOOK.replace('test-only-secret-key', 'test-other-secret-key'))
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


def test_robot_text_keeps_source_names_and_full_disclosure_without_links(setup, monkeypatch):
    from apps.api.app.client_service_contracts import default_settings
    from apps.api.app.client_service_disclosure import disclosure_lines

    client, calls = setup
    robot = create(client)
    template = default_settings().templates[2].model_dump()
    card = {'service_date': '2026-11-16', 'template': template, 'state': 'ready', 'revision': 0,
            'content': {**template['content'], 'risk': '旧风险提示', 'adviser': '旧姓名', 'license': '', 'institution': '',
                        'conclusion': '等待[公告](https://example.com/filing_(today))核对。'},
            'market': {'summary': '文案排版测试（www.example.cn/market）。', 'metrics': [],
                       'sources': [{'title': '交易所公告', 'url': 'https://example.com/report'},
                                   {'title': 'https://example.net/only-a-url', 'url': 'https://example.net/only-a-url'}]}}
    monkeypatch.setattr(service, 'detail', lambda _: card)
    body = {'request_id': 'text-no-links', 'kind': 'text', 'card_id': '00000000-0000-4000-8000-000000000001', 'revision': 0}
    response = client.post('/api/v1/client-service/robots/' + robot['id'] + '/send', json=body)
    assert response.status_code == 200 and response.json()['state'] == 'sent'
    text = calls[0][1]['json']['text']['content']
    assert text.endswith('\n'.join(disclosure_lines()))
    assert text.count('风险提示：') == 1
    assert '旧风险提示' not in text and '旧姓名' not in text
    assert '等待公告核对。' in text and '文案排版测试。' in text
    assert text.count('来源：') == 1 and '来源：交易所公告' in text
    assert 'example.' not in text and 'http' not in text
    assert card['market']['sources'][0]['url'] == 'https://example.com/report'


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


def test_review_blocks_incomplete_or_promised_returns_before_any_send(setup):
    client, calls = setup
    robot = create(client)
    prefix = "/api/v1/client-service/robots"
    bad = {"text": "本次保证收益，详见 https://example.com/news"}
    review = client.post(prefix + "/review", json=bad)
    assert review.status_code == 200
    assert {issue["code"] for issue in review.json()["issues"]} == {"disclosure", "signature", "link", "promise"}
    rejected = client.post(prefix + "/" + robot["id"] + "/send", json={
        "request_id": "bad-material", "kind": "text", "content_text": bad["text"],
    })
    assert rejected.status_code == 422 and calls == []


def test_content_batch_delivers_to_selected_groups_once_and_risk_monitor_surfaces_rejections(setup):
    client, calls = setup
    first = create(client, name="一组")
    second = create(client, name="二组", webhook=WEBHOOK.replace("test-only-secret-key", "test-other-secret-key"))
    create(client, name="已停用组", enabled=False, webhook=WEBHOOK.replace("test-only-secret-key", "test-paused-secret-key"))
    prefix = "/api/v1/client-service/robots"
    text = "今日观察公开信息，具体执行由投顾核对。\n" + "\n".join(disclosure_lines())
    for robot in [first, second]:
        payload = {"request_id": "batch-id:" + robot["id"], "kind": "text", "content_text": text}
        route = prefix + "/" + robot["id"] + "/send"
        delivered = client.post(route, json=payload).json()
        assert delivered["state"] == "sent"
        assert client.post(route, json=payload).json()["id"] == delivered["id"]
    assert len(calls) == 2
    assert all(call[1]["json"]["text"]["content"] == text for call in calls)

    with db.connect() as connection:
        connection.execute("UPDATE client_service_deliveries SET state='failed',message='接收端拒绝' WHERE robot_id=?", (second["id"],))
    risks = client.get(prefix + "/risks")
    assert risks.status_code == 200
    result = risks.json()
    assert [(item["robot_name"], item["state"]) for item in result["items"]] == [("二组", "failed")]
    assert [item["name"] for item in result["paused"]] == ["已停用组"]
    assert "test-other-secret-key" not in risks.text


def test_group_send_can_use_a_themed_rebalance_card(setup, monkeypatch):
    client, calls = setup
    robot = create(client)
    card = RebalanceCard(theme="jade", product="投顾产品", code="603650", name="测试股票", direction="开仓",
                         before="0", after="5", price="46.70", reason="核对公告。")
    monkeypatch.setattr(robots, "render_rebalance_card", lambda draft: b"test-image-" + draft.theme.encode())
    response = client.post("/api/v1/client-service/robots/" + robot["id"] + "/send", json={
        "request_id": "group-image", "kind": "image", "suggestion": card.model_dump(),
    })
    assert response.status_code == 200 and response.json()["state"] == "sent"
    assert base64.b64decode(calls[0][1]["json"]["image"]["base64"]) == b"test-image-jade"


def test_archive_reads_each_bound_group_and_retries_from_the_saved_cursor(setup, tmp_path, monkeypatch):
    client, pushes = setup
    root = '/api/v1/client-service/robots'
    library = tmp_path / 'finance.so'
    library.touch()
    config = archive.ArchiveSettings(
        'ww-test', library, tmp_path, 'WECOM_TEST_ARCHIVE_SECRET', {'roomA': '一组', 'roomB': '二组'},
    )
    monkeypatch.setattr(archive, 'archive_settings', lambda: config)
    monkeypatch.setenv(config.secret_env, 'test-only-archive-secret')
    first = create(client, archive_room_id='roomA', name='一组')
    other_url = WEBHOOK.replace('test-only-secret-key', 'test-other-secret-key')
    second = create(client, archive_room_id='roomB', name='二组', webhook=other_url)
    assert client.post(root, json={'name': '重复配置', 'webhook': WEBHOOK}).status_code == 409
    assert client.post(root, json={
        'name': '同群不同地址', 'webhook': WEBHOOK + '-new', 'archive_room_id': 'roomA',
    }).status_code == 409
    assert client.post(root, json={
        'name': '未授权群', 'webhook': WEBHOOK + '-new', 'archive_room_id': 'roomC',
    }).status_code == 422
    assert client.put(root + '/' + second['id'], json={'name': '二组新名', 'revision': 0}).json()['archive_room_id'] == 'roomB'

    now = int(time.time())
    seen = []

    def message(id_, room, sender, text):
        return {'msgid': id_, 'roomid': room, 'from': sender, 'action': 'send', 'msgtype': 'text',
                'msgtime': (now - 180) * 1000, 'text': {'content': text}}

    first_page = [
        message('a1', 'roomA', 'wo-client', '请问赎回流程？'),
        message('a2', 'roomA', 'adviser', '本产品保证收益'),
        message('b1', 'roomB', 'wm-client', '二组想了解仓位安排'),
        message('other', 'roomC', 'wo-other', '未授权的记录'),
    ]

    class FakeArchive:
        def __init__(self, *_): pass
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self, cursor):
            seen.append(cursor)
            if len(seen) == 1:
                return 100, first_page
            if len(seen) == 2:
                raise archive.ArchiveError('样例连接中断')
            return 200, [first_page[0], message('b2', 'roomB', 'adviser', '客户可核对风险说明')]

    monkeypatch.setattr(archive, 'FinanceArchive', FakeArchive)
    assert client.get(root + '/' + first['id'] + '/chat').json()['state'] == 'waiting'
    archive.sync_archive(config, clock=now - 120)
    archive.sync_archive(config, clock=now - 110)
    archive.sync_archive(config, clock=now - 60)
    mid = client.get(root + '/' + first['id'] + '/chat').json()
    assert mid['state'] == 'error' and mid['total'] == 2 and mid['synced_at']
    archive.sync_archive(config, clock=now)
    assert seen == [0, 100, 100]
    a = client.get(root + '/' + first['id'] + '/chat').json()
    b = client.get(root + '/' + second['id'] + '/chat').json()
    assert a['state'] == b['state'] == 'ready'
    assert a['total'] == b['total'] == 2
    assert [item['id'] for item in a['needs']] == ['a1']
    assert [item['id'] for item in a['alerts']] == ['a2']
    assert [item['id'] for item in b['needs']] == ['b1']
    assert b['alerts'] == []
    assert '二组想了解' not in str(a) and '赎回流程' not in str(b)
    with db.connect() as connection:
        assert connection.execute('SELECT COUNT(*) FROM client_service_wecom_messages').fetchone()[0] == 4
    assert pushes == []


def test_push_rejects_a_changed_group_configuration(setup):
    client, pushes = setup
    robot = create(client)
    path = '/api/v1/client-service/robots/' + robot['id']
    assert client.put(path, json={'name': '更新后的群', 'webhook': WEBHOOK + '-other', 'revision': 0}).status_code == 200
    assert client.post(path + '/send', json={'request_id': 'old-target', 'kind': 'test', 'robot_revision': 0}).status_code == 409
    assert pushes == []
    assert client.post(path + '/send', json={'request_id': 'new-target', 'kind': 'test', 'robot_revision': 1}).json()['state'] == 'sent'
    assert len(pushes) == 1
