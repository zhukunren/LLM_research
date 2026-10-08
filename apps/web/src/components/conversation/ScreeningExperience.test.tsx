import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ConversationWorkspace from './ConversationWorkspace'
import type { Conversation, ScreeningTaskRevision } from '../../api'

vi.mock('./ProjectMembership', () => ({ default: () => <span>项目归属</span> }))
const timestamp = '2026-10-04T08:00:00Z'
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const baseConversation: Conversation = { id: 'screening', task_id: 'task', entry_scope: 'screening', workflow_type: 'screening', research_depth: 'standard', task_revision: 0, active_run_id: null, pending_execution: false, state: 'active', messages: [], turns: [], created_at: timestamp, updated_at: timestamp }
const task: ScreeningTaskRevision = {
  task_id: 'task', revision: 1, original_user_messages: ['收盘价高于20日均线'],
  conditions: [{ condition_id: 'trend', library: 'technical', description: '收盘价高于20日均线', source_quote: '收盘价高于20日均线', expression: {} }],
  references: [{ reference_id: 'trend-ref', condition_id: 'trend', parameter_overrides: {} }], logic_tree: { op: 'condition', reference_id: 'trend-ref' },
  scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: '2026-09-30', report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: null, ranking: null }, unresolved: [],
}

function mockScreening(restored?: Conversation) {
  let stored = restored ?? { ...baseConversation }
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path, method, body })
    if (path === '/watchlists') return json({ items: [{ id: 'focus', name: '重点观察' }] })
    if (path === '/conversations') return json(method === 'POST' ? stored : { items: restored ? [{ ...restored, title: '趋势候选' }] : [] })
    if (path.endsWith('/messages')) {
      stored = { ...stored, messages: [{ id: 'request', role: 'user', content: String(body.content), source_refs: [], created_at: timestamp }] }
      return json({ message_id: 'request', turn_id: 'turn', state: 'awaiting_agent' })
    }
    if (path.endsWith('/process')) return json({ id: 'turn', state: 'succeeded', result: { ready_to_execute: true, execution_authorized: false } })
    if (path === '/conversations/screening') return json(stored)
    if (path.endsWith('/revisions/1')) return json(task)
    return json({ items: [] })
  }))
  return calls
}

it('lets screening users switch real filter examples and edit a draft without sending a request', async () => {
  const calls = mockScreening()
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  expect(screen.getByRole('button', { name: '生成筛选方案' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: '市场机会' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('默认行情日期')).toHaveValue('2026-09-30')
  const progress = screen.getByRole('navigation', { name: '本次选股进度' })
  expect(within(progress).getByRole('button', { name: /描述条件/ })).toHaveAttribute('aria-current', 'step')
  expect(within(progress).getByRole('button', { name: /查看结果/ })).toBeDisabled()
  await user.click(screen.getByText('更多条件示例（需要模型解析）'))
  await user.click(screen.getByRole('button', { name: '研报证据' }))
  expect(screen.getByRole('button', { name: '研报证据' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: '订单证据' }))
  await user.type(screen.getByLabelText('选股要求'), '，仅看已落地订单')
  expect(screen.getByLabelText('选股要求')).toHaveValue('找出研报中出现订单增长实际证据的公司，并列出对应原文。，仅看已落地订单')
  expect(screen.getByLabelText('选股要求')).toHaveFocus()
  expect(screen.getByRole('button', { name: '生成筛选方案' })).toBeEnabled()
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it('carries the selected stock pool and date into the first screening request', async () => {
  const calls = mockScreening()
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.selectOptions(screen.getByLabelText('默认股票范围'), 'focus')
  fireEvent.change(screen.getByLabelText('默认行情日期'), { target: { value: '2026-09-28' } })
  await user.click(screen.getByText('更多条件示例（需要模型解析）'))
  await user.click(screen.getByRole('button', { name: '均线上方且上涨' }))
  await user.click(screen.getByRole('button', { name: '生成筛选方案' }))
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/process'))).toBe(true))
  expect(calls.find(call => call.path === '/conversations' && call.method === 'POST')!.body).toMatchObject({ workflow_type: 'screening' })
  expect(calls.find(call => call.path.endsWith('/messages'))!.body.content).toBe('筛选收盘价高于20日均线，且近5个交易日涨幅大于3%的股票。\n股票范围以界面设置为准：自选分组“重点观察”。行情截止日期以界面设置为准：2026-09-28。请先整理筛选方案，本次不要执行筛选。')
  expect(calls.some(call => call.path.endsWith('/execute'))).toBe(false)
})

it('sends visible defaults and requests a plan before executing when controls are untouched', async () => {
  const calls = mockScreening()
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.click(screen.getByText('更多条件示例（需要模型解析）'))
  await user.click(screen.getByRole('button', { name: '均线上方且上涨' }))
  await user.click(screen.getByRole('button', { name: '生成筛选方案' }))
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/process'))).toBe(true))
  expect(calls.find(call => call.path.endsWith('/messages'))!.body.content).toContain('未在要求中明确指定股票范围时，默认使用全部A股。未在要求中明确指定截止日期时，默认使用2026-09-30的行情。请先整理筛选方案，本次不要执行筛选。')
  expect(calls.some(call => call.path.endsWith('/execute'))).toBe(false)
})

it('keeps explicit control overrides in the request even when the description has a scope and date', async () => {
  const calls = mockScreening()
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.selectOptions(screen.getByLabelText('默认股票范围'), 'focus')
  fireEvent.change(screen.getByLabelText('默认行情日期'), { target: { value: '2026-09-28' } })
  fireEvent.change(screen.getByLabelText('选股要求'), { target: { value: '范围为600000.SH，截至2026-09-14，收盘价高于20日均线' } })
  await user.click(screen.getByRole('button', { name: '生成筛选方案' }))
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/process'))).toBe(true))
  expect(calls.find(call => call.path.endsWith('/messages'))!.body.content).toContain('股票范围以界面设置为准：自选分组“重点观察”。行情截止日期以界面设置为准：2026-09-28。')
})

it('does not restore a research conversation passed through the shared initial conversation id', async () => {
  const stored: Conversation = { ...baseConversation, workflow_type: 'research', task_revision: 3, messages: [{ id: 'answer', role: 'assistant', content: '这是一条研究答复', source_refs: [], created_at: timestamp }] }
  const calls = mockScreening(stored)
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="screening" />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  expect(screen.getByRole('button', { name: '生成筛选方案' })).toBeInTheDocument()
  expect(screen.queryByText('这是一条研究答复')).not.toBeInTheDocument()
  expect(calls.some(call => call.path === '/conversations/screening')).toBe(false)
  expect(calls.some(call => call.path.endsWith('/revisions/3'))).toBe(false)
})

it('opens saved schemes directly from the new screening entry and closes with Escape', async () => {
  const calls = mockScreening()
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  const reuseButton = screen.getByRole('button', { name: '复用已保存方案' })
  await user.click(reuseButton)
  const library = screen.getByRole('dialog', { name: '历史与方案' })
  expect(within(library).getByRole('button', { name: '已保存方案' })).toHaveAttribute('aria-pressed', 'true')
  await waitFor(() => expect(calls.some(call => call.path === '/saved-screening-tasks')).toBe(true))
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: '历史与方案' })).not.toBeInTheDocument()
  expect(reuseButton).toHaveFocus()
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it('restores the confirmation phase and keeps execution unavailable while edits are unsent', async () => {
  const stored: Conversation = { ...baseConversation, task_revision: 1, messages: [{ id: 'request', role: 'user', content: '收盘价高于20日均线', source_refs: [], created_at: timestamp }], turns: [{ id: 'ready', user_message_id: 'request', base_revision: 0, state: 'succeeded', response_text: '方案已整理', result: { task_revision: 1, ready_to_execute: true }, created_at: timestamp, updated_at: timestamp }] }
  const calls = mockScreening(stored)
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  const execute = await screen.findByRole('button', { name: '确认并开始筛选' })
  await waitFor(() => expect(execute).toBeEnabled())
  expect(screen.getByRole('button', { name: /确认方案$/ })).toHaveAttribute('aria-current', 'step')
  expect(screen.getByText('条件就绪')).toBeInTheDocument()
  await user.type(screen.getByLabelText('选股要求'), '增加成交量条件')
  expect(execute).toBeDisabled()
  expect(screen.getByRole('button', { name: '发送修改' })).toBeEnabled()
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})
