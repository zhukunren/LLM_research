"""Browser verification of cached financial series; never starts data collection."""
import argparse
import json
from pathlib import Path
import sys

from playwright.sync_api import expect, sync_playwright


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    errors, calls = [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1080}, device_scale_factor=1)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: calls.append({"method": request.method, "url": request.url})
                if "/financial-" in request.url or "/financials?" in request.url else None)
        page.goto(args.base_url + "/#/library/reports", wait_until="domcontentloaded")
        page.get_by_role("button", name="数据与服务", exact=True).click()
        drawer = page.get_by_role("dialog", name="数据与服务", exact=True)
        drawer.locator("summary").filter(has_text="标准财务与指标计算").click()
        panel = drawer.get_by_role("region", name="标准财务与指标计算", exact=True)
        panel.get_by_label("财务截止日", exact=True).fill("2026-10-20")
        panel.get_by_label("数据版本口径", exact=True).select_option("as_of")
        rows = panel.locator("tbody tr")
        expect(rows).to_have_count(5, timeout=30000)
        expect(panel.locator("canvas")).to_be_visible(timeout=30000)
        annual_values = rows.locator("td:nth-child(2)").all_text_contents()
        assert all(value != "—" for value in annual_values), annual_values
        annual = rows.filter(has=page.locator("td", has_text="2025-12-31"))
        annual.get_by_role("button", name="查看计算依据", exact=True).click()
        evidence = panel.get_by_role("complementary", name="财务计算依据")
        expect(evidence.get_by_text("源值", exact=False)).to_be_visible(timeout=30000)
        assert "标准值" in evidence.inner_text()
        exact_source = evidence.inner_text()
        panel.get_by_role("button", name="保存本次计算", exact=True).click()
        expect(panel.get_by_role("button", name="本次计算已保存", exact=True)).to_be_disabled(timeout=30000)
        panel.locator("h3").scroll_into_view_if_needed()
        page.screenshot(path=str(args.output / "controls-desktop.png"))
        panel.locator("canvas").scroll_into_view_if_needed()
        page.screenshot(path=str(args.output / "annual-desktop.png"))
        evidence.scroll_into_view_if_needed()
        page.screenshot(path=str(args.output / "sources-desktop.png"))
        panel.get_by_label("财务期间口径", exact=True).select_option("ttm")
        expect(rows).to_have_count(23, timeout=30000)
        missing = rows.filter(has=page.locator("td", has_text="2026-09-30"))
        expect(missing.locator("td:nth-child(2)")).to_have_text("—")
        assert "未取得" in missing.inner_text()
        panel.get_by_label("财务期间口径", exact=True).select_option("annual")
        expect(rows).to_have_count(5)
        page.set_viewport_size({"width": 390, "height": 844})
        panel.locator("h3").scroll_into_view_if_needed()
        page.screenshot(path=str(args.output / "controls-mobile.png"))
        panel.locator("canvas").scroll_into_view_if_needed()
        page.screenshot(path=str(args.output / "annual-mobile.png"))
        overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 2")
        assert not overflow, "Mobile page has horizontal overflow"
        panel.get_by_label("财务截止日", exact=True).fill("2026-10-19")
        expect(rows).to_have_count(5, timeout=30000)
        expect(panel.get_by_text("当前范围没有可用数值，缺口原因已逐期列出；未补零或沿用其他报告期。", exact=True)).to_be_visible(timeout=30000)
        expect(panel.locator("canvas")).to_have_count(0)
        assert all(value == "—" for value in rows.locator("td:nth-child(2)").all_text_contents())
        assert "缺少当时可得的版本证据" in rows.first.inner_text()
        assert not any(item["method"] == "POST" and "/maintenance/" in item["url"] for item in calls), calls
        assert not errors, errors
        result = {
            "status": "passed", "annual_periods": 5, "ttm_periods": 23,
            "saved_real_calculation": True, "provenance": exact_source,
            "strict_historical_cutoff": "2026-10-19", "historical_values": "all missing",
            "mobile_width": 390, "horizontal_overflow": overflow,
            "automatic_acquisition": False, "page_errors": errors,
        }
        (args.output / "ui-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    main()
