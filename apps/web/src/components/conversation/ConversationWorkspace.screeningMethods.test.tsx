import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { Conversation, ScreeningTaskRevision } from '../../api'
import ConversationWorkspace from './ConversationWorkspace'

const timestamp = '2026-10-20T08:00:00Z'
const template = { id: 'above_sma', version: 1, name: '收盘价在均线上方', formula: '收盘价 > SMA(N)', parameters: { window: { label: '均线周期 N', default: 20, min: 2, max: 250, step: 1 } } }
const task: ScreeningTaskRevision = { task_id: 'shared', revision: 3, original_user_messages: ['保留回购条件'], conditions: [{ condition_id: 'news-1', library: 'news', source_quote: '有实际回购', description: '有实际回购', expression: {} }], references: [{ reference_id: 'news-ref', condition_id: 'news-1', parameter_overrides: {} }], logic_tree: { op: 'condition', reference_id: 'news-ref' }, scope: { as_of: '2026-10-15', universe: { kind: 'watchlist', watchlist_id: 'watch-1', stock_codes: [] }, news_lookback_calendar_days: 30, report_lookback_calendar_days: null, price_basis: 'unadjusted', ranking: null }, unresolved: [] }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

it('offers all four methods on the new-screening page and sends reuse to the shared plan center', async () => {
  const calls = mock(), user = userEvent.setup(), choose = vi.fn(), saved = vi.fn()
  render(<ConversationWorkspace initialWorkflowType="screening" initialNewDraft shellNavigation onScreeningMethod={choose} onScreeningSaved={saved} data={{ available: true, last_date: '2026-10-20' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  const methods = within(screen.getByRole('region', { name: '选择选股方式' }))
  for (const [label, id] of [['技术选股', 'technical'], ['形态选股', 'pattern'], ['资讯选股', 'news'], ['研报选股', 'report']]) {
    await user.click(methods.getByRole('button', { name: new RegExp(label) }))
    expect(choose).toHaveBeenLastCalledWith(id)
  }
  expect(methods.queryByRole('button', { name: /条件组合/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '打开我的方案' }))
  expect(saved).toHaveBeenCalledOnce()
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
    if (url.pathname === '/api/v1/screening-templates') return json({ items: [template] })
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

it('adds a different source to the same plan without discarding a pending request or the original source', async () => {
  const calls = mock(true), user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialScope="news" initialConversationId="shared" initialSource={{ reference: { kind: 'news_item', source_id: 'news-source' }, label: '回购公告原文' }} data={{ available: true, last_date: '2026-10-20' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.type(screen.getByLabelText('选股要求'), '保留原来的回购要求')
  await user.click(await screen.findByRole('button', { name: '叠加条件' }))
  const drawer = screen.getByRole('dialog', { name: '叠加选股条件' })
  await user.click(within(drawer).getByRole('button', { name: '形态选股' }))
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
