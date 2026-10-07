"""Public-only real transport/browser smoke checks; no model or private requests."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import json
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from apps.api.app import public_sources, news_library, research_external


def main():
    evidence = {"public_url": "https://example.com/", "private_requests": [], "public_checks": {}}
    for url in ("http://127.0.0.1:8066/api/v1/health", "http://10.0.0.1/", "http://[::1]/"):
        try:
            news_library.extract_web_text(url)
        except Exception as exc:
            evidence["private_requests"].append({"url": url, "rejected": True, "type": type(exc).__name__, "message": str(exc)})
        else:
            raise AssertionError("Private source was not rejected")
    try:
        with public_sources.source_session() as session:
            response = session.get(evidence["public_url"], timeout=30)
            response.raise_for_status()
            evidence["public_checks"]["transport"] = {"status": response.status_code, "url": response.url, "example_domain_present": "Example Domain" in response.text, "tls_verification": bool(session.verify), "source_proxy_configured": bool(session.proxies)}
    except Exception as exc:
        evidence["public_checks"]["transport"] = {"error": type(exc).__name__, "message": str(exc)[:250]}
    try:
        page = news_library.extract_web_text(evidence["public_url"])
        evidence["public_checks"]["news_browser"] = {"url": page["url"], "title": page["title"], "public_body_present": "documentation examples" in page["text"], "body_characters": len(page["text"])}
    except Exception as exc:
        evidence["public_checks"]["news_browser"] = {"error": type(exc).__name__, "message": str(exc)[:250]}
    work = Path(__file__).with_name("network-check-work")
    context = SimpleNamespace(conversation_id="network-check", research_depth="standard", as_of="2026-10-07")
    try:
        with patch.object(research_external.research_workspace, "directory", return_value=work):
            page = research_external.capture_page(research_external.CapturePageArgs(url=evidence["public_url"]), context)
        evidence["public_checks"]["research_browser"] = {"url": page["url"], "title": page["title"], "public_body_present": "documentation examples" in page["text_preview"], "body_characters": len(page["text_preview"]), "image_path": page["image_path"]}
    except Exception as exc:
        evidence["public_checks"]["research_browser"] = {"error": type(exc).__name__, "message": str(exc)[:250]}
    destination = Path(__file__).with_name("network-validation.json")
    destination.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
