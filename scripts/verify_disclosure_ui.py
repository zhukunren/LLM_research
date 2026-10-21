"""Headless UI smoke test against an isolated archive verification server."""
import argparse
import json
from pathlib import Path
import re
import sys

from playwright.sync_api import sync_playwright


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:38117")
    parser.add_argument("--title", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1080}, device_scale_factor=1)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(args.base_url + "/#/library/reports", wait_until="domcontentloaded")
        page.get_by_role("button", name="原始披露", exact=True).click()
        archive = page.get_by_role("region", name="原始披露归档")
        archive.get_by_role("button", name=re.compile(re.escape(args.title))).first.click()
        reader = page.get_by_role("region", name="披露版本阅读")
        reader.locator('canvas[aria-label="原始披露 PDF 第 1 页"]').wait_for(state="visible", timeout=60000)
        assert reader.get_by_label("PDF 阅读器", exact=True).bounding_box()["height"] <= 850
        assert archive.evaluate("element => getComputedStyle(element).overflowY") == "auto"
        reader.get_by_label("PDF 阅读器", exact=True).screenshot(path=str(args.output / "reader-desktop.png"))
        reader.get_by_label("检索本份原文").fill("合并及公司资产负债表")
        reader.get_by_role("button", name="定位原文页", exact=True).click()
        hit = reader.locator(".disclosure-hit").first
        hit.wait_for(state="visible")
        physical_page = int(re.search(r"第 (\d+) 页", hit.inner_text())[1])
        hit.click()
        reader.locator(f'canvas[aria-label="原始披露 PDF 第 {physical_page} 页"]').wait_for(state="visible", timeout=60000)
        reader.get_by_label("PDF 阅读器", exact=True).screenshot(path=str(args.output / "located-page.png"))
        reader.get_by_role("button", name="核对分类", exact=True).click()
        archive.get_by_label("报告期末", exact=True).wait_for(state="visible")
        assert archive.get_by_label("报告期末", exact=True).input_value() == "2025-12-31"
        archive.locator(".disclosure-editor").screenshot(path=str(args.output / "classification-desktop.png"))
        archive.get_by_role("button", name="取消编辑", exact=True).click()
        page.set_viewport_size({"width": 390, "height": 844})
        archive.get_by_role("button", name="归档原始披露", exact=True).click()
        archive.get_by_label("原始披露 PDF 文件").wait_for(state="visible")
        archive.locator(".disclosure-editor").screenshot(path=str(args.output / "upload-mobile.png"))
        overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 2")
        assert not overflow, "Mobile document has horizontal overflow"
        assert not errors, errors
        result = {"status": "passed", "title": args.title, "located_physical_page": physical_page,
                  "mobile_width": 390, "horizontal_overflow": overflow, "page_errors": errors}
        (args.output / "ui-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    main()
