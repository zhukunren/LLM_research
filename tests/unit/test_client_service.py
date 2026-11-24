import base64
from dataclasses import asdict
from datetime import date, datetime, timedelta
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
    monkeypatch.setattr(research_models, '_discover', lambda _: ({'gpt-6.2-astra', 'gpt-6.2-sol'}, 'verified'))
    monkeypatch.setattr(research_models, 'research_model_settings', lambda: {'account_tier': 'paid', 'allowed_models': [], 'reasoning_efforts': {}})
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


def finish(card, *, opened=True, published=None, observed=None, commentary=None, summary='市场震荡，成交较为活跃，板块走势分化。'):
    with db.connect() as connection:
        row = dict(connection.execute('SELECT * FROM client_service_cards WHERE id=?', (card['id'],)).fetchone())
        body = {'summary': summary,
                'metrics': [{'label':label,'value':value,'observed_at':observed or WHEN.isoformat(),'source_url':URL} for label,value in [('上证指数','3600.00（+0.20%）'),('深证成指','12000.00（-0.30%）'),('创业板指','2600.00（-0.50%）')]],
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
    assert {item['content']['theme'] for item in settings['templates']} == {'soochow'}
    settings['enabled'] = True
    saved = service.save_settings(ServiceSettings(**settings))
    assert saved['revision'] == 1 and saved['enabled']
    with pytest.raises(HTTPException) as error:
        service.save_settings(ServiceSettings(**settings))
    assert error.value.status_code == 409
    saved['templates'][0]['time'] = '25:00'
    assert client.put('/api/v1/client-service/settings', json=saved).status_code == 422


def test_migration_updates_original_default_themes_and_preserves_saved_choices(configured):
    from apps.api.app import opening_plans
    from apps.api.app.opening_plan_card import OpeningPlanContent

    config = service.settings()
    config.update(revision=4, enabled=True, weekdays=[1, 3])
    for template in config['templates']:
        template['content']['theme'] = 'river'
        template['content']['conclusion'] = '保留原有判断'
    config['templates'][0]['content'].pop('theme')
    config['templates'][1]['content']['theme'] = 'jade'
    with db.connect() as connection:
        connection.execute('INSERT INTO client_service_settings VALUES(1,?,?,?)', (4, db.json_dump(config), db.utc_now()))
        connection.execute('DELETE FROM schema_migrations WHERE version=?', ('066_client_card_default_theme.sql',))

    existing_card = service.start(request('saved-before-theme-update'))
    plan_date = date.fromisoformat(DAY)
    plan = OpeningPlanContent(theme='river', sections={'judgment': '保留开盘计划内容'})
    opening_plans.save_content(opening_plans.SaveOpeningTemplate(revision=0, content=plan))
    saved_plan = opening_plans.save_content(opening_plans.SaveOpeningPlan(revision=0, content=plan), plan_date=plan_date)

    db.ensure_initialized()
    updated = service.settings()
    config['revision'] += 1
    for index, template in enumerate(config['templates']):
        template['content']['theme'] = 'jade' if index == 1 else 'soochow'
    assert updated == config
    assert service.detail(existing_card['id'])['content']['theme'] == 'river'
    workspace = opening_plans.editor(plan_date)
    assert workspace['saved'] == saved_plan
    assert workspace['template'] == {'revision': 2, 'content': {'theme': 'soochow', 'sections': plan.sections},
                                     'collection_request_id': None}

    updated['templates'][0]['content']['theme'] = 'river'
    saved_after_upgrade = service.save_settings(ServiceSettings(**updated))
    db.ensure_initialized()
    assert service.settings() == saved_after_upgrade


def test_fixed_disclosure_upgrades_legacy_settings_cards_and_all_write_paths(configured):
    from apps.api.app.client_service_disclosure import FIXED_DISCLOSURE
    client, _ = configured
    legacy = {**CardContent().model_dump(), 'risk': '市场有风险', 'adviser': '旧姓名', 'license': ''}
    legacy.pop('institution')
    config = service.settings()
    for template in config['templates']:
        template['content'] = {**legacy, 'conclusion': '保留原有判断'}
    with db.connect() as connection:
        connection.execute('INSERT INTO client_service_settings VALUES(1,?,?,?)', (4, db.json_dump(config), db.utc_now()))
    loaded = client.get('/api/v1/client-service/settings').json()
    assert loaded['revision'] == 4
    for template in loaded['templates']:
        assert all(template['content'][key] == value for key, value in FIXED_DISCLOSURE.items())
        assert template['content']['conclusion'] == '保留原有判断'
    # An old client cannot clear or replace the fixed block when saving a template.
    loaded['templates'][0]['content'] = legacy
    saved = client.put('/api/v1/client-service/settings', json=loaded)
    assert saved.status_code == 200
    assert saved.json()['templates'][0]['content']['risk'] == FIXED_DISCLOSURE['risk']
    card = service.start(request('legacy-disclosure'))
    old_template = {**card['template'], 'content': legacy}
    with db.connect() as connection:
        connection.execute('UPDATE client_service_cards SET content_json=?,template_json=? WHERE id=?',
                           (db.json_dump(legacy), db.json_dump(old_template), card['id']))
    loaded_card = client.get(f"/api/v1/client-service/cards/{card['id']}").json()
    assert loaded_card['revision'] == card['revision']
    for content in (loaded_card['content'], loaded_card['template']['content']):
        assert all(content[key] == value for key, value in FIXED_DISCLOSURE.items())
    response = client.put(f"/api/v1/client-service/cards/{card['id']}", json={
        'revision': card['revision'], 'content': {**legacy, 'risk': '', 'institution': '', 'conclusion': '保留此次编辑'},
    })
    assert response.status_code == 200
    assert response.json()['content']['conclusion'] == '保留此次编辑'
    assert all(response.json()['content'][key] == value for key, value in FIXED_DISCLOSURE.items())
    preview = client.post('/api/v1/client-service/preview', json={
        'template': old_template, 'date': DAY, 'content': legacy,
    })
    assert preview.status_code == 200
    assert not {'risk', 'signature', 'adviser', 'license', 'institution'} & {region['key'] for region in preview.json()['regions']}
    normalized = client.post('/api/v1/client-service/preview', json={
        'template': old_template, 'date': DAY, 'content': {**legacy, **FIXED_DISCLOSURE},
    })
    assert preview.json()['image'] == normalized.json()['image']
    draft = client.post('/api/v1/client-service/preview?draft=true', json={
        'template': old_template, 'date': DAY, 'content': legacy,
    })
    assert draft.status_code == 200
    assert draft.json()['draft'] is True
    assert draft.json()['image_hash'] != preview.json()['image_hash']
    assert draft.json()['regions'] == preview.json()['regions']


def test_all_theme_renderers_keep_full_fixed_disclosure_visible_and_read_only(monkeypatch):
    from apps.api.app.client_service_contracts import default_settings
    from apps.api.app.client_service_disclosure import FIXED_DISCLOSURE, disclosure_lines
    calls = []
    original = images.ImageDraw.ImageDraw.text
    def track(draw, xy, text, *args, **kwargs):
        calls.append((str(text), draw.textbbox(xy, text, font=kwargs.get('font'))))
        return original(draw, xy, text, *args, **kwargs)
    monkeypatch.setattr(images.ImageDraw.ImageDraw, 'text', track)
    template = default_settings().templates[2].model_dump()
    for theme in images.THEMES:
        calls.clear()
        regions = []
        card = {'template': template, 'service_date': DAY, 'market': None,
                'content': {**CardContent().model_dump(), 'theme': theme, 'risk': '', 'adviser': '', 'license': '', 'institution': ''}}
        image = Image.open(BytesIO(images.render_card(card, regions=regions)))
        drawn = ''.join(text for text, _ in calls)
        assert FIXED_DISCLOSURE['risk'] in drawn
        assert all(line in drawn for line in disclosure_lines()[1:])
        assert all(0 <= left <= right < image.width and 0 <= top <= bottom < image.height - 8
                   for _, (left, top, right, bottom) in calls)
        assert not {'risk', 'signature', 'adviser', 'license', 'institution'} & {region['key'] for region in regions}


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


def test_card_generation_records_the_focus_and_rejects_changes_to_a_queued_request(configured):
    from apps.api.app import client_service_runtime

    client, calls = configured
    endpoint = '/api/v1/client-service/cards'
    focus = '优先观察量能变化。'
    payload = {'request_id': 'focused-card', 'slot_id': 'checkpoint', 'date': DAY, 'generation_focus': f' {focus} '}
    started = client.post(endpoint, json=payload)
    assert started.status_code == 202, started.text
    card = started.json()
    assert card['generation_focus'] == focus and card['cutoff'] == WHEN.isoformat()
    assert client.post(endpoint, json={**payload, 'generation_focus': focus}).json()['id'] == card['id']
    assert client.post(endpoint, json={**payload, 'generation_focus': '换一组重点'}).status_code == 409
    assert client.post(endpoint, json={**payload, 'request_id': 'concurrent', 'generation_focus': '换一组重点', 'regenerate': True}).status_code == 409
    assert client.post(endpoint, json={**payload, 'request_id': 'too-long', 'generation_focus': '字' * 201}).status_code == 422
    assert len(calls) == 1
    prompt = json.loads(client_service_runtime.prompt(*calls[0]))
    assert prompt['本次关注点'] == focus
    assert focus not in prompt['current_user_request']
    assert client.get(f"{endpoint}/{card['id']}").json()['generation_focus'] == focus


def test_client_briefs_freeze_the_model_for_each_turn(configured):
    from apps.api.app.client_service_contracts import InstantBrief
    scheduled = finish(service.start(request('scheduled')))
    regenerated = service.start(request('regenerated', regenerate=True))
    instant = service.start_instant(InstantBrief(request_id='instant', model_mode='instant'))
    assert regenerated['id'] == scheduled['id']
    assert instant['slot_id'].startswith('live-')
    with db.connect() as connection:
        rows = connection.execute('''SELECT c.model_id AS conversation_model,c.reasoning_effort AS conversation_effort,
            t.model_id,t.reasoning_effort FROM client_service_turns s
            JOIN conversations c ON c.id=s.conversation_id JOIN conversation_turns t ON t.id=s.turn_id''').fetchall()
    assert len(rows) == 3
    assert [(row['model_id'], row['reasoning_effort']) for row in rows].count(('gpt-6.2-sol', 'max')) == 2
    assert any((row['model_id'], row['reasoning_effort']) == ('gpt-6.2-astra', 'low') for row in rows)
    assert all(row['model_id'] == row['conversation_model'] and row['reasoning_effort'] == row['conversation_effort'] for row in rows)
    assert research_models.resolve_selection() == {'model_id': 'gpt-6.2-astra', 'reasoning_effort': 'low'}


@pytest.mark.parametrize('resume', [False, True])
def test_client_runtime_uses_inline_snapshot_and_native_search_without_general_research_setup(configured, monkeypatch, resume):
    import openai_codex
    from apps.api.app import client_service_runtime, conversation_store, research_assistants, research_workspace
    card = service.start(request('lean-runtime'))
    with db.connect() as connection:
        record = dict(connection.execute('SELECT conversation_id,turn_id FROM client_service_cards WHERE id=?', (card['id'],)).fetchone())
        snapshot = {'cutoff': WHEN.isoformat(), 'sha256': 'evidence-hash', 'missing': [], 'sources': [{'url': URL}],
                    'metrics': [{'code': '000001.SH', 'value': '3600.00点 +0.20%', 'observed_at': WHEN.isoformat(),
                                 'source_url': URL, 'raw': 'large provider record' * 1000}], 'attempts': []}
        connection.execute('INSERT INTO client_service_market_snapshots VALUES(?,?,?,?,?)',
                           (record['turn_id'], record['conversation_id'], WHEN.isoformat(), db.json_dump(snapshot), db.utc_now()))
    cid, tid = record['conversation_id'], record['turn_id']
    conversation_store.start_turn(cid, tid)
    if resume:
        codex_store.bind_thread(cid, 'previous-brief-thread', 'gpt-6-luna', 'test')
    observed = {}
    def forbidden(*args, **kwargs):
        raise AssertionError('Client briefs must not load the general research workspace, skill, or MCP bridge')
    monkeypatch.setattr(research_workspace, 'prepare', forbidden)
    monkeypatch.setattr(research_assistants, 'materialize_skill', forbidden)
    monkeypatch.setattr(service.codex_runtime, '_mcp_overrides', forbidden)
    monkeypatch.setattr(service.codex_runtime, 'llm_settings', lambda: {'model': 'gpt-6-luna', 'base_url': 'https://example.invalid',
                        'api_key': 'test-key', 'reasoning_effort': 'high', 'supports_standalone_web_search': True})
    class FakeCodex:
        def __init__(self, config):
            observed['config'] = config
            self._client = SimpleNamespace()
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def thread_start(self, **kwargs):
            observed['thread'] = kwargs
            return SimpleNamespace(id='brief-thread', turn=self.turn)
        def thread_resume(self, thread_id, **kwargs):
            observed['thread'] = kwargs
            return SimpleNamespace(id=thread_id, turn=self.turn)
        def turn(self, inputs, **kwargs):
            observed['inputs'], observed['turn'] = inputs, kwargs
            events = [SimpleNamespace(method='item/completed', payload={'item': {'type': 'agentMessage', 'phase': 'final_answer', 'text': '{}'}}),
                      SimpleNamespace(method='turn/completed', payload={'turn': {'status': 'completed'}})]
            return SimpleNamespace(id='brief-turn', stream=lambda: iter(events))
    monkeypatch.setattr(service.codex_runtime, '_sdk', lambda: (openai_codex.ApprovalMode, FakeCodex, openai_codex.CodexConfig,
                        openai_codex.Sandbox, openai_codex.SkillInput, openai_codex.TextInput))
    result = service.codex_runtime.run_conversation_turn(cid, tid)
    assert result['model'] == 'gpt-6.2-sol' and result['reasoning_effort'] == 'max'
    assert observed['turn']['model'] == 'gpt-6.2-sol' and observed['turn']['effort'] == 'max'
    assert observed['turn']['turn_service_tier'] == 'default'
    assert len(observed['inputs']) == 1 and isinstance(observed['inputs'][0], openai_codex.TextInput)
    compact = json.loads(observed['inputs'][0].text)
    assert 'conversation_history' not in compact and 'research_workspace' not in compact
    assert compact['client_market_snapshot']['metrics'][0]['value'] == snapshot['metrics'][0]['value']
    assert compact['client_market_snapshot']['metrics'][0]['observed_at'] == WHEN.isoformat()
    assert 'raw' not in compact['client_market_snapshot']['metrics'][0]
    assert compact['client_market_snapshot']['sha256'] == 'evidence-hash'
    assert observed['thread']['developer_instructions'] == client_service_runtime.INSTRUCTIONS
    assert observed['thread']['base_instructions'] == client_service_runtime.BASE_INSTRUCTIONS
    overrides = observed['config'].config_overrides
    assert 'web_search="live"' in overrides and 'features.standalone_web_search=true' in overrides
    assert 'features.shell_tool=false' in overrides
    assert not any(value.startswith('mcp_servers.llm_research.') for value in overrides)
    # The full numeric evidence remains stored unchanged for audit/validation.
    with db.connect() as connection:
        assert json.loads(connection.execute('SELECT payload_json FROM client_service_market_snapshots WHERE turn_id=?', (tid,)).fetchone()[0]) == snapshot
    general = conversation_store.create_conversation('news', workflow_type='research')
    message = conversation_store.add_user_message(general['id'], 'general', 0, '普通研究')
    assert client_service_runtime.prepare(general['id'], message['turn_id']) is None
    with db.connect() as connection:
        connection.execute('INSERT INTO client_service_turns VALUES(?,?)', (general['id'], message['turn_id']))
    assert client_service_runtime.prepare(general['id'], message['turn_id']) is None  # Visual review is not brief generation.


def test_brief_can_omit_repeated_indices_without_losing_numeric_evidence(configured, monkeypatch):
    from apps.api.app import client_service_market
    card = service.start(request('no-repeated-index-copy'))
    row = service._row(card['id'])
    metrics = [{'label': label, 'value': value, 'observed_at': WHEN.isoformat(), 'source_url': URL}
               for label, value in [('上证指数', '3600.00点 +0.20%'), ('深证成指', '12000.00点 -0.30%'), ('创业板指', '2600.00点 -0.50%')]]
    monkeypatch.setattr(client_service_market, 'read', lambda *args: {'metrics': metrics, 'sources': [{'title': '服务端行情', 'url': URL, 'published_at': None}]})
    monkeypatch.setattr(service, 'web_evidence', lambda *_: (True, {'https://example.com/market'}))
    body = {'summary': '市场表现分化。', 'metrics': [], 'commentary': {'headline': '时点简评', 'conclusion': '判断', 'action': '主线', 'focus': '观察'},
            'sources': [{'title': '当期市场综述', 'url': 'https://example.com/market', 'published_at': WHEN.isoformat()}]}
    result = service.verified_market(row, json.dumps(body))
    assert result['metrics'] == metrics
    assert {source['url'] for source in result['sources']} == {URL, 'https://example.com/market'}
    assert result['quality'] == 'verified'


@pytest.mark.parametrize('blocker', ['provider', 'policy', 'effort'])
def test_unavailable_client_model_fails_before_creating_a_card_without_falling_back(configured, monkeypatch, blocker):
    client, calls = configured
    if blocker == 'provider':
        monkeypatch.setattr(research_models, '_discover', lambda _: ({'gpt-5.6-luna'}, 'verified'))
    elif blocker == 'policy':
        monkeypatch.setattr(research_models, 'research_model_settings', lambda: {'account_tier': 'paid', 'allowed_models': ['gpt-5.6-luna'], 'reasoning_efforts': {}})
    else:
        monkeypatch.setattr(research_models, 'research_model_settings', lambda: {'account_tier': 'paid', 'allowed_models': [], 'reasoning_efforts': {'gpt-6.2-sol': ['high']}})
    response = client.post('/api/v1/client-service/briefs', json={'request_id': 'configured-model-unavailable'})
    assert response.status_code == 503
    assert '深度' in response.json()['detail']['message']
    assert not calls
    with db.connect() as connection:
        assert connection.execute('SELECT COUNT(*) FROM client_service_cards').fetchone()[0] == 0
        assert connection.execute('SELECT COUNT(*) FROM conversations').fetchone()[0] == 0


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


def test_visual_review_reads_two_native_images_is_idempotent_and_does_not_change_card(configured, monkeypatch, tmp_path):
    from apps.api.app import client_service_reviews as reviews, research_attachments
    monkeypatch.setattr(research_attachments,'application_paths',lambda:SimpleNamespace(attachments_root=tmp_path/'attachments'))
    client,calls=configured
    card=finish(service.start(request()))
    endpoint=f"/api/v1/client-service/cards/{card['id']}/review"
    payload={'request_id':'review-1','expected_revision':card['revision'],'review_focus':['disclosure','metrics']}
    assert client.get(endpoint).json()=={'review':None}
    response=client.post(endpoint,json=payload)
    assert response.status_code==202,response.text
    review=response.json()
    assert review['state']=='queued',review
    assert review['review_focus']==['metrics','disclosure']
    assert client.post(endpoint,json={**payload,'review_focus':['metrics','disclosure']}).json()['id']==review['id']
    assert client.post(endpoint,json={**payload,'review_focus':['legibility']}).status_code==409
    assert client.post(endpoint,json={**payload,'review_focus':['always_pass']}).status_code==422
    assert len(calls)==2
    with db.connect() as c:
        row=c.execute('SELECT * FROM client_service_reviews WHERE id=?',(review['id'],)).fetchone()
        attachments=c.execute('SELECT * FROM research_attachments WHERE conversation_id=?',(row['conversation_id'],)).fetchall()
        assert len(attachments)==2 and all(item['model_image_name'] for item in attachments)
        prompt=c.execute("SELECT content FROM conversation_messages WHERE conversation_id=? AND role='user'",(row['conversation_id'],)).fetchone()[0]
        assert '指数与指标区域、风险提示与投顾落款' in prompt and '完整执行上述全部检查' in prompt
        verdict={'verdict':'passed','summary':'指数区域可读，但正文需要压缩。','issues':[{'area':'正文','severity':'warning','message':'文字过密','suggestion':'缩短摘要'}]}
        c.execute("UPDATE conversation_turns SET state='succeeded',response_text=? WHERE id=?",(json.dumps(verdict),row['turn_id']))
    result=client.get(endpoint).json()['review']
    assert result['state']=='complete' and result['result']['verdict']=='needs_changes'
    assert result['review_focus']==review['review_focus']
    assert service.detail(card['id'])==card
    assert service.conversation_store.list_conversations(exclude_intelligence=True)==[]
    assert client.post(endpoint,json={**payload,'request_id':'stale','expected_revision':99}).status_code==409


def test_visual_review_rejects_unready_cards_and_invalid_model_json(configured, monkeypatch, tmp_path):
    from apps.api.app import research_attachments
    monkeypatch.setattr(research_attachments,'application_paths',lambda:SimpleNamespace(attachments_root=tmp_path/'attachments'))
    client,_=configured
    card=service.start(request())
    endpoint=f"/api/v1/client-service/cards/{card['id']}/review"
    assert client.post(endpoint,json={'request_id':'unready','expected_revision':card['revision']}).status_code==422
    card=finish(card)
    review=client.post(endpoint,json={'request_id':'bad-json','expected_revision':card['revision']}).json()
    assert review['state']=='queued',review
    with db.connect() as c:
        row=c.execute('SELECT turn_id FROM client_service_reviews WHERE id=?',(review['id'],)).fetchone()
        c.execute("UPDATE conversation_turns SET state='succeeded',response_text='not a verdict' WHERE id=?",(row['turn_id'],))
    assert client.get(endpoint).json()['review']['state']=='failed'


@pytest.mark.parametrize('values', [{'opened': False}, {'published': (WHEN + timedelta(minutes=1)).isoformat()}, {'published': '2026-11-13 10:31:00+08:00'}])
def test_unopened_or_future_sources_are_not_published(configured, values):
    card = finish(service.start(request()), **values)
    assert card['state'] == 'failed' and card['market'] is None
    assert not images.image_path(card['id']).exists()


def test_future_metrics_remain_unknown_instead_of_becoming_current_values(configured):
    card = finish(service.start(request()), observed=(WHEN + timedelta(minutes=1)).isoformat())
    assert card['state'] == 'failed' and card['market'] is None
    assert '核心指数采集不完整' in card['message']


def test_three_unknown_indices_are_not_reported_as_a_ready_card(configured):
    card=service.start(request())
    with db.connect() as c:
        row=c.execute('SELECT * FROM client_service_cards WHERE id=?',(card['id'],)).fetchone()
        text=json.dumps({'summary':'三大指数普遍走弱。','metrics':[{'label':label,'value':'未核实','source_url':None,'observed_at':None} for label in ('上证指数','深证成指','创业板指')],'sources':[{'title':'来源','url':URL,'published_at':WHEN.isoformat()}]})
        c.execute("UPDATE conversation_turns SET state='succeeded',response_text=? WHERE id=?",(text,row['turn_id']))
    for i,item in enumerate([{'type':'webSearch','action':{'type':'search'},'results':[{'url':URL,'ref_id':'turn0search0'}]},{'type':'webSearch','action':{'type':'openPage','url':URL}}]):
        codex_store.append_event(row['conversation_id'],row['turn_id'],'thread','turn',i,'item/completed',{'item':item})
    assert service.detail(card['id'])['state']=='failed'
    assert not images.image_path(card['id']).exists()


def test_prepared_server_quotes_fill_model_unknowns_without_a_web_document_open(configured,monkeypatch):
    from apps.api.app import client_service_market as market
    card=service.start(request())
    with db.connect() as c:row=c.execute('SELECT * FROM client_service_cards WHERE id=?',(card['id'],)).fetchone()
    metrics=[market.quote(code,price,'3000',WHEN,'测试财经行情',f'https://example.com/{code}',{'close':price}) for code,price in zip(market.INDEXES,('2990','2980','2970'))]
    snapshot={'cutoff':WHEN.isoformat(),'metrics':metrics,'sources':[{'title':i['provider'],'url':i['source_url'],'published_at':None} for i in metrics],'attempts':[],'missing':[]}
    calls=[]
    monkeypatch.setattr(market,'collect',lambda *args,**kwargs:(calls.append(1) or snapshot))
    market.prepare(row['conversation_id'],row['turn_id']);market.prepare(row['conversation_id'],row['turn_id'])
    assert len(calls)==1
    card=finish(card,opened=False)
    assert card['state']=='ready' and len(card['market']['metrics'])==3
    assert card['market']['metrics'][0]['value']=='2990.00点 -0.33%'
    assert card['market']['metrics'][0]['raw']=={'close':'2990'}


def test_customer_png_omits_internal_collection_diagnostics(configured):
    card=finish(service.start(request()))
    baseline=images.render_card(card)
    card['market']['limitations']=['Tushare 没有接口权限，未核实，继续补采。'*20]
    assert images.render_card(card)==baseline
    assert 'Tushare' not in card['market']['public_notes'][0]


def test_customer_png_renders_link_labels_and_keeps_the_original_card():
    template = service.default_settings().templates[2].model_dump()
    card = {
        'template': template, 'service_date': DAY,
        'content': {**template['content'], 'conclusion': '观察公告'},
        'market': {
            'summary': '强弱分化。', 'data_note': '沪深两市口径。',
            'metrics': [{'label': '上证指数', 'value': '3600点 +0.2%', 'observed_at': WHEN.isoformat()}],
            'sources': [{'title': '公开市场数据', 'url': 'https://example.com/source'}],
        },
    }
    expected = images.render_card(card)
    card['content']['conclusion'] = '观察[公告](https://example.com/filing)'
    card['market']['summary'] = '强弱分化（www.example.cn/market）。'
    card['market']['data_note'] = '沪深两市口径（https://example.com/notes）。'
    card['market']['metrics'][0]['value'] = '3600点 +0.2% <https://example.com/data>'
    card['market']['sources'][0]['title'] = '公开市场数据 example.org/source'
    assert images.render_card(card) == expected
    assert 'https://example.com/filing' in card['content']['conclusion']
    assert card['market']['sources'][0]['url'] == 'https://example.com/source'


def test_missing_optional_statistics_are_omitted_from_the_finished_card(configured):
    card=finish(service.start(request()))
    with db.connect() as c:row=dict(c.execute('SELECT * FROM client_service_cards WHERE id=?',(card['id'],)).fetchone())
    body={'summary':card['market']['summary'],'metrics':card['market']['metrics']+[{'label':'涨停家数','value':'未核实','source_url':None,'observed_at':None}], 'sources':card['market']['sources']}
    result=service.verified_market(row,json.dumps(body))
    assert len(result['metrics'])==3 and all(item['value']!='未核实' for item in result['metrics'])


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


def test_replayed_brief_prepares_quotes_at_original_cutoff_and_keeps_generation_time(configured, monkeypatch):
    from apps.api.app import client_service_market as market, client_service_runtime

    client, _ = configured
    cutoff = WHEN.replace(hour=13, minute=4, second=11)
    generated_at = (cutoff + timedelta(hours=1)).isoformat()
    monkeypatch.setattr(service, 'now', lambda: cutoff)
    original = finish(client.post('/api/v1/client-service/briefs', json={'request_id': 'original-brief', 'theme': 'gold'}).json(),
                      commentary=COMMENTARY)
    monkeypatch.setattr(service, 'now', lambda: cutoff + timedelta(hours=1))
    focus = '重点解释半日成交和行业分化。'
    command = {'request_id': 'original-cutoff', 'source_card_id': original['id'], 'generation_focus': focus}
    replay = client.post('/api/v1/client-service/briefs', json=command)
    assert replay.status_code == 202, replay.text
    replay = replay.json()
    assert replay['id'] != original['id'] and replay['cutoff'] == original['cutoff'] == cutoff.isoformat()
    assert replay['generation_focus'] == focus and original['generation_focus'] == ''
    assert replay['template']['time'] == '13:04' and replay['content']['theme'] == 'gold'
    assert replay['content']['headline'] == '' and original['content']['headline'] == COMMENTARY['headline']
    assert client.post('/api/v1/client-service/briefs', json=command).json()['id'] == replay['id']
    assert client.post('/api/v1/client-service/briefs', json={'request_id': 'original-cutoff'}).status_code == 409

    observed = cutoff.replace(second=0)
    metrics = [market.quote(code, '2990', '3000', observed, '样例行情', f'https://example.com/{code}', {})
               for code in market.INDEXES]
    snapshot = {'cutoff': cutoff.isoformat(), 'metrics': metrics, 'sources': [], 'attempts': [], 'missing': []}
    calls = []
    monkeypatch.setattr(market, 'collect', lambda value: calls.append(value) or snapshot)
    with db.connect() as connection:
        row = connection.execute('SELECT conversation_id,turn_id FROM client_service_cards WHERE id=?', (replay['id'],)).fetchone()
        connection.execute('UPDATE conversation_turns SET updated_at=? WHERE id=?', (generated_at, row['turn_id']))
    client_service_runtime.prepare(*row)
    client_service_runtime.prepare(*row)
    prompt = json.loads(client_service_runtime.prompt(*row))
    assert calls == [cutoff.isoformat()]
    assert prompt['client_market_snapshot']['cutoff'] == cutoff.isoformat()
    assert len(prompt['client_market_snapshot']['metrics']) == 3
    assert prompt['本次关注点'] == focus

    result = finish(replay, commentary=COMMENTARY)
    assert result['state'] == 'ready', result['message']
    assert result['market']['generated_at'] == generated_at
    assert result['market']['public_notes'] == ['行情时点 11-13 13:04（北京时间）']
    images_before = images.render_card(result)
    saved = service.save_card(result['id'], SaveCard(revision=result['revision'], content=CardContent(**result['content'])))
    assert saved['market']['generated_at'] == generated_at and images.render_card(saved) == images_before


@pytest.mark.parametrize('summary, commentary, message', [
    ('A股早盘探底回升，沪指仍收跌。', COMMENTARY, '收盘措辞'),
    ('午间指数表现分化。', {**COMMENTARY, 'headline': '修复分化仍待验证'}, '标题'),
    ('午间指数表现分化。', {**COMMENTARY, 'action': '两条行业消息催化相关题材。'}, '涨跌原因'),
    ('午间指数表现分化。', {**COMMENTARY, 'action': '行业消息已公开，直接催化关系尚不明确。'}, None),
    ('截至午间收盘，沪指下跌。', COMMENTARY, None),
])
def test_instant_copy_checks_timing_and_cause_before_publishing(configured, monkeypatch, summary, commentary, message):
    client, _ = configured
    monkeypatch.setattr(service, 'now', lambda: WHEN.replace(hour=13, minute=4))
    card = client.post('/api/v1/client-service/briefs', json={'request_id': 'copy-check'}).json()
    result = finish(card, observed=WHEN.replace(hour=11, minute=30).isoformat(), summary=summary, commentary=commentary)
    if message:
        assert result['state'] == 'failed' and message in result['message']
        assert result['market'] is None and not images.image_path(card['id']).exists()
    else:
        assert result['state'] == 'ready', result['message']


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
    draft = client.post('/api/v1/client-service/preview?draft=true', json={
        'template': value['template'], 'date': DAY, 'content': value['content'], 'card_id': value['id'],
    }).json()
    assert draft['saved_image_hash'] == preview['image_hash']
    assert draft['image_hash'] != draft['saved_image_hash']
    settings = service.settings()
    settings['templates'][2]['content'] = edited
    saved_settings = client.put('/api/v1/client-service/settings', json=settings).json()
    assert saved_settings['templates'][2]['content']['market_overrides'] == {}
    assert saved_settings['templates'][2]['content']['conclusion'] == '直接从图片编辑的判断'
    assert client.put(f"/api/v1/client-service/cards/{card['id']}", json={'revision': value['revision'], 'content': {**edited, 'market_overrides': {'source_url': 'https://wrong.test'}}}).status_code == 422
