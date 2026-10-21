"""Packet-four browser checks against an explicitly isolated verification server."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

from playwright.sync_api import expect, sync_playwright


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:38118")
    parser.add_argument("--result", type=Path, required=True)
    args = parser.parse_args()
    result = json.loads(args.result.read_text(encoding="utf-8"))
    output = args.result.parent / "browser"
    output.mkdir(exist_ok=True)
    errors, writes = [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1080}, device_scale_factor=1)
        page.set_default_timeout(30000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: writes.append({"method": request.method, "url": request.url}) if request.method != "GET" else None)
        page.goto(args.base_url + "/#/projects/" + result["project_id"], wait_until="domcontentloaded")
        page.get_by_label("公司研究对象", exact=True).select_option(result["stock_code"])
        company = page.get_by_role("region", name="公司研究", exact=True)
        expect(company.get_by_label("公司研究截止日")).to_have_value(result["as_of"])
        financial = company.get_by_role("region", name="标准财务与指标计算", exact=True)
        annual = financial.locator("tbody tr").filter(has=page.locator("td", has_text="2025-12-31"))
        annual.get_by_role("button", name="查看计算依据", exact=True).click()
        evidence = financial.get_by_role("complementary", name="财务计算依据")
        original = evidence.get_by_role("region", name="原文关联与独立数字依据")
        expect(original.get_by_text("仅关联文档", exact=False).first).to_be_visible()
        expect(evidence.get_by_text("源值 " + result["revenue"], exact=False)).to_be_visible()
        original.get_by_role("button", name="保存独立数字依据", exact=True).click()
        proof_field = original.get_by_label("数字依据标识", exact=True)
        expect(proof_field).to_have_value(__import__("re").compile(r"^[a-f0-9]{64}$"))
        proof_id = proof_field.input_value()
        saved = page.request.get(args.base_url + "/api/v1/research-evidence/" + proof_id).json()
        assert saved["point"]["value"] == result["revenue"] and not saved["original_verified"]
        with page.expect_popup() as popup_info:
            original.get_by_role("link", name="打开独立数字依据", exact=True).click()
        proof = popup_info.value
        proof.wait_for_load_state()
        assert result["revenue"] in proof.locator("body").inner_text()
        pdf_url = proof.get_by_role("link", name=__import__("re").compile("物理页")).first.get_attribute("href")
        pdf = page.request.get(args.base_url + pdf_url.split("#")[0])
        assert pdf.status == 200 and hashlib.sha256(pdf.body()).hexdigest() == result["sha256"]
        proof.screenshot(path=str(output / "independent-evidence.png"))
        proof.close()
        original.locator("summary").filter(has_text="关联或核对本输入的原文").click()
        original.get_by_label("对应报告期原文", exact=True).select_option(result["official_version_id"])
        original.get_by_label("核对物理页", exact=True).fill(str(result["physical_page"]))
        expect(original.locator("pre")).to_contain_text("456,451,731")
        original.locator("summary").filter(has_text="核对 PDF 原页").click()
        canvas = original.locator('canvas[aria-label="原始披露 PDF 第 ' + str(result["physical_page"]) + ' 页"]')
        expect(canvas).to_be_visible(timeout=60000)
        canvas.scroll_into_view_if_needed()
        page.screenshot(path=str(output / "original-page.png"))
        assert not original.get_by_label("已核对期间列单位币种与合并范围").is_checked()
        original.get_by_role("button", name="保存文档关联", exact=True).click()
        expect(original.get_by_role("status")).to_have_text("仅关联文档")
        unchanged = page.request.get(args.base_url + "/api/v1/research-evidence/" + proof_id).json()
        assert unchanged == saved, "New page associations must not mutate saved numeric citations"
        original.locator("summary").filter(has_text="关联或核对本输入的原文").click()
        original.locator("h4").scroll_into_view_if_needed()
        page.screenshot(path=str(output / "financial-evidence-desktop.png"))
        page.set_viewport_size({"width": 390, "height": 844})
        original.locator("h4").scroll_into_view_if_needed()
        page.screenshot(path=str(output / "financial-evidence-mobile.png"))
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth + 2")
        page.set_viewport_size({"width": 1440, "height": 1080})
        page.get_by_role("tab", name="同业对比", exact=True).click()
        comparison = page.get_by_role("region", name="标准财务同业对比", exact=True)
        expect(comparison.locator("tbody tr")).not_to_have_count(0)
        assert comparison.locator("thead th").count() == 4
        comparison.get_by_role("button", name="保存本次比较", exact=True).click()
        expect(comparison.get_by_role("button", name="本次比较已保存", exact=True)).to_be_disabled()
        comparison.get_by_role("button", name="数字依据", exact=True).first.click()
        expect(comparison.get_by_role("link", name="打开独立数字依据", exact=True)).to_be_visible()
        comparison.get_by_label("保存的财务比较").select_option(result["comparison_id"])
        expect(comparison.get_by_text("保存的历史版本", exact=False)).to_be_visible()
        comparison.locator("h3").scroll_into_view_if_needed()
        page.screenshot(path=str(output / "comparison-desktop.png"))
        comparison.locator("table").scroll_into_view_if_needed()
        page.screenshot(path=str(output / "comparison-table-desktop.png"))
        page.set_viewport_size({"width": 390, "height": 844})
        comparison.locator("h3").scroll_into_view_if_needed()
        page.screenshot(path=str(output / "comparison-mobile.png"))
        comparison.locator("table").scroll_into_view_if_needed()
        page.screenshot(path=str(output / "comparison-table-mobile.png"))
        assert not page.evaluate("document.documentElement.scrollWidth > innerWidth + 2")
        assert not any("/messages" in call["url"] or "/maintenance/" in call["url"] or "/import" in call["url"] for call in writes), writes
        assert not errors, errors
        report = {"status": "passed", "project_id": result["project_id"], "proof_id": proof_id,
                  "frozen_citation_unchanged": True, "pdf_hash_verified": result["sha256"], "physical_page": result["physical_page"],
                  "comparison_companies": 3, "mobile_width": 390, "horizontal_overflow": False,
                  "model_calls": 0, "automatic_acquisition": False, "human_verification_published": False, "page_errors": errors}
        (output / "ui-result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    main()
