"""Browser acceptance using intercepted synthetic API responses, never the daily database."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect


OUTPUT = Path(__file__).resolve().parent
STAMP = "2026-10-06T01:00:00Z"
DATA = {"available": True, "last_date": "2026-09-28", "securities": 5569,
        "quality_status": "issues_found", "formal_execution_ready": False, "formal_blockers": ["复权口径未确认"]}
CONVERSATION = {
    "id": "sample", "task_id": None, "entry_scope": "report", "workflow_type": "research", "research_depth": "standard",
    "research_scope": {"as_of": "2026-09-28", "stock_codes": ["600519.SH"]}, "research_scope_revision": 0,
    "workflow_revision": 0, "project_id": None, "task_revision": 0, "active_run_id": None,
    "pending_execution": False, "state": "active", "created_at": STAMP, "updated_at": STAMP,
    "messages": [{"id": "question", "role": "user", "content": "核对贵州茅台经营现金流的证据", "source_refs": [], "created_at": STAMP},
                 {"id": "answer", "role": "assistant", "content": "## 核心结论\n经营现金流需要与回款和收入交叉核对。\n\n## 反证与风险\n这是一条隔离验收答复，需要后续核对原始公告。", "source_refs": [], "created_at": STAMP}],
    "turns": [{"id": "turn", "user_message_id": "question", "base_revision": 0, "state": "succeeded",
               "research_scope": {"as_of": "2026-09-28", "stock_codes": ["600519.SH"]}, "workflow_type": "research",
               "response_text": "经营现金流需要核对", "result": {}, "created_at": STAMP, "updated_at": STAMP}],
}


class SyntheticApi:
    def __init__(self):
        self.mode = "home"
        self.writes = []

    def intercept(self, route):
        request = route.request
        path = urlparse(request.url).path.removeprefix("/api/v1")
        if request.method not in {"GET", "HEAD"}:
            self.writes.append({"path": path, "method": request.method, "body": request.post_data_json})
            if path.endswith("/notes/from-message"):
                value = {"id": "note", "project_id": "inbox", "revision": 1, "pdf": {"status": "queued"}}
            elif path.endswith("/research-candidates"):
                value = {"id": "candidate", "name": "贵州茅台", "stock_code": "600519.SH"}
            else:
                route.fulfill(status=422, json={"message": "验收未授权这项写入"})
                return
        elif path == "/data/status":
            value = DATA
        elif path == "/security-catalog":
            value = {"items": [{"stock_code": "600519.SH", "name": "贵州茅台", "market": "SH", "pinyin": "guizhoumaotai", "initials": "gzmt"}]}
        elif path == "/conversations/sample":
            value = CONVERSATION
        elif path == "/conversations":
            value = {"items": [{**CONVERSATION, "title": "核对经营现金流", "last_turn_state": "succeeded"}] if self.mode == "research" else []}
        elif path == "/tasks":
            value = {"active_count": 1, "items": [{"id": "job:sync", "kind": "data_sync", "title": "资料更新", "kind_label": "资料更新",
                       "state": "running", "state_label": "处理中", "stage": "正在更新名称、行情和资讯，原有资料仍可使用。",
                       "created_at": STAMP, "updated_at": STAMP, "action_label": "查看数据更新", "destination": {"kind": "settings"}}]}
        elif path == "/settings/status":
            value = {"text_model": {"configured": True, "model": "验收模型"}, "tushare": {"configured": True}, "codex_runtime": {"available": True}}
        elif path == "/maintenance/status":
            value = {"job": None}
        else:
            value = {"items": [], "total": 0}
        route.fulfill(json=value)


def no_overflow(page):
    return page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:5173")
    args = parser.parse_args()
    checks, errors = [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        for width in [1440, 390, 320]:
            context = browser.new_context(viewport={"width": width, "height": 900 if width > 500 else 844})
            page = context.new_page()
            fixture = SyntheticApi()
            page.route("**/api/v1/**", fixture.intercept)
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(args.url + "/#/home")
            expect(page.get_by_role("heading", name="你想先完成哪件事？")).to_be_visible()
            expect(page.get_by_role("button", name="研究一家公司", exact=False)).to_be_visible()
            assert no_overflow(page)
            page.screenshot(path=str(OUTPUT / f"first-home-{width}.png"), full_page=True)
            page.get_by_role("button", name="研究一家公司", exact=False).click()
            page.get_by_role("textbox", name="公司名称或证券代码").fill("贵州茅台")
            page.get_by_role("button", name="准备研究问题").click()
            expect(page.get_by_role("textbox", name="研究要求")).to_have_value(__import__('re').compile("贵州茅台"))
            assert fixture.writes == [], fixture.writes
            checks.append({"width": width, "case": "first-task", "overflow": False, "writes": 0})
            fixture.mode = "research"
            page.goto(args.url + "/#/research/sample?scope=report")
            expect(page.get_by_role("button", name="保存为研究笔记")).to_be_visible()
            expect(page.get_by_role("heading", name="接下来做什么？")).to_be_visible()
            page.get_by_role("button", name="加入观察", exact=True).click()
            expect(page.get_by_role("combobox", name="观察候选股票代码")).to_have_value("贵州茅台")
            expect(page.get_by_role("textbox", name="观察候选备注")).not_to_have_value("")
            assert not page.locator(".research-candidate-plan").get_attribute("open")
            assert no_overflow(page)
            page.screenshot(path=str(OUTPUT / f"research-next-{width}.png"), full_page=True)
            page.get_by_role("button", name="保存研究候选", exact=True).click()
            expect(page.get_by_role("form", name="加入研究候选观察")).to_have_count(0)
            assert len(fixture.writes) == 1 and fixture.writes[0]["path"].endswith("/research-candidates"), fixture.writes
            assert fixture.writes[0]["body"]["stock_code"] == "600519.SH"
            checks.append({"width": width, "case": "observe-prefill", "writes": 1, "no_process_or_execute": True})
            page.reload()
            expect(page.get_by_role("button", name="保存为研究笔记")).to_be_visible()
            assert len(fixture.writes) == 1
            page.get_by_role("button", name="运行任务", exact=True).click()
            expect(page.get_by_role("button", name=__import__('re').compile("资料更新.*查看数据更新"))).to_be_visible()
            assert no_overflow(page)
            assert page.evaluate("!!document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 20)?.closest('.workspace-modal-backdrop')"), "Task modal must block background navigation"
            page.screenshot(path=str(OUTPUT / f"task-progress-{width}.png"), full_page=True)
            checks.append({"width": width, "case": "bookmark-and-tasks", "reload_writes": 0, "overflow": False})
            context.close()
        browser.close()
    assert not errors, errors
    (OUTPUT / "browser-validation.json").write_text(json.dumps({"scope": "Synthetic intercepted API; visual and interaction acceptance; no model evaluation or daily database writes", "checks": checks, "page_errors": errors}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"checks": len(checks), "page_errors": errors}, ensure_ascii=False))


if __name__ == "__main__":
    main()
