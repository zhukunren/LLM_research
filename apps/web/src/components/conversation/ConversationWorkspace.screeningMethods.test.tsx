import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { Conversation, ScreeningTaskRevision } from '../../api'
import ConversationWorkspace from './ConversationWorkspace'

const timestamp = '2026-10-20T08:00:00Z'
const template = { id: 'above_sma', version: 1, name: '收盘价在均线上方', formula: '收盘价 > SMA(N)', parameters: { window: { label: '均线周期 N', default: 20, min: 2, max: 250, step: 1 } } }
const industryTemplate = { id: 'industry_valuation', version: 1, name: '行业估值与成交额', formula: '比较同行市盈率及成交额', requires_industry: true,
  parameters: { amount_window: { label: '成交额窗口（交易日）', default: 20, min: 1, max: 60, step: 1 }, min_daily_amount_yi: { label: '日均成交额下限（亿元）', default: .5, min: 0, max: 1000, step: .01 } } }
const task: ScreeningTaskRevision = { task_id: 'shared', revision: 3, original_user_messages: ['保留回购条件'], conditions: [{ condition_id: 'news-1', library: 'news', source_quote: '有实际回购', description: '有实际回购', expression: {} }], references: [{ reference_id: 'news-ref', condition_id: 'news-1', parameter_overrides: {} }], logic_tree: { op: 'condition', reference_id: 'news-ref' }, scope: { as_of: '2026-10-15', universe: { kind: 'watchlist', watchlist_id: 'watch-1', stock_codes: [] }, news_lookback_calendar_days: 30, report_lookback_calendar_days: null, price_basis: 'unadjusted', ranking: null }, unresolved: [] }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

it('uses a single plan picker on the new-screening page and keeps plan management separate', async () => {
  const calls = mock(), choose = vi.fn(), saved = vi.fn()
  render(<ConversationWorkspace initialWorkflowType="screening" initialNewDraft shellNavigation onScreeningMethod={choose} onScreeningSaved={saved} data={{ available: true, last_date: '2026-10-20' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  expect(screen.queryByRole('region', { name: '选择选股方式' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '引用方案' })).toBeInTheDocument()
  expect(choose).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '管理方案' })).not.toBeInTheDocument()
  expect(saved).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog', { name: '历史与方案' })).not.toBeInTheDocument()
  expect(calls.creations).toHaveLength(0)
  expect(calls.messages).toHaveLength(0)
  expect(calls.templates).toHaveLength(0)
})

function mock(existing = false) {
  const messages: Record<string, unknown>[] = [], creations: Record<string, unknown>[] = [], templates: Record<string, unknown>[] = []
  let stored: Conversation = { id: 'shared', task_id: 'shared', entry_scope: existing ? 'news' : 'report', workflow_type: 'screening', task_revision: existing ? 3 : 0, active_run_id: null, pending_execution: false, state: 'active', messages: existing ? [{ id: 'original', role: 'user', content: '保留回购条件', source_refs: [], created_at: timestamp }] : [], turns: [], created_at: timestamp, updated_at: timestamp }
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost'), method = init?.method || 'GET', body = init?.body ? JSON.parse(String(init.body)) : {}
    if (url.pathname === '/api/v1/conversations' && method === 'POST') { creations.push(body); stored = { ...stored, entry_scope: body.entry_scope }; return json(stored) }
    if (url.pathname === '/api/v1/conversations') return json({ items: existing ? [stored] : [] })
    if (url.pathname === '/api/v1/conversations/shared') return json(stored)
    if (url.pathname.endsWith('/revisions/3')) return json(task)
    if (url.pathname === '/api/v1/watchlists') return json({ items: [{ id: 'watch-1', name: '重点公司' }] })
    if (url.pathname === '/api/v1/screening-templates') return json({ items: url.searchParams.get('include_industry') === 'true' ? [template, industryTemplate] : [template] })
    if (url.pathname === '/api/v1/screening-industries') return json({ items: [{ code: '801081.SI', name: '半导体', level: 2 }] })
    if (url.pathname.endsWith('/screening-templates/industry_valuation/preview')) return json({ stock_code: body.stock_code, requested_as_of: body.as_of, actual_date: body.as_of, state: 'true', details: [{ name: industryTemplate.name, state: 'true', note: '核对日期 2026-10-20 · 市盈率（TTM）18 倍 · 日均成交额 2 亿元' }], chart: { bars: [] } })
    if (url.pathname.endsWith('/screening-templates/industry_valuation')) { templates.push(body); return json({ task }) }
    if (url.pathname.endsWith('/screening-templates/above_sma/preview')) return json({ stock_code: body.stock_code, requested_as_of: body.as_of, actual_date: body.as_of, state: 'true', details: [], chart: { bars: [] } })
    if (url.pathname.endsWith('/screening-templates/above_sma')) { templates.push(body); stored = { ...stored, task_revision: 3, messages: [{ id: 'template-message', role: 'user', content: '固定规则已提交', source_refs: [], created_at: timestamp }] }; return json({ task }) }
    if (url.pathname === '/api/v1/patterns') return json({ items: [{ id: 'shape-a', version: 2, name: '双底目标', params: { min_similarity: 88, match_mode: 'recent', recent_bars: 20 } }] })
    if (url.pathname.endsWith('/messages')) {
      messages.push(body)
      stored = { ...stored, messages: [...stored.messages, { id: `new-${messages.length}`, role: 'user', content: body.content, source_refs: body.source_refs, created_at: timestamp }] }
      return json({ message_id: `new-${messages.length}`, turn_id: 'turn-new', state: 'succeeded', base_revision: stored.task_revision, source_refs: body.source_refs })
    }
    return json({ items: [] })
  })
  vi.stubGlobal('fetch', fetcher)
  return { messages, creations, templates, fetcher }
}

it('submits the report form through the shared conversation with its scope, evidence policy and review-only intent', async () => {
  const calls = mock(), user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialScope="report" screeningMethod="report" initialNewDraft data={{ available: true, last_date: '2026-10-20' }} />)
  await waitFor(() => expect(screen.getByLabelText('专用选股要求')).toBeEnabled())
  await user.type(screen.getByLabelText('专用选股要求'), '订单实际增长')
  fireEvent.change(screen.getByLabelText('研报发布窗口天数'), { target: { value: '90' } })
  await user.selectOptions(screen.getByLabelText('选股股票范围'), 'watch-1')
  fireEvent.change(screen.getByLabelText('选股截止日期'), { target: { value: '2026-10-15' } })
  expect(calls.creations).toHaveLength(0)
  await user.click(screen.getByRole('button', { name: '只生成方案' }))
  await waitFor(() => expect(calls.messages).toHaveLength(1))
  expect(calls.creations[0]).toMatchObject({ entry_scope: 'report', workflow_type: 'screening' })
  expect(calls.messages[0]).toMatchObject({ base_revision: 0, source_refs: [] })
  expect(calls.messages[0].content).toContain('近 90 个自然日')
  expect(calls.messages[0].content).toContain('已发生事实与实际经营数据')
  expect(calls.messages[0].content).toContain('股票范围以界面设置为准：自选分组“重点公司”')
  expect(calls.messages[0].content).toContain('行情截止日期以界面设置为准：2026-10-15')
  expect(calls.messages[0].content).toContain('仅整理筛选方案，暂不执行')
  expect(calls.fetcher.mock.calls.some(([url, init]) => String(url).endsWith('/execute') && init?.method === 'POST')).toBe(false)
})

it('publishes deterministic technical parameters with the selected universe through the existing template API', async () => {
  const calls = mock(), user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialScope="technical" screeningMethod="technical" initialNewDraft data={{ available: true, last_date: '2026-10-20' }} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '开始筛选' })).toBeEnabled())
  fireEvent.change(screen.getByLabelText('均线周期 N'), { target: { value: '35' } })
  await user.selectOptions(screen.getByLabelText('选股股票范围'), 'watch-1')
  await user.click(screen.getByRole('button', { name: '开始筛选' }))
  await waitFor(() => expect(calls.templates).toHaveLength(1))
  expect(calls.templates[0]).toMatchObject({ parameters: { window: 35 }, as_of: '2026-10-20', universe: { kind: 'watchlist', watchlist_id: 'watch-1' } })
  expect(calls.creations[0]).toMatchObject({ entry_scope: 'technical', workflow_type: 'screening' })
  expect(calls.messages).toHaveLength(0)
})

it('tries a fixed rule and starts a separate run without consuming the dialogue draft', async () => {
  const calls = mock(), user = userEvent.setup(), onOpenConversation = vi.fn()
  render(<ConversationWorkspace initialWorkflowType="screening" initialNewDraft initialPrompt="原对话草稿继续保留" fixedRulesOpen onCloseFixedRules={vi.fn()}
    onOpenConversation={onOpenConversation} data={{ available: true, last_date: '2026-10-20' }} />)
  const tools = within(await screen.findByRole('dialog', { name: '固定规则与试算' }))
  const tryRule = tools.getByRole('button', { name: '试算规则' })
  await waitFor(() => expect(tryRule).toBeEnabled())
  fireEvent.change(tools.getByLabelText('均线周期 N'), { target: { value: '35' } })
  fireEvent.change(tools.getByLabelText('固定规则截止日期'), { target: { value: '2026-10-15' } })
  await user.selectOptions(tools.getByLabelText('固定规则股票范围'), 'watch-1')
  await user.click(tryRule)
  await tools.findByText('符合', { selector: 'strong' })
  expect(calls.creations).toHaveLength(0)
  expect(calls.templates).toHaveLength(0)
  await user.click(tools.getByRole('button', { name: '按固定规则筛选' }))
  await waitFor(() => expect(onOpenConversation).toHaveBeenCalledWith('shared', 'screening', 'screening'))
  expect(calls.creations[0]).toMatchObject({ request_id: expect.any(String), entry_scope: 'screening' })
  expect(calls.templates[0]).toMatchObject({ parameters: { window: 35 }, as_of: '2026-10-15', universe: { kind: 'watchlist', watchlist_id: 'watch-1' } })
  expect(calls.messages).toHaveLength(0)
  expect(screen.getByLabelText('选股要求')).toHaveValue('原对话草稿继续保留')
})

it('passes the same industry, valuation and turnover inputs to preview and formal screening', async () => {
  const calls = mock(), user = userEvent.setup(), onOpenConversation = vi.fn()
  const close = vi.fn()
  const view = render(<ConversationWorkspace initialWorkflowType="screening" initialNewDraft fixedRulesOpen onCloseFixedRules={close}
    onOpenConversation={onOpenConversation} />)
  const drawer = within(await screen.findByRole('dialog', { name: '固定规则与试算' }))
  await user.click(await drawer.findByRole('button', { name: '行业估值与成交额' }))
  const run = drawer.getByRole('button', { name: '按固定规则筛选' })
  expect(run).toBeDisabled()
  await user.type(await drawer.findByLabelText('搜索行业'), '半导体')
  await user.selectOptions(drawer.getByLabelText('申万行业'), '801081.SI')
  await user.selectOptions(drawer.getByLabelText('估值条件'), 'below_industry_median')
  fireEvent.change(drawer.getByLabelText('日均成交额下限（亿元）'), { target: { value: '1.25' } })
  expect(run).toBeDisabled()
  view.rerender(<ConversationWorkspace initialWorkflowType="screening" initialNewDraft fixedRulesOpen onCloseFixedRules={close}
    onOpenConversation={onOpenConversation} data={{ available: true, last_date: '2026-10-20' }} />)
  expect(drawer.getByLabelText('固定规则截止日期')).toHaveValue('2026-10-20')
  await user.click(drawer.getByRole('button', { name: '试算规则' }))
  expect(await drawer.findByText(/核对日期 2026-10-20.*日均成交额 2 亿元/)).toBeVisible()
  const previewCall = calls.fetcher.mock.calls.find(([url]) => String(url).endsWith('/industry_valuation/preview'))
  const selection = { as_of: '2026-10-20', parameters: { amount_window: 20, min_daily_amount_yi: 1.25 },
    industry: { industry_code: '801081.SI', pe_comparison: 'below_industry_median' } }
  expect(JSON.parse(String(previewCall?.[1]?.body))).toMatchObject(selection)
  await user.click(run)
  await waitFor(() => expect(onOpenConversation).toHaveBeenCalledWith('shared', 'screening', 'screening'))
  expect(calls.templates[0]).toMatchObject(selection)
})

it('adds news and report settings through one materials group on the current plan', async () => {
  const calls = mock(true), user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialScope="news" initialConversationId="shared" data={{ available: true, last_date: '2026-10-20' }} />)
  async function openMaterials() {
    await user.click(await screen.findByRole('button', { name: '查看方案' }))
    const summary = within(await screen.findByRole('region', { name: '资料条件' }))
    expect(summary.getByText('资讯 · 1 条 · 近 30 个自然日')).toBeVisible()
    await user.click(summary.getByRole('button', { name: '添加资料条件' }))
    return within(screen.getByRole('dialog', { name: '添加资料条件' }))
  }
  let fields = await openMaterials()
  await user.selectOptions(fields.getByLabelText('资料来源'), 'report')
  fireEvent.change(fields.getByLabelText('研报发布窗口天数'), { target: { value: '90' } })
  await user.selectOptions(fields.getByLabelText('研报证据口径'), 'separate')
  await user.type(fields.getByLabelText('新增判断要求'), '核对实际订单与预期订单')
  await user.click(fields.getByRole('button', { name: '加入待发送要求' }))
  fields = await openMaterials()
  fireEvent.change(fields.getByLabelText('资讯发布窗口天数'), { target: { value: '15' } })
  await user.type(fields.getByLabelText('新增判断要求'), '有实际实施回购的公告')
  await user.click(fields.getByRole('button', { name: '加入待发送要求' }))
  expect(calls.messages).toHaveLength(0)
  await user.click(screen.getByRole('button', { name: '只改方案' }))
  await waitFor(() => expect(calls.messages).toHaveLength(1))
  expect(calls.messages[0]).toMatchObject({ base_revision: 3 })
  expect(calls.messages[0].content).toContain('研报窗口：截至 2026-10-15的近 90 个自然日')
  expect(calls.messages[0].content).toContain('分别核对事实与预测')
  expect(calls.messages[0].content).toContain('资讯窗口：截至 2026-10-15的近 15 个自然日')
  expect(calls.messages[0].content).toContain('更新方案但暂不执行')
})

it('adds a different source to the same plan without discarding a pending request or the original source', async () => {
  const calls = mock(true), user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialScope="news" initialConversationId="shared" initialSource={{ reference: { kind: 'news_item', source_id: 'news-source' }, label: '回购公告原文' }} data={{ available: true, last_date: '2026-10-20' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.type(screen.getByLabelText('选股要求'), '保留原来的回购要求')
  await user.click(await screen.findByRole('button', { name: '叠加条件' }))
  const drawer = screen.getByRole('dialog', { name: '叠加选股条件' })
  await user.click(within(drawer).getByRole('button', { name: '已保存形态' }))
  await within(drawer).findByRole('option', { name: '双底目标 · v2' })
  await user.selectOptions(within(drawer).getByLabelText('叠加的形态模板'), 'shape-a@2')
  await user.click(within(drawer).getByRole('button', { name: '加入待发送要求' }))
  expect(calls.messages).toHaveLength(0)
  expect((screen.getByLabelText('选股要求') as HTMLTextAreaElement).value).toContain('保留原来的回购要求')
  expect((screen.getByLabelText('选股要求') as HTMLTextAreaElement).value).toContain('保留已有条件及参数、原组合关系、股票范围和截止日期')
  await user.click(screen.getByRole('button', { name: '修改并重筛' }))
  await waitFor(() => expect(calls.messages).toHaveLength(1))
  expect(calls.creations).toHaveLength(0)
  expect(calls.messages[0]).toMatchObject({ base_revision: 3, source_refs: [{ kind: 'news_item', source_id: 'news-source' }, { kind: 'pattern', source_id: 'shape-a', version: 2 }] })
  expect(task.scope.as_of).toBe('2026-10-15')
})
