import json
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect


OUTPUT = Path(__file__).parent / "interaction-simplification"
OUTPUT.mkdir(exist_ok=True)
DATE = "2026-10-02T02:00:00Z"
TASK = {
    "task_id": "ui-research", "revision": 1,
    "original_user_messages": ["关注趋势转强的公司"],
    "conditions": [{"condition_id": "trend", "library": "technical", "source_quote": "趋势转强",
                    "description": "收盘价高于20日均线", "expression": {}}],
    "references": [{"reference_id": "trend-ref", "condition_id": "trend", "parameter_overrides": {}}],
    "logic_tree": {"op": "condition", "reference_id": "trend-ref"},
    "scope": {"universe": {"kind": "all_a_shares", "stock_codes": []}, "as_of": "2026-09-30"},
    "unresolved": [],
}
ANSWER = """## 订单研究结论

**两家公司均有已落地订单，利润兑现节奏不同。**

- 示例公司甲：新增订单已经签订，交付集中在第四季度。
- 示例公司乙：已完成部分交付，但毛利率仍需核对。

| 公司 | 订单变化 | 已实现收入 | 主要风险 |
| --- | --- | --- | --- |
| 示例公司甲 | 20% | 1.2 亿元 | 交付进度 |
| 示例公司乙 | 12% | 0.8 亿元 | 原材料成本 |

> 数据截至 2026-09-30；订单增长不能直接视为利润增长。

[下载完整比较](outputs/comparison.csv) · [阅读研究笔记](outputs/note.md)

```python
growth = (current_orders / prior_orders - 1) * 100
```
"""


def fixture(scenario):
    return {
        "id": "ui-research", "task_id": "ui-research", "entry_scope": "screening",
        "research_mode": "research",
        "task_revision": 1 if scenario == "plan" else 0,
        "active_run_id": None, "pending_execution": False, "state": "active",
        "messages": [{"id": "question", "role": "user", "content": "比较两家公司的订单兑现情况",
                      "source_refs": [], "created_at": DATE},
                     {"id": "answer", "role": "assistant", "content": ANSWER,
                      "source_refs": [], "created_at": DATE}],
        "turns": [{"id": "ui-turn", "user_message_id": "question", "base_revision": 0,
                   "state": "succeeded", "response_text": ANSWER,
                   "result": {"task_revision": 1 if scenario == "plan" else 0},
                   "created_at": DATE, "updated_at": DATE}],
        "created_at": DATE, "updated_at": DATE,
    }


def run_case(browser, name, width, height, scenario):
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
    page = context.new_page()
    errors, writes = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    current = fixture(scenario)
    current_task = json.loads(json.dumps(TASK))
    runs = []

    def respond(route):
        request = route.request
        path = urlparse(request.url).path.removeprefix("/api/v1")
        response = {"items": []}
        if request.method != "GET":
            body = request.post_data_json
            writes.append({"path": path, "body": body})
            if path.endswith("/mode"):
                current["research_mode"] = body["research_mode"]
                response = {"research_mode": current["research_mode"]}
            elif path.endswith("/scope"):
                current_task["revision"] += 1
                current_task["scope"].update(as_of=body["as_of"], universe=body["universe"])
                current["task_revision"] = current_task["revision"]
                current["turns"][0]["result"]["task_revision"] = current_task["revision"]
                response = {"revision": current_task["revision"]}
            elif path.endswith("/execute"):
                run_id = f"ui-run-{len(runs) + 1}"
                runs.insert(0, {"id": run_id, "task_revision": current_task["revision"], "as_of": current_task["scope"]["as_of"],
                                "status": "succeeded", "job_id": f"job-{run_id}", "created_at": DATE, "finished_at": DATE})
                current["active_run_id"] = run_id
                response = {"run_id": run_id}
            else:
                response = {"id": "saved-ui", "version": 1, "name": body.get("name")}
        elif path == "/data/status":
            response = {"available": True, "last_date": "2026-09-30", "rows": 1000, "securities": 20}
        elif path == "/conversations":
            response = {"items": [] if scenario == "empty" else [{**current, "title": "订单兑现研究"}]}
        elif path == "/conversations/ui-research":
            response = current
        elif path == "/conversations/research-modes":
            response = {"default_mode": "research"}
        elif "/revisions/" in path:
            response = current_task
        elif path == "/watchlists":
            response = {"items": [{"id": "watchlist", "name": "重点关注"}]}
        elif path.endswith("/screening-runs"):
            response = {"items": runs}
        elif "/screening-runs/ui-run-" in path and not path.endswith("/decisions"):
            run_id = path.rsplit("/", 1)[-1]
            response = {**next(run for run in runs if run["id"] == run_id), "task": current_task,
                        "result": {}, "job": {"state": "succeeded", "progress": 1, "message": "已完成"}}
        elif path.endswith("/decisions"):
            response = {"items": [], "total": 0}
        elif path.endswith("/research-files"):
            response = {"items": [
                {"name": "comparison.csv", "bytes": 640,
                 "url": "/api/v1/conversations/ui-research/research-files/comparison.csv"},
                {"name": "note.md", "bytes": 2048,
                 "url": "/api/v1/conversations/ui-research/research-files/note.md"},
            ]}
        elif path.endswith("/research-files/comparison.csv"):
            route.fulfill(status=200, body="company,growth\nexample,20\n", content_type="application/octet-stream",
                          headers={"Content-Disposition": "attachment; filename=comparison.csv"})
            return
        route.fulfill(status=200, json=response)

    page.route("**/api/v1/**", respond)
    page.goto("http://127.0.0.1:5173/", wait_until="networkidle")
    expect(page.get_by_role("textbox", name="研究要求")).to_be_enabled()
    expect(page.get_by_label("研究模式", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="应用范围与日期", exact=True)).to_have_count(0)
    if scenario == "empty":
        expect(page.get_by_text("今天想研究什么？", exact=True)).to_be_visible()
        expect(page.get_by_role("complementary", name="当前筛选任务和结果")).to_have_count(0)
        page.get_by_role("button", name="市场机会", exact=True).click()
        expect(page.get_by_role("textbox", name="研究要求")).to_have_value(
            "最近哪些股票值得进一步研究？请结合走势、成交和已有资料，列出理由与风险。")
        assert not writes
    else:
        expect(page.get_by_role("heading", name="订单研究结论")).to_be_visible()
        expect(page.get_by_role("cell", name="20%", exact=True)).to_be_visible()
        assert not page.locator(".research-answer-code").get_attribute("open")
        if scenario == "research":
            expect(page.get_by_role("heading", name="筛选方案", exact=True)).to_have_count(0)
            expect(page.get_by_role("heading", name="筛选结果", exact=True)).to_have_count(0)
            with page.expect_download() as download:
                page.get_by_role("link", name="下载完整比较", exact=True).click()
            assert download.value.suggested_filename == "comparison.csv"
        if scenario == "plan":
            page.get_by_role("button", name="保存方案", exact=True).click()
            expect(page.get_by_role("status")).to_contain_text("已保存“收盘价高于20日均线”")
            assert len(writes) == 1
            assert writes[0]["path"].endswith("/saved-screening-tasks")
            expect(page.get_by_role("textbox", name="方案名称")).to_have_count(0)
            page.get_by_label("研究模式", exact=True).select_option("advanced")
            expect(page.get_by_label("研究模式", exact=True)).to_have_value("advanced")
            page.get_by_role("textbox", name="研究要求").fill("稍后比较估值")
            page.get_by_label("调整行情日期").fill("2026-09-29")
            expect(page.get_by_text("范围和日期已自动保存", exact=True)).to_be_visible()
            page.get_by_label("调整股票范围").select_option("watchlist")
            expect(page.get_by_label("调整股票范围")).to_be_enabled()
            expect(page.get_by_text("范围和日期已自动保存", exact=True)).to_be_visible()
            expect(page.get_by_role("textbox", name="研究要求")).to_have_value("稍后比较估值")
            page.get_by_role("textbox", name="研究要求").fill("")
            page.get_by_role("button", name="确认并开始筛选", exact=True).click()
            expect(page.get_by_role("button", name="按当前条件再筛一次", exact=True)).to_be_enabled()
            page.get_by_role("button", name="按当前条件再筛一次", exact=True).click()
            expect(page.get_by_role("button", name="按当前条件再筛一次", exact=True)).to_be_enabled()
            execution = [write["body"] for write in writes if write["path"].endswith("/execute")]
            assert len(execution) == 2 and execution[0]["action"] == "button"
            assert execution[0]["revision"] == 3
            assert execution[0]["request_id"] != execution[1]["request_id"]
            assert not any(write["path"].endswith(("/messages", "/process")) for write in writes)
    page.get_by_role("textbox", name="研究要求").scroll_into_view_if_needed()
    page.screenshot(path=str(OUTPUT / f"{name}.png"), full_page=True)
    dimensions = page.evaluate("""() => ({
      viewport: innerWidth, document: document.documentElement.scrollWidth,
      clippedButtons: [...document.querySelectorAll('button')].filter(button => {
        const box = button.getBoundingClientRect();
        return box.width > 0 && button.scrollWidth > button.clientWidth + 2;
      }).map(button => button.getAttribute('aria-label') || button.textContent.trim())
    })""")
    assert dimensions["document"] <= width + 1, dimensions
    assert not dimensions["clippedButtons"], dimensions
    assert not errors, errors
    context.close()
    return {"name": name, "dimensions": dimensions, "page_errors": errors, "writes": writes}


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    results = []
    for device, width, height in [("desktop", 1440, 900), ("mobile", 390, 844), ("narrow-mobile", 320, 740)]:
        for scenario in ("empty", "research", "plan"):
            results.append(run_case(browser, f"{device}-{scenario}", width, height, scenario))
    browser.close()
    print(json.dumps(results, ensure_ascii=False, indent=2))
