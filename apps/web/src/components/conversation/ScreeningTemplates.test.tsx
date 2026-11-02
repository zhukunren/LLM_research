import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ScreeningTemplates from './ScreeningTemplates'
import ConversationWorkspace from './ConversationWorkspace'
import type { Conversation, ScreeningTaskRevision } from '../../api'

const template = { id: 'above_sma', version: 1, name: '收盘价在均线上方', formula: '收盘价 > 最近 N 个交易日均价（含当日）', parameters: { window: { label: '均线周期 N', default: 20, min: 2, max: 250, step: 1 } } }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

it('previews an AND combination as text and sends all edited parameters', async () => {
  const combined = { id: 'trend_momentum', version: 1, name: '趋势走强', formula: '收盘价高于{ma_window}日均线 且 近{return_window}日涨幅大于{threshold}%',
    rules: ['收盘价高于{ma_window}日均线', '近{return_window}日涨幅大于{threshold}%'], parameters: {
      ma_window: { label: '均线周期', default: 20, min: 2, max: 250, step: 1 },
      return_window: { label: '回看周期', default: 5, min: 1, max: 250, step: 1 },
      threshold: { label: '涨幅阈值', default: 3, min: -100, max: 1000, step: 0.1 },
    } }
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [combined] })))
  const selected = vi.fn()
  const { container } = render(<ScreeningTemplates disabled={false} onSelect={selected} />)
  await userEvent.click(await screen.findByRole('button', { name: '选择基础方案：趋势走强' }))
  expect(container.querySelector('.screening-template-sketch')).toBeNull()
  expect(container.querySelectorAll('.screening-template-preview-rules li')).toHaveLength(2)
  expect(screen.getByText(/以上条件需同时满足/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('趋势走强：涨幅阈值'), { target: { value: '6' } })
  expect(screen.getByText('近5日涨幅大于6%')).toBeInTheDocument()
  expect(selected).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '生成并筛选：趋势走强' }))
  expect(selected).toHaveBeenCalledWith(combined, { ma_window: 20, return_window: 5, threshold: 6 })
})
async function openStarter() {
  if (screen.queryByLabelText('选股要求')) {
    const examples = await screen.findByRole('button', { name: '选股示例' })
    if (examples.getAttribute('aria-expanded') === 'false') await userEvent.click(examples)
  }
  const button = await screen.findByRole('button', { name: '选择基础方案：收盘价高于20日均线' })
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
}

it('uses text-only starter cards with exact labels and a reversible preview before selecting', async () => {
  const returns = { id: 'return_above', version: 1, name: '区间涨幅', formula: '区间收益率 > 阈值', parameters: { window: { label: '交易日 N', default: 20, min: 2, max: 250, step: 1 }, threshold: { label: '涨幅阈值', default: 10, min: 0, max: 100, step: 0.1 } } }
  const cross = { id: 'ma_cross', version: 1, name: '均线上穿', formula: '当日短均线 > 长均线，前日短均线 ≤ 长均线', parameters: { fast: { label: '短周期', default: 5, min: 2, max: 250, step: 1 }, slow: { label: '长周期', default: 20, min: 2, max: 250, step: 1 } } }
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [template, returns, cross] })))
  const selected = vi.fn()
  render(<ScreeningTemplates disabled={false} onSelect={selected} />)
  const priceCard = await screen.findByRole('button', { name: '选择基础方案：收盘价高于20日均线' })
  const returnCard = screen.getByRole('button', { name: '选择基础方案：近20日涨幅大于10%' })
  const crossCard = screen.getByRole('button', { name: '选择基础方案：5日均线上穿20日均线' })
  for (const card of [priceCard, returnCard, crossCard]) {
    expect(card).toHaveAttribute('aria-expanded', 'false')
    expect(card).toHaveAccessibleDescription('每组条件需同时满足。选择后可调整参数，提交即自动筛选。')
    expect(card.querySelector('.screening-template-sketch')).toBeNull()
    expect(card.querySelector('.screening-template-chevron')).toHaveAttribute('aria-hidden', 'true')
  }
  priceCard.focus()
  await userEvent.keyboard('{Enter}')
  expect(priceCard).toHaveAttribute('aria-expanded', 'true')
  expect(priceCard).toHaveAttribute('aria-controls', screen.getByRole('article', { name: '基础方案预览' }).id)
  expect(selected).not.toHaveBeenCalled()
  await userEvent.click(crossCard)
  expect(priceCard).toHaveAttribute('aria-expanded', 'false')
  expect(priceCard).not.toHaveAttribute('aria-controls')
  expect(crossCard).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('heading', { name: '5日均线上穿20日均线' })).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('均线上穿：短周期'), { target: { value: '20' } })
  expect(screen.getByRole('button', { name: '生成并筛选：均线上穿' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('均线上穿：短周期'), { target: { value: '5' } })
  await userEvent.click(screen.getByRole('button', { name: '生成并筛选：均线上穿' }))
  expect(selected).toHaveBeenCalledWith(cross, { fast: 5, slow: 20 })
  await userEvent.click(crossCard)
  expect(screen.queryByRole('article', { name: '基础方案预览' })).not.toBeInTheDocument()
  expect(crossCard).toHaveAttribute('aria-expanded', 'false')
})

it('keeps starter cards and the selected preview disabled while a request is pending', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [template] })))
  const selected = vi.fn()
  const view = render(<ScreeningTemplates disabled={false} onSelect={selected} />)
  await openStarter()
  view.rerender(<ScreeningTemplates disabled onSelect={selected} />)
  expect(screen.getByRole('button', { name: '选择基础方案：收盘价高于20日均线' })).toBeDisabled()
  expect(screen.getByLabelText('收盘价在均线上方：均线周期 N')).toBeDisabled()
  expect(screen.getByRole('button', { name: '生成并筛选：收盘价在均线上方' })).toBeDisabled()
  expect(selected).not.toHaveBeenCalled()
})

it('shows exact formula, validates edits and sends numbers without model parsing', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [template] })))
  const selected = vi.fn()
  render(<ScreeningTemplates disabled={false} onSelect={selected} />)
  await openStarter()
  const input = await screen.findByLabelText('收盘价在均线上方：均线周期 N')
  expect(screen.getByText(template.formula)).not.toBeVisible()
  await userEvent.click(screen.getByText('公式与说明'))
  expect(screen.getByText(template.formula)).toBeVisible()
  expect(input.closest('details')).not.toHaveAttribute('open')
  await userEvent.click(screen.getByText('调整参数'))
  expect(input).toBeVisible()
  fireEvent.change(input, { target: { value: '0' } })
  expect(screen.getByRole('button', { name: '生成并筛选：收盘价在均线上方' })).toBeDisabled()
  fireEvent.change(input, { target: { value: '10' } })
  await userEvent.click(screen.getByRole('button', { name: '生成并筛选：收盘价在均线上方' }))
  expect(selected).toHaveBeenCalledWith(template, { window: 10 })
})

it('recovers catalog errors without hiding free-text fallback', async () => {
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async () => ++reads === 1 ? json({ message: 'unavailable' }, 503) : json({ items: [template] })))
  render(<ScreeningTemplates disabled={false} onSelect={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name: '重试读取基础方案' }))
  await openStarter()
  expect(await screen.findByRole('button', { name: '生成并筛选：收盘价在均线上方' })).toBeEnabled()
})

it('publishes an atomic template plan, retries stable identity, and resumes automatic execution', async () => {
  const timestamp = '2026-09-30T08:00:00Z'
  let current: Conversation = { id: 'quickstart', task_id: 'quickstart', entry_scope: 'screening', workflow_type: 'screening', research_depth: 'standard', task_revision: 0, active_run_id: null, pending_execution: false, state: 'active', messages: [], turns: [], created_at: timestamp, updated_at: timestamp }
  const task: ScreeningTaskRevision = { task_id: 'quickstart', revision: 1, original_user_messages: ['基础方案'], conditions: [{ condition_id: 'starter', library: 'technical', description: '收盘价 > SMA(10)', source_quote: '基础方案', expression: {} }], references: [{ reference_id: 'ref', condition_id: 'starter', parameter_overrides: {} }], logic_tree: { op: 'condition', reference_id: 'ref' }, scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: '2026-09-30', report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: 'unknown', ranking: null }, unresolved: [] }
  const calls: { path: string; body: Record<string, unknown> }[] = []
  const attempts: Record<string, unknown>[] = []
  let creates = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path, body })
    if (path === '/screening-templates') return json({ items: [template] })
    if (path === '/conversations') { if (init?.method === 'POST') { creates++; return json(current) }; return json({ items: [] }) }
    if (path.endsWith('/screening-templates/above_sma')) {
      attempts.push(body)
      if (attempts.length === 1) return json({ message: '连接中断' }, 503)
      current = { ...current, task_revision: 1, pending_execution: true, messages: [{ id: 'user', role: 'user', content: '基础方案', source_refs: [], created_at: timestamp }, { id: 'answer', role: 'assistant', content: '已生成基础方案，正在自动筛选。', source_refs: [], created_at: timestamp }], turns: [{ id: 'turn', user_message_id: 'user', base_revision: 0, state: 'succeeded', response_text: '已生成基础方案，正在自动筛选。', result: { intent: 'template', task_revision: 1, execution_authorized: true, ready_to_execute: true }, created_at: timestamp, updated_at: timestamp }] }
      return json({ revision: 1, task })
    }
    if (path === '/conversations/quickstart') return json(current)
    if (path.endsWith('/revisions/1')) return json(task)
    return json({ items: [] })
  }))
  render(<ConversationWorkspace initialWorkflowType="screening" initialNewDraft data={{ available: true, last_date: '2026-09-30' }} />)
  await openStarter()
  const button = await screen.findByRole('button', { name: '生成并筛选：收盘价在均线上方' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.change(screen.getByLabelText('收盘价在均线上方：均线周期 N'), { target: { value: '10' } })
  await userEvent.click(button)
  await screen.findByText(/基础方案尚未完成：连接中断/)
  await userEvent.click(button)
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/execute'))).toBe(true))
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])
  expect(attempts[0]).toMatchObject({ parameters: { window: 10 }, base_revision: 0, as_of: '2026-09-30' })
  expect(creates).toBe(1)
  expect(calls.filter(call => call.path.endsWith('/execute'))).toHaveLength(1)
})

it('does not reclaim the screen when a template finishes after navigation to research', async () => {
  let finish: (value: Response) => void = () => {}
  let started = false
  const result = new Promise<Response>(resolve => { finish = resolve })
  const location = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    if (path === '/screening-templates') return json({ items: [template] })
    if (path === '/conversations' && init?.method === 'POST') return json({ id: 'old-screen', task_revision: 0 })
    if (path.endsWith('/screening-templates/above_sma')) { started = true; return result }
    return json({ items: [] })
  }))
  const view = render(<ConversationWorkspace initialWorkflowType="screening" initialNewDraft data={{ available: true, last_date: '2026-09-30' }} onLocationChange={location} />)
  await openStarter()
  const button = await screen.findByRole('button', { name: '生成并筛选：收盘价在均线上方' })
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
  await waitFor(() => expect(started).toBe(true))
  view.rerender(<ConversationWorkspace initialWorkflowType="research" initialNewDraft data={{ available: true, last_date: '2026-09-30' }} onLocationChange={location} />)
  finish(json({ revision: 1, task: {} }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(location.mock.calls.some(call => call[0] === 'old-screen')).toBe(false)
  expect(screen.queryByRole('button', { name: '确认并开始筛选' })).not.toBeInTheDocument()
})

it('ignores an old template response when a new empty screening draft is requested', async () => {
  let finish: (value: Response) => void = () => {}
  let started = false
  const result = new Promise<Response>(resolve => { finish = resolve })
  const location = vi.fn()
  const consumed = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    if (path === '/screening-templates') return json({ items: [template] })
    if (path === '/conversations' && init?.method === 'POST') return json({ id: 'previous-draft', task_revision: 0 })
    if (path.endsWith('/screening-templates/above_sma')) { started = true; return result }
    return json({ items: [] })
  }))
  const props = { initialWorkflowType: 'screening' as const, initialNewDraft: true, data: { available: true, last_date: '2026-09-30' }, onLocationChange: location, onNewResearchConsumed: consumed }
  const view = render(<ConversationWorkspace {...props} newResearchKey={0} />)
  await openStarter()
  const button = await screen.findByRole('button', { name: '生成并筛选：收盘价在均线上方' })
  await waitFor(() => expect(button).toBeEnabled())
  await userEvent.click(button)
  await waitFor(() => expect(started).toBe(true))
  view.rerender(<ConversationWorkspace {...props} newResearchKey={2} />)
  finish(json({ revision: 1, task: {} }))
  await waitFor(() => expect(consumed).toHaveBeenCalled())
  view.rerender(<ConversationWorkspace {...props} newResearchKey={0} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  expect(location.mock.calls.some(call => call[0] === 'previous-draft')).toBe(false)
  await userEvent.click(await screen.findByRole('button', { name: '选股示例' }))
  expect(screen.getByRole('button', { name: '选择基础方案：收盘价高于20日均线' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: '确认并开始筛选' })).not.toBeInTheDocument()
})
