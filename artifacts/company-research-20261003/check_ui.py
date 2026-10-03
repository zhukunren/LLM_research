"""Company and evidence browser acceptance; all records live in an isolated fixture database."""
from __future__ import annotations

from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

OUTPUT = Path(__file__).resolve().parent
ROOT = OUTPUT.parent.parent
spec = importlib.util.spec_from_file_location("project_acceptance_helpers", ROOT / "artifacts/research-projects-20261003/check_ui.py")
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def make_report(path):
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    writer = PdfWriter()
    page = writer.add_blank_page(width=595, height=842)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 40 760 Td (Synthetic report: cash flow needs verification.) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    writer.write(path)
    return "Synthetic report: cash flow needs verification."


def main():
    temporary = ROOT / "runtime/browser-runs" / uuid4().hex
    temporary.mkdir(parents=True)
    data_root = temporary / "source"
    market_dir = data_root / "stock_data"
    market_dir.mkdir(parents=True)
    os.environ["LLMR_DB_PATH"] = str(temporary / "app.db")
    os.environ["LLMR_DATA_ROOT"] = str(data_root)
    import pyarrow as pa
    import pyarrow.parquet as pq
    pq.write_table(pa.Table.from_pylist([{"stock_code": "600519.SH", "trade_date": datetime(2026, 9, day), "open": 1.0 + day / 100, "high": 1.5, "low": .8, "close": 1.2, "volume": 1000., "amount": 1200.} for day in range(1, 11)]), market_dir / "stock_daily.parquet")
    from apps.api.app import db, research_projects, news_sources, research_workspace
    db.init_db()
    project = research_projects.create_project(research_projects.CreateProject(name="验收 · 公司研究与原文依据", objective="全部行情与材料均为合成验收数据，验证研究日期、引用位置和历史版本。", request_id="project"))
    pid = project["id"]
    research_projects.add_company(pid, "600519.SH")
    note = research_projects.create_note(pid, research_projects.CreateNote(title="验收研究判断", body="这是合成研究笔记，用于验证支持与反方原文的关联。", stock_code="600519.SH", request_id="note"))
    original = news_sources.import_items(news_sources.NewsImport(request_id="news", items=[news_sources.NewsItemInput(title="合成经营资讯", body="🔎合成记录。经营现金流需要与收入交叉核验。\n此处没有实际公司业绩数据。", source="合成验收材料", available_at="2026-09-10T10:00:00+08:00", stock_codes=["600519.SH"])]))["items"][0]
    news_sources.import_items(news_sources.NewsImport(request_id="late", items=[news_sources.NewsItemInput(title="合成后续修订", body="这份较晚的修订仅在9月20日之后可用。", source="合成验收材料", available_at="2026-09-20T10:00:00+08:00", stock_codes=["600519.SH"])]), base_id=original["id"])
    report_path = temporary / "synthetic-report.pdf"
    report_text = make_report(report_path)
    with db.connect() as connection:
        connection.execute("INSERT INTO security_catalog VALUES(?,?,?,?,?,?)", ("600519.SH", "贵州茅台", "guizhoumaotai", "gzmt", "SH", db.utc_now()))
        connection.execute("""INSERT INTO documents(id,sha256,filename,title,stock_code,stock_code_status,available_at,available_at_status,pages,extracted_chars,parse_status,source_path,imported_at)
            VALUES('report',?,'synthetic.pdf','合成研报原件','600519.SH','confirmed','2026-09-10','confirmed',1,?,'indexed',?,'2026-09-10')""", (hashlib.sha256(report_path.read_bytes()).hexdigest(), len(report_text), str(report_path)))
        connection.execute("INSERT INTO document_pages VALUES('report',1,?)", (report_text,))
    api_port, web_port = helpers.free_port(), helpers.free_port()
    environment = {**os.environ, "LLMR_WEB_PORT": str(web_port), "LLMR_API_PROXY_TARGET": f"http://127.0.0.1:{api_port}"}
    processes, errors, checks = [], [], []
    try:
        with (temporary / "api.log").open("w") as api_log, (temporary / "web.log").open("w") as web_log:
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            api = subprocess.Popen([sys.executable, "-m", "uvicorn", "apps.api.app.main:app", "--host", "127.0.0.1", "--port", str(api_port)], cwd=ROOT, env=environment, stdout=api_log, stderr=api_log, creationflags=flags)
            processes.append(api)
            helpers.ready(f"http://127.0.0.1:{api_port}/api/v1/health", api)
            web = subprocess.Popen([shutil.which("node"), str(ROOT / "apps/web/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", str(web_port), "--strictPort"], cwd=ROOT / "apps/web", env=environment, stdout=web_log, stderr=web_log, creationflags=flags)
            processes.append(web)
            url = f"http://127.0.0.1:{web_port}"
            helpers.ready(url, web)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(**research_workspace.browser_options())
                context = browser.new_context(viewport={"width": 1440, "height": 1100})
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(url)
                page.get_by_role("button", name="贵州茅台 600519.SH", exact=True).click()
                page.get_by_label("公司研究截止日", exact=True).fill("2026-09-10")
                company = page.get_by_role("region", name="公司研究", exact=True)
                expect(company.get_by_text("行情实际截至", exact=False)).to_be_visible()
                expect(company.get_by_role("button", name="合成经营资讯", exact=False)).to_be_visible()
                expect(company.get_by_role("button", name="合成后续修订", exact=False)).to_have_count(0)
                company.get_by_role("button", name="研报", exact=True).click()
                company.get_by_role("button", name="合成研报原件", exact=False).click()
                expect(company.get_by_text(report_text, exact=True)).to_be_visible()
                company.get_by_text("阅读 PDF 原件", exact=True).click()
                expect(company.locator("canvas")).to_be_visible(timeout=20000)
                company.get_by_text("阅读 PDF 原件", exact=True).click()
                checks.extend(["company-dossier", "market-actual-date-and-unknown-units", "point-in-time-news-version", "indexed-report-and-original-pdf"])
                page.get_by_text("判断与原文依据", exact=True).click()
                page.get_by_role("button", name="添加判断与依据", exact=True).click()
                builder = page.get_by_role("region", name="添加判断与依据", exact=True)
                builder.get_by_label("判断内容", exact=True).fill("合成资料提出现金流与收入交叉核验的要求。")
                builder.get_by_label("判断类别", exact=True).select_option("fact")
                builder.get_by_label("证据关系", exact=True).select_option("context")
                builder.get_by_role("button", name="合成经营资讯", exact=False).click()
                quote = "经营现金流需要与收入交叉核验。"
                expect(builder.locator("pre")).to_contain_text(quote)
                builder.locator("pre").evaluate("""(element, quote) => {
                    const node = element.firstChild;
                    const start = node.textContent.indexOf(quote);
                    const range = document.createRange();
                    range.setStart(node, start); range.setEnd(node, start + quote.length);
                    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
                }""", quote)
                builder.get_by_role("button", name="引用所选原文", exact=True).click()
                expect(builder.get_by_label("引用原文", exact=True)).to_have_value(quote)
                builder.get_by_role("button", name="保存判断与依据", exact=True).click()
                expect(page.get_by_text("事实陈述", exact=True)).to_be_visible()
                page.get_by_role("button", name="定位原文", exact=True).click()
                expect(page.locator("mark")).to_have_text(quote)
                expect(page.get_by_text("保存时的原文摘录", exact=False)).to_be_visible()
                checks.extend(["selected-quote-unicode-location", "claim-kind-and-source-stance", "immutable-source-snapshot"])
                page.evaluate("window.scrollTo(0, 0)")
                page.screenshot(path=str(OUTPUT / "desktop.png"), full_page=True)
                context.close()
                layouts = []
                for name, width in (("tablet", 820), ("mobile", 390), ("narrow", 320)):
                    context = browser.new_context(viewport={"width": width, "height": 1100})
                    page = context.new_page()
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.goto(url)
                    page.get_by_role("button", name="贵州茅台 600519.SH", exact=True).click()
                    page.get_by_label("公司研究截止日", exact=True).fill("2026-09-10")
                    page.get_by_text("判断与原文依据", exact=True).click()
                    page.get_by_role("button", name="定位原文", exact=True).click()
                    expect(page.locator("mark")).to_have_text(quote)
                    expect(page.locator(".company-research-chart svg")).to_be_visible()
                    axis = page.locator(".company-research-chart svg text").first
                    screen_size = axis.evaluate("element => Number.parseFloat(getComputedStyle(element).fontSize) * element.getScreenCTM().a")
                    assert screen_size >= 11, (name, screen_size)
                    layout = helpers.dimensions(page)
                    assert layout["document"] <= width + 1, (name, layout)
                    assert not layout["clippedButtons"], (name, layout)
                    layouts.append({"device": name, **layout})
                    if width == 390:
                        page.evaluate("window.scrollTo(0, 0)")
                        page.screenshot(path=str(OUTPUT / "mobile.png"), full_page=True)
                    context.close()
                browser.close()
        assert not errors, errors
        result = {"data": "synthetic isolated fixtures; no model calls; production database unchanged", "checks": checks, "layouts": layouts, "page_errors": errors}
        (OUTPUT / "validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        for process in reversed(processes):
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=5)


if __name__ == "__main__":
    main()
