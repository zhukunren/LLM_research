"""Real headless browser with fixture responses at the pinned transport boundary."""
from io import BytesIO
import socket
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
import requests

from apps.api.app import news_library, news_sources, public_sources, research_external


@pytest.fixture
def public_page(monkeypatch):
    sent = []
    real_dns = socket.getaddrinfo
    def resolve(host, port, *args, **kwargs):
        if host == "public-fixture.example":
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]
        return real_dns(host, port, *args, **kwargs)
    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    def send(self, request, **kwargs):
        # Every request that reaches HTTP transport has a pinned public origin.
        assert self.target.hostname == "public-fixture.example"
        assert urlsplit(request.url).hostname == "93.184.216.34"
        path = urlsplit(request.url).path
        sent.append(path)
        response = requests.Response()
        response.headers = requests.structures.CaseInsensitiveDict({"Content-Type": "text/html; charset=utf-8"})
        response.status_code = 200
        if path == "/old":
            response.status_code = 302
            response.headers["Location"] = "https://public-fixture.example/new/page"
            body = b""
        elif path == "/private-redirect":
            response.status_code = 302
            response.headers["Location"] = "http://127.0.0.1/private"
            body = b""
        elif path == "/new/data.json":
            response.headers["Content-Type"] = "application/json"
            body = b'{"revenue":1499.6}'
        else:
            body = ("""<!doctype html><html><head><title>Public dynamic fixture</title></head><body>
                <h1>Public source with guarded dynamic content</h1><p>""" + "Fixture public text. " * 20 + """</p>
                <table><tr><th>Revenue</th></tr></table>
                <script src="http://127.0.0.1/private-script"></script>
                <iframe src="http://127.0.0.1/private-frame"></iframe>
                <script>
                fetch('data.json').then(r => r.json()).then(d => {
                    document.querySelector('table').insertAdjacentHTML('beforeend', '<tr id="loaded"><td>'+d.revenue+'</td></tr>');
                });
                fetch('http://127.0.0.1/private-fetch').catch(() => {});
                try { new WebSocket('ws://127.0.0.1/private-socket'); } catch (_) {}
                navigator.serviceWorker?.register('/sw.js').catch(() => {});
                </script></body></html>""").encode()
        response._content = body
        response._content_consumed = True
        response.raw = BytesIO()
        return response
    monkeypatch.setattr(public_sources._PinnedAdapter, "send", send)
    return sent


def test_guarded_browser_keeps_redirect_base_and_dynamic_fetch_while_blocking_private_resources(public_page, tmp_path, monkeypatch):
    monkeypatch.setattr(research_external.research_workspace, "directory", lambda _: tmp_path / "work")
    context = SimpleNamespace(conversation_id="public", research_depth="standard", as_of="2026-10-07")
    page = research_external.capture_page(research_external.CapturePageArgs(url="https://public-fixture.example/old", wait_selector="#loaded"), context)
    assert page["url"] == "https://public-fixture.example/new/page"
    assert "1499.6" in page["text_preview"]
    assert page["tables_preview"][0]["rows"][1][0]["text"] == "1499.6"
    assert "/new/data.json" in public_page
    assert not any("private" in path for path in public_page)
    assert "/sw.js" not in public_page


def test_news_url_import_uses_the_same_public_browser_guard(public_page):
    page = news_library.extract_web_text("https://public-fixture.example/old")
    assert page["url"] == "https://public-fixture.example/new/page"
    assert page["title"] == "Public dynamic fixture" and "1499.6" in page["text"]
    assert "/new/data.json" in public_page
    assert not any("private" in path for path in public_page)


def test_news_redirect_to_private_origin_is_not_sent_to_http_transport_or_model(public_page):
    with pytest.raises(news_sources.NewsError, match="本机|内网"):
        news_library.extract_web_text("https://public-fixture.example/private-redirect")
    assert public_page == ["/private-redirect"]


@pytest.mark.parametrize("url", ["http://localhost/private", "http://127.0.0.1/private", "http://10.0.0.1/private"])
def test_news_private_navigation_is_rejected_before_launch_or_transport(public_page, url):
    with pytest.raises(news_sources.NewsError, match="本机|内网"):
        news_library.extract_web_text(url)
    assert public_page == []
