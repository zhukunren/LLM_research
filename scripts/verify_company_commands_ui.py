"""Verify company slash commands in the built workbench without sending model messages."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import sys

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright


def show_financial_chart(dialog):
    # Initial coverage loading may refresh the calculated series once.
    for attempt in range(3):
        expect(dialog.locator("canvas")).to_be_visible(timeout=30000)
        try:
            dialog.locator("canvas").scroll_into_view_if_needed()
            return
        except PlaywrightError as error:
            if "not attached" not in str(error) or attempt == 2:
                raise


def verify(page, output):
    input_box = page.get_by_role("textbox", name="研究要求", exact=True)
    expect(input_box).to_be_enabled(timeout=30000)
    input_box.fill("/")
    suggestions = page.get_by_role("listbox", name="快捷命令建议")
    expect(suggestions.get_by_role("option")).to_have_count(6)
    input_box.press("ArrowDown")
    input_box.press("Tab")
    expect(input_box).to_have_value("/披露 ")
    input_box.fill("/披露 000333")
    expect(suggestions.get_by_role("option", name="美的集团 000333.SZ · 打开原始披露", exact=True)).to_be_visible()
    input_box.press("Enter")
    archive = page.get_by_role("dialog", name="公司原始披露", exact=True)
    expect(archive.get_by_role("heading", name="美的集团 · 公司原始披露", exact=True)).to_be_visible()
    expect(archive.get_by_role("region", name="原始披露归档")).to_be_visible(timeout=30000)
    page.screenshot(path=str(output / "disclosures-desktop.png"))
    page.keyboard.press("Escape")
    expect(input_box).to_be_focused()

    input_box.fill("/查财务 贵州茅台")
    suggestions.get_by_role("option", name="贵州茅台 600519.SH · 查财务", exact=True).click()
    finance = page.get_by_role("dialog", name="公司财务", exact=True)
    expect(finance.get_by_role("heading", name="贵州茅台 · 公司财务", exact=True)).to_be_visible()
    expect(finance.locator("tbody tr")).to_have_count(5, timeout=30000)
    expect(finance.locator("canvas")).to_be_visible(timeout=30000)
    show_financial_chart(finance)
    page.screenshot(path=str(output / "financials-desktop.png"))
    page.keyboard.press("Escape")

    input_box.fill("/切换公司 000333.sz")
    input_box.press("Enter")
    current = page.get_by_role("group", name="当前研究公司", exact=True)
    expect(current).to_contain_text("美的集团")
    expect(current).to_contain_text("000333.SZ")
    input_box.fill("请分析这家公司的经营变化")
    current.get_by_role("button", name="查财务", exact=True).click()
    expect(finance.get_by_role("heading", name="美的集团 · 公司财务", exact=True)).to_be_visible()
    finance.get_by_role("button", name="关闭公司财务", exact=True).click()
    expect(input_box).to_be_focused()
    expect(input_box).to_have_value("请分析这家公司的经营变化")
    page.screenshot(path=str(output / "current-company-desktop.png"))

    page.set_viewport_size({"width": 390, "height": 844})
    input_box.fill("/")
    expect(suggestions.get_by_role("option")).to_have_count(6)
    popup = page.locator(".company-command-menu")
    box = popup.bounding_box()
    assert box and box["x"] >= 0 and box["x"] + box["width"] <= 391, box
    assert box["y"] >= 0 and box["y"] + box["height"] <= 845, box
    page.screenshot(path=str(output / "suggestions-mobile.png"))
    input_box.fill("/财务 茅台")
    input_box.press("Enter")
    expect(finance.locator("canvas")).to_be_visible(timeout=30000)
    show_financial_chart(finance)
    page.screenshot(path=str(output / "financials-mobile.png"))
    assert not page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 2")
    page.keyboard.press("Escape")
    expect(current).to_contain_text("美的集团")
    input_box.fill("/披露")
    input_box.press("Enter")
    expect(archive.get_by_role("heading", name="美的集团 · 公司原始披露", exact=True)).to_be_visible()
    page.keyboard.press("Escape")

    input_box.fill("/财务 贵州茅台")
    input_box.dispatch_event("keydown", {"key": "Enter", "isComposing": True})
    expect(finance).to_have_count(0)
    input_box.press("Escape")
    expect(suggestions).to_have_count(0)
    expect(input_box).to_have_value("/财务 贵州茅台")
    input_box.fill("/财务 不存在股票公司123456789")
    input_box.press("Enter")
    expect(page.get_by_text("没有匹配的公司，请检查名称或股票代码。", exact=True)).to_be_visible()
    expect(finance).to_have_count(0)
    page.set_viewport_size({"width": 1440, "height": 1080})
    input_box.fill("/研报 五粮液")
    input_box.press("Enter")
    reports = page.get_by_role("dialog", name="公司研报", exact=True)
    expect(reports.get_by_role("region", name="公司研报列表")).to_be_visible(timeout=30000)
    expect(reports.get_by_role("article", name="公司研报原文")).to_be_visible(timeout=30000)
    expect(reports.get_by_role("img", name="研报 PDF 第 1 页", exact=True)).to_be_visible(timeout=60000)
    page.screenshot(path=str(output / "reports-desktop.png"))
    page.keyboard.press("Escape")
    expect(input_box).to_be_focused()
    input_box.fill("/资讯 601126")
    input_box.press("Enter")
    news = page.get_by_role("dialog", name="公司资讯", exact=True)
    expect(news.locator(".company-news-body")).to_be_visible(timeout=30000)
    page.screenshot(path=str(output / "news-desktop.png"))
    page.keyboard.press("Escape")
    input_box.fill("/行情 600519.sh")
    input_box.press("Enter")
    market = page.get_by_role("dialog", name="公司行情", exact=True)
    expect(market.get_by_role("img", name="K线主图叠加指标走势", exact=True)).to_be_visible(timeout=30000)
    expect(market.get_by_text("实际截至", exact=False)).to_be_visible()
    page.screenshot(path=str(output / "market-desktop.png"))
    market.get_by_label("行情截止日", exact=True).fill("2025-12-31")
    expect(market.get_by_role("img", name="K线主图叠加指标走势", exact=True)).to_be_visible(timeout=30000)
    expect(market.get_by_text("实际截至 2025-", exact=False)).to_be_visible(timeout=30000)
    page.set_viewport_size({"width": 390, "height": 844})
    page.screenshot(path=str(output / "market-mobile.png"))
    assert not page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 2")
    page.keyboard.press("Escape")
    expect(current).to_contain_text("美的集团")
    return {
        "name_query": "600519.SH", "bare_code_query": "000333.SZ",
        "current_company": "000333.SZ", "draft_retained": True, "keyboard_selection": True,
        "ime_does_not_execute": True, "escape_restores_focus": True,
        "mobile_width": 390, "menu_bounds": box, "horizontal_overflow": False,
        "reports_pdf_company": "000858.SZ", "news_company": "601126.SH",
        "market_company": "600519.SH", "market_cutoff": "2025-12-31", "commands": 6,
    }


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    errors, writes, reads = [], [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1080}, device_scale_factor=1)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: writes.append({"method": request.method, "url": request.url})
                if request.method not in {"GET", "HEAD", "OPTIONS"} else reads.append(request.url))
        try:
            page.goto(args.base_url + "/#/research/new", wait_until="domcontentloaded")
            result = verify(page, args.output)
            assert not errors, errors
            assert not writes, writes
            assert any("/companies/600519.SH/financials?" in url for url in reads)
            assert any("/disclosures?" in url and "stock_code=000333.SZ" in url for url in reads)
            assert any("/news?" in url and "stock_code=601126.SH" in url for url in reads)
            assert any("/securities/600519.SH/bars?" in url and "as_of=2025-12-31" in url for url in reads)
            result.update(status="passed", checked_at=datetime.now().isoformat(), page_errors=errors, mutation_requests=writes)
            (args.output / "ui-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(result, ensure_ascii=False))
        except Exception:
            page.screenshot(path=str(args.output / "failure.png"))
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main()
