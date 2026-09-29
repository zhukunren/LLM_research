from __future__ import annotations

import json
import logging
from pathlib import Path

from pypdf import PdfReader

from apps.api.app.market import profile
from apps.api.app.settings import REPORT_DIR


def main() -> None:
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    pdfs = []
    if REPORT_DIR.is_dir():
        for path in sorted(REPORT_DIR.glob("*.pdf")):
            try:
                reader = PdfReader(path, strict=False)
                pages = [(page.extract_text() or "") for page in reader.pages]
                pdfs.append({"filename": path.name, "bytes": path.stat().st_size, "pages": len(pages), "extracted_chars": sum(map(len, pages)), "status": "text_available" if any(pages) else "no_text"})
            except Exception as exc:
                pdfs.append({"filename": path.name, "bytes": path.stat().st_size, "status": "failed", "reason": str(exc)[:200]})
    report = {"market_data": profile(), "research_reports": {"count": len(pdfs), "items": pdfs}}
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

