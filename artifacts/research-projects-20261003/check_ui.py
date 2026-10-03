"""Real-browser acceptance against an isolated database and application processes."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
from urllib.request import urlopen
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright


OUTPUT = Path(__file__).resolve().parent
ROOT = OUTPUT.parent.parent


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def ready(url, process):
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError(f"Application exited before becoming ready: {process.returncode}")
        try:
            with urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("Application startup timed out")


def dimensions(page):
    return page.evaluate("""() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        clippedButtons: [...document.querySelectorAll('button')].filter(button => {
            const r = button.getBoundingClientRect();
            return r.width > 0 && button.scrollWidth > button.clientWidth + 2;
        }).map(button => button.getAttribute('aria-label') || button.textContent.trim())
    })""")


def main():
    temporary = ROOT / "runtime" / "browser-runs" / uuid4().hex
    temporary.mkdir(parents=True)
    database = temporary / "app.db"
    os.environ["LLMR_DB_PATH"] = str(database)
    os.environ["LLMR_DATA_ROOT"] = str(temporary / "source")
    from apps.api.app import conversation_store, db, research_projects, research_workspace

    db.init_db()
    with db.connect() as connection:
        connection.execute("INSERT INTO security_catalog VALUES(?,?,?,?,?,?)", ("600519.SH", "贵州茅台", "guizhoumaotai", "gzmt", "SH", db.utc_now()))
    seed = research_projects.create_project(research_projects.CreateProject(
        name="验收示例 · 白酒经营研究", objective="仅用于界面验收的合成记录，验证问题与证据的组织方式。", request_id="seed"))
    research_projects.add_company(seed["id"], "600519.SH")
    conversation = conversation_store.create_conversation("screening", project_id=seed["id"])
    cid = conversation["id"]
    request = conversation_store.add_user_message(cid, "seed", 0, "比较经营兑现和现金流，需要哪些证据？")
    conversation_store.start_turn(cid, request["turn_id"])
    conversation_store.finish_turn(cid, request["turn_id"], 0, "succeeded",
        "### 待验证的问题\n\n这是一条界面验收用的合成研究答复。\n\n- 核对经营现金流与收入的变化。\n- 寻找支持和反方证据。\n\n[验收表格](outputs/research.csv)",
        {"runtime": "codex", "ready_to_execute": False})
    outputs = research_workspace.directory(cid) / "outputs"
    outputs.mkdir(parents=True)
    (outputs / "research.csv").write_text("question,status\n现金流与收入是否一致,待核验\n", encoding="utf-8")

    api_port, web_port = free_port(), free_port()
    environment = {**os.environ, "LLMR_WEB_PORT": str(web_port), "LLMR_API_PROXY_TARGET": f"http://127.0.0.1:{api_port}"}
    processes = []
    errors, checks = [], []
    try:
        with (temporary / "api.log").open("w") as api_log, (temporary / "web.log").open("w") as web_log:
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            api = subprocess.Popen([sys.executable, "-m", "uvicorn", "apps.api.app.main:app", "--host", "127.0.0.1", "--port", str(api_port)], cwd=ROOT, env=environment, stdout=api_log, stderr=api_log, creationflags=flags)
            processes.append(api)
            ready(f"http://127.0.0.1:{api_port}/api/v1/health", api)
            web = subprocess.Popen([shutil.which("node"), str(ROOT / "apps/web/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", str(web_port), "--strictPort"], cwd=ROOT / "apps/web", env=environment, stdout=web_log, stderr=web_log, creationflags=flags)
            processes.append(web)
            url = f"http://127.0.0.1:{web_port}"
            ready(url, web)
            with sync_playwright() as playwright:
                options = research_workspace.browser_options()
                browser = playwright.chromium.launch(**options)
                context = browser.new_context(viewport={"width": 1440, "height": 1000})
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(url)
                expect(page.get_by_role("heading", name="研究中心", exact=True)).to_be_visible()
                page.get_by_role("button", name="新建项目", exact=True).click()
                page.get_by_role("textbox", name="项目名称", exact=True).fill("验收新项目")
                page.get_by_role("textbox", name="研究目标", exact=True).fill("持续核验经营判断，保存证据与观点。")
                page.get_by_role("button", name="保存项目", exact=True).click()
                expect(page.get_by_role("heading", name="验收新项目", exact=True)).to_be_visible()
                page.get_by_role("combobox", name="选择关联公司", exact=True).fill("600519")
                page.get_by_role("option", name="贵州茅台").click()
                page.get_by_role("button", name="加入", exact=True).click()
                expect(page.get_by_role("button", name="贵州茅台 600519.SH", exact=True)).to_be_visible()
                page.get_by_role("button", name="写研究笔记", exact=True).click()
                page.get_by_role("textbox", name="笔记标题", exact=True).fill("经营变化需要交叉验证")
                page.get_by_role("textbox", name="研究内容", exact=True).fill("### 研究假设\n\n这是验收记录，尚未核实实际经营数据。")
                page.get_by_label("笔记关联公司", exact=True).select_option("600519.SH")
                page.get_by_role("textbox", name="验证事项", exact=True).fill("检查后续公告中的经营现金流。")
                page.get_by_role("textbox", name="失效条件", exact=True).fill("连续出现与原判断冲突的公开证据。")
                page.get_by_role("button", name="保存笔记", exact=True).click()
                expect(page.get_by_role("heading", name="经营变化需要交叉验证", exact=True)).to_be_visible()
                page.reload()
                expect(page.get_by_role("heading", name="经营变化需要交叉验证", exact=True)).to_be_visible()
                page.get_by_role("button", name="开始研究", exact=True).click()
                expect(page.get_by_role("heading", name="投研助手", exact=True)).to_be_visible()
                expect(page.get_by_role("combobox", name="所属研究项目", exact=True)).to_have_value(research_projects.list_projects()[0]["id"])
                expect(page.get_by_role("textbox", name="研究要求", exact=True)).to_be_enabled()
                page.get_by_role("navigation", name="主菜单").get_by_role("button", name="研究中心", exact=True).click()
                page.get_by_role("button", name="验收示例 · 白酒经营研究", exact=False).click()
                page.get_by_role("tab", name="研究对话", exact=False).click()
                page.get_by_role("button", name="比较经营兑现和现金流", exact=False).click()
                expect(page.get_by_text("这是一条界面验收用的合成研究答复。", exact=True)).to_be_visible()
                page.get_by_role("button", name="保存为研究笔记", exact=True).click()
                expect(page.get_by_role("status").filter(has_text="答复已保存")).to_be_visible()
                page.get_by_role("button", name="保存为研究笔记", exact=True).click()
                assert len(research_projects.get_project(seed["id"])["notes"]) == 1
                page.get_by_role("button", name="查看项目", exact=True).click()
                expect(page.get_by_role("heading", name="比较经营兑现和现金流，需要哪些证据？", exact=True)).to_be_visible()
                expect(page.get_by_role("link", name="验收表格", exact=True)).to_have_attribute("href", f"/api/v1/conversations/{cid}/research-files/research.csv")
                page.get_by_role("button", name="编辑笔记 比较经营兑现和现金流，需要哪些证据？", exact=True).click()
                page.get_by_label("观点状态", exact=True).select_option("challenged")
                page.get_by_role("textbox", name="验证事项", exact=True).fill("核对下一次公告中的现金流和收入。")
                page.get_by_role("textbox", name="失效条件", exact=True).fill("多份原文持续显示相反结果。")
                page.get_by_role("button", name="保存笔记", exact=True).click()
                expect(page.get_by_text("存在反证", exact=True)).to_be_visible()
                page.get_by_text("历史版本", exact=True).click()
                expect(page.locator(".research-note-history > details")).to_have_count(2)
                page.locator(".research-note-history > details > summary").last.click()
                expect(page.locator(".research-note-history > details").last.get_by_text("这是一条界面验收用的合成研究答复。", exact=True)).to_be_visible()
                expect(page.locator(".research-note-history > details > summary").last).to_contain_text("待验证")
                page.get_by_text("历史版本", exact=True).click()
                checks.extend(["project-create", "company-association", "note-write-and-reload", "scoped-conversation-start", "source-conversation-resume", "answer-save-idempotent", "source-artifact-link"])
                checks.extend(["manual-thesis-state-update", "immutable-note-history"])
                page.get_by_role("tab", name="研究成果", exact=False).click()
                expect(page.get_by_role("link", name="research.csv", exact=False)).to_be_visible()
                page.get_by_role("tab", name="研究笔记", exact=False).click()
                page.screenshot(path=str(OUTPUT / "desktop.png"), full_page=True)
                context.close()
                layouts = []
                for name, width in (("desktop", 1440), ("tablet", 820), ("mobile", 390), ("narrow", 320)):
                    context = browser.new_context(viewport={"width": width, "height": 950})
                    page = context.new_page()
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.goto(url)
                    page.get_by_role("button", name="验收示例 · 白酒经营研究", exact=False).click()
                    expect(page.get_by_role("heading", name="比较经营兑现和现金流，需要哪些证据？", exact=True)).to_be_visible()
                    layout = dimensions(page)
                    assert layout["document"] <= width + 1, (name, layout)
                    assert not layout["clippedButtons"], (name, layout)
                    layouts.append({"device": name, **layout})
                    if width <= 390:
                        page.screenshot(path=str(OUTPUT / f"{name}.png"), full_page=True)
                    context.close()
                browser.close()
        assert not errors, errors
        result = {"data": "isolated synthetic fixtures; no model calls; production database unchanged", "checks": checks, "layouts": layouts, "page_errors": errors}
        (OUTPUT / "validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        for process in reversed(processes):
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    main()
