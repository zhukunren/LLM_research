import hashlib
import json
from datetime import date

import pytest
from fastapi.testclient import TestClient

from apps.api.app import db, main, news_library, news_sources, report_catalog, worker, pattern_examples, index_market
from apps.api.app.model_client import ModelRequestError


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'reading.db')
    monkeypatch.setattr(report_catalog, 'llm_settings', lambda: {'configured': True, 'model': 'fixture'})
    with TestClient(main.app) as session:
        yield session


def news(title, timestamp):
    return news_sources.NewsItemInput(title=title, body=title + '：公司已经签署订单。', source='公告', available_at=timestamp)


def test_news_dates_filter_before_model_and_history_retains_range(client, monkeypatch):
    news_sources.import_items(news_sources.NewsImport(request_id='seed', items=[
        news('too-early', '2026-09-13T15:59:59+00:00'), news('in-start', '2026-09-13T16:00:00+00:00'),
        news('in-end', '2026-09-14T15:59:59+00:00'), news('too-late', '2026-09-14T16:00:00+00:00'), news('undated', None)]))
    sent = []
    def complete(instructions, content, **kwargs):
        articles = json.loads(content)['articles']; sent.extend(articles)
        return {'items': [{'id': item['id'], 'matched': True, 'reason': '已签署', 'quote': '公司已经签署订单。'} for item in articles]}
    monkeypatch.setattr(news_library, 'complete_json', complete)
    response = client.post('/api/v1/condition-drafts', json={'library': 'news', 'prompt': '已经签署订单', 'start_date': '2026-09-14', 'end_date': '2026-09-14'})
    assert response.status_code == 200
    draft = response.json()
    assert {item['title'] for item in sent} == {'in-start', 'in-end'}
    assert draft['news_matches']['matched_count'] == 2
    assert client.get('/api/v1/condition-drafts/' + draft['id']).json()['news_matches']['end_date'] == '2026-09-14'
    assert client.post('/api/v1/condition-drafts', json={'library': 'news', 'prompt': '订单', 'start_date': '2026-09-15', 'end_date': '2026-09-14'}).status_code == 422


def test_news_empty_range_skips_model_and_invalid_evidence_fails(client, monkeypatch):
    monkeypatch.setattr(news_library, 'complete_json', lambda *a, **k: pytest.fail('empty range must not call model'))
    assert news_library.match_news('订单', date(2026, 9, 14), date(2026, 9, 14))['candidate_count'] == 0
    record = news_sources.import_items(news_sources.NewsImport(request_id='seed', items=[news('in', '2026-09-14T08:00:00+08:00')]))['items'][0]
    monkeypatch.setattr(news_library, 'complete_json', lambda *a, **k: {'items': [{'id': record['id'], 'matched': True, 'reason': '订单', 'quote': '编造证据'}]})
    with pytest.raises(ModelRequestError):
        news_library.match_news('订单', date(2026, 9, 14), date(2026, 9, 14))


def test_url_import_saves_standard_news_and_replay_avoids_browser(client, monkeypatch):
    monkeypatch.setattr(news_library, 'extract_web_text', lambda url: {'url': url, 'title': '网页', 'text': '网页原文'})
    monkeypatch.setattr(news_library, 'complete_json', lambda *a, **k: {'title': '订单', 'body': '公司签署订单。', 'source': '公告', 'published_at': '2026-09-14T08:00:00+08:00', 'stock_codes': ['600000.SH'], 'event_key': None})
    request = {'request_id': 'url-1', 'url': 'https://example.com/article'}
    result = client.post('/api/v1/news/import-url', json=request)
    assert result.status_code == 201
    assert result.json()['items'][0]['stock_codes'] == ['600000.SH']
    monkeypatch.setattr(news_library, 'extract_web_text', lambda url: pytest.fail('replay must not open browser'))
    assert client.post('/api/v1/news/import-url', json=request).json()['replay'] is True
    assert client.post('/api/v1/news/import-url', json={**request, 'url': 'https://example.com/other'}).status_code == 409


def add_report(tmp_path):
    path = tmp_path / 'report.pdf'; path.write_bytes(b'%PDF-1.4\nfixture')
    with db.connect() as connection:
        connection.execute("INSERT INTO documents(id,sha256,filename,title,pages,extracted_chars,parse_status,source_path,imported_at) VALUES('report',?,'wrong-000002.SZ-20250901.pdf','wrong',1,100,'indexed',?,?)", (hashlib.sha256(path.read_bytes()).hexdigest(), str(path), db.utc_now()))
        connection.execute("INSERT INTO document_pages VALUES('report',1,'浦发银行 600000.SH 银行研究 券商甲 分析师张三 2026年9月14日 订单增长')")


def report_fields():
    values = {'stock_code': '600000.SH', 'stock_name': '浦发银行', 'title': '银行研究', 'analysts': '张三', 'broker': '券商甲', 'theme': '银行研究', 'main_points': '订单增长', 'publication_date': '2026-09-14'}
    return {'fields': {key: {'value': value, 'page': 1, 'quote': '2026年9月14日' if key == 'publication_date' else value} for key, value in values.items()}}


def test_report_dictionary_auto_confirms_from_pages_and_serves_inline_pdf(client, tmp_path, monkeypatch):
    add_report(tmp_path)
    monkeypatch.setattr(report_catalog, 'complete_json', lambda *a, **k: report_fields())
    assert client.post('/api/v1/documents/catalog').json()['queued'] == 1
    assert client.post('/api/v1/documents/catalog').json()['queued'] == 0
    with db.connect() as connection:
        job_id = connection.execute("SELECT metadata_job_id FROM documents WHERE id='report'").fetchone()[0]
    worker.execute_job(job_id)
    report = client.get('/api/v1/documents').json()['items'][0]
    assert report['metadata_status'] == 'ready'
    assert report['stock_code'] == '600000.SH' and report['stock_code_status'] == 'confirmed'
    assert report['publication_date'] == '2026-09-14' and report['available_at_status'] == 'confirmed'
    assert set(report['metadata']['fields']) == set(report_fields()['fields'])
    pdf = client.get('/api/v1/documents/report/pdf')
    assert pdf.headers['content-type'] == 'application/pdf'
    assert pdf.headers['content-disposition'].startswith('inline;')
    assert pdf.content.startswith(b'%PDF')
    assert client.get('/api/v1/documents/missing/pdf').status_code == 404


def test_unverified_report_metadata_is_not_auto_confirmed(client, tmp_path, monkeypatch):
    add_report(tmp_path)
    fields = report_fields(); fields['fields']['stock_code']['quote'] = '不是原文'
    monkeypatch.setattr(report_catalog, 'complete_json', lambda *a, **k: fields)
    client.post('/api/v1/documents/catalog')
    with db.connect() as connection:
        job_id = connection.execute("SELECT metadata_job_id FROM documents WHERE id='report'").fetchone()[0]
    worker.execute_job(job_id)
    report = client.get('/api/v1/documents').json()['items'][0]
    assert report['metadata_status'] == 'failed'
    assert report['stock_code_status'] != 'confirmed'
    assert client.post('/api/v1/documents/catalog?retry_failed=true').json()['queued'] == 1


def test_best_match_uses_real_best_window_and_ignores_bad_bars(client, monkeypatch):
    template = {'target_bars': 10, 'points': list(range(10)), 'representation': 'price_path', 'algorithm_version': 'path-window-v2'}
    def bars(values):
        return [{'trade_date': f'2026-09-{i+1:02}', 'open': n, 'high': n+1, 'low': n-1, 'close': n, 'quality_valid': True} for i, n in enumerate(values)]
    perfect = bars(list(range(10, 20)) + list(range(20, 10, -1)))
    bad = bars(list(range(10, 20))); bad[5]['quality_valid'] = False
    monkeypatch.setattr(pattern_examples.market, 'source_fingerprint', lambda: ('fixture', 1, 1))
    monkeypatch.setattr(pattern_examples.market, 'latest_market_date', lambda cutoff: '2026-09-20')
    monkeypatch.setattr(pattern_examples.market, 'iter_recent_bars', lambda *a: iter([('bad', bad), ('perfect', perfect)]))
    result = pattern_examples.find_example(template)
    assert result['stock_code'] == 'perfect' and result['similarity'] == 100
    assert result['bars'][-1]['trade_date'] < '2026-09-20'
    assert result['valid_securities'] == 1
    monkeypatch.setattr(pattern_examples.market, 'iter_recent_bars', lambda *a: pytest.fail('same source should use cache'))
    assert pattern_examples.find_example(template) == result


def test_index_cache_filters_cutoff_and_stays_separate(tmp_path, monkeypatch):
    monkeypatch.setattr(index_market, 'INDEX_FILE', tmp_path / 'index.json')
    monkeypatch.setattr(index_market, '_fetch', lambda *a: ([{'ts_code': '000001.SH', 'trade_date': '20260914', 'open': 10, 'high': 12, 'low': 9, 'close': 11, 'vol': 100, 'amount': None}], 'fixture'))
    bars = index_market.get_bars('2026-09-14', 10)
    assert bars[0]['close'] == 11 and bars[0]['amount'] is None
    assert bars[0]['source'] == 'fixture'
    monkeypatch.setattr(index_market, '_fetch', lambda *a: pytest.fail('cache should be reused'))
    assert index_market.get_bars('2026-09-14', 10) == bars


def test_ranked_matches_return_distinct_real_companies_and_share_cache(client, monkeypatch):
    template = {'target_bars': 10, 'points': list(range(10)), 'representation': 'price_path', 'algorithm_version': 'path-window-v2'}
    def bars(values, month='09'):
        return [{'trade_date': f'2026-{month}-{i+1:02}', 'open': n, 'high': n+1, 'low': n-1, 'close': n, 'quality_valid': True} for i, n in enumerate(values)]
    perfect = bars(list(range(10, 20)) + list(range(20, 10, -1)))
    recent = bars(list(range(30, 40)), '10')
    similar = bars([10, 12, 10, 14, 12, 16, 14, 18, 16, 20])
    bad = bars(list(range(10, 20))); bad[5]['quality_valid'] = False
    monkeypatch.setattr(pattern_examples.market, 'source_fingerprint', lambda: ('ranked', 1, 1))
    monkeypatch.setattr(pattern_examples.market, 'latest_market_date', lambda cutoff: '2026-10-10')
    monkeypatch.setattr(pattern_examples.market, 'iter_recent_bars', lambda *a: iter([('bad', bad), ('600001.SH', perfect), ('600002.SH', similar), ('600003.SH', recent)]))
    result = pattern_examples.find_example(template, limit=2)
    assert result['stock_code'] == '600003.SH'
    assert [item['stock_code'] for item in result['items']] == ['600003.SH', '600001.SH']
    assert result['items'][1]['bars'] == perfect[1:11]  # Equal shapes prefer the later window.
    assert result['scanned_securities'] == 4 and result['valid_securities'] == 3
    monkeypatch.setattr(pattern_examples.market, 'iter_recent_bars', lambda *a: pytest.fail('all limits should share one scan'))
    full = pattern_examples.find_example(template, limit=12)
    assert len(full['items']) == 3
    scores = [item['similarity'] for item in full['items']]
    assert scores == sorted(scores, reverse=True)
    assert pattern_examples.find_example(template)['items'] == full['items'][:1]


def test_ranked_match_endpoint_checks_version_and_limit(client, monkeypatch):
    pattern = client.post('/api/v1/patterns', json={'name': '上涨形态', 'input_type': 'drawing', 'representation': 'price_path', 'points': list(range(10)), 'target_bars': 10, 'params': {}}).json()
    monkeypatch.setattr(pattern_examples.market, 'source_fingerprint', lambda: None)
    path = f"/api/v1/patterns/{pattern['id']}/best-match"
    response = client.get(path, params={'version': 1, 'limit': 12})
    assert response.status_code == 200
    assert response.json()['items'] == [] and response.json()['bars'] == []
    assert client.get(path, params={'version': 2, 'limit': 12}).status_code == 404
    for limit in (0, 25):
        assert client.get(path, params={'version': 1, 'limit': limit}).status_code == 422


def test_ranked_matches_do_not_cache_a_changed_market(client, monkeypatch):
    fingerprints = iter([('before', 1, 1), ('after', 2, 2)])
    monkeypatch.setattr(pattern_examples.market, 'source_fingerprint', lambda: next(fingerprints))
    monkeypatch.setattr(pattern_examples.market, 'latest_market_date', lambda cutoff: '2026-09-14')
    monkeypatch.setattr(pattern_examples.market, 'iter_recent_bars', lambda *a: iter([]))
    with pytest.raises(ValueError, match='行情更新中'):
        pattern_examples.find_example({'target_bars': 10, 'points': list(range(10)), 'representation': 'price_path'}, limit=12)
    with db.connect() as connection:
        assert connection.execute('SELECT COUNT(*) FROM pattern_examples').fetchone()[0] == 0


def test_ranked_matches_keep_the_best_twenty_four_across_a_larger_market(client, monkeypatch):
    template = {'target_bars': 10, 'points': list(range(10)), 'representation': 'price_path', 'algorithm_version': 'path-window-v2'}
    bars = [{'trade_date': f'2026-09-{i+1:02}', 'open': n, 'high': n+1, 'low': n-1, 'close': n, 'quality_valid': True} for i, n in enumerate(range(10, 20))]
    codes = [f'{600000+i}.SH' for i in range(30)]
    monkeypatch.setattr(pattern_examples.market, 'source_fingerprint', lambda: ('large-ranked', 1, 1))
    monkeypatch.setattr(pattern_examples.market, 'latest_market_date', lambda cutoff: '2026-09-14')
    monkeypatch.setattr(pattern_examples.market, 'iter_recent_bars', lambda *a: iter((code, bars) for code in codes))
    result = pattern_examples.find_example(template, limit=24)
    assert len(result['items']) == 24 and result['valid_securities'] == 30
    assert {item['stock_code'] for item in result['items']} == set(codes[-24:])
    assert all(item['bars'] == bars and item['similarity'] == 100 for item in result['items'])
