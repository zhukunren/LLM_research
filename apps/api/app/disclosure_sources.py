"""Bounded official-PDF import using the existing pinned public HTTP transport."""
from __future__ import annotations

from urllib.parse import urlsplit, urljoin, urlunsplit
import requests

from .public_sources import source_session, PublicSourceError
from .settings import _read_config

MAX_PDF_BYTES = 50 * 1024 * 1024
OFFICIAL_DOMAINS = ("cninfo.com.cn", "sse.com.cn", "szse.cn", "bse.cn")


def official_url(url: str) -> str:
    try:
        parts = urlsplit(url.strip())
        host = (parts.hostname or "").lower().rstrip(".")
        port = parts.port
    except ValueError:
        raise ValueError("原文链接格式无效") from None
    if (parts.scheme not in {"http", "https"} or not host or parts.username is not None or parts.password is not None
            or port not in {None, 443 if parts.scheme == "https" else 80}):
        raise ValueError("请使用不含登录凭据的官方 HTTP/HTTPS 原文链接")
    config = _read_config()
    extra = {item.strip().lower() for item in config.get("disclosures", "official_hosts", fallback="").split(",") if item.strip()}
    if not any(host == domain or host.endswith("." + domain) for domain in OFFICIAL_DOMAINS) and host not in extra:
        raise ValueError("目前支持巨潮、上交所、深交所和北交所；发行人官网须由维护者登记域名")
    return urlunsplit((parts.scheme, host, parts.path or "/", parts.query, ""))


def validate_pdf(data: bytes) -> None:
    if not data or len(data) > MAX_PDF_BYTES:
        raise ValueError("PDF 不能为空，且每份不能超过 50 MB")
    if not data.startswith(b"%PDF-"):
        raise ValueError("未取得 PDF 原文，请使用原文下载链接；网页或登录页不能归档为 PDF")


def download(url: str, *, active=lambda: True) -> tuple[bytes, str]:
    current = official_url(url)
    try:
        with source_session() as session:
            for _ in range(6):
                if not active():
                    raise InterruptedError("导入已停止")
                # Validate every redirect before it is sent, in addition to DNS pinning.
                with session.get(current, stream=True, allow_redirects=False, timeout=(10, 30),
                                 headers={"Accept": "application/pdf", "User-Agent": "LLMResearch/1.0"}) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("Location")
                        if not location:
                            raise ValueError("官方原文重定向缺少地址")
                        current = official_url(urljoin(current, location))
                        continue
                    if response.status_code != 200:
                        raise ValueError(f"官方原文暂未取得（HTTP {response.status_code}）")
                    length = response.headers.get("Content-Length", "")
                    if length.isdigit() and int(length) > MAX_PDF_BYTES:
                        raise ValueError("官方 PDF 超过 50 MB，请下载后使用经拆分且标明来源的文件")
                    data = bytearray()
                    for chunk in response.iter_content(64 * 1024):
                        if not active():
                            raise InterruptedError("导入已停止")
                        data.extend(chunk)
                        if len(data) > MAX_PDF_BYTES:
                            raise ValueError("官方 PDF 超过 50 MB")
                    result = bytes(data)
                    validate_pdf(result)
                    return result, current
            raise ValueError("官方原文重定向次数过多")
    except (requests.RequestException, PublicSourceError) as exc:
        raise ValueError("官方原文读取失败，请检查链接或网络后重试") from exc
