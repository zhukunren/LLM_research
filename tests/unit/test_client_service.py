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


def finish(card, *, opened=True, published=None, observed=None, commentary=None):
    with db.connect() as connection:
        row = dict(connection.execute('SELECT * FROM client_service_cards WHERE id=?', (card['id'],)).fetchone())
        body = {'summary': '市场震荡，成交较为活跃，板块走势分化。',
                'metrics': [{'label': '上证指数', 'value': '3600.00（+0.20%）', 'observed_at': observed or WHEN.isoformat(), 'source_url': URL}],
                'sources': [{'title': '交易所市场数据', 'url': URL, 'published_at': published or WHEN.isoformat()}], 'limitations': []}
        if commentary is not None:
            body['commentary'] = commentary
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


def test_renderer_keeps_maximum_length_copy_and_sources_inside_image(monkeypatch):
    from apps.api.app.client_service_contracts import default_settings
    content = CardContent(brand='服' * 20, headline='题' * 20, conclusion='判' * 160,
                          action='行' * 180, focus='观' * 140, service='服' * 80,
                          adviser='顾' * 30, license='A' * 30, risk='险' * 100).model_dump()
    template = default_settings().templates[2].model_dump()
    card = {'template': template, 'content': content, 'service_date': DAY,
            'market': {'summary': '行情数据需核实。' * 50, 'cutoff': WHEN.isoformat(),
                       'metrics': [{'label': '很长的指标名称' * 4, 'value': '+123.45% ' * 12,
                                    'observed_at': WHEN.isoformat()}] * 6,
                       'limitations': ['待核实信息' * 50] * 8,
                       'sources': [{'title': '数据来源' * 20}] * 3}}
    bounds = []
    original = images.ImageDraw.ImageDraw.text
    def track(draw, xy, text, *args, **kwargs):
        bounds.append(draw.textbbox(xy, text, font=kwargs.get('font')))
        return original(draw, xy, text, *args, **kwargs)
    monkeypatch.setattr(images.ImageDraw.ImageDraw, 'text', track)
    image = Image.open(BytesIO(images.render_card(card)))
    assert image.width == 1080 and image.height > 1440
    assert all(0 <= left <= right < image.width and 0 <= top <= bottom < image.height - 8
               for left, top, right, bottom in bounds)


COMMENTARY = {'headline': '即时市场观察', 'conclusion': '市场表现分化，需继续核实成交变化。',
              'action': '与客户核对关注事项，等待后续公开信息。', 'focus': '关注量能、市场广度与重要公告。'}


def test_instant_briefs_use_current_cutoff_and_do_not_replace_scheduled_cards(configured, monkeypatch):
    client, calls = configured
    monkeypatch.setattr(service, 'now', lambda: WHEN.replace(hour=9, minute=12))
    first = client.post('/api/v1/client-service/briefs', json={'request_id': 'live-one'})
    assert first.status_code == 202
    first = first.json()
    assert first['cutoff'] == WHEN.replace(hour=9, minute=12).isoformat()
    assert first['slot_id'].startswith('live-')
    assert first['template']['title'] == '即时简报'
    assert first['content']['conclusion'] == ''
    second = client.post('/api/v1/client-service/briefs', json={'request_id': 'live-two'}).json()
    assert first['id'] != second['id'] and len(calls) == 2
    assert client.post('/api/v1/client-service/briefs', json={'request_id': 'live-one'}).json()['id'] == first['id']
    monkeypatch.setattr(service, 'now', lambda: WHEN + timedelta(days=1))
    assert client.post('/api/v1/client-service/briefs', json={'request_id': 'live-one'}).json()['id'] == first['id']
    assert len(calls) == 2
    with db.connect() as connection:
        prompt = connection.execute("SELECT content FROM conversation_messages WHERE role='user' LIMIT 1").fetchone()[0]
    assert 'commentary' in prompt and '09:12' in prompt and '徐晔' not in prompt


def test_instant_completion_fills_copy_but_preserves_saved_user_edits(configured):
    client, _ = configured
    card = client.post('/api/v1/client-service/briefs', json={'request_id': 'live-edit'}).json()
    content = {**card['content'], 'conclusion': '用户手工判断'}
    service.save_card(card['id'], SaveCard(revision=0, content=CardContent(**content)))
    completed = finish(card, commentary=COMMENTARY)
    assert completed['state'] == 'ready'
    assert completed['content']['conclusion'] == '用户手工判断'
    assert completed['content']['action'] == COMMENTARY['action']
    assert completed['revision'] == 2
    assert client.post('/api/v1/client-service/preview', json={'template': completed['template'], 'date': DAY, 'content': completed['content'], 'card_id': completed['id']}).status_code == 200


def test_instant_rejects_missing_commentary_and_unopened_sources(configured):
    client, _ = configured
    card = client.post('/api/v1/client-service/briefs', json={'request_id': 'live-invalid'}).json()
    assert finish(card)['state'] == 'failed'
    other = client.post('/api/v1/client-service/briefs', json={'request_id': 'live-no-evidence'}).json()
    assert finish(other, opened=False, commentary=COMMENTARY)['state'] == 'failed'


def test_live_ids_are_allowed_for_preview_but_not_for_the_six_scheduled_templates(configured):
    from apps.api.app.client_service_contracts import ServiceSettings
    client, _ = configured
    live = client.post('/api/v1/client-service/briefs', json={'request_id': 'live-settings'}).json()
    settings = service.settings()
    settings['templates'][2] = live['template']
    assert client.put('/api/v1/client-service/settings', json=settings).status_code == 422


def test_theme_selection_persists_and_all_slots_have_distinct_artwork(configured):
    from apps.api.app.client_service_contracts import default_settings
    template = default_settings().templates[2].model_dump()
    hashes = set()
    for theme in images.THEMES:
        for slot in (*images.ART_SLOTS, 'live-' + 'a' * 32):
            card = {'template': {**template, 'id': slot}, 'content': CardContent(theme=theme).model_dump(), 'service_date': DAY}
            image = Image.open(BytesIO(images.render_card(card)))
            hashes.add(__import__('hashlib').sha256(image.crop((0, 0, 1080, 400)).tobytes()).hexdigest())
    assert len(hashes) == len(images.THEMES) * 7
    card = finish(service.start(request('theme-save')))
    content = CardContent(**{**card['content'], 'theme': 'jade'})
    saved = service.save_card(card['id'], SaveCard(revision=card['revision'], content=content))
    assert saved['content']['theme'] == 'jade'
    client, _ = configured
    preview = client.post('/api/v1/client-service/preview', json={'template': saved['template'], 'date': DAY, 'content': saved['content'], 'card_id': saved['id']})
    assert base64.b64decode(preview.json()['image'].split(',')[1]) == client.get(f"/api/v1/client-service/cards/{card['id']}/image.png").content


def test_instant_brief_retains_requested_theme_and_rejects_unknown_themes(configured):
    client, _ = configured
    response = client.post('/api/v1/client-service/briefs', json={'request_id': 'theme-live', 'theme': 'gold'})
    assert response.status_code == 202 and response.json()['content']['theme'] == 'gold'
    assert client.post('/api/v1/client-service/briefs', json={'request_id': 'theme-live', 'theme': 'jade'}).status_code == 409
    assert client.post('/api/v1/client-service/briefs', json={'request_id': 'unknown-theme', 'theme': '../secret'}).status_code == 422
    assert client.post('/api/v1/client-service/cards', json={'request_id': 'invalid-live-slot', 'slot_id': 'live-' + 'a' * 32, 'date': DAY}).status_code == 422



def test_official_logo_composites_on_natural_artwork_without_an_opaque_strip():
    from apps.api.app.client_service_contracts import default_settings
    template = default_settings().templates[2].model_dump()
    with Image.open(images.PROJECT_ROOT / 'apps/web/public/brand/soochow-white.png') as original:
        mark = original.convert('RGBA')
        mark.thumbnail((220, 50))
    for theme, palette in images.THEMES.items():
        card = {'template': template, 'content': CardContent(theme=theme).model_dump(), 'service_date': DAY}
        rendered = Image.open(BytesIO(images.render_card(card)))
        left = images.WIDTH - 64 - mark.width
        background = images._masthead(theme, images.artwork_index(template['id']))
        reference = background.crop((left, 52, left + mark.width, 52 + mark.height))
        reference.paste(mark, (0, 0), mark)
        assert rendered.crop((left, 52, left + mark.width, 52 + mark.height)).tobytes() == reference.tobytes()
        assert rendered.crop((750, 0, 1080, 40)).tobytes() == background.crop((750, 0, 1080, 40)).tobytes()
        from PIL import ImageStat
        assert sum(ImageStat.Stat(reference).stddev) > 0



def test_preview_regions_match_export_and_market_edits_preserve_original_evidence(configured):
    client, _ = configured
    card = finish(service.start(request('editable-image')))
    edited = {**card['content'], 'conclusion': '直接从图片编辑的判断', 'market_overrides': {'summary': '用户修订的展示摘要', 'metric.0.value': '用户修订值'}}
    saved = client.put(f"/api/v1/client-service/cards/{card['id']}", json={'revision': card['revision'], 'content': edited})
    assert saved.status_code == 200
    value = saved.json()
    assert value['market'] == card['market']
    preview = client.post('/api/v1/client-service/preview', json={'template': value['template'], 'date': DAY, 'content': value['content'], 'card_id': value['id']}).json()
    regions = {item['key']: item for item in preview['regions']}
    assert regions['conclusion']['value'] == '直接从图片编辑的判断'
    assert regions['market.summary']['value'] == '用户修订的展示摘要'
    assert regions['market.metric.0.value']['value'] == '用户修订值'
    assert all(region['x'] >= 0 and region['y'] >= 0 and region['x'] + region['width'] <= preview['width'] and region['y'] + region['height'] <= preview['height'] for region in regions.values())
    assert base64.b64decode(preview['image'].split(',')[1]) == client.get(f"/api/v1/client-service/cards/{card['id']}/image.png").content
    settings = service.settings()
    settings['templates'][2]['content'] = edited
    saved_settings = client.put('/api/v1/client-service/settings', json=settings).json()
    assert saved_settings['templates'][2]['content']['market_overrides'] == {}
    assert saved_settings['templates'][2]['content']['conclusion'] == '直接从图片编辑的判断'
    assert client.put(f"/api/v1/client-service/cards/{card['id']}", json={'revision': value['revision'], 'content': {**edited, 'market_overrides': {'source_url': 'https://wrong.test'}}}).status_code == 422
