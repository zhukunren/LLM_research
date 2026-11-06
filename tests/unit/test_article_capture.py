from io import BytesIO
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests

from apps.api.app import article_capture as article, research_external as external


@pytest.fixture
def capture(tmp_path, monkeypatch):
    monkeypatch.setattr(external.research_workspace, 'directory', lambda _: tmp_path / 'work')
    monkeypatch.setattr(external, '_public_url', lambda url: url)
    context = SimpleNamespace(conversation_id='test', research_depth='standard', as_of='2026-10-20')
    sent = []
    def use(body, status=200, content_type='text/html; charset=utf-8'):
        def request(url, **kwargs):
            sent.append((url, kwargs))
            response = requests.Response()
            response.url = url
            response.status_code = status
            response.headers['Content-Type'] = content_type
            response.raw = BytesIO(body)
            return response
        session = SimpleNamespace(get=request)
        class Session:
            def __enter__(self): return session
            def __exit__(self, *_): pass
        monkeypatch.setattr(external, '_source_session', Session)
    return context, sent, use


def html():
    return ('<html><head><title>当日收评</title><meta name="date" content="2026-10-20"></head><body>'
            '<nav>导航不是证据</nav><h1>市场收盘</h1><p>' + '沪深两市成交14561亿元，较前日增加186亿元。' * 10 + '</p>'
            '<script>伪造脚本正文，不得作为来源</script><p hidden>隐藏内容不属于可见原文</p></body></html>')


def test_static_article_keeps_raw_bytes_dates_quotes_and_does_not_start_browser(capture, monkeypatch):
    context, sent, use = capture
    body = html().encode()
    use(body)
    monkeypatch.setattr(external, 'capture_page', lambda *_a, **_kw: pytest.fail('static article started a browser'))
    result = article.capture_article(external.CapturePageArgs(url='https://publisher.example/close'), context)
    assert result['capture_method'] == 'html_article'
    assert result['publisher_declared_date'] == '2026-10-20'
    assert result['title'] == '当日收评'
    assert '成交14561亿元，较前日增加186亿元' in result['text_preview']
    assert '伪造脚本' not in result['text_preview'] and '隐藏内容' not in result['text_preview']
    assert len(sent) == 1 and sent[0][1]['allow_redirects'] is False
    assert sent[0][1]['timeout'][1] <= 5
    assert Path(result['html_path']).read_bytes() == body
    assert json.loads(Path(result['text_path']).with_name('metadata.json').read_text(encoding='utf-8'))['sha256'] == result['sha256']


def test_gb2312_metadata_is_decoded_without_corrupting_numeric_quotes(capture):
    context, _, use = capture
    use(html().replace('<head>', '<head><meta charset="gb2312">').encode('gb18030'), content_type='text/html')
    result = article.capture_article(external.CapturePageArgs(url='https://publisher.example/close'), context)
    assert '沪深两市成交14561亿元' in result['text_preview']


@pytest.mark.parametrize('status', [403, 404, 410])
def test_permanent_http_failure_does_not_retry_with_a_browser(capture, monkeypatch, status):
    context, sent, use = capture
    use(b'not found', status=status)
    monkeypatch.setattr(external, 'capture_page', lambda *_a, **_kw: pytest.fail('permanent failure retried in browser'))
    with pytest.raises(external.ExternalSourceError, match=f'HTTP {status}'):
        article.capture_article(external.CapturePageArgs(url='https://publisher.example/dead'), context)
    assert len(sent) == 1


def test_received_app_shell_uses_one_bounded_text_browser_attempt(capture, monkeypatch):
    context, _, use = capture
    use(b'<html><title>App</title><body><div id="root"></div><script>load()</script></body></html>')
    observed = []
    monkeypatch.setattr(external, 'capture_page', lambda args, ctx, **kwargs: observed.append(kwargs) or {'capture_method': 'browser_text'})
    assert article.capture_article(external.CapturePageArgs(url='https://publisher.example/dynamic'), context)['capture_method'] == 'browser_text'
    assert observed == [{'text_only': True, 'timeout_seconds': 12}]


def test_block_page_is_not_retried_or_saved_as_article(capture, monkeypatch):
    context, _, use = capture
    use(html().replace('当日收评', 'Verify you are human').encode())
    monkeypatch.setattr(external, 'capture_page', lambda *_a, **_kw: pytest.fail('block page retried'))
    with pytest.raises(external.ExternalSourceError, match='拦截页'):
        article.capture_article(external.CapturePageArgs(url='https://publisher.example/blocked'), context)


def test_known_desktop_article_switches_to_mobile_once(capture):
    context, sent, use = capture
    use(html().encode())
    result = article.capture_article(external.CapturePageArgs(url='https://www.thepaper.cn/newsDetail_forward_123'), context)
    assert [item[0] for item in sent] == ['https://m.thepaper.cn/newsDetail_forward_123']
    assert result['requested_url'] == 'https://www.thepaper.cn/newsDetail_forward_123'
    assert result['url'] == 'https://m.thepaper.cn/newsDetail_forward_123'


def test_responsive_page_selects_one_article_subtree_without_hiding_conflicting_facts(capture):
    context, _, use = capture
    paragraph = '沪深两市成交14561亿元，较前日增加186亿元。' * 10
    use(('<html><head><title>收评</title></head><body><div>2026-10-20 15:30:44</div>'
        '<div id="Zoom"><p>' + paragraph + '</p></div><div id="mobile"><p>' + paragraph + '</p></div></body></html>').encode())
    result = article.capture_article(external.CapturePageArgs(url='https://publisher.example/responsive'), context)
    assert result['text_scope'] == 'article_container'
    assert result['text_preview'].count(paragraph) == 1
    assert '2026-10-20 15:30:44' in result['text_preview']


def test_turnover_hints_are_bound_to_actual_quotes_and_preserve_precision():
    quote = '两市成交14561亿元，较前一交易日的14375亿元增加186亿元。其中，沪市成交7000亿元。'
    hints = article.turnover_candidates([{'id': 'real-read', 'text': quote}])
    assert hints[0]['source_id'] == 'real-read' and hints[0]['quote'] == quote
    assert hints[0]['amount_yi'] == '14561' and hints[0]['change_yi'] == '186'
    assert hints[0]['status'].endswith('requires_citation_and_date_validation')
    rounded = article.turnover_candidates([{'id': 'rounded', 'text': '沪深两市成交额1.46万亿元。'}])
    assert rounded[0]['source_amount'] == '1.46万亿' and rounded[0]['amount_yi'] == '14600.00'
    assert rounded[0]['rounding_step_yi'] == '100.00'


@pytest.mark.parametrize('text', ['全市场成交额1.47万亿元。', '沪深两市成交额超过1.4万亿元。'])
def test_unknown_scope_and_thresholds_do_not_become_observed_totals(text):
    assert article.turnover_candidates([{'id': 'source', 'text': text}]) == []


@pytest.mark.parametrize('text', ['沪深两市成交14561亿元，沪市较前一交易日增加130亿元。', '沪深两市成交14561亿元，某板块融资额增加200亿元。'])
def test_unrelated_changes_are_not_labeled_as_two_exchange_comparisons(text):
    assert article.turnover_candidates([{'id': 'source', 'text': text}])[0]['change_yi'] is None


def test_unbounded_html_nesting_is_rejected_before_expensive_extraction():
    parser = article.ArticleText()
    with pytest.raises(external.ExternalSourceError, match='结构过深'):
        parser.feed('<div>' * 257)
