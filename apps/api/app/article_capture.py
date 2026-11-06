"""Small, source-backed HTML reads for closing commentary; render only JS shells."""
from __future__ import annotations

import hashlib
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
import re
import time
from urllib.parse import urljoin, urlsplit

import requests

from . import research_external as external

MAX_BYTES = 2 * 1024 * 1024
HTTP_BUDGET_SECONDS = 8
BROWSER_BUDGET_SECONDS = 12
VOID_TAGS = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
SKIP_TAGS = {'script', 'style', 'noscript', 'svg', 'nav', 'footer', 'aside', 'form', 'template'}
BLOCK_TAGS = {'p', 'div', 'article', 'main', 'section', 'h1', 'h2', 'h3', 'tr', 'li', 'br'}


def turnover_candidates(sources):
    """Quote-backed extraction hints, never an automatic published conclusion."""
    pattern = re.compile(r'(?P<scope>沪深京三市|沪深京|三市|沪深两市|沪深市场|两市)\s*(?:全天|当日|今日)?成交(?:额|金额)?\s*(?:约为|为|约|合计|达到|达)?\s*(?P<number>[0-9][0-9,.]*)\s*(?P<unit>万亿|亿)(?:元)?')
    output = []
    for source in sources:
        for line in source['text'].splitlines():
            match = pattern.search(line)
            if not match or len(line) > 1200:
                continue
            try:
                source_amount = Decimal(match['number'].replace(',', ''))
                multiplier = 10000 if match['unit'] == '万亿' else 1
                amount = source_amount * multiplier
                rounding_step = Decimal(10) ** source_amount.as_tuple().exponent * multiplier
                following = re.split(r'[。；;]', line[match.end():], maxsplit=1)[0]
                change = re.search(r'^[\s，,]*(?:较|比)(?:前一(?:个)?交易日|上一(?:个)?交易日|前日|昨日)[^。；;]{0,50}?(增加|减少|放量|缩量)\s*(?:了|约|为)?\s*([0-9][0-9,.]*)\s*(万亿|亿)', following)
                delta = Decimal(change[2].replace(',', '')) * (10000 if change[3] == '万亿' else 1) * (-1 if change[1] in {'减少', '缩量'} else 1) if change else None
            except InvalidOperation:
                continue
            output.append({'source_id': source['id'], 'quote': line, 'market_scope': 'SH_SZ_BJ' if match['scope'] in {'沪深京三市', '沪深京', '三市'} else 'SH_SZ',
                'source_amount': match['number'] + match['unit'], 'amount_yi': str(amount), 'rounding_step_yi': str(rounding_step), 'change_yi': str(delta) if delta is not None else None,
                'status': 'extracted_candidate_requires_citation_and_date_validation'})
            if len(output) >= 6:
                return output
    return output


class ArticleText(HTMLParser):
    """Extract visible prose without executing scripts or treating JSON as text."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.parts = []
        self.title_parts = []
        self.paragraphs = []
        self.paragraph = []
        self.publication = None
        self.blocked = False
        self.candidates = []
        self.active_candidates = []
        self.text_scope = 'page_body'

    def _append(self, text):
        self.parts.append(text)
        for _, index in self.active_candidates:
            self.candidates[index]['parts'].append(text)

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'meta':
            name = (values.get('property') or values.get('name') or '').lower()
            if name in {'article:published_time', 'date', 'pubdate'} and not self.publication:
                self.publication = values.get('content')
        if tag == 'time' and values.get('itemprop') == 'datePublished' and not self.publication:
            self.publication = values.get('datetime')
        hidden = tag in SKIP_TAGS or 'hidden' in values or values.get('aria-hidden') == 'true' or bool(
            re.search(r'display\s*:\s*none|visibility\s*:\s*hidden', values.get('style', ''), re.I))
        if tag not in VOID_TAGS:
            if len(self.stack) >= 256:
                raise external.ExternalSourceError('网页结构过深，请切换其他来源。')
            self.stack.append((tag, hidden))
            if not any(item[1] for item in self.stack):
                identity = values.get('id', '').lower()
                classes = values.get('class', '').lower().split()
                priority = 110 if values.get('itemprop') == 'articleBody' else 100 if tag == 'article' else 90 if tag == 'main' else 80 if identity in {'zoom', 'articlebody', 'article-content', 'news-content'} else 70 if any(name in {'article-content', 'article_content', 'news-content', 'news_content'} for name in classes) else 0
                if priority:
                    self.candidates.append({'priority': priority, 'parts': []})
                    self.active_candidates.append((len(self.stack), len(self.candidates) - 1))
        if tag in BLOCK_TAGS and not any(item[1] for item in self.stack):
            self._append('\n')
        if tag in {'td', 'th'}:
            self._append('\t')
        if tag == 'p':
            self.paragraph = []

    def handle_endtag(self, tag):
        if tag == 'p' and self.paragraph:
            self.paragraphs.append(''.join(self.paragraph).strip())
            self.paragraph = []
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                self.active_candidates = [item for item in self.active_candidates if item[0] <= index]
                break
        if tag in BLOCK_TAGS:
            self._append('\n')

    def handle_data(self, data):
        if any(hidden for _, hidden in self.stack):
            return
        tags = {tag for tag, _ in self.stack}
        if 'title' in tags:
            self.title_parts.append(data)
        elif 'head' not in tags:
            self._append(data)
            if 'p' in tags:
                self.paragraph.append(data)

    def extracted(self):
        def clean(parts):
            return '\n'.join(line.strip() for line in ''.join(parts).splitlines() if line.strip())
        text = clean(self.parts)
        title = ''.join(self.title_parts).strip()
        # An app shell, navigation, or anti-bot page is not a readable article.
        self.blocked = any(marker in (title + '\n' + text[:1000]).lower() for marker in (
            'just a moment', 'verify you are human', 'access denied', 'checking your browser'))
        candidates = [(item['priority'], clean(item['parts'])) for item in self.candidates]
        candidates = [item for item in candidates if len(item[1]) >= 120]
        if candidates:
            # Select one semantic article subtree. Do not deduplicate arbitrary
            # facts across different contexts merely to make quotes unique.
            body = max(candidates, key=lambda item: (item[0], len(item[1])))[1]
            dates = list(dict.fromkeys(line for line in text.splitlines() if re.fullmatch(r'\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?', line)))[:3]
            text = '\n'.join([*(line for line in [title, *dates] if line and line not in body), body])
            self.text_scope = 'article_container'
        prose = sum(len(paragraph) for paragraph in self.paragraphs if len(paragraph) >= 40)
        usable = not self.blocked and len(text) >= 200 and prose >= 120
        return title, text, usable


def preferred_article_url(url):
    """A known publisher's mobile article avoids its slow desktop app shell."""
    parts = urlsplit(url)
    if parts.hostname in {'thepaper.cn', 'www.thepaper.cn'} and re.fullmatch(r'/newsDetail_forward_\d+', parts.path):
        mobile = parts._replace(netloc='m.thepaper.cn', fragment='').geturl()
        return mobile
    return url


def _decode(body, content_type):
    charset = re.search(r'charset\s*=\s*["\']?([A-Za-z0-9_-]+)', content_type, re.I)
    if charset is None:
        charset = re.search(br'charset\s*=\s*["\']?([A-Za-z0-9_-]+)', body[:8192], re.I)
    encoding = charset[1] if charset else 'utf-8'
    if isinstance(encoding, bytes):
        encoding = encoding.decode('ascii')
    if encoding.lower() in {'gb2312', 'gbk'}:
        encoding = 'gb18030'
    try:
        return body.decode(encoding)
    except (UnicodeError, LookupError) as exc:
        raise external.ExternalSourceError('网页字符编码无法确认，请切换其他来源。') from exc


def _read_html(url):
    deadline = time.monotonic() + HTTP_BUDGET_SECONDS
    with external._source_session() as session:
        for _ in range(6):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise external.ExternalSourceError('原文读取超时，请切换其他来源；临时故障最多重试一次。')
            with session.get(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/xhtml+xml'},
                             timeout=(min(3, remaining), min(5, remaining)), stream=True, allow_redirects=False) as response:
                if response.status_code in {301, 302, 303, 307, 308} and response.headers.get('Location'):
                    url = urljoin(url, response.headers['Location'])
                    continue  # Each hop is independently validated by the pinned transport.
                if response.status_code >= 400:
                    raise external.ExternalSourceError(f'原文读取失败（HTTP {response.status_code}），请切换其他来源。')
                content_type = response.headers.get('Content-Type', '')
                if 'application/pdf' in content_type.lower():
                    raise external.ExternalSourceError('Download is starting: 此来源是PDF，请读取原始文件。')
                if not any(kind in content_type.lower() for kind in ('text/html', 'application/xhtml+xml')):
                    raise external.ExternalSourceError('来源未返回可确认的HTML正文，请切换其他来源。')
                declared = response.headers.get('Content-Length', '')
                if declared.isdigit() and int(declared) > MAX_BYTES:
                    raise external.ExternalSourceError('网页超过正文读取大小预算。')
                data = bytearray()
                for chunk in response.iter_content(64 * 1024):
                    data.extend(chunk)
                    if len(data) > MAX_BYTES:
                        raise external.ExternalSourceError('网页超过正文读取大小预算。')
                    if time.monotonic() >= deadline:
                        raise external.ExternalSourceError('原文读取超时，请切换其他来源。')
                return response.url, bytes(data), content_type
    raise external.ExternalSourceError('来源跳转次数过多，请切换其他来源。')


def capture_article(args, context):
    requested = external._public_url(args.url)
    # Try a known alternate representation, never repeat the same failed URL.
    url = preferred_article_url(requested)
    try:
        final_url, data, content_type = _read_html(url)
    except requests.RequestException as exc:
        raise external.ExternalSourceError('原文连接失败或超时，请切换其他来源；临时故障最多重试一次。') from exc
    html = _decode(data, content_type)
    parser = ArticleText()
    parser.feed(html)
    title, text, usable = parser.extracted()
    if parser.blocked:
        raise external.ExternalSourceError('网页返回访问验证或拦截页，请切换其他来源。')
    if not usable:
        # Only a received but incomplete HTML page gets a browser attempt.
        return external.capture_page(external.CapturePageArgs(url=final_url), context,
                                     text_only=True, timeout_seconds=BROWSER_BUDGET_SECONDS)
    directory = external._new_source(context, 'article')
    (directory / 'page.html').write_bytes(data)
    (directory / 'text.txt').write_text(text, encoding='utf-8')
    metadata = external._provenance(context, directory, kind='web', requested_url=requested, url=final_url,
        title=title or urlsplit(final_url).hostname, publisher_declared_date=parser.publication,
        sha256=hashlib.sha256(data).hexdigest(), text_path=str(directory / 'text.txt'),
        html_path=str(directory / 'page.html'), text_characters=len(text), capture_method='html_article', text_scope=parser.text_scope)
    external._write_json(directory / 'metadata.json', metadata)
    return {**metadata, 'text_preview': text[:8000], 'text_truncated': len(text) > 8000,
            'note': '原始HTML和提取正文已保存，未使用搜索摘要或生成式改写；日期、摘录和结论仍须校验。'}
