"""Reject browser write requests from outside the local workbench."""
from __future__ import annotations

import os
from urllib.parse import urlsplit

from starlette.requests import Request


_READ_METHODS = {"GET", "HEAD", "OPTIONS"}
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _origin(value: str, *, referer: bool = False) -> tuple[str, str, int] | None:
    if not value or any(ord(character) <= 32 for character in value):
        return None
    try:
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            return None
        if parts.username is not None or parts.password is not None:
            return None
        if not referer and (parts.path not in {"", "/"} or parts.query or parts.fragment):
            return None
        port = parts.port or (443 if parts.scheme == "https" else 80)
        return parts.scheme, parts.hostname.lower(), port
    except ValueError:
        return None


def trusted_write_request(request: Request) -> bool:
    """Allow same-origin user mode and the configured local Vite origin.

    Origin-less CLI/MCP requests remain supported. Browser Fetch Metadata and
    Referer prevent those requests from becoming a cross-site form fallback.
    This is a browser write boundary, not authentication for local processes.
    """
    if request.method in _READ_METHODS:
        return True
    origin_header = request.headers.get("origin")
    if origin_header is None and request.headers.get("sec-fetch-site", "").lower() == "cross-site":
        return False
    source = origin_header
    is_referer = False
    if source is None:
        source = request.headers.get("referer")
        is_referer = True
    if source is None:
        return True
    candidate = _origin(source, referer=is_referer)
    if candidate is None:
        return False
    allowed = set()
    destination = _origin(str(request.url), referer=True)
    if destination and destination[1] in _LOOPBACK_HOSTS:
        allowed.update((destination[0], host, destination[2]) for host in _LOOPBACK_HOSTS)
    try:
        web_port = int(os.environ.get("LLMR_WEB_PORT", "5173"))
    except ValueError:
        web_port = 0
    if 1 <= web_port <= 65535:
        allowed.update(("http", host, web_port) for host in ("127.0.0.1", "localhost"))
    return candidate in allowed
