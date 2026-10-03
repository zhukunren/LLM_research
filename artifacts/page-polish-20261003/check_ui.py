"""Seven-page functional and responsive acceptance against synthetic local data."""
from __future__ import annotations
import argparse
from datetime import date, datetime, timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from threading import Thread
import time
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

OUTPUT = Path(__file__).resolve().parent
ROOT = OUTPUT.parent.parent
spec = importlib.util.spec_from_file_location('previous_acceptance', ROOT / 'artifacts/research-projects-20261003/check_ui.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def configure():
    from apps.api.app import main, condition_language, pattern_language, market, screening_execution
    original = market.cached_profile
    market.cached_profile = lambda: {**original(), 'price_basis': 'forward_adjusted', 'volume_unit': 'shares', 'amount_unit': 'CNY'}
    previous = main.llm_settings
    def local_settings():
        return {**previous(), 'configured': False}
    main.llm_settings = condition_language.llm_settings = pattern_language.llm_settings = local_settings
    def evaluate(condition, reference, code, as_of):
        time.sleep(.02)
        state = 'true' if code == '600000.SH' else 'false' if code == '600519.SH' else 'unknown'
        return {'stock_code': code, 'condition_id': condition['condition_id'], 'reference_id': reference['reference_id'], 'state': state, 'evaluation_status': 'completed', 'reason_code': 'data_missing' if state == 'unknown' else 'condition_met' if state == 'true' else 'condition_not_met', 'explanation': '合成验收条件判断', 'data_as_of': as_of}
    screening_execution.evaluate_reference = evaluate
    from fastapi.responses import JSONResponse
    from apps.api.app import conversation_store, db, research_workspace
    from apps.api.app.screening_contracts import ScreeningTaskRevision
    @main.app.middleware('http')
    async def fixture_agent(request, next_handler):
        path = request.url.path
        if request.method == 'POST' and path.startswith('/api/v1/conversations/') and path.endswith('/process'):
            pieces = path.split('/')
            cid, tid = pieces[4], pieces[6]
            turn = conversation_store.get_turn(cid, tid)
            message = conversation_store.get_user_message(cid, turn['user_message_id'])
            text = message['content']
            conversation_store.start_turn(cid, tid)
            revision = turn['base_revision']
            if '均线' in text:
                task = ScreeningTaskRevision.model_validate({'task_id': cid, 'revision': revision + 1, 'original_user_messages': [text], 'conditions': [{'condition_id': 'c', 'library': 'technical', 'source_quote': text, 'description': '收盘价高于20日均线', 'expression': {'op': 'indicator_compare', 'window': 20}}], 'references': [{'reference_id': 'r', 'condition_id': 'c'}], 'logic_tree': {'op': 'condition', 'reference_id': 'r'}, 'scope': {'universe': {'kind': 'all_a_shares'}, 'as_of': main.market.cached_profile()['last_date']}, 'unresolved': []})
                conversation_store.save_task_revision(cid, revision, message['id'], task)
                revision += 1
                answer = '已整理合成验收方案：收盘价高于20日均线。可保存或确认筛选。'
            else:
                answer = '## 合成研究答复\n\n已读取测试材料。\n\n| 公司 | 需要核验 |\n| --- | --- |\n| 验收公司甲 | 现金流与收入 |\n\n这里只验证研究交互，不表达实际投资判断。'
            conversation_store.finish_turn(cid, tid, revision, 'succeeded', answer, {'runtime': 'fixture', 'ready_to_execute': False})
            return JSONResponse(conversation_store.get_turn(cid, tid), status_code=200)
        return await next_handler(request)
    return main


def fixtures(temporary):
    data = temporary / 'source'
    (data / 'stock_data').mkdir(parents=True)
    os.environ['LLMR_DB_PATH'] = str(temporary / 'app.db')
    os.environ['LLMR_DATA_ROOT'] = str(data)
    import pyarrow as pa
    import pyarrow.parquet as pq
    rows = []
    dates = []
    day = date(2026, 6, 1)
    while len(dates) < 100:
        if day.weekday() < 5: dates.append(day)
        day += timedelta(days=1)
    for code in ['600000.SH', '600519.SH', '000001.SZ']:
        for index, day in enumerate(dates):
            close = 10 + index / 10
            rows.append({'stock_code': code, 'trade_date': datetime.combine(day, datetime.min.time()), 'open': close - .1, 'high': close + .5, 'low': close - .5, 'close': close, 'volume': 1000., 'amount': 1000 * close})
    pq.write_table(pa.Table.from_pylist(rows), data / 'stock_data/stock_daily.parquet')
    index_bars = [{**row, 'trade_date': row['trade_date'].date().isoformat(), 'quality_valid': True} for row in rows if row['stock_code'] == '600000.SH']
    (data / 'market_index').mkdir()
    (data / 'market_index/000001.SH.json').write_text(json.dumps({'requested_start': '1900-01-01', 'requested_end': '2100-01-01', 'bars': index_bars}), encoding='utf-8')
    main = configure()
    from apps.api.app import db, research_projects, conversation_store, news_sources, saved_screening_tasks, observation_api, worker
    from apps.api.app.screening_contracts import ScreeningTaskRevision
    db.init_db()
    with db.connect() as connection:
        for code, name, pinyin in [('600000.SH', '验收公司甲', 'yshgsj'), ('600519.SH', '验收公司乙', 'yshgsy'), ('000001.SZ', '验收公司丙', 'yshgsb')]:
            connection.execute('INSERT INTO security_catalog VALUES(?,?,?,?,?,?)', (code, name, pinyin, pinyin, code[-2:], db.utc_now()))
    project = research_projects.create_project(research_projects.CreateProject(name='验收 · 页面与功能打磨', objective='全部数据为合成验收资料，验证页面交互与业务状态。', request_id='project'))
    research_projects.add_company(project['id'], '600000.SH')
    research_projects.create_note(project['id'], research_projects.CreateNote(title='验收研究笔记', body='## 研究问题\n\n仅验证交互，不表达实际投资判断。', stock_code='600000.SH', request_id='note'))
    for number in range(25):
        news_sources.import_items(news_sources.NewsImport(request_id=f'news-{number}', items=[news_sources.NewsItemInput(title=f'合成资讯 {number:02d} · 回购资料', body=f'这是第{number}条合成资讯。公司公告包含回购事项，需要核对具体金额和进展。', source='验收合成资料', stock_codes=['600000.SH'], available_at='2026-09-10T10:00:00+08:00')]))
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    writer = PdfWriter()
    for number in (1, 2):
        page = writer.add_blank_page(width=595, height=842)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        stream = DecodedStreamObject(); stream.set_data(f'BT /F1 16 Tf 40 760 Td (Synthetic research report - page {number}) Tj ET'.encode())
        page[NameObject('/Contents')] = writer._add_object(stream)
    pdf = temporary / 'synthetic.pdf'; writer.write(pdf)
    with db.connect() as connection:
        connection.execute("""INSERT INTO documents(id,sha256,filename,title,stock_code,stock_code_status,available_at,available_at_status,pages,extracted_chars,parse_status,source_path,imported_at,metadata_status)
          VALUES('report',?,'synthetic.pdf','合成研报 · 经营与回购','600000.SH','confirmed','2026-09-10','confirmed',2,100,'indexed',?,'2026-09-10','ready')""", (hashlib.sha256(pdf.read_bytes()).hexdigest(), str(pdf)))
        for number in (1, 2):
            text = f'这是第{number}页合成研报，公司披露回购事项，仅用于检索与阅读验收。'
            connection.execute('INSERT INTO document_pages VALUES(?,?,?)', ('report', number, text))
            connection.execute('INSERT INTO document_pages_fts VALUES(?,?,?)', ('report', number, text))
    task = ScreeningTaskRevision.model_validate({'task_id': 'seed', 'revision': 1, 'original_user_messages': ['验收价格条件'], 'conditions': [{'condition_id': 'c', 'library': 'technical', 'source_quote': '验收价格条件', 'description': '收盘价高于20日均线', 'expression': {'op': 'indicator_compare', 'window': 20}}], 'references': [{'reference_id': 'r', 'condition_id': 'c'}], 'logic_tree': {'op': 'condition', 'reference_id': 'r'}, 'scope': {'universe': {'kind': 'all_a_shares'}, 'as_of': dates[30].isoformat()}, 'unresolved': []})
    saved = saved_screening_tasks.save_task(task, name='验收 · 趋势观察方案')
    queued = observation_api.execute_saved(saved['id'], observation_api.ExecuteSaved(request_id='seed-execute', version=1, as_of=dates[30]))
    worker.execute_job(queued['job_id'])
    from apps.api.app.models import PatternInput
    main.save_pattern(PatternInput(name='验收 · 上升趋势', input_type='drawing', representation='price_path', target_bars=20, points=[i / 19 for i in range(20)], params={'min_similarity': 80}))
    return project, dates


PAGES = [('research', '研究中心'), ('assistant', '投研助手'), ('observation', '观察池'), ('news', '资讯库'), ('technical', '技术指标库'), ('patterns', '形态库'), ('reports', '研报库')]


def navigate(page, name):
    page.get_by_role('navigation', name='主菜单').get_by_role('button', name=name, exact=True).click()
    expect(page.get_by_role('heading', name=name, exact=True)).to_be_visible()


def functional(browser, url, errors):
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/api/v1/documents/catalog*', lambda route: route.fulfill(status=200, json={'queued': 0}))
    page.goto(url)
    checks = []
    page.get_by_role('button', name='新建项目', exact=True).click()
    page.get_by_label('项目名称', exact=True).fill('验收 · 项目输入保留')
    page.get_by_label('研究目标', exact=True).fill('验证关闭、刷新和保存后的数据归属。')
    page.get_by_role('button', name='关闭编辑', exact=True).click()
    page.get_by_role('button', name='新建项目', exact=True).click()
    expect(page.get_by_label('项目名称', exact=True)).to_have_value('验收 · 项目输入保留')
    page.get_by_role('button', name='保存项目', exact=True).click()
    expect(page.get_by_role('heading', name='验收 · 项目输入保留', exact=True)).to_be_visible()
    page.get_by_role('button', name='编辑项目', exact=True).click()
    page.get_by_label('项目名称', exact=True).fill('验收 · 项目刷新后继续编辑')
    page.get_by_role('button', name='刷新研究中心', exact=True).click()
    expect(page.get_by_label('项目名称', exact=True)).to_have_value('验收 · 项目刷新后继续编辑')
    expect(page.get_by_role('heading', name='编辑项目', exact=True)).to_be_visible()
    page.get_by_role('button', name='保存项目', exact=True).click()
    expect(page.get_by_role('heading', name='验收 · 项目刷新后继续编辑', exact=True)).to_be_visible()
    tabs = page.get_by_role('tablist', name='项目内容')
    tabs.get_by_role('tab').first.focus(); page.keyboard.press('End')
    expect(tabs.get_by_role('tab', name='研究成果', exact=False)).to_have_attribute('aria-selected', 'true')
    page.keyboard.press('Home')
    checks.append('project-draft-close-refresh-save-and-keyboard-tabs')
    page.get_by_role('button', name='开始研究', exact=True).click()
    expect(page.get_by_role('heading', name='投研助手', exact=True)).to_be_visible()
    page.get_by_role('textbox', name='研究要求', exact=True).fill('比较合成验收资料，先不筛选。')
    page.locator('.conversation-composer button[type="submit"]').click()
    expect(page.get_by_role('heading', name='合成研究答复', exact=True)).to_be_visible(timeout=20000)
    expect(page.get_by_role('cell', name='验收公司甲', exact=True)).to_be_visible()
    page.get_by_role('button', name='保存为研究笔记', exact=True).click()
    expect(page.get_by_role('status').filter(has_text='答复已保存')).to_be_visible()
    page.get_by_role('button', name='深度研究', exact=True).click()
    expect(page.get_by_role('button', name='深度研究', exact=True)).to_have_attribute('aria-pressed', 'true')
    page.get_by_role('button', name='新研究', exact=True).click()
    expect(page.get_by_text('今天想研究什么？', exact=True)).to_be_visible()
    checks.append('assistant-send-markdown-project-note-mode-and-new-research')
    navigate(page, '观察池')
    page.get_by_role('tab', name='选股', exact=True).focus(); page.keyboard.press('ArrowRight')
    expect(page.get_by_role('tab', name='观察池', exact=True)).to_have_attribute('aria-selected', 'true')
    expect(page.get_by_label('观察备注', exact=True)).to_be_visible(timeout=15000)
    page.get_by_label('观察备注', exact=True).fill('验收：切页后保留尚未保存的观察备注。')
    navigate(page, '研究中心'); navigate(page, '观察池')
    expect(page.get_by_role('tab', name='观察池', exact=True)).to_have_attribute('aria-selected', 'true')
    expect(page.get_by_label('观察备注', exact=True)).to_have_value('验收：切页后保留尚未保存的观察备注。')
    page.get_by_role('button', name='保存观察记录', exact=True).click()
    expect(page.get_by_role('status').filter(has_text='观察记录已保存')).to_be_visible()
    checks.append('observation-keyboard-tab-draft-navigation-and-save')
    navigate(page, '资讯库')
    expect(page.locator('.news-body')).to_be_visible()
    expect(page.get_by_label('当前资讯字号')).to_have_text('14')
    page.get_by_role('button', name='放大资讯字体').click()
    expect(page.get_by_label('当前资讯字号')).to_have_text('15')
    page.get_by_role('textbox', name='搜索资讯').fill('不存在的验收短语')
    expect(page.get_by_text('没有找到符合筛选条件的资讯。', exact=True)).to_be_visible()
    page.get_by_role('button', name='清除资讯搜索').click()
    expect(page.locator('.local-news-list button')).to_have_count(20)
    page.get_by_role('button', name='下一页', exact=True).click()
    expect(page.locator('.local-news-list button')).to_have_count(5)
    page.get_by_role('button', name='上一页', exact=True).click()
    checks.append('news-reading-font-search-clear-and-pagination')
    navigate(page, '技术指标库')
    expect(page.get_by_role('img', name='K线主图叠加指标走势')).to_be_visible()
    page.get_by_role('button', name='相对强弱指标', exact=False).click()
    expect(page.get_by_role('img', name='K线主图和指标副图走势')).to_be_visible()
    chart = page.get_by_role('img', name='K线主图和指标副图走势')
    chart.focus(); page.keyboard.press('Home')
    expect(page.locator('.indicator-hover-values')).to_be_visible()
    tabs = page.get_by_role('tablist', name='技术指标库功能')
    tabs.get_by_role('tab', name='创建条件', exact=True).click()
    page.get_by_role('textbox', name='选股条件描述', exact=True).fill('收盘价高于20日均线')
    page.get_by_role('button', name='生成条件', exact=True).click()
    expect(page.get_by_role('button', name='确认并保存 1 个条件', exact=True)).to_be_visible(timeout=15000)
    page.get_by_role('button', name='试算看看', exact=True).click()
    expect(page.locator('.trial-result')).to_be_visible()
    page.get_by_role('button', name='确认并保存 1 个条件', exact=True).click()
    expect(page.get_by_text('条件已保存，可随时在“我的条件”中复用', exact=True)).to_be_visible()
    tabs.get_by_role('tab', name='独立条件库', exact=True).click()
    expect(page.get_by_role('button', name='查看与调整', exact=True)).to_be_visible()
    page.get_by_role('button', name='查看与调整', exact=True).click()
    inspector = page.locator('.condition-inspector')
    expect(inspector).to_be_visible()
    inspector.get_by_role('textbox').first.fill('验收 · 修改后的均线条件')
    inspector.get_by_role('button', name='保存为新版本', exact=True).click()
    expect(page.get_by_role('heading', name='验收 · 修改后的均线条件', exact=True).first).to_be_visible()
    inspector.get_by_role('button', name='将此版本加入组合', exact=True).click()
    page.get_by_role('button', name='查看组合', exact=False).click()
    expect(page.get_by_role('heading', name='组合你的选股条件', exact=True)).to_be_visible()
    page.get_by_label('组合名称', exact=True).fill('验收 · 已调整条件的组合')
    page.get_by_role('button', name='保存组合', exact=True).click()
    expect(page.get_by_role('status').filter(has_text='保存')).to_be_visible()
    checks.append('technical-indicator-chart-keyboard-condition-generate-preview-save-library')
    checks.append('condition-revision-and-cross-library-composition-save')
    navigate(page, '形态库')
    page.get_by_role('tab', name='描述需求', exact=True).click()
    page.get_by_label('形态需求描述', exact=True).fill('近30个交易日的双底形态，相似度不低于85%')
    page.get_by_role('button', name='生成形态草稿', exact=True).click()
    expect(page.get_by_role('button', name='确认并保存形态', exact=True)).to_be_visible(timeout=15000)
    navigate(page, '资讯库'); navigate(page, '形态库')
    expect(page.get_by_role('tab', name='描述需求', exact=True)).to_have_attribute('aria-selected', 'true')
    expect(page.get_by_label('形态需求描述', exact=True)).to_have_value('近30个交易日的双底形态，相似度不低于85%')
    page.get_by_role('button', name='确认并保存形态', exact=True).click()
    expect(page.get_by_role('status').filter(has_text='已保存')).to_be_visible()
    page.get_by_role('tab', name='我的形态', exact=True).click()
    expect(page.locator('.saved-condition-card')).to_have_count(2)
    checks.append('pattern-local-draft-navigation-restore-save-and-gallery')
    navigate(page, '研报库')
    expect(page.get_by_role('img', name='研报 PDF 第 1 页')).to_be_visible(timeout=15000)
    viewer = page.locator('.pdf-document-viewer')
    viewer.get_by_role('button', name='下一页', exact=True).click()
    expect(page.get_by_role('img', name='研报 PDF 第 2 页')).to_be_visible()
    viewer.get_by_label('PDF 显示比例').select_option('page')
    expect(viewer.get_by_role('button', name='缩小 PDF')).to_be_enabled()
    before = viewer.locator('canvas').evaluate('canvas => canvas.getBoundingClientRect().width')
    viewer.get_by_role('button', name='缩小 PDF').click()
    expect(viewer.get_by_role('button', name='缩小 PDF')).to_be_enabled()
    after = viewer.locator('canvas').evaluate('canvas => canvas.getBoundingClientRect().width')
    assert after < before, (before, after)
    viewer.get_by_role('button', name='专注阅读', exact=True).click()
    expect(viewer).to_have_class('pdf-document-viewer expanded')
    page.keyboard.press('Escape')
    expect(viewer).to_have_class('pdf-document-viewer')
    checks.append('reports-real-pdf-page-fit-relative-zoom-and-focus-reading')
    page.get_by_role('button', name='数据与服务', exact=True).first.click()
    expect(page.get_by_role('dialog', name='数据与服务')).to_be_visible()
    page.get_by_role('button', name='检查助手连接', exact=True).click()
    expect(page.get_by_text('智能助手尚未配置，请联系维护者完成首次设置。', exact=True)).to_be_visible()
    with page.expect_download() as download:
        page.get_by_role('button', name='保存诊断信息', exact=True).click()
    assert download.value.suggested_filename == '投研工作台-诊断信息.txt'
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog', name='数据与服务')).to_have_count(0)
    checks.append('services-connection-state-diagnostics-download-and-escape')
    context.close()
    return checks


def audit(url, functional_only=False, layouts_only=False):
    checks, layouts, errors = [], [], []
    with sync_playwright() as playwright:
        from apps.api.app import research_workspace
        browser = playwright.chromium.launch(**research_workspace.browser_options())
        for device, width in ([] if functional_only else [('desktop', 1440), ('tablet', 820), ('mobile', 390), ('narrow', 320)]):
            context = browser.new_context(viewport={'width': width, 'height': 1000})
            page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/api/v1/documents/catalog*', lambda route: route.fulfill(status=200, json={'queued': 0}))
            page.goto(url)
            for key, name in PAGES:
                navigate(page, name)
                if key == 'technical': expect(page.get_by_role('img', name='K线主图叠加指标走势')).to_be_visible(timeout=15000)
                if key == 'reports': expect(page.get_by_role('img', name='研报 PDF 第 1 页')).to_be_visible(timeout=15000)
                if key == 'patterns': expect(page.get_by_role('img', name='K线主图叠加指标走势')).to_be_visible(timeout=15000)
                if key in ['news', 'technical', 'reports']:
                    tabs = page.get_by_role('tablist', name=name + '功能')
                    tabs.get_by_role('tab').first.focus(); page.keyboard.press('ArrowRight')
                    expect(tabs.get_by_role('tab', name='独立条件库')).to_have_attribute('aria-selected', 'true')
                    page.keyboard.press('Home')
                if key == 'patterns':
                    tabs = page.get_by_role('tablist', name='形态库功能')
                    tabs.get_by_role('tab').first.focus(); page.keyboard.press('ArrowRight')
                    expect(page.get_by_label('形态需求描述')).to_be_visible()
                    page.keyboard.press('Home')
                if key == 'technical':
                    expect(page.get_by_role('img', name='K线主图叠加指标走势')).to_be_visible(timeout=15000)
                    expect(page.locator('.indicator-catalog button').first).to_be_visible()
                if key == 'news': expect(page.locator('.news-body')).to_be_visible()
                if key == 'reports': expect(page.get_by_role('img', name='研报 PDF 第 1 页')).to_be_visible(timeout=15000)
                if key == 'patterns': expect(page.get_by_role('img', name='K线主图叠加指标走势')).to_be_visible(timeout=15000)
                if key == 'observation': expect(page.locator('.observation-table-scroll tbody tr').first).to_be_visible()
                layout = helpers.dimensions(page)
                assert layout['document'] <= width + 1, (device, key, layout)
                assert not layout['clippedButtons'], (device, key, layout)
                layouts.append({'device': device, 'page': key, **layout})
                if device in ['desktop', 'mobile']:
                    page.evaluate('window.scrollTo(0,0); document.activeElement?.blur()')
                    page.screenshot(path=str(OUTPUT / f'{device}-{key}.png'), full_page=True)
                print(f'PASS {device} {name}', flush=True)
            context.close()
        if not layouts_only: checks.extend(functional(browser, url, errors))
        browser.close()
    assert not errors, errors
    result = {'fixtures': 'synthetic isolated database, local parsers; no external provider calls', 'layouts': layouts, 'checks': checks, 'page_errors': errors}
    (OUTPUT / ('functional.json' if functional_only else 'validation.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--serve', type=int); parser.add_argument('--functional-only', action='store_true'); parser.add_argument('--layouts-only', action='store_true'); args = parser.parse_args()
    if args.serve:
        app = configure().app
        from apps.api.app import worker
        def consume():
            while True:
                worker.execute_job(exclude_kinds=('research_turn', 'report_catalog', 'maintenance'))
                time.sleep(.2)
        Thread(target=consume, daemon=True).start()
        import uvicorn
        uvicorn.run(app, host='127.0.0.1', port=args.serve, log_level='warning')
        return
    temporary = ROOT / 'runtime/browser-runs' / uuid4().hex
    temporary.mkdir(parents=True); fixtures(temporary)
    api_port, web_port = helpers.free_port(), helpers.free_port()
    env = {**os.environ, 'LLMR_WEB_PORT': str(web_port), 'LLMR_API_PROXY_TARGET': f'http://127.0.0.1:{api_port}'}
    processes = []
    try:
        with (temporary / 'api.log').open('w') as api_log, (temporary / 'web.log').open('w') as web_log:
            flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            api = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--serve', str(api_port)], cwd=ROOT, env=env, stdout=api_log, stderr=api_log, creationflags=flags); processes.append(api)
            helpers.ready(f'http://127.0.0.1:{api_port}/api/v1/health', api)
            web = subprocess.Popen([shutil.which('node'), str(ROOT / 'apps/web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', str(web_port), '--strictPort'], cwd=ROOT / 'apps/web', env=env, stdout=web_log, stderr=web_log, creationflags=flags); processes.append(web)
            helpers.ready(f'http://127.0.0.1:{web_port}', web)
            audit(f'http://127.0.0.1:{web_port}', args.functional_only, args.layouts_only)
    finally:
        for process in reversed(processes):
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)

if __name__ == '__main__': main()
