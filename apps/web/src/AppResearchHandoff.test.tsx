import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeAll, expect, it, vi } from 'vitest'
import App from './App'
import type { Conversation, ConversationTurn, ScreeningTaskRevision } from './api'

vi.mock('./components/PdfReader', () => ({
  default: ({ actions, pageControls }: { actions: ReactNode; pageControls: ReactNode }) => <>{pageControls}{actions}</>,
}))
beforeAll(async () => {
  await Promise.all([import('./pages/ResearchWorkspace'), import('./pages/ScreeningWorkspace'), import('./pages/LibraryWorkspace'), import('./pages/ReportPage')])
}, 20000)

it('screens from the home composer and continues with a revision, an explanation and a saved plan in one conversation', async () => {
  window.history.replaceState(null, '', '#/research/new')
  const date = '2026-11-16', timestamp = `${date}T08:00:00Z`
  const root = '/api/v1/conversations', conversationUrl = `${root}/home-screening`
  const first = '能否帮我筛一下收盘价高于20日均线，近5个交易日涨幅大于3%的股票？'
  const actions = [first, '把涨幅门槛改成5%，日期和其他条件沿用，再筛一次。', '为什么第一只入选？把实际值和门槛都列出来。', '把这套规则保存为「均线走强」。']
  let stored: Conversation = { id: 'home-screening', task_id: 'home-screening', entry_scope: 'screening', workflow_type: 'research', state: 'active', task_revision: 0, active_run_id: null, pending_execution: false, messages: [], turns: [], created_at: timestamp, updated_at: timestamp }
  const writes: { path: string; body: Record<string, unknown> }[] = []
  const batches: { id: string; turn_id: string; task_revision: number; as_of: string; status: string; created_at: string }[] = []
  const plan = (revision: number): ScreeningTaskRevision => ({
    task_id: stored.id, revision, original_user_messages: [first],
    conditions: [{ condition_id: 'trend', library: 'technical', description: `涨幅大于${revision === 1 ? 3 : 5}%`, source_quote: first, expression: {} }],
    references: [{ reference_id: 'ref', condition_id: 'trend', parameter_overrides: {} }], logic_tree: { op: 'condition', reference_id: 'ref' },
    scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: date, report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: null, ranking: null }, unresolved: [],
  })
  const json = (value: unknown) => new Response(JSON.stringify(value))
  function finish(turn: ConversationTurn, answer: string, revision = stored.task_revision) {
    const completed = { ...turn, state: 'succeeded' as const, response_text: answer, result: { task_revision: revision } }
    stored = { ...stored, task_revision: revision, turns: [completed, ...stored.turns.filter(item => item.id !== turn.id)],
      messages: [...stored.messages, { id: `answer-${turn.id}`, role: 'assistant', content: answer, source_refs: [], created_at: timestamp }] }
    return completed
  }
  function batch(turn: ConversationTurn, revision: number) {
    const id = `batch-${revision}`
    batches.unshift({ id, turn_id: turn.id, task_revision: revision, as_of: date, status: 'succeeded', created_at: timestamp })
    stored = { ...stored, active_run_id: id }
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : {}
    if (method === 'POST') writes.push({ path, body })
    if (path === '/api/v1/data/status') return json({ available: true, last_date: date })
    if (path === root) return json(method === 'POST' ? stored : { items: stored.messages.length ? [stored] : [] })
    if (path === conversationUrl) return json(stored)
    if (path === `${conversationUrl}/messages`) {
      const number = writes.filter(write => write.path === path).length
      const turn: ConversationTurn = { id: `turn-${number}`, user_message_id: `message-${number}`, base_revision: stored.task_revision, state: 'awaiting_agent', response_text: null, result: {}, created_at: timestamp, updated_at: timestamp }
      stored = { ...stored, messages: [...stored.messages, { id: turn.user_message_id, role: 'user', content: body.content, source_refs: body.source_refs, created_at: timestamp }], turns: [turn, ...stored.turns] }
      if (number === 1) {
        stored = { ...stored, workflow_type: 'screening' }
        batch(turn, 1)
        return json({ message_id: turn.user_message_id, turn_id: turn.id, state: 'succeeded', workflow_type: 'screening', turn: finish(turn, '第一批名单已生成。', 1) })
      }
      return json({ message_id: turn.user_message_id, turn_id: turn.id, state: 'awaiting_agent', workflow_type: 'screening', source_refs: body.source_refs })
    }
    if (path.endsWith('/process')) {
      const turn = stored.turns[0]
      if (turn.id === 'turn-2') { batch(turn, 2); return json(finish(turn, '按5%门槛重筛完成。', 2)) }
      return json(finish(turn, turn.id === 'turn-3' ? '第一只入选股票的实际涨幅为6%。' : '已保存为「均线走强」。'))
    }
    if (path.includes('/revisions/')) return json(plan(Number(path.split('/').at(-1))))
    if (path.endsWith('/screening-runs')) return json({ items: batches })
    const run = batches.find(item => path.endsWith(`/screening-runs/${item.id}`))
    if (run) return json({ ...run, task: plan(run.task_revision), result: { coverage: { target_total: 2, true_count: 1, false_count: 1, unknown_count: 0 } } })
    if (path.endsWith('/decisions')) return json({ items: [{ stock_code: '600000.SH', state: 'true', condition_decisions: [] }], total: 1 })
    return json({ items: [], queued: 0 })
  }))
  const user = userEvent.setup()
  render(<App />)
  const home = await screen.findByRole('textbox', { name: '研究要求' })
  await waitFor(() => expect(home).toBeEnabled())
  fireEvent.change(home, { target: { value: actions[0] } })
  await user.click(screen.getByRole('button', { name: '发送' }))
  await screen.findByText('第一批名单已生成。')
  expect(window.location.hash).toContain('#/screening/home-screening')
  expect(writes.filter(write => write.path === `${conversationUrl}/messages`)[0].body).toMatchObject({ content: first, route_screening: true })
  expect(writes.some(write => write.path.includes('/turn-1/'))).toBe(false)
  const screening = await screen.findByRole('textbox', { name: '选股要求' })
  const messages = () => writes.filter(write => write.path === `${conversationUrl}/messages`).map(write => write.body)
  for (const [index, label, answer] of [
    [1, '修改并重筛', '按5%门槛重筛完成。'],
    [2, '发送追问', '第一只入选股票的实际涨幅为6%。'],
    [3, '保存方案', '已保存为「均线走强」。'],
  ] as const) {
    await waitFor(() => expect(screening).toBeEnabled())
    if (index === 2) {
      const selector = screen.queryByRole('combobox', { name: '查看筛选运行' })
      if (!selector) await user.click(screen.getByRole('button', { name: '查看名单' }))
      const run = await screen.findByRole('combobox', { name: '查看筛选运行' })
      await waitFor(() => expect(run).toHaveValue('batch-2'))
      await user.selectOptions(run, 'batch-1')
    }
    fireEvent.change(screening, { target: { value: actions[index] } })
    await user.click(screen.getByRole('button', { name: label }))
    await screen.findByText(answer)
  }
  expect(messages()).toHaveLength(4)
  expect(messages()[1]).toMatchObject({ base_revision: 1 })
  expect(messages()[1].content).toContain(actions[1])
  expect(messages()[2]).toMatchObject({ content: actions[2], base_revision: 2, source_refs: [{ kind: 'screening_run', source_id: 'batch-1' }] })
  expect(messages()[3]).toMatchObject({ content: actions[3], base_revision: 2, source_refs: [] })
  expect(writes.filter(write => write.path === root)).toHaveLength(1)
  expect(writes.some(write => write.path.endsWith('/execute'))).toBe(false)
}, 20000)

it('takes the question to the report, adds selected pages to the original draft and carries them to screening', async () => {
  window.history.replaceState(null, '', '#/research/new')
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/v1/data/status') return new Response(JSON.stringify({ available: true, last_date: '2026-11-16' }))
    if (path === '/api/v1/documents') return new Response(JSON.stringify({ items: [
      { id: 'report', title: '订单变化', pages: 5, parse_status: 'indexed', metadata_status: 'succeeded', publication_date: '2026-11-16', stock_code: '000001.SZ' },
    ] }))
    if (init?.method === 'POST' && path !== '/api/v1/documents/catalog') throw new Error('交接不提交消息')
    return new Response(JSON.stringify({ items: [], queued: 0 }))
  })
  vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup(), view = render(<App />)
  const research = await screen.findByRole('textbox', { name: '研究要求' })
  const question = '核对订单变化，先列出可以复用的口径'
  await waitFor(() => expect(research).toBeEnabled())
  fireEvent.change(research, { target: { value: question } })
  await user.click(screen.getByRole('button', { name: /读懂一份研报/ }))
  expect(await screen.findByText(question, { selector: 'summary span' })).toBeVisible()
  const usePage = await screen.findByRole('button', { name: '用此页继续研究' })
  fireEvent.change(screen.getByRole('spinbutton', { name: '研报页码' }), { target: { value: '3' } })
  await user.click(usePage)
  expect(await screen.findByRole('link', { name: '订单变化 · 第3页' })).toHaveAttribute('href', '/api/v1/documents/report/pdf#page=3')
  expect(screen.getByRole('textbox', { name: '研究要求' })).toBe(research)
  expect(research).toHaveValue(question)

  await user.click(screen.getByRole('button', { name: '选研报' }))
  expect(await screen.findByRole('spinbutton', { name: '研报页码' })).toHaveValue(3)
  fireEvent.change(screen.getByRole('spinbutton', { name: '研报页码' }), { target: { value: '4' } })
  await user.click(screen.getByRole('button', { name: '带此页去选股' }))
  const screening = await screen.findByRole('textbox', { name: '选股要求' }, { timeout: 6000 })
  await waitFor(() => expect(screening).toHaveValue(question))
  expect(screen.getByRole('link', { name: '订单变化 · 第3页' })).toBeVisible()
  expect(screen.getByRole('link', { name: '订单变化 · 第4页' })).toBeVisible()
  expect(screen.getByRole('button', { name: '只生成方案' })).toBeEnabled()
  view.unmount()
  render(<App />)
  const restored = await screen.findByRole('textbox', { name: '选股要求' }, { timeout: 6000 })
  await waitFor(() => expect(restored).toHaveValue(question))
  expect(screen.getByRole('link', { name: '订单变化 · 第4页' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: '返回研报' }))
  expect(await screen.findByRole('spinbutton', { name: '研报页码' })).toHaveValue(4)
  await user.click(screen.getByRole('button', { name: '返回原问题' }))
  expect(await screen.findByRole('textbox', { name: '研究要求' })).toHaveValue(question)
  expect(screen.queryByRole('link', { name: '订单变化 · 第4页' })).not.toBeInTheDocument()
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').every(([path]) => String(path).endsWith('/documents/catalog'))).toBe(true)
}, 20000)
