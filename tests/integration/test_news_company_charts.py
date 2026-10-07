import pytest
from fastapi.testclient import TestClient

from apps.api.app import db, main, news_sources, security_catalog


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'news-companies.db')
    with TestClient(main.app) as session:
        with db.connect() as connection:
            connection.executemany('INSERT INTO security_catalog VALUES(?,?,?,?,?,?)', [
                (code, name, '', '', code[-2:], db.utc_now()) for code, name in [
                    ('002236.SZ', '大华股份'), ('600000.SH', '浦发银行'), ('601126.SH', '四方股份'),
                    ('002717.SZ', '*ST岭南'), ('688192.SH', '迪哲医药-U'),
                    ('300024.SZ', '机器人'), ('600617.SH', '国新能源'), ('601668.SH', '中国建筑'),
                ]
            ])
        yield session


def article(client, title, body, codes=None, source='公告'):
    response = client.post('/api/v1/news/import', json={'request_id': title, 'items': [{
        'title': title, 'body': body, 'source': source, 'stock_codes': codes or [],
    }]})
    assert response.status_code == 201
    original = response.json()['items'][0]
    response = client.get('/api/v1/news/' + original['id'])
    assert response.status_code == 200
    return original, response.json()


def test_existing_unlinked_news_resolves_names_in_title_and_body_without_rewriting_links(client):
    original, result = article(client, '中勘北斗与大华股份合作', '浦发银行提供融资，大华股份负责设备。')
    assert result['chart_companies'] == [
        {'stock_code': '002236.SZ', 'name': '大华股份'}, {'stock_code': '600000.SH', 'name': '浦发银行'},
    ]
    assert result['stock_codes'] == [] and result['body'] == original['body']
    assert news_sources.get_item(original['id']) == original
    assert news_sources.list_news_sources('002236.SZ', '2026-10-05')['total'] == 0


def test_codes_and_names_are_deduplicated_and_retained_in_mention_order(client):
    _, result = article(client, '四方股份(601126.SH)公告', '证券代码：600000。大华股份（002236）共同合作。', ['002236.SZ'])
    assert [company['stock_code'] for company in result['chart_companies']] == ['601126.SH', '600000.SH', '002236.SZ']


def test_plain_names_match_risk_prefixes_and_listing_suffixes(client):
    _, result = article(client, '岭南签署订单', '迪哲医药公布研究结果。')
    # Two-character risk aliases are intentionally not used as broad text matches.
    assert [company['stock_code'] for company in result['chart_companies']] == ['688192.SH']
    _, result = article(client, '*ST岭南公告', '迪哲医药-U公布研究结果。')
    assert [company['stock_code'] for company in result['chart_companies']] == ['002717.SZ', '688192.SH']


def test_source_names_and_unqualified_six_digit_amounts_do_not_create_charts(client):
    _, result = article(client, '宏观资讯', '拟投入600000元，覆盖002236户。未上市公司取得订单。', source='浦发银行')
    assert result['chart_companies'] == []


def test_explicit_codes_work_without_catalog_names(client):
    _, result = article(client, '公告', '公司（600519.sh）公告。', ['000002.SZ'])
    assert result['chart_companies'] == [{'stock_code': '600519.SH', 'name': '600519.SH'}, {'stock_code': '000002.SZ', 'name': '000002.SZ'}]


def test_catalog_updates_are_used_without_a_restart(client):
    original, result = article(client, '新名称企业公告', '云端科技签署订单。')
    assert result['chart_companies'] == []
    with db.connect() as connection:
        connection.execute('INSERT INTO security_catalog VALUES(?,?,?,?,?,?)', ('600001.SH', '云端科技', '', '', 'SH', db.utc_now()))
    assert client.get('/api/v1/news/' + original['id']).json()['chart_companies'] == [{'stock_code': '600001.SH', 'name': '云端科技'}]


def test_unknown_news_still_returns_not_found(client):
    assert client.get('/api/v1/news/missing').status_code == 404


def test_industry_words_and_embedded_names_are_not_companies(client):
    _, result = article(client, 'Sharpa发布机器人本体', '机器人公司Sharpa布局中国新能源基础设施，中国建筑行业景气改善。')
    assert result['chart_companies'] == []
    _, result = article(client, '机器人：拟签署订单', '国新能源与中国建筑共同合作。')
    assert [company['stock_code'] for company in result['chart_companies']] == ['300024.SZ', '600617.SH', '601668.SH']
