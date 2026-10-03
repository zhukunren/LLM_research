"""Measure navigation geometry with delayed local data and cold page modules."""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

OUTPUT = Path(__file__).resolve().parent
ROOT = OUTPUT.parent.parent
spec = importlib.util.spec_from_file_location('polish_acceptance', ROOT / 'artifacts/page-polish-20261003/check_ui.py')
polish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(polish)

RECORDER = """() => {
  window.navigationFrames = [];
  window.navigationRecording = true;
  const capture = () => {
    if (!window.navigationRecording) return;
    const rect = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const {x, y, width, height} = element.getBoundingClientRect();
      return {x, y, width, height};
    };
    window.navigationFrames.push({
      scrollY, width: document.documentElement.clientWidth,
      viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
      layoutWidth: document.documentElement.getBoundingClientRect().width,
      height: document.documentElement.scrollHeight,
      header: rect('.research-header'), sidebar: rect('.sidebar'),
      actions: rect('.research-header-actions'), frame: rect('.page-frame'),
      heading: rect('.page-content h1'), headingText: document.querySelector('.page-content h1')?.textContent ?? '',
      loading: !!document.querySelector('.page-loading'),
      activePage: document.querySelector('.nav-item[aria-current="page"]')?.getAttribute('aria-label'),
    });
    requestAnimationFrame(capture);
  };
  requestAnimationFrame(capture);
}"""


def navigation(page, name, scrolled=False):
    if scrolled:
        page.evaluate('window.scrollTo(0, Math.min(300, document.documentElement.scrollHeight - innerHeight))')
        page.wait_for_timeout(100)
    before = page.evaluate('({scrollY, height: document.documentElement.scrollHeight})')
    page.evaluate(RECORDER)
    page.evaluate("name => document.querySelector(`.workspace-navigation button[aria-label=\"${name}\"]`).click()", name)
    expect(page.get_by_role('heading', name=name, exact=True)).to_be_visible(timeout=15000)
    if name in ['技术指标库', '形态库']:
        expect(page.get_by_role('img', name='K线主图叠加指标走势')).to_be_visible(timeout=15000)
    if name == '研报库':
        expect(page.get_by_role('img', name='研报 PDF 第 1 页')).to_be_visible(timeout=15000)
    if name == '资讯库': expect(page.locator('.news-body')).to_be_visible()
    if name == '研究中心': expect(page.get_by_role('heading', name='验收 · 页面与功能打磨', exact=True)).to_be_visible()
    page.wait_for_load_state('networkidle', timeout=15000)
    page.wait_for_timeout(500)
    frames = page.evaluate('() => { window.navigationRecording = false; return window.navigationFrames; }')
    committed = [item for item in frames if item['activePage'] == name]
    def spread(values):
        return round(max(values) - min(values), 2) if values else 0
    result = {
        'page': name, 'scrolled': scrolled, 'before': before,
        'viewport_width_shift': spread([item['width'] for item in frames]),
        'layout_width_shift': spread([item['layoutWidth'] for item in frames]),
        'horizontal_overflow': max(item['documentWidth'] - item['viewportWidth'] for item in frames),
        'header_x_shift': spread([item['header']['x'] for item in frames]),
        'header_width_shift': spread([item['header']['width'] for item in frames]),
        'sidebar_y_shift': spread([item['sidebar']['y'] for item in frames]),
        'header_actions_x_shift': spread([item['actions']['x'] for item in frames]),
        'scroll_y_values': sorted(set(item['scrollY'] for item in frames)),
        'scroll_y_values_after_commit': sorted(set(item['scrollY'] for item in committed)),
        'blank_heading_frames': sum(not item['headingText'] for item in frames),
        'heading_x_shift': spread([item['heading']['x'] for item in frames if item['heading']]),
        'heading_y_shift': spread([item['heading']['y'] for item in frames if item['heading']]),
        'heading_y_shift_after_commit': spread([item['heading']['y'] for item in committed if item['heading']]),
        'document_heights': sorted(set(item['height'] for item in frames)),
    }
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def install_delays(page):
    def delayed(route):
        if route.request.method == 'GET': page.wait_for_timeout(220)
        route.continue_()
    page.route('**/api/v1/**', delayed)
    page.route('**/api/v1/documents/catalog*', lambda route: route.fulfill(status=200, json={'queued': 0}))
    def module(route):
        page.wait_for_timeout(450)
        route.continue_()
    page.route('**/src/pages/*.tsx*', module)


def audit(url, assert_stable=False):
    results, checks, errors = [], [], []
    with sync_playwright() as playwright:
        from apps.api.app import research_workspace
        browser = playwright.chromium.launch(**research_workspace.browser_options(), ignore_default_args=['--hide-scrollbars'])
        for device, width in [('desktop', 1440), ('tablet', 820), ('mobile', 390), ('narrow', 320)]:
            context = browser.new_context(viewport={'width': width, 'height': 900})
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            install_delays(page)
            page.goto(url)
            page.wait_for_timeout(2000)
            for name in ['投研助手', '观察池', '资讯库', '技术指标库', '形态库', '研报库', '研究中心']:
                results.append({'device': device, **navigation(page, name)})
            for name in ['资讯库', '投研助手', '研究中心']:
                results.append({'device': device, **navigation(page, name, scrolled=True)})
            navigation(page, '资讯库')
            page.evaluate('window.scrollTo(0, Math.min(120, document.documentElement.scrollHeight - innerHeight))')
            page.wait_for_timeout(100)
            before = page.evaluate('scrollY')
            page.evaluate("document.querySelector('.nav-item[aria-label=\"资讯库\"]').click()")
            page.wait_for_timeout(500)
            assert page.evaluate('scrollY') == before
            checks.append(f'{device}: same-page-navigation-preserves-reading-position')
            navigation(page, '研报库')
            geometry = """() => {
              const {x, width} = document.querySelector('.research-header').getBoundingClientRect();
              return {x, width};
            }"""
            before = page.evaluate(geometry)
            viewer = page.locator('.pdf-document-viewer')
            viewer.get_by_role('button', name='专注阅读', exact=True).click()
            expect(viewer).to_have_class('pdf-document-viewer expanded')
            assert page.evaluate(geometry) == before
            page.keyboard.press('Escape')
            expect(viewer).to_have_class('pdf-document-viewer')
            assert page.evaluate(geometry) == before
            page.get_by_role('button', name='数据与服务', exact=True).first.click()
            expect(page.get_by_role('dialog', name='数据与服务')).to_be_visible()
            assert page.evaluate(geometry) == before
            page.keyboard.press('Escape')
            expect(page.get_by_role('dialog', name='数据与服务')).to_have_count(0)
            assert page.evaluate(geometry) == before
            checks.append(f'{device}: pdf-focus-and-services-scroll-lock-preserve-shell-width')
            navigation(page, '研究中心')
            page.screenshot(path=str(OUTPUT / f'{device}.png'), full_page=True)
            page.unroute_all(behavior='ignoreErrors')
            context.close()
            # New context keeps the target routes cold for cancellation/racing clicks.
            context = browser.new_context(viewport={'width': width, 'height': 900})
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            install_delays(page)
            page.goto(url)
            expect(page.get_by_role('heading', name='验收 · 页面与功能打磨', exact=True)).to_be_visible(timeout=15000)
            page.evaluate(RECORDER)
            for name in ['观察池', '资讯库', '研究中心']:
                page.evaluate("name => document.querySelector(`.nav-item[aria-label=\"${name}\"]`).click()", name)
                page.wait_for_timeout(80)
            page.wait_for_load_state('networkidle', timeout=15000)
            page.wait_for_timeout(500)
            expect(page.locator('.nav-item[aria-current="page"]')).to_have_attribute('aria-label', '研究中心')
            expect(page.locator('.main-shell')).to_have_attribute('aria-busy', 'false')
            frames = page.evaluate('() => { window.navigationRecording = false; return window.navigationFrames; }')
            assert all(frame['headingText'] for frame in frames)
            checks.append(f'{device}: rapid-cold-navigation-keeps-last-selected-page')
            page.unroute_all(behavior='ignoreErrors')
            context.close()
        browser.close()
    output = {'fixtures': 'isolated synthetic data, delayed GET requests and page modules; no external model calls', 'results': results, 'checks': checks, 'page_errors': errors}
    assert not errors, errors
    if assert_stable:
        for result in results:
            assert result['layout_width_shift'] <= 1, result
            assert result['horizontal_overflow'] <= 1, result
            assert result['header_width_shift'] <= 1, result
            assert result['header_actions_x_shift'] <= 1, result
            assert result['sidebar_y_shift'] <= 1, result
            assert result['scroll_y_values_after_commit'] == [0], result
            assert result['blank_heading_frames'] == 0, result
            assert result['heading_y_shift_after_commit'] <= 1, result
    (OUTPUT / ('validation.json' if assert_stable else 'baseline.json')).write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assert-stable', action='store_true')
    parser.add_argument('--functional-only', action='store_true')
    args = parser.parse_args()
    temporary = ROOT / 'runtime/browser-runs' / uuid4().hex
    temporary.mkdir(parents=True)
    polish.fixtures(temporary)
    api_port, web_port = polish.helpers.free_port(), polish.helpers.free_port()
    env = {**os.environ, 'LLMR_WEB_PORT': str(web_port), 'LLMR_API_PROXY_TARGET': f'http://127.0.0.1:{api_port}'}
    processes = []
    try:
        with (temporary / 'api.log').open('w') as api_log, (temporary / 'web.log').open('w') as web_log:
            flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            api = subprocess.Popen([sys.executable, str(ROOT / 'artifacts/page-polish-20261003/check_ui.py'), '--serve', str(api_port)], cwd=ROOT, env=env, stdout=api_log, stderr=api_log, creationflags=flags)
            processes.append(api)
            polish.helpers.ready(f'http://127.0.0.1:{api_port}/api/v1/health', api)
            web = subprocess.Popen([shutil.which('node'), str(ROOT / 'apps/web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', str(web_port), '--strictPort'], cwd=ROOT / 'apps/web', env=env, stdout=web_log, stderr=web_log, creationflags=flags)
            processes.append(web)
            polish.helpers.ready(f'http://127.0.0.1:{web_port}', web)
            if args.functional_only:
                polish.OUTPUT = OUTPUT
                polish.audit(f'http://127.0.0.1:{web_port}', functional_only=True)
            else:
                audit(f'http://127.0.0.1:{web_port}', args.assert_stable)
    finally:
        for process in reversed(processes):
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)


if __name__ == '__main__': main()
