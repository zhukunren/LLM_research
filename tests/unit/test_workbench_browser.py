from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from threading import Thread

import pytest

from deployment import workbench_browser as browser


@pytest.fixture
def auth_server():
    with ThreadingHTTPServer(('127.0.0.1', 0), browser.BrowserHandler) as server:
        server.origin = 'https://workbench.test'
        server.sessions = browser.BrowserSessions()
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield server
        finally:
            server.shutdown()
            worker.join()


def request(server, method, path, *, headers=None, body=None):
    connection = HTTPConnection(*server.server_address, timeout=5)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        response.read()
        return response.status, response.headers
    finally:
        connection.close()


def test_only_iframe_sign_in_can_render_in_a_local_file_preview(auth_server):
    status, embedded = request(auth_server, 'GET', '/login', headers={'Sec-Fetch-Dest': 'iframe'})
    assert status == 200
    assert "frame-ancestors file: 'self'" in embedded['Content-Security-Policy']
    _, top_level = request(auth_server, 'GET', '/login', headers={'Sec-Fetch-Dest': 'document'})
    assert "frame-ancestors 'none'" in top_level['Content-Security-Policy']


def test_session_cookie_from_local_preview_is_partitioned_and_accepted(auth_server):
    ticket = auth_server.sessions.issue('/')
    headers = {'Origin': auth_server.origin, 'Content-Type': 'application/json'}
    status, response = request(auth_server, 'POST', '/session', headers=headers, body=json.dumps({'ticket': ticket}))
    assert status == 200
    standard, embedded = response.get_all('Set-Cookie')
    assert standard.startswith(browser.COOKIE + '=') and 'SameSite=Lax' in standard
    assert embedded.startswith(browser.EMBEDDED_COOKIE + '=')
    assert all(flag in embedded for flag in ('SameSite=None', 'Partitioned', 'HttpOnly', 'Secure'))
    assert request(auth_server, 'GET', '/check', headers={'Cookie': embedded.split(';', 1)[0]})[0] == 204
    assert request(auth_server, 'GET', '/check', headers={'Cookie': browser.EMBEDDED_COOKIE + '=invalid'})[0] == 401


def test_browser_link_can_only_be_redeemed_once():
    sessions = browser.BrowserSessions()
    ticket = sessions.issue("/#/research")
    with ThreadPoolExecutor(max_workers=2) as workers:
        redeemed = list(workers.map(sessions.redeem, (ticket, ticket)))
    [(target, session)] = [grant for grant in redeemed if grant is not None]
    assert target == "/#/research"
    assert sessions.authorized(session)
    assert not sessions.authorized(ticket)


def test_browser_link_and_session_expire_independently(monkeypatch):
    now = 20_000
    monkeypatch.setattr(browser, "monotonic", lambda: now)
    sessions = browser.BrowserSessions()
    invalid = sessions.issue("/")
    now += browser.LINK_TTL
    assert sessions.redeem(invalid) is None
    _, session = sessions.redeem(sessions.issue("/"))
    now += browser.SESSION_TTL
    assert not sessions.authorized(session)


@pytest.mark.parametrize("target", [
    "https://example.com/",
    "//example.com/",
    "/%2fexample.com/",
    "/\\example.com/",
    "/%0a/example.com/",
    "/_workbench/browser/link",
])
def test_browser_link_rejects_unsafe_destinations(target):
    assert not browser.valid_target(target)


def test_browser_link_accepts_same_site_routes_with_queries_and_fragments():
    assert browser.valid_target("/?view=workbench#/research/record-id")
