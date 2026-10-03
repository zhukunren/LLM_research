import argparse
import json
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


OUTPUT = Path(__file__).parent
URL = "http://127.0.0.1:5174/"
PAGES = [
    ("assistant", "投研助手"),
    ("observation", "观察池"),
    ("news", "资讯库"),
    ("technical", "技术指标库"),
    ("patterns", "形态库"),
    ("reports", "研报库"),
]


def dimensions(page):
    return page.evaluate("""() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      clippedButtons: [...document.querySelectorAll('button')].filter(button => {
        const box = button.getBoundingClientRect();
        return box.width > 0 && button.scrollWidth > button.clientWidth + 2;
      }).map(button => button.getAttribute('aria-label') || button.textContent.trim()),
      navigation: [...document.querySelectorAll('.workspace-navigation .nav-item')]
        .map(button => ({label: button.getAttribute('aria-label'), width: button.getBoundingClientRect().width}))
    })""")


def run_case(browser, device, width, height):
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/api/v1/documents/catalog*", lambda route: route.fulfill(status=200, json={"queued": 0}))
    page.route("**/api/v1/conversations/*/mode", lambda route: route.abort())
    page.goto(URL, wait_until="networkidle")
    expect(page.get_by_role("textbox", name="研究要求")).to_be_enabled()
    if width > 820:
        page.get_by_role("button", name="收起导航", exact=True).click()
        expect(page.locator(".app-shell")).to_have_class("app-shell sidebar-collapsed")
        page.reload(wait_until="networkidle")
        expect(page.locator(".app-shell")).to_have_class("app-shell sidebar-collapsed")
        page.get_by_role("button", name="展开导航", exact=True).click()
    page.get_by_role("button", name="新研究", exact=True).click()
    expect(page.get_by_role("button", name="市场机会", exact=True)).to_be_visible()
    page.get_by_role("button", name="深度研究", exact=True).click()
    expect(page.get_by_role("button", name="深度研究", exact=True)).to_have_attribute("aria-pressed", "true")
    page.get_by_role("button", name="研究模式", exact=True).click()
    page.get_by_role("button", name="市场机会", exact=True).click()
    expect(page.get_by_role("textbox", name="研究要求")).not_to_have_value("")
    page.get_by_role("textbox", name="研究要求").fill("")
    results = []
    for name, label in PAGES:
        page.get_by_role("navigation", name="主菜单").get_by_role("button", name=label, exact=True).click()
        expect(page.get_by_role("heading", name=label, exact=True)).to_be_visible()
        page.wait_for_timeout(1400)
        if name == "news":
            expect(page.get_by_role("textbox", name="搜索资讯")).to_be_visible()
        if name in ("news", "technical", "reports"):
            tabs = page.get_by_role("tablist", name=f"{label}功能")
            expect(tabs.get_by_role("tab").first).to_have_attribute("aria-selected", "true")
            tabs.get_by_role("tab").first.focus()
            page.keyboard.press("ArrowRight")
            expect(tabs.get_by_role("tab", name="独立条件库", exact=True)).to_have_attribute("aria-selected", "true")
            page.keyboard.press("Home")
            expect(tabs.get_by_role("tab").first).to_have_attribute("aria-selected", "true")
            page.wait_for_timeout(500)
        page.evaluate("window.scrollTo(0, 0)")
        page.evaluate("document.activeElement?.blur()")
        page.screenshot(path=str(OUTPUT / f"{device}-{name}.png"), full_page=width <= 560)
        size = dimensions(page)
        assert size["document"] <= width + 1, (device, name, size)
        assert not size["clippedButtons"], (device, name, size)
        assert all(item["width"] > 20 for item in size["navigation"]), (device, name, size)
        results.append({"device": device, "page": name, **size})
        print(f"PASS {device} {name}", flush=True)
    assert not errors, (device, errors)
    context.close()
    return results


def run_conversation_case(browser, device, width, height, scenario):
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    stamp = "2026-10-02T02:00:00Z"
    answer = """## 订单研究结论

**两家公司均有已落地订单，利润兑现节奏不同。**

- 示例公司甲：新增订单已经签订，交付集中在第四季度。
- 示例公司乙：已完成部分交付，但毛利率仍需核对。

| 公司 | 订单变化 | 已实现收入 | 主要风险 |
| --- | --- | --- | --- |
| 示例公司甲 | 20% | 1.2 亿元 | 交付进度 |
| 示例公司乙 | 12% | 0.8 亿元 | 原材料成本 |

> 订单增长不能直接视为利润增长。

```python
growth = current_orders / prior_orders - 1
```
"""
    conversation = {
        "id": "layout-research", "task_id": "layout-research", "title": "订单兑现质量比较",
        "entry_scope": "screening", "research_mode": "research", "task_revision": 1 if scenario == "plan" else 0,
        "active_run_id": None, "pending_execution": False, "state": "active",
        "messages": [
            {"id": "question", "role": "user", "content": "比较两家公司的订单兑现情况", "source_refs": [], "created_at": stamp},
            {"id": "answer", "role": "assistant", "content": answer, "source_refs": [], "created_at": stamp},
        ],
        "turns": [{"id": "layout-turn", "user_message_id": "question", "base_revision": 0, "state": "succeeded",
                   "response_text": answer, "result": {"task_revision": 1 if scenario == "plan" else 0}, "created_at": stamp, "updated_at": stamp}],
        "created_at": stamp, "updated_at": stamp,
    }
    task = {
        "task_id": "layout-research", "revision": 1, "original_user_messages": ["关注趋势转强的公司"],
        "conditions": [{"condition_id": "trend", "library": "technical", "source_quote": "趋势转强", "description": "收盘价高于20日均线", "expression": {}}],
        "references": [{"reference_id": "trend-ref", "condition_id": "trend", "parameter_overrides": {}}],
        "logic_tree": {"op": "condition", "reference_id": "trend-ref"},
        "scope": {"universe": {"kind": "all_a_shares", "stock_codes": []}, "as_of": "2026-09-30"}, "unresolved": [],
    }

    def respond(route):
        path = urlparse(route.request.url).path.removeprefix("/api/v1")
        response = {"items": []}
        if path == "/data/status":
            response = {"available": True, "last_date": "2026-09-30", "rows": 1000, "securities": 20}
        elif path == "/conversations":
            response = {"items": [conversation]}
        elif path == "/conversations/layout-research":
            response = conversation
        elif "/revisions/" in path:
            response = task
        elif path == "/conversations/research-modes":
            response = {"default_mode": "research"}
        route.fulfill(status=200, json=response)

    page.route("**/api/v1/**", respond)
    page.goto(URL, wait_until="networkidle")
    expect(page.get_by_role("heading", name="订单研究结论", exact=True)).to_be_visible()
    expect(page.get_by_role("cell", name="20%", exact=True)).to_be_visible()
    if scenario == "plan":
        expect(page.get_by_role("heading", name="筛选方案", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="确认并开始筛选", exact=True)).to_be_enabled()
    else:
        expect(page.get_by_role("complementary", name="当前筛选任务和结果")).to_have_count(0)
    page.screenshot(path=str(OUTPUT / f"{device}-{scenario}.png"), full_page=width <= 560)
    size = dimensions(page)
    assert size["document"] <= width + 1, (device, scenario, size)
    assert not size["clippedButtons"], (device, scenario, size)
    assert not errors, errors
    context.close()
    print(f"PASS {device} {scenario}", flush=True)


def verify_pdf_case(browser, device, width, height):
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
    page = context.new_page()
    page.route("**/api/v1/documents/catalog*", lambda route: route.fulfill(status=200, json={"queued": 0}))
    page.goto(URL, wait_until="networkidle")
    page.get_by_role("navigation", name="主菜单").get_by_role("button", name="研报库", exact=True).click()
    expect(page.get_by_role("img", name="研报 PDF 第 1 页", exact=True)).to_be_visible(timeout=30000)
    viewer = page.locator(".pdf-document-viewer")
    viewer.get_by_role("button", name="下一页", exact=True).click()
    try:
        expect(page.get_by_role("img", name="研报 PDF 第 2 页", exact=True)).to_be_visible(timeout=20000)
    except AssertionError:
        page.screenshot(path=str(OUTPUT / f"{device}-pdf-failure.png"), full_page=True)
        print(viewer.inner_text(), flush=True)
        print(page.locator(".pdf-canvas-container canvas").get_attribute("aria-label"), flush=True)
        raise
    viewer.get_by_role("button", name="放大 PDF", exact=True).click()
    expect(viewer.get_by_label("PDF 显示比例")).to_have_value("custom")
    viewer.get_by_label("PDF 显示比例").select_option("page")
    expect(page.get_by_role("img", name="研报 PDF 第 2 页", exact=True)).to_be_visible(timeout=20000)
    pixels = page.locator(".pdf-canvas-container canvas").evaluate("""canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < pixels.length; i += 116) {
        if (pixels[i + 3] && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 220) ink++;
      }
      return {width: canvas.width, height: canvas.height, ink};
    }""")
    assert pixels["width"] > 100 and pixels["height"] > 100 and pixels["ink"] > 20, pixels
    size = dimensions(page)
    assert size["document"] <= width + 1 and not size["clippedButtons"], size
    page.evaluate("window.scrollTo(0, 0); document.activeElement?.blur()")
    page.screenshot(path=str(OUTPUT / f"{device}-reports.png"), full_page=width <= 560)
    context.close()
    print(f"PASS {device} PDF render, page change, zoom, pixels {pixels}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf-only", action="store_true")
    parser.add_argument("--device", choices=["desktop", "laptop", "tablet", "mobile", "narrow"])
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        results = []
        devices = [
            ("desktop", 1440, 900),
            ("laptop", 1100, 800),
            ("tablet", 820, 1000),
            ("mobile", 390, 844),
            ("narrow", 320, 740),
        ]
        if args.device:
            devices = [device for device in devices if device[0] == args.device]
        if not args.pdf_only:
            for device, width, height in devices:
                results.extend(run_case(browser, device, width, height))
            for device, width, height in [("desktop", 1440, 900), ("mobile", 390, 844), ("narrow", 320, 740)]:
                for scenario in ("research", "plan"):
                    run_conversation_case(browser, device, width, height, scenario)
        for device, width, height in devices:
            verify_pdf_case(browser, device, width, height)
        browser.close()
        print(json.dumps({"checked_views": len(results) + (6 if results else 0), "pdf_checks": len(devices), "overflow": False, "clipped_buttons": False}, indent=2))
