import pytest
from apps.api.app import disclosure_sources


@pytest.mark.parametrize("url", ["http://localhost/x.pdf", "https://cninfo.com.cn.evil.test/a.pdf",
                               "file:///tmp/a.pdf", "https://user:password@www.sse.com.cn/a.pdf",
                               "https://www.sse.com.cn:444/a.pdf"])
def test_non_official_or_credential_urls_fail(url):
    with pytest.raises(ValueError):
        disclosure_sources.official_url(url)


def test_official_subdomain_and_explicit_issuer_host(monkeypatch, tmp_path):
    path = tmp_path / "config.ini"
    path.write_text("[disclosures]\nofficial_hosts=ir.example.com\n", encoding="utf-8")
    monkeypatch.setenv("LLMR_CONFIG_FILE", str(path))
    assert disclosure_sources.official_url("https://static.cninfo.com.cn/a.pdf#page=2").endswith("a.pdf")
    assert disclosure_sources.official_url("https://ir.example.com/a.pdf")
    with pytest.raises(ValueError):
        disclosure_sources.official_url("https://evil.ir.example.com/a.pdf")


class Response:
    def __init__(self, status, headers=None, body=b""):
        self.status_code, self.headers, self.body = status, headers or {}, body
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def iter_content(self, _): yield self.body


class Session:
    def __init__(self, responses): self.responses, self.urls = iter(responses), []
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def get(self, url, **kwargs):
        assert kwargs["allow_redirects"] is False and kwargs["stream"]
        self.urls.append(url)
        return next(self.responses)


def test_each_redirect_is_checked_before_request(monkeypatch):
    session = Session([Response(302, {"Location": "https://evil.test/file.pdf"})])
    monkeypatch.setattr(disclosure_sources, "source_session", lambda: session)
    with pytest.raises(ValueError):
        disclosure_sources.download("https://static.cninfo.com.cn/a.pdf")
    assert len(session.urls) == 1


def test_html_oversize_and_cancel_are_not_accepted(monkeypatch):
    for response in [Response(200, body=b"<html>login</html>"), Response(200, {"Content-Length": str(60 * 1024 * 1024)})]:
        monkeypatch.setattr(disclosure_sources, "source_session", lambda: Session([response]))
        with pytest.raises(ValueError):
            disclosure_sources.download("https://www.sse.com.cn/file.pdf")
    with pytest.raises(InterruptedError):
        disclosure_sources.download("https://www.sse.com.cn/file.pdf", active=lambda: False)
