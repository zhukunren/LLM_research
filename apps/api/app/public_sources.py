"""Public-source HTTP transport with validated, pinned destination addresses.

The browser never opens source sockets: its routes use this transport and receive
the final response body. Configured proxies remain trusted transport endpoints;
the origin URL sent to a forwarding proxy or CONNECT tunnel is a public IP.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import ipaddress
import os
import socket
import urllib.request
from urllib.parse import urlencode, urlsplit, urlunsplit

import certifi
import requests
from requests.adapters import HTTPAdapter


class PublicSourceError(ValueError):
    pass


@dataclass(frozen=True)
class PublicTarget:
    url: str
    hostname: str
    address: str
    port: int
    scheme: str

    @property
    def authority(self) -> str:
        host = f"[{self.hostname}]" if ":" in self.hostname else self.hostname
        return host if self.port == (443 if self.scheme == "https" else 80) else f"{host}:{self.port}"

    @property
    def connection_url(self) -> str:
        parts = urlsplit(self.url)
        address = f"[{self.address}]" if ":" in self.address else self.address
        return urlunsplit((self.scheme, f"{address}:{self.port}", parts.path, parts.query, ""))


def network_proxies() -> dict[str, str]:
    inherited = urllib.request.getproxies()
    return {scheme: os.environ.get("LLMR_RESEARCH_" + scheme.upper() + "_PROXY") or inherited[scheme]
            for scheme in ("http", "https")
            if os.environ.get("LLMR_RESEARCH_" + scheme.upper() + "_PROXY") or inherited.get(scheme)}


def _parts(value: str):
    try:
        parts = urlsplit(value)
        port = parts.port if parts.port is not None else (443 if parts.scheme == "https" else 80)
        hostname = (parts.hostname or "").rstrip(".").encode("idna").decode("ascii").lower()
    except (ValueError, UnicodeError) as exc:
        raise PublicSourceError("来源网址格式无效。") from exc
    if parts.scheme not in {"http", "https"} or not hostname or parts.username is not None or parts.password is not None or port == 0:
        raise PublicSourceError("仅支持不含登录凭证的公开 HTTP/HTTPS 来源网址。")
    if hostname in {"localhost", "localhost.localdomain"} or "%" in hostname:
        raise PublicSourceError("来源网址不能指向本机或内网。")
    return parts, hostname, port


def _public(address: str) -> bool:
    try:
        return ipaddress.ip_address(address).is_global
    except ValueError:
        return False


def resolve_public_url(value: str, *, public_dns=None) -> PublicTarget:
    parts, hostname, port = _parts(value)
    try:
        addresses = {row[4][0] for row in socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)}
    except OSError as exc:
        raise PublicSourceError("无法解析来源域名，请核对网址或网络。") from exc
    if not addresses or not all(_public(address) for address in addresses):
        fake_range = ipaddress.ip_network("198.18.0.0/15")
        try:
            literal = ipaddress.ip_address(hostname)
        except ValueError:
            literal = None
        fake = bool(addresses) and all(ipaddress.ip_address(address).version == 4
                                      and ipaddress.ip_address(address) in fake_range for address in addresses)
        addresses = set((public_dns or public_dns_addresses)(hostname)) if (
            fake and literal is None and parts.scheme == "https" and port == 443
        ) else set()
        if not addresses or not all(_public(address) for address in addresses):
            raise PublicSourceError("来源网址不能指向本机、内网或保留地址；代理 Fake-IP 须通过公开 HTTPS 域名核验。")
    # Prefer IPv4 for existing Windows/proxy installations; connect to this
    # numeric address, never resolve the source hostname again in urllib3.
    address = sorted(addresses, key=lambda value: (ipaddress.ip_address(value).version, value))[0]
    host = f"[{hostname}]" if ":" in hostname else hostname
    authority = host if port == (443 if parts.scheme == "https" else 80) else f"{host}:{port}"
    url = urlunsplit((parts.scheme, authority, parts.path or "/", parts.query, ""))
    return PublicTarget(url, hostname, address, port, parts.scheme)


# Public DNS resolver bootstrap avoids recursively trying to resolve DoH hosts
# through the Fake-IP DNS being checked. TLS authenticates the resolver hostname.
_DNS_BOOTSTRAP = {"dns.google": "8.8.8.8", "cloudflare-dns.com": "1.1.1.1"}
_dns_failures: dict[str, str] = {}


@lru_cache(maxsize=256)
def public_dns_addresses(host: str) -> tuple[str, ...]:
    query = urlencode({"name": host, "type": "A"})
    for endpoint in ("https://dns.google/resolve?", "https://cloudflare-dns.com/dns-query?"):
        try:
            with source_session(_bootstrap=True) as session:
                response = session.get(endpoint + query, headers={"Accept": "application/dns-json"}, timeout=8)
                response.raise_for_status()
                value = response.json()
            addresses = tuple(answer["data"] for answer in value.get("Answer", []) if answer.get("type") in {1, 28})
            if addresses:
                return addresses
            _dns_failures[host] = "resolver returned no public records"
        except (OSError, ValueError, KeyError) as exc:
            _dns_failures[host] = type(exc).__name__
    return ()


class _PinnedAdapter(HTTPAdapter):
    def __init__(self, target: PublicTarget):
        self.target = target
        super().__init__(max_retries=0)

    def build_connection_pool_key_attributes(self, request, verify, cert=None):
        hosts, options = super().build_connection_pool_key_attributes(request, verify, cert)
        if self.target.scheme == "https":
            # urllib3 uses server_hostname for SNI and assert_hostname when
            # matching the verified certificate, including after proxy CONNECT.
            options.update(server_hostname=self.target.hostname, assert_hostname=self.target.hostname)
        return hosts, options


class _PublicAdapter(HTTPAdapter):
    def __init__(self, *, public_dns=None, bootstrap=False):
        self.public_dns = public_dns
        self.bootstrap = bootstrap
        self.destinations = {}
        super().__init__(max_retries=0)

    def send(self, request, **kwargs):
        if kwargs.get("verify") is False:
            raise PublicSourceError("公开来源读取不能关闭 TLS 证书验证。")
        parts, hostname, port = _parts(request.url)
        if self.bootstrap and hostname in _DNS_BOOTSTRAP and parts.scheme == "https" and port == 443:
            target = PublicTarget(request.url, hostname, _DNS_BOOTSTRAP[hostname], port, "https")
        else:
            target = resolve_public_url(request.url, public_dns=self.public_dns)
        key = (target.scheme, target.hostname, target.address, target.port)
        adapter = self.destinations.get(key)
        if adapter is None:
            # Keep pools local to this source session; origin names never share
            # a TLS identity even when they resolve to the same public address.
            adapter = self.destinations[key] = _PinnedAdapter(target)
        wire = request.copy()
        wire.url = target.connection_url
        wire.headers["Host"] = target.authority
        response = adapter.send(wire, **kwargs)
        # Cookie/redirect processing in requests uses the original URL; the
        # next redirect is separately resolved and pinned by this adapter.
        response.url = target.url
        response.request = request
        return response

    def close(self):
        for adapter in self.destinations.values():
            adapter.close()
        self.destinations.clear()
        super().close()


def source_session(*, proxies=None, public_dns=None, _bootstrap=False):
    session = requests.Session()
    session.trust_env = False
    session.proxies.update(network_proxies() if proxies is None else proxies)
    session.verify = certifi.where()
    session.max_redirects = 5
    for scheme in ("http://", "https://"):
        session.mount(scheme, _PublicAdapter(public_dns=public_dns, bootstrap=_bootstrap))
    return session


class BrowserSourceGuard:
    """Fulfill every browser HTTP request through pinned, verified transport.

    Redirects are followed here rather than by Chromium (Playwright routing can
    otherwise miss later redirect hops). A base element keeps relative resources
    correct for HTML delivered from the final URL.
    """
    def __init__(self, context, *, transport=None, max_response_bytes=20 * 1024 * 1024, blocked_types=()):
        self.transport = transport or source_session()
        self.maximum = max_response_bytes
        self.blocked_types = set(blocked_types)
        self.navigation_urls = {}
        self.errors = []
        context.route("**/*", self.route)
        # Routed sockets stay disconnected unless connect_to_server is called.
        # Returning immediately also avoids a synchronous close before the
        # Playwright websocket handler has finished initialization.
        context.route_web_socket("**/*", lambda _route: None)
        # WebRTC is not an HTTP route and must not open an independent socket.
        context.add_init_script("""for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
            Object.defineProperty(globalThis, key, {value: undefined, configurable: false});
        }""")

    def route(self, route):
        request = route.request
        if request.resource_type in self.blocked_types:
            route.abort()
            return
        try:
            headers = {name: value for name, value in request.all_headers().items()
                       if name.lower() not in {"host", "content-length", "connection", "accept-encoding", "proxy-authorization"}}
            with self.transport.request(request.method, request.url, headers=headers,
                                        data=request.post_data_buffer, timeout=30,
                                        stream=True, allow_redirects=True) as response:
                data = bytearray()
                for chunk in response.iter_content(64 * 1024):
                    data.extend(chunk)
                    if len(data) > self.maximum:
                        raise PublicSourceError("网页资源超过读取大小预算。")
                body = bytes(data)
                response_headers = {name: value for name, value in response.headers.items()
                                    if name.lower() not in {"content-length", "content-encoding", "transfer-encoding", "connection", "location"}}
                if request.is_navigation_request():
                    self.navigation_urls[request.url] = response.url
                if response.url != request.url and "text/html" in response.headers.get("Content-Type", "").lower():
                    from html import escape
                    base = ('<base href="' + escape(response.url, quote=True) + '">').encode()
                    # Insert inside head so charset/meta parsing stays intact.
                    import re
                    match = re.search(br"<head\b[^>]*>", body, re.I)
                    offset = match.end() if match else 0
                    body = body[:offset] + base + body[offset:]
                route.fulfill(status=response.status_code, headers=response_headers, body=body)
        except (PublicSourceError, requests.RequestException, OSError, ValueError) as exc:
            self.errors.append(str(exc)[:200])
            route.abort()

    def final_url(self, page_url: str) -> str:
        return self.navigation_urls.get(page_url, page_url)

    def close(self):
        self.transport.close()


def browser_options(options: dict) -> dict:
    # Fulfilled routes do not need Chromium DNS. This also prevents speculative
    # native networking from resolving destinations outside the guarded routes.
    return {**options, "args": [*options.get("args", []), "--host-resolver-rules=MAP * ~NOTFOUND",
                               "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"]}


def launch_browser(playwright, options: dict):
    """Deny native browser sockets, including literal-IP speculative requests.

    Reserve a local TCP port without listening, so the browser's mandatory proxy
    cannot accept connections or be replaced by another local service while the
    browser runs. <-loopback> disables Chromium's implicit localhost bypass.
    Source HTTP traffic remains in the separately configured Python transport.
    """
    blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            blocker.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        blocker.bind(("127.0.0.1", 0))
        proxy = {"server": f"http://127.0.0.1:{blocker.getsockname()[1]}", "bypass": "<-loopback>"}
        browser = playwright.chromium.launch(**{**browser_options(options), "proxy": proxy})
        browser.on("disconnected", lambda *_: blocker.close())
        return browser
    except Exception:
        blocker.close()
        raise
