from datetime import date
from unittest.mock import Mock
import copy
import json
import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from apps.api.app import daily_signals_api as service

DAY = '2026-11-12'
CODE = '300001.SZ'
PAYLOAD = {'date': DAY, 'n': 20, 'strategy_name': 'test_strategy', 'generation_id': 'generation-1', 'code': CODE, 'side': 'buy'}

@pytest.fixture
def client(monkeypatch):
    app = FastAPI(); app.include_router(service.router)
    return TestClient(app)


def snapshot(side='buy'):
    return {'schema_version': 1, 'date': DAY, 'strategies': [{
        'strategy_name': 'test_strategy', 'strategy_title': '测试策略', 'generation_id': 'generation-1', 'covers_date': True,
        'buy_signals': [{'code': CODE, 'name': '测试股票'}] if side == 'buy' else [],
        'sell_signals': [{'code': CODE, 'name': '测试股票'}] if side == 'sell' else [],
        'win_rate': 1.0, 'ann_return': 10.0,
    }]}


def description(side='buy', source_hash='hash'):
    return {'run_id': 'generation-1', 'cache_projection': {'strategy_source_sha256': 'hash'}, 'catalog_entry': {
        'description_status': 'verified', side + '_logic': '根据量价和风险条件筛选。',
        'strategy_description': {'source': {'sha256': source_hash}},
    }}


def test_quote_batch_preserves_zero_and_omits_missing_codes(client, monkeypatch):
    monkeypatch.setattr(service, 'market_day', lambda _: {CODE: {'code': CODE, 'date': DAY, 'volume': 0, 'volume_unit': '手'}})
    response = client.post('/api/v1/daily-signals/market', json={'date': DAY, 'codes': [CODE, CODE, '600000.SH']})
    assert response.status_code == 200
    assert response.json()['items'] == [{'code': CODE, 'date': DAY, 'volume': 0, 'volume_unit': '手'}]
    assert client.post('/api/v1/daily-signals/market', json={'date': DAY, 'codes': ['invalid']}).status_code == 422


def test_market_cache_is_bounded_and_keeps_tushare_units(monkeypatch):
    service._market_cache.clear()
    monkeypatch.setattr(service, 'tushare_settings', lambda: {'token': 'test-secret', 'api_url': 'http://relay.example.test'})
    monkeypatch.setattr(service, 'configured_limiter', lambda: None)
    calls = []
    class Client:
        def __init__(self, *_args, api_url, **_kwargs):
            assert api_url == 'http://relay.example.test'
        def raw_query(self, _api, **params):
            calls.append(params['trade_date'])
            return {'data': {'fields': ['ts_code', 'trade_date', 'vol'], 'items': [[CODE, params['trade_date'], 0], ['600000.SH', '20990101', 999]]}}
    monkeypatch.setattr(service, 'TushareClient', Client)
    for day in [date(2026, 11, 9), date(2026, 11, 10), date(2026, 11, 11)]:
        result = service.market_day(day)
        assert result[CODE]['volume'] == 0
        assert result[CODE]['volume_unit'] == '手'
        assert '600000.SH' not in result
    service.market_day(date(2026, 11, 11))
    assert len(calls) == 3 and len(service._market_cache) == 2
    service._market_cache.clear()


def named_snapshot():
    source = snapshot()
    source.update(dates=[DAY], n=20, unavailable_count=0, items=[{'private_metadata': '未公开的元数据'}])
    source['strategies'][0].update(strategy_name='private_original_name', strategy_title='量价突破趋势动量',
                                   generation_id='private_original_name-generation', private_metadata='未公开的元数据')
    return source


def test_signals_replace_source_names_and_ids_without_exposing_internal_metadata(client, monkeypatch):
    source = named_snapshot()
    upstream = Mock(return_value=httpx.Response(200, json=source, request=httpx.Request('GET', 'https://example.test')))
    monkeypatch.setattr(service.httpx, 'get', upstream)
    response = client.get('/api/v1/daily-signals/signals?n=10&date=' + DAY)
    assert response.status_code == 200
    result = response.json()
    strategy = result['strategies'][0]
    assert strategy['strategy_name'].startswith('signal-')
    assert strategy['strategy_title'] != source['strategies'][0]['strategy_title']
    assert strategy['generation_id'] == ''
    assert strategy['buy_signals'] == source['strategies'][0]['buy_signals']
    assert strategy['win_rate'] == 1.0 and strategy['ann_return'] == 10.0
    assert 'private_original_name' not in response.text
    assert '未公开的元数据' not in json.dumps(result, ensure_ascii=False)
    assert 'items' not in result and 'private_metadata' not in strategy
    assert upstream.call_args.kwargs['params'] == {'n': '10', 'date': DAY}
    client.get('/api/v1/daily-signals/signals')
    assert upstream.call_args.kwargs['params'] == {'n': '20'}


def test_signal_ids_remain_stable_and_titles_follow_upstream_renames():
    source = named_snapshot()
    source['strategies'].append({**source['strategies'][0], 'strategy_name': 'another_private_name', 'strategy_title': '深度缺口反转'})
    original = copy.deepcopy(source)
    first = service.named_signals(source)
    assert source == original
    source['date'] = '2026-11-11'
    source['n'] = 10
    source['strategies'].reverse()
    source['strategies'][1].update(strategy_title='真实策略名称', generation_id='new-generation')
    second = service.named_signals(source)
    assert [s['strategy_name'] for s in first['strategies']] == [s['strategy_name'] for s in reversed(second['strategies'])]
    assert {s['strategy_name']: s['strategy_title'] for s in first['strategies']} == {
        s['strategy_name']: s['strategy_title'] for s in second['strategies']}
    assert '真实策略名称' not in json.dumps(second, ensure_ascii=False)


def test_signal_without_a_title_still_uses_a_stable_alias():
    source = named_snapshot()
    source['strategies'][0].pop('strategy_title')
    assert service.named_signals(source)['strategies'][0]['strategy_title'] != '未命名策略'


def test_signals_reject_invalid_queries_and_do_not_return_upstream_errors(client, monkeypatch):
    upstream = Mock(return_value=httpx.Response(503, text='private_original_name', request=httpx.Request('GET', 'https://example.test')))
    monkeypatch.setattr(service.httpx, 'get', upstream)
    for query in ('n=0', 'n=10001', 'date=invalid'):
        assert client.get('/api/v1/daily-signals/signals?' + query).status_code == 422
    upstream.assert_not_called()
    response = client.get('/api/v1/daily-signals/signals')
    assert response.status_code == 503 and 'private_original_name' not in response.text
    upstream.return_value = httpx.Response(200, json={'strategies': []}, request=httpx.Request('GET', 'https://example.test'))
    assert client.get('/api/v1/daily-signals/signals').status_code == 502
