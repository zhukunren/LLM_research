import base64
from datetime import datetime
from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image, ImageChops
import pytest

from apps.api.app import celebration, db, main
from apps.api.app.client_service_images import web_asset


PATH = '/api/v1/client-service/celebrations'
INPUT = {'portfolio_name': '行业轮动掘金', 'code': '300315'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'celebrations.db')
    db.init_db()
    with db.connect() as connection:
        connection.execute('INSERT INTO security_catalog VALUES (?,?,?,?,?,?)',
                           ('300315.SZ', '掌趣科技', '', '', 'SZ', db.utc_now()))
    with TestClient(main.app) as session:
        yield session


def mock_quote(monkeypatch, *, now='2026-11-23T15:10:00+08:00', stamp='20261123150200',
               last='3.54', high='3.60', previous='3.38'):
    row = [''] * 34
    row[2], row[3], row[4], row[6], row[30], row[33] = '300315', last, previous, '61200', stamp, high
    monkeypatch.setattr(celebration, 'now', lambda: datetime.fromisoformat(now))
    monkeypatch.setattr(celebration, 'tencent_quote_rows', lambda _: {'sz300315': row})


@pytest.mark.parametrize('theme,filename,text_limits', [
    ('red_gold', 'soochow-red-title.png', (720, 1749)),
    ('blue_gold', 'soochow-blue-gold.png', (1207, 1840)),
])
@pytest.mark.parametrize('mode,price,rise,threshold', [
    ('close', '3.54', '4.73%', '4%'),
    ('intraday_high', '3.60', '6.51%', None),
])
def test_creates_the_selected_poster(client, monkeypatch, mode, price, rise, threshold, theme, filename, text_limits):
    mock_quote(monkeypatch)
    response = client.post(PATH, json={**INPUT, 'mode': mode, 'theme': theme})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['stock_name'] == '掌趣科技'
    assert result['code'] == '300315.SZ'
    assert result['theme'] == theme
    assert result['portfolio_name'] == INPUT['portfolio_name']
    assert (result['price'], result['change_percent'], result['closing_threshold']) == (price, rise, threshold)
    assert result['observed_at'] == '2026-11-23T15:02:00+08:00'
    assert result['source'] == '腾讯财经'
    with (Image.open(BytesIO(base64.b64decode(result['image'].split(',', 1)[1]))) as poster,
          Image.open(web_asset(f'client-service/celebrations/{filename}')) as background):
        assert (poster.format, poster.size) == ('PNG', (1080, 1920))
        changes = ImageChops.difference(poster, background).getbbox()
        assert changes is not None and text_limits[0] < changes[1] < changes[3] < text_limits[1]


def test_before_close_uses_previous_completed_trading_day(client, monkeypatch):
    mock_quote(monkeypatch, now='2026-11-23T14:55:00+08:00', stamp='20261123145400')

    class PreviousDailyBar:
        def raw_query(self, api_name, **params):
            if api_name == 'trade_cal':
                assert params['end_date'] == '20261122'
                return [{'cal_date': '20261120', 'is_open': 1}, {'cal_date': '20261122', 'is_open': 0}]
            assert (api_name, params['ts_code'], params['trade_date']) == ('daily', '300315.SZ', '20261120')
            return [{'ts_code': '300315.SZ', 'trade_date': '20261120', 'close': 3.38, 'high': 3.4,
                     'pre_close': 3.33, 'vol': 61200}]

    monkeypatch.setattr(celebration.tushare_sync, 'create_client', lambda **_: PreviousDailyBar())
    response = client.post(PATH, json={**INPUT, 'mode': 'close'})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['observed_at'] == '2026-11-20T15:00:00+08:00'
    assert result['price'] == '3.38'
    assert result['source'] == 'Tushare 日线'
    assert result['theme'] == 'red_gold'


def test_after_close_does_not_use_an_incomplete_quote(client, monkeypatch):
    mock_quote(monkeypatch, stamp='20261123145700')

    class MissingDailyBar:
        def raw_query(self, api_name, **params):
            if api_name == 'trade_cal':
                return [{'cal_date': '20261123', 'is_open': 1}]
            assert params['trade_date'] == '20261123'
            return []

    monkeypatch.setattr(celebration.tushare_sync, 'create_client', lambda **_: MissingDailyBar())
    response = client.post(PATH, json={**INPUT, 'mode': 'close'})
    assert response.status_code == 503


def test_threshold_stays_below_the_displayed_close_and_declines_a_loss(client, monkeypatch):
    mock_quote(monkeypatch, last='53.0001', high='53.10', previous='50')
    response = client.post(PATH, json={**INPUT, 'mode': 'close'})
    assert response.status_code == 200, response.text
    assert (response.json()['change_percent'], response.json()['closing_threshold']) == ('6.00%', '5%')

    mock_quote(monkeypatch, last='49.50', high='53.10', previous='50')
    assert client.post(PATH, json={**INPUT, 'mode': 'close'}).status_code == 422
