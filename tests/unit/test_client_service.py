import base64
from dataclasses import asdict
from datetime import datetime, timedelta
from io import BytesIO
import json
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from apps.api.app import client_service as service, client_service_images as images, codex_store, db, research_models
from apps.api.app.client_service_api import router
from apps.api.app.client_service_contracts import CardContent, GenerateCard, SaveCard, ServiceSettings

DAY = '2026-11-13'
WHEN = datetime.fromisoformat(DAY + 'T10:30:00+08:00')
URL = 'https://www.sse.com.cn/market/verified-source'


@pytest.fixture
def configured(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'app.db')
    monkeypatch.setattr(research_models, 'llm_settings', lambda: {'configured': True, 'model': 'gpt-6-luna', 'reasoning_effort': 'high'})
    monkeypatch.setattr(research_models, '_discover', lambda _: ({'gpt-6-luna'}, 'verified'))
    monkeypatch.setattr(service.codex_runtime, 'availability', lambda: {'available': True, 'web_search': {'enabled': True, 'mode': 'live'}})
    calls = []
    original_enqueue = service.research_turn_service.enqueue_turn
    def enqueue(conversation, turn):
        with db.connect() as connection:
            previous = connection.execute('SELECT 1 FROM research_turn_jobs WHERE turn_id=?', (turn,)).fetchone()
        result = original_enqueue(conversation, turn)
        if not previous:
            calls.append((conversation, turn))
        return result
    monkeypatch.setattr(service.research_turn_service, 'enqueue_turn', enqueue)
    monkeypatch.setattr(service, 'now', lambda: WHEN)
    monkeypatch.setattr(images, 'application_paths', lambda: SimpleNamespace(artifact_root=tmp_path / 'artifacts'))
    db.init_db()
    app = FastAPI(); app.include_router(router)
    return TestClient(app), calls


def request(identifier='generate-1', **values):
    return GenerateCard(request_id=identifier, slot_id='checkpoint', date=DAY, **values)


def finish(card, *, opened=True, published=None, observed=None):
    with db.connect() as connection:
        row = dict(connection.execute('SELECT * FROM client_service_cards WHERE id=?', (card['id'],)).fetchone())
        body = {'summary': '市场震荡，成交较为活跃，板块走势分化。',
                'metrics': [{'label': '上证指数', 'value': '3600.00（+0.20%）', 'observed_at': observed or WHEN.isoformat(), 'source_url': URL}],
                'sources': [{'title': '交易所市场数据', 'url': URL, 'published_at': published or WHEN.isoformat()}], 'limitations': []}
        connection.execute("UPDATE conversation_turns SET state='succeeded',response_text=? WHERE id=?", (json.dumps(body), row['turn_id']))
    events = [{'type': 'webSearch', 'action': {'type': 'search'}, 'results': [{'ref_id': 'turn0search0', 'url': URL}]}]
    if opened:
        events.append({'type': 'webSearch', 'action': {'type': 'other'}, 'results': [{'ref_id': 'turn1view0', 'url': URL}]})
    for index, item in enumerate(events):
        codex_store.append_event(row['conversation_id'], row['turn_id'], 'thread', 'turn', index, 'item/completed', {'item': item})
    return service.detail(card['id'])


def test_settings_have_six_slots_and_optimistic_revision(configured):
    client, _ = configured
    settings = service.settings()
    assert [item['time'] for item in settings['templates']] == ['08:45', '09:45', '10:30', '11:35', '14:30', '15:30']
    settings['enabled'] = True
    saved = service.save_settings(ServiceSettings(**settings))
    assert saved['revision'] == 1 and saved['enabled']
    with pytest.raises(HTTPException) as error:
        service.save_settings(ServiceSettings(**settings))
    assert error.value.status_code == 409
    saved['templates'][0]['time'] = '25:00'
    assert client.put('/api/v1/client-service/settings', json=saved).status_code == 422


def test_generation_is_idempotent_and_does_not_send_editable_copy_to_codex(configured):
    _, calls = configured
    config = service.settings()
    config['templates'][2]['content']['conclusion'] = 'PRIVATE-CUSTOM-COPY'
    service.save_settings(ServiceSettings(**config))
    first = service.start(request())
    second = service.start(request())
    assert first['id'] == second['id'] and len(calls) == 1
    assert first['content']['conclusion'] == 'PRIVATE-CUSTOM-COPY'
    assert first['cutoff'] == WHEN.isoformat()
    with db.connect() as connection:
        prompt = connection.execute("SELECT content FROM conversation_messages WHERE role='user'").fetchone()[0]
    assert 'PRIVATE-CUSTOM-COPY' not in prompt and '徐晔' not in prompt
    assert '实际打开' in prompt and '截止' in prompt and '不要生成操作建议' in prompt
    assert len(service.list_cards(request().date)) == 1
    assert configured[0].get('/api/v1/client-service/cards?date=' + DAY).status_code == 200
    assert service.start(request('another-click'))['id'] == first['id'] and len(calls) == 1


def test_completed_cards_are_persisted_as_png_without_browser_and_preview_matches_download(configured):
    client, _ = configured
    card = finish(service.start(request()))
    assert card['state'] == 'ready' and card['market']['quality'] == 'verified'
    stored = images.image_path(card['id']).read_bytes()
    assert Image.open(BytesIO(stored)).size[0] == 1080
    preview = client.post('/api/v1/client-service/preview', json={'template': card['template'], 'date': DAY, 'content': card['content'], 'card_id': card['id']})
    assert preview.status_code == 200
    data = base64.b64decode(preview.json()['image'].split(',')[1])
    assert data == stored == client.get(f"/api/v1/client-service/cards/{card['id']}/image.png").content
    assert preview.json()['height'] >= 1440


@pytest.mark.parametrize('values', [{'opened': False}, {'published': (WHEN + timedelta(minutes=1)).isoformat()}, {'published': '2026-11-13 10:31:00+08:00'}])
def test_unopened_or_future_sources_are_not_published(configured, values):
    card = finish(service.start(request()), **values)
    assert card['state'] == 'failed' and card['market'] is None
    assert not images.image_path(card['id']).exists()


def test_future_metrics_remain_unknown_instead_of_becoming_current_values(configured):
    card = finish(service.start(request()), observed=(WHEN + timedelta(minutes=1)).isoformat())
    assert card['state'] == 'ready' and card['market']['quality'] == 'partial'
    assert card['market']['metrics'][0]['value'] == '未核实'
    assert card['market']['metrics'][0]['source_url'] is None


def test_regeneration_preserves_customer_copy_and_prior_request_replay_does_not_restart(configured):
    client, calls = configured
    card = finish(service.start(request()))
    content = CardContent(**{**card['content'], 'conclusion': '这是用户自己的判断。', 'action': '这是用户自己的安排。'})
    edited = service.save_card(card['id'], SaveCard(revision=card['revision'], content=content))
    settings = service.settings()
    settings['templates'][2]['time'] = '10:45'
    service.save_settings(ServiceSettings(**settings))
    regenerated = service.start(request('retry-1', regenerate=True))
    assert regenerated['content'] == edited['content'] and len(calls) == 2
    assert regenerated['cutoff'] == card['cutoff'] and regenerated['template']['time'] == '10:30'
    assert service.start(request())['id'] == card['id'] and len(calls) == 2
    with pytest.raises(HTTPException) as error:
        service.save_card(card['id'], SaveCard(revision=0, content=CardContent()))
    assert error.value.status_code == 409
    assert client.put(f"/api/v1/client-service/cards/{card['id']}", json={'revision': 1, 'content': content.model_dump(), 'market': {'summary': '不能由用户覆盖'}}).status_code == 422
    assert service.conversation_store.list_conversations(exclude_intelligence=True) == []


def test_scheduler_runs_once_in_window_ignores_other_days_and_finalizes_without_page(configured):
    _, calls = configured
    settings = service.settings(); settings['enabled'] = True
    service.save_settings(ServiceSettings(**settings))
    service.tick(clock=WHEN - timedelta(minutes=1))
    assert not calls
    service.tick(clock=WHEN)
    service.tick(clock=WHEN + timedelta(minutes=1))
    assert len(calls) == 1
    service.tick(clock=WHEN + timedelta(days=1))
    assert len(calls) == 1
    card = service.list_cards(request().date)[0]
    finish(card)
    assert images.image_path(card['id']).exists()
    assert service.start(request('manual-after-schedule'))['id'] == card['id'] and len(calls) == 1


def test_scheduler_recovers_a_reserved_card_without_queue_registration(configured):
    _, calls = configured
    card = service.start(request())
    with db.connect() as connection:
        job = connection.execute('SELECT job_id FROM research_turn_jobs').fetchone()[0]
        connection.execute('DELETE FROM research_turn_jobs')
        connection.execute('DELETE FROM jobs WHERE id=?', (job,))
    service.tick(clock=WHEN)
    with db.connect() as connection:
        assert connection.execute('SELECT COUNT(*) FROM research_turn_jobs').fetchone()[0] == 1
    assert service.detail(card['id'])['state'] == 'awaiting_agent'


def test_market_permissions_preview_date_and_future_requests_are_checked(configured, monkeypatch):
    client, _ = configured
    card = service.start(request())
    response = client.post('/api/v1/client-service/preview', json={'template': card['template'], 'date': '2026-11-12', 'content': card['content'], 'card_id': card['id']})
    assert response.status_code == 422
    with pytest.raises(HTTPException) as error:
        service.start(GenerateCard(request_id='future', slot_id='preopen', date='2026-11-14'))
    assert error.value.status_code == 422
    with pytest.raises(HTTPException) as error:
        service.start(GenerateCard(request_id='later-today', slot_id='late', date=DAY))
    assert error.value.status_code == 422
    monkeypatch.setattr(service.codex_runtime, 'availability', lambda: {'available': True, 'web_search': {'enabled': True, 'mode': 'cached'}})
    with pytest.raises(HTTPException) as error:
        service.start(GenerateCard(request_id='cached', slot_id='preopen', date=DAY))
    assert error.value.status_code == 503


def test_other_workspace_cannot_read_or_preview_a_card(configured, tmp_path):
    from apps.api.app.security_context import ActorContext, actor_scope
    from apps.api.app.storage import storage_paths
    card = service.start(request())
    workspace = asdict(storage_paths(project_root=tmp_path, database_path=tmp_path / 'other.db'))
    with actor_scope(ActorContext('other-user', 'other-tenant', workspace={key: str(value) for key, value in workspace.items()})):
        db.init_db()
        with pytest.raises(HTTPException) as error:
            service.detail(card['id'])
        assert error.value.status_code == 404
        assert service.settings()['revision'] == 0
