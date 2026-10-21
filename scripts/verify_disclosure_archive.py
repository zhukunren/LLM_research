"""Isolated verification of an official PDF import and the upload deduplication path."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--code", required=True)
    parser.add_argument("--period", required=True)
    parser.add_argument("--published", required=True)
    parser.add_argument("--title", required=True)
    args = parser.parse_args()
    root = ROOT / "runtime" / "verification" / ("disclosure-archive-" + uuid4().hex[:10])
    root.mkdir(parents=True)
    environment = {"LLMR_STATE_ROOT": str(root / "state"), "LLMR_DB_PATH": str(root / "state/app.db"),
                   "LLMR_UPLOAD_ROOT": str(root / "uploads"), "LLMR_ARTIFACT_ROOT": str(root / "artifacts"),
                   "LLMR_AUTH_MODE": "local", "LLMR_CONFIG_FILE": str(root / "isolated.ini")}
    os.environ.update(environment)
    (root / "environment.json").write_text(json.dumps(environment, ensure_ascii=False, indent=2), encoding="utf-8")
    from fastapi.testclient import TestClient
    from apps.api.app import main as application, worker, disclosures
    from pypdf import PdfReader
    import pypdfium2
    payload = {"request_id": "official-link", "url": args.url,
               "metadata": {"title": args.title, "stock_code": args.code, "report_period": args.period,
                            "publication_date": args.published, "document_type": "annual", "document_form": "full", "confirmed": True}}
    print(json.dumps({"verification_root": str(root)}, ensure_ascii=False), flush=True)
    with TestClient(application.app) as client:
        submitted = client.post("/api/v1/disclosures/import-url", json=payload)
        submitted.raise_for_status()
        run = submitted.json()
        worker.execute_job(run["job_id"])
        result = client.get("/api/v1/disclosure-imports/" + run["id"]).json()
        if result["state"] != "succeeded":
            (root / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            raise RuntimeError(result["message"])
        detail = client.get("/api/v1/disclosures/versions/" + result["version_id"]).json()
        path, _ = disclosures.pdf_path(result["version_id"])
        returned = client.get(detail["pdf_url"])
        returned.raise_for_status()
        assert hashlib.sha256(returned.content).hexdigest() == detail["sha256"]
        reader = PdfReader(path)
        assert len(reader.pages) == detail["pages"]
        for page in {1, min(5, detail["pages"]), detail["pages"]}:
            response = client.get(f"/api/v1/disclosures/versions/{detail['id']}/pages/{page}")
            response.raise_for_status()
            assert response.json()["page_number"] == page
        upload_request = {key: value for key, value in payload.items() if key != "url"}
        upload_request["request_id"] = "same-file-upload"
        again = client.post("/api/v1/disclosures/upload", data={"payload": json.dumps(upload_request, ensure_ascii=False)},
                            files={"file": ("official-report.pdf", returned.content, "application/pdf")})
        again.raise_for_status()
        worker.execute_job(again.json()["job_id"])
        duplicate = client.get("/api/v1/disclosure-imports/" + again.json()["id"]).json()
        assert duplicate["outcome"] == "duplicate" and duplicate["version_id"] == result["version_id"]
        pdf = pypdfium2.PdfDocument(path)
        previews = []
        for index in {0, min(4, len(pdf) - 1)}:
            page = pdf[index]
            bitmap = page.render(scale=1.1)
            output = root / f"physical-page-{index + 1}.png"
            bitmap.to_pil().save(output)
            bitmap.close(); page.close()
            previews.append(str(output))
        pdf.close()
        report = {"status": "passed", "official_url": args.url, "version_id": detail["id"], "pages": detail["pages"],
                  "sha256": detail["sha256"], "pdf_path": str(path), "upload_reused_version": True,
                  "preview_paths": previews, "environment": str(root / "environment.json")}
        (root / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
