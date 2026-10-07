"""Exercise public-source boundaries without connecting to a private service."""
from io import BytesIO
import socket
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
import requests

from apps.api.app import public_sources as sources


def dns(address="93.184.216.34"):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 80))]


@pytest.mark.parametrize("url", ["http://localhost/x", "http://127.0.0.1/x", "http://10.0.0.1/x",
                                 "http://169.254.169.254/x", "http://[::1]/x", "http://user:pass@example.com/x",
                                 "file:///secret", "https://example.com:bad/x", "https://example.com:0/x",
                                 "https://@example.com/x", "https://:pass@example.com/x"])
def test_nonpublic_or_invalid_source_is_rejected_before_transport(url):
    with pytest.raises(sources.PublicSourceError):
        sources.resolve_public_url(url)


def test_dns_rebinding_cannot_change_the_numeric_connection_target(monkeypatch):
    resolutions, connections, writes = [], [], []

    def resolve(host, port, *_args, **_kwargs):
        resolutions.append(host)
        address = "93.184.216.34" if resolutions.count("publisher.example") == 1 else "127.0.0.1"
        return dns(address if host == "publisher.example" else host)

    class WireSocket:
        def setsockopt(self, *_): pass
        def settimeout(self, *_): pass
        def connect(self, address): connections.append(address)
        def sendall(self, data): writes.append(data)
        def makefile(self, *_):
            return BytesIO(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\npublic")
        def close(self): pass

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    monkeypatch.setattr(socket, "socket", lambda *_args, **_kwargs: WireSocket())
    with sources.source_session(proxies={}) as session:
        response = session.get("http://publisher.example/source", timeout=1)
    assert response.content == b"public" and response.url == "http://publisher.example/source"
    assert resolutions == ["publisher.example", "93.184.216.34"]
    assert connections == [("93.184.216.34", 80)]
    assert b"Host: publisher.example\r\n" in b"".join(writes)


def test_https_proxy_connect_uses_public_ip_and_original_tls_identity(monkeypatch):
    target = sources.PublicTarget("https://publisher.example/file", "publisher.example", "93.184.216.34", 443, "https")
    adapter = sources._PinnedAdapter(target)
    request = requests.Request("GET", target.connection_url, headers={"Host": target.authority}).prepare()
    pool = adapter.get_connection_with_tls_context(request, sources.certifi.where(), proxies={"https": "http://alice:secret@127.0.0.1:7897"})
    assert pool.host == target.address
    assert pool.proxy.host == "127.0.0.1"
    assert pool.cert_reqs == "CERT_REQUIRED"
    assert pool.assert_hostname == "publisher.example"
    connection = pool._new_conn()
    observed = {}
    monkeypatch.setattr(type(connection), "connect", lambda self: observed.update(
        tunnel_host=self._tunnel_host, tls_hostname=self.server_hostname,
        proxy_authorization=self._tunnel_headers.get("Proxy-Authorization")))
    pool._prepare_proxy(connection)
    assert observed["tunnel_host"] == "93.184.216.34"
    assert observed["tls_hostname"] == "publisher.example"
    assert observed["proxy_authorization"].startswith("Basic ")
    adapter.close()


def test_http_forward_proxy_receives_numeric_absolute_url_and_original_host(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: dns())
    observed = {}
    def send(self, request, **kwargs):
        observed.update(url=request.url, host=request.headers["Host"], proxies=kwargs["proxies"])
        response = requests.Response()
        response.status_code = 200
        response._content = b"ok"
        return response
    monkeypatch.setattr(sources._PinnedAdapter, "send", send)
    with sources.source_session(proxies={"http": "http://127.0.0.1:7897"}) as session:
        session.get("http://publisher.example/path?q=1", allow_redirects=False)
    assert observed["url"] == "http://93.184.216.34:80/path?q=1"
    assert observed["host"] == "publisher.example"
    assert observed["proxies"] == {"http": "http://127.0.0.1:7897"}


def test_cross_origin_redirect_is_revalidated_and_does_not_leak_authorization_or_cookie(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: dns())
    calls = []
    def send(self, request, **kwargs):
        calls.append((self.target.hostname, dict(request.headers)))
        response = requests.Response()
        response.status_code = 302 if len(calls) == 1 else 200
        response.headers = requests.structures.CaseInsensitiveDict({"Location": "https://other.example/final"} if len(calls) == 1 else {})
        response._content = b""
        response._content_consumed = True
        response.raw = BytesIO()
        return response
    monkeypatch.setattr(sources._PinnedAdapter, "send", send)
    with sources.source_session(proxies={}) as session:
        response = session.get("https://publisher.example/start", headers={"Authorization": "Bearer audit", "Cookie": "private=audit"})
    assert response.url == "https://other.example/final"
    assert calls[0][1]["Host"] == "publisher.example"
    assert calls[1][1]["Host"] == "other.example"
    assert "Authorization" not in calls[1][1] and "Cookie" not in calls[1][1]


def test_redirect_to_private_target_is_rejected_before_second_send(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, *_args, **_kwargs: dns("127.0.0.1" if host == "127.0.0.1" else "93.184.216.34"))
    calls = []
    def send(self, request, **kwargs):
        calls.append(request.url)
        response = requests.Response()
        response.status_code = 302
        response.headers = requests.structures.CaseInsensitiveDict({"Location": "http://127.0.0.1/private"})
        response._content = b""
        response._content_consumed = True
        response.raw = BytesIO()
        return response
    monkeypatch.setattr(sources._PinnedAdapter, "send", send)
    with sources.source_session(proxies={}) as session:
        with pytest.raises(sources.PublicSourceError, match="内网"):
            session.get("http://publisher.example/start")
    assert calls == ["http://93.184.216.34:80/start"]


def test_fake_ip_is_replaced_by_public_dns_address_without_disabling_tls(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: dns("198.18.0.111"))
    seen = []
    target = sources.resolve_public_url("https://publisher.example/report.pdf", public_dns=lambda host: seen.append(host) or ("8.8.8.8",))
    assert seen == ["publisher.example"] and target.address == "8.8.8.8"
    assert target.connection_url == "https://8.8.8.8:443/report.pdf"
    for url in ("http://publisher.example/report", "https://publisher.example:8443/report", "https://198.18.0.111/report"):
        with pytest.raises(sources.PublicSourceError):
            sources.resolve_public_url(url, public_dns=lambda _: ("8.8.8.8",))


def test_source_transport_refuses_explicit_tls_disable(monkeypatch):
    with sources.source_session(proxies={}) as session:
        with pytest.raises(sources.PublicSourceError, match="TLS"):
            session.get("https://publisher.example/", verify=False)


def test_native_browser_proxy_port_is_reserved_unreachable_and_released_on_close():
    options, handlers = {}, {}
    browser = SimpleNamespace(on=lambda event, callback: handlers.update({event: callback}))
    playwright = SimpleNamespace(chromium=SimpleNamespace(launch=lambda **kwargs: options.update(kwargs) or browser))
    sources.launch_browser(playwright, {"headless": True})
    proxy = urlsplit(options["proxy"]["server"])
    assert proxy.hostname == "127.0.0.1" and options["proxy"]["bypass"] == "<-loopback>"
    assert "--disable-quic" in options["args"]
    with pytest.raises(OSError):
        socket.create_connection((proxy.hostname, proxy.port), timeout=0.2)
    handlers["disconnected"]()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as check:
        check.bind((proxy.hostname, proxy.port))
