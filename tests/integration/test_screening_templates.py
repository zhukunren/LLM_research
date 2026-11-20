from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from apps.api.app import conversation_store, db, main, market, runtime_executor, screening_runner, tushare_sync, worker
from apps.api.app.screening_templates import INDUSTRY_TEMPLATE_ID, TEMPLATES


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


def test_dedicated_catalog_exposes_single_rules_without_changing_existing_starters(client):
    existing = client.get('/api/v1/screening-templates').json()['items']
    dedicated = client.get('/api/v1/screening-templates?include_singles=true').json()['items']
    assert {item['id'] for item in existing} == {'trend_momentum', 'cross_confirm', 'cross_momentum'}
    assert {item['id'] for item in dedicated} == {item['id'] for item in TEMPLATES}
    fixed = client.get('/api/v1/screening-templates?include_singles=true&include_industry=true').json()['items']
    assert fixed[-1]['id'] == INDUSTRY_TEMPLATE_ID and fixed[-1]['requires_industry']


def test_industry_valuation_uses_dated_inputs_for_preview_and_run(client, tmp_path, monkeypatch):
    codes = ['600000.SH', '600001.SH', '600002.SH', '600003.SH']
    start, end = '2026-09-11', '2026-09-14'
    calls = []

    def member(code, entry='19981005', exit=None):
        return dict(ts_code=code, in_date=entry, out_date=exit, l1_code='801080.SI', l1_name='电子',
                    l2_code='801081.SI', l2_name='半导体', l3_code='850811.SI', l3_name='数字芯片设计')

    class Feed:
        def raw_query(self, name, **params):
            calls.append((name, params))
            if name == 'index_member_all':
                if params['is_new'] == 'Y':
                    return [member(codes[0]), member(codes[1]), member(codes[2], '20260915'), member(codes[3])]
                return [member(codes[2], exit='20260914')]
            if name == 'daily_basic':
                assert params['trade_date'] == '20260914'
                return [dict(ts_code=code, trade_date='20260914', pe_ttm=pe)
                        for code, pe in zip(codes, (10, 30, None, 60), strict=True)]
            if name == 'trade_cal':
                return [dict(cal_date=value.replace('-', ''), is_open=1) for value in (start, end)]
            assert name == 'daily' and params['trade_date'] == '20260911'
            return [dict(ts_code=code, trade_date='20260911', amount=40000) for code in codes]

    def bars(*_):
        return [dict(trade_date=start, amount=40000000, quality_valid=True),
                dict(trade_date=end, amount=60000, quality_valid=True)]

    monkeypatch.setattr(tushare_sync, 'STOCK_FILE', tmp_path / 'stock_daily.parquet')
    monkeypatch.setattr(tushare_sync, 'create_client', Feed)
    monkeypatch.setattr(tushare_sync, '_market_completion', lambda: {'complete_days': [end]})
    monkeypatch.setattr(market, 'get_bars', bars)
    monkeypatch.setattr(market, 'iter_recent_bars', lambda as_of, limit, stocks: [(code, bars()) for code in stocks])
    assert {'code': '801081.SI', 'name': '半导体', 'level': 2} in client.get('/api/v1/screening-industries').json()['items']

    inputs = {'version': 1, 'as_of': end, 'parameters': {'amount_window': 2, 'min_daily_amount_yi': 0.5},
              'industry': {'industry_code': '801081.SI', 'pe_comparison': 'below_industry_median'}}
    preview_url = f'/api/v1/screening-templates/{INDUSTRY_TEMPLATE_ID}/preview'
    preview = client.post(preview_url, json={**inputs, 'stock_code': codes[0]})
    assert preview.status_code == 200, preview.text
    assert preview.json()['state'] == 'true'
    detail = preview.json()['details'][0]
    assert detail['data_as_of'] == end
    assert detail['actual_values']['市盈率（TTM）'] == 10
    assert detail['actual_values']['日均成交额'] == 0.5
    assert detail['actual_values']['行业正市盈率样本'] == 3
    assert detail['thresholds']['市盈率（TTM）'] == 30

    cid = client.post('/api/v1/conversations', json={'entry_scope': 'screening', 'workflow_type': 'screening'}).json()['id']
    base = f'/api/v1/conversations/{cid}'
    published = client.post(f'{base}/screening-templates/{INDUSTRY_TEMPLATE_ID}', json={
        **inputs, 'base_revision': 0, 'client_message_id': 'industry-valuation', 'universe': {'kind': 'all_a_shares'},
    })
    assert published.status_code == 201, published.text
    saved = published.json()
    assert saved['task']['conditions'][0]['library'] == 'fundamentals'
    assert saved['task']['conditions'][0]['program'] is None
    queued = client.post(f"{base}/turns/{saved['turn_id']}/execute", json={'action': 'message'})
    assert queued.status_code == 202, queued.text
    assert worker.execute_job(queued.json()['job_id'])

    run_url = f"{base}/screening-runs/{queued.json()['run_id']}"
    run = client.get(run_url).json()
    assert run['status'] == 'partial'
    assert any(item.startswith(f'tushare:daily_basic-{end}:sha256:') for item in run['result']['source_manifests'])
    decisions = {row['stock_code']: row for row in client.get(f'{run_url}/decisions').json()['items']}
    assert [decisions[code]['state'] for code in codes[:3]] == ['true', 'false', 'unknown']
    assert decisions[codes[0]]['condition_decisions'][0]['actual_values'] == detail['actual_values']
    assert '缺少可确认的申万行业成分记录' in decisions[codes[2]]['condition_decisions'][0]['explanation']
    assert [name for name, _ in calls].count('daily_basic') == 1
    assert [name for name, _ in calls].count('daily') == 1


def test_home_trend_shorthand_and_same_conversation_edit_use_the_same_rules(client, monkeypatch):
    from apps.api.app import codex_runtime

    def unexpected_model():
        pytest.fail('已匹配的固定公式不需要排队调用模型')

    monkeypatch.setattr(codex_runtime, 'availability', unexpected_model)
    cid = client.post('/api/v1/conversations', json={'entry_scope': 'screening', 'workflow_type': 'research'}).json()['id']
    url = f'/api/v1/conversations/{cid}'
    body = {'client_message_id': 'trend', 'base_revision': 0, 'route_screening': True,
            'content': '收盘价高于 20 日均线、近 5 个交易日涨幅超过 3%'}
    accepted = client.post(url + '/messages', json=body)
    assert accepted.status_code == 202, accepted.text
    turn = accepted.json()['turn']
    assert turn['state'] == 'succeeded' and turn['workflow_type'] == 'screening'
    assert turn['result']['template_parameters'] == {'ma_window': 20, 'return_window': 5, 'threshold': 3}
    replay = client.post(url + '/messages', json=body)
    assert replay.status_code == 200, replay.text
    assert replay.json()['turn']['id'] == turn['id']
    first_runs = client.get(url + '/screening-runs').json()['items']
    assert len(first_runs) == 1
    assert first_runs[0]['as_of'] == '2026-09-14'

    update = client.post(url + '/messages', json={'client_message_id': 'threshold', 'base_revision': 1,
                         'content': '把近 5 个交易日涨幅门槛从 3% 改成超过 5%，其他条件、股票范围和日期沿用，再筛一次。'}).json()
    modified = client.post(f"{url}/turns/{update['turn_id']}/process")
    assert modified.status_code == 200, modified.text
    assert modified.json()['result']['template_parameters']['threshold'] == 5

    revisions = [client.get(f'{url}/revisions/{value}').json() for value in (1, 2)]
    assert revisions[0]['scope'] == revisions[1]['scope']
    assert revisions[0]['conditions'][0] == revisions[1]['conditions'][0]
    assert revisions[0]['conditions'][1]['program']['source_code'] == revisions[1]['conditions'][1]['program']['source_code']
    assert revisions[1]['conditions'][1]['program']['parameters']['threshold'] == 5
    assert sorted(run['task_revision'] for run in client.get(url + '/screening-runs').json()['items']) == [1, 2]


@pytest.mark.parametrize('content', [
    '收盘价高于20日均线、近5个交易日涨幅超过3%，不要执行。',
    '截至2026-09-10，筛选收盘价高于20日均线、近5个交易日涨幅超过3%的股票。',
    '筛选收盘价高于20日均线、近5个交易日涨幅超过3%的股票，再加成交量超过1亿元。',
    '收盘价高于20日均线、近5个交易日涨幅超过3%。\n\n[选股工作台指令]\n行情截止日期以界面设置为准：2026-09-10。',
])
def test_custom_or_preview_request_still_uses_the_agent(client, monkeypatch, content):
    from apps.api.app import codex_runtime

    monkeypatch.setattr(codex_runtime, 'availability', lambda: {'available': True})
    cid = client.post('/api/v1/conversations', json={'entry_scope': 'screening', 'workflow_type': 'screening'}).json()['id']
    url = f'/api/v1/conversations/{cid}'
    message = client.post(url + '/messages', json={'client_message_id': 'custom', 'base_revision': 0, 'content': content}).json()
    processed = client.post(f"{url}/turns/{message['turn_id']}/process")
    assert processed.status_code == 202, processed.text
    assert processed.json()['job']['state'] == 'queued'
    assert client.get(url + '/screening-runs').json()['items'] == []


def preview_bars(count=35):
    return [dict(trade_date=str(date(2026, 9, 14) - timedelta(days=count - i - 1)),
                 open=10 + i, high=12 + i, low=9 + i, close=11 + i,
                 volume=1000, quality_valid=True) for i in range(count)]


def test_template_preview_evaluates_rules_and_chart_without_creating_work(client, monkeypatch):
    monkeypatch.setattr(market, 'get_bars', lambda *_: preview_bars())
    before = client.get('/api/v1/conversations').json()['items']
    payload = dict(version=1, parameters={'ma_window': 20, 'return_window': 5, 'threshold': 3}, stock_code='600000.SH', as_of='2026-09-14')
    response = client.post('/api/v1/screening-templates/trend_momentum/preview', json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['state'] == 'true'
    assert [item['state'] for item in result['details']] == ['true', 'true']
    assert result['actual_date'] == '2026-09-14'
    assert result['chart']['lines'][0]['label'] == 'SMA 20'
    assert result['chart']['lines'][0]['values'][-1] == pytest.approx(sum(range(26, 46)) / 20)
    assert client.get('/api/v1/conversations').json()['items'] == before
    with db.connect() as connection:
        assert connection.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 0


@pytest.mark.parametrize('case', ['short', 'stale', 'invalid'])
def test_template_preview_keeps_missing_stale_and_invalid_data_unknown(client, monkeypatch, case):
    bars = preview_bars(5 if case == 'short' else 35)
    if case == 'stale':
        bars[-1]['trade_date'] = '2026-09-13'
    elif case == 'invalid':
        bars[-1].update(close=float('nan'), quality_valid=False)
    monkeypatch.setattr(market, 'get_bars', lambda *_: bars)
    response = client.post('/api/v1/screening-templates/above_sma/preview', json=dict(version=1, parameters={'window': 20}, stock_code='600000.SH', as_of='2026-09-14'))
    assert response.status_code == 200, response.text
    assert response.json()['state'] == 'unknown'
    assert response.json()['details'][0]['reason']


@pytest.mark.parametrize('changes', [{'parameters': {'window': True}}, {'as_of': '2026-10-01'}, {'stock_code': 'not-a-code'}, {'parameters': {'window': 20.5}}])
def test_template_preview_rejects_invalid_requests(client, changes):
    payload = dict(version=1, parameters={'window': 20}, stock_code='600000.SH', as_of='2026-09-14')
    assert client.post('/api/v1/screening-templates/above_sma/preview', json={**payload, **changes}).status_code == 422


@pytest.mark.parametrize('template_id', ['above_sma', 'return_above', 'ma_cross', 'trend_momentum', 'cross_confirm', 'cross_momentum'])
def test_full_deterministic_lifecycle(client, monkeypatch, template_id):
    cid, msg, url, payload = setup_plan(client, template_id)
    created = client.post(url, json=payload)
    assert created.status_code == 201, created.text
    msg = {'turn_id': created.json()['turn_id']}
    task = created.json()['task']
    if template_id in {'trend_momentum', 'cross_confirm', 'cross_momentum'}:
        assert len(task['conditions']) == 2 and len(task['references']) == 2
        assert task['logic_tree']['op'] == 'all' and len(task['logic_tree']['children']) == 2
    assert task['conditions'][0]['program']['source_code'].startswith('def screen(')
    with db.connect() as connection:
        assert connection.execute('SELECT count(*) FROM jobs').fetchone()[0] == 0
    assert client.get(f'/api/v1/conversations/{cid}/screening-runs').json()['items'] == []
    current = client.get(f'/api/v1/conversations/{cid}').json()
    assert current['turns'][0]['result']['execution_authorized'] is True
    assert current['turns'][0]['result']['ready_to_execute'] is True
    assert current['pending_execution'] is True
    replay = client.post(url, json=payload)
    assert replay.status_code == 201 and replay.json()['idempotent_replay']
    assert len(client.get(f'/api/v1/conversations/{cid}').json()['messages']) == len(current['messages'])
    assert client.post(url, json={**payload, 'parameters': {**payload['parameters'], next(iter(payload['parameters'])): 4}}).status_code == 409
    execute_url = f"/api/v1/conversations/{cid}/turns/{msg['turn_id']}/execute"
    assert client.post(execute_url, json={'action': 'button', 'revision': 2, 'request_id': 'wrong'}).status_code == 409
    queued = client.post(execute_url, json={'action': 'message'})
    assert queued.status_code == 202, queued.text
    assert client.post(execute_url, json={'action': 'message'}).json()['run_id'] == queued.json()['run_id']
    assert client.get(f'/api/v1/conversations/{cid}').json()['pending_execution'] is False
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
    execute = client.post(f"/api/v1/conversations/{cid}/turns/{plan.json()['turn_id']}/execute", json={'action': 'message'})
    assert execute.status_code == 503 and execute.json()['code'] == 'runtime_unavailable'
    assert client.get(f'/api/v1/conversations/{cid}/screening-runs').json()['items'] == []


def test_catalogue_presents_three_combinations_and_rejects_invalid_cross_periods(client):
    items = client.get('/api/v1/screening-templates').json()['items']
    assert [item['id'] for item in items] == ['trend_momentum', 'cross_confirm', 'cross_momentum']
    assert all(len(item['rules']) == 2 for item in items)
    cid, _, url, payload = setup_plan(client, 'cross_confirm', {'fast': 20, 'slow': 5})
    assert client.post(url, json=payload).status_code == 422
    assert client.get(f'/api/v1/conversations/{cid}').json()['task_revision'] == 0


def test_combination_requires_both_independent_conditions(client, monkeypatch):
    cid, _, url, payload = setup_plan(client, 'trend_momentum')
    plan = client.post(url, json=payload)
    assert plan.status_code == 201, plan.text
    queued = client.post(f"/api/v1/conversations/{cid}/turns/{plan.json()['turn_id']}/execute",
                         json={'action': 'message'}).json()
    prices = {'600000.SH': [20.] * 15 + [10.] * 5 + [11.],
              '600001.SH': [10.] * 20 + [10.1], '600002.SH': [10.] * 20 + [12.]}
    def bars(_date, limit, codes):
        return [(code, [{'trade_date': (date(2026, 9, 14) - timedelta(days=len(values)-1-i)).isoformat(),
                         'close': price, 'quality_valid': True} for i, price in enumerate(values)])
                for code in codes for values in [prices[code][-limit:]]]
    monkeypatch.setattr(market, 'iter_recent_bars', bars)
    assert worker.execute_job(queued['job_id'])
    decisions = client.get(f"/api/v1/conversations/{cid}/screening-runs/{queued['run_id']}/decisions").json()['items']
    assert {item['stock_code']: item['state'] for item in decisions} == {'600000.SH': 'false', '600001.SH': 'false', '600002.SH': 'true'}
