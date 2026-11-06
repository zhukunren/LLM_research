import { openScreeningDetails } from '../../test/screeningDelivery'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ConversationWorkspace from './ConversationWorkspace'
import type { Conversation, ScreeningTaskRevision } from '../../api'

vi.mock('./ProjectMembership', () => ({ default: () => <span>项目归属</span> }))
const timestamp = '2026-10-04T08:00:00Z'
const screeningWorkspacePromptMarker = '\n\n[选股工作台指令]\n'
const autoExecutionInstruction = '请整理筛选方案；条件完整后请开始筛选并直接返回结果，不等待用户再次确认；有关键条件不明确时先向用户提问。'
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const baseConversation: Conversation = { id: 'screening', task_id: 'task', entry_scope: 'screening', workflow_type: 'screening', research_depth: 'standard', task_revision: 0, active_run_id: null, pending_execution: false, state: 'active', messages: [], turns: [], created_at: timestamp, updated_at: timestamp }
const task: ScreeningTaskRevision = {
  task_id: 'task', revision: 1, original_user_messages: ['收盘价高于20日均线'],
  conditions: [{ condition_id: 'trend', library: 'technical', description: '收盘价高于20日均线', source_quote: '收盘价高于20日均线', expression: {} }],
  references: [{ reference_id: 'trend-ref', condition_id: 'trend', parameter_overrides: {} }], logic_tree: { op: 'condition', reference_id: 'trend-ref' },
  scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: '2026-09-30', report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: null, ranking: null }, unresolved: [],
}

function mockScreening(restored?: Conversation, plan = task, autoExecute = false) {
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
    if (path.endsWith('/process')) return json({ id: 'turn', state: 'succeeded', result: { ready_to_execute: true, execution_authorized: autoExecute } })
    if (path.endsWith('/execute')) {
      stored = { ...stored, active_run_id: 'run', pending_execution: false }
      return json({ run_id: 'run' })
    }
    if (path.endsWith('/screening-runs')) return json({ items: stored.active_run_id ? [{ id: 'run', task_revision: 1, as_of: '2026-09-30', status: 'queued', created_at: timestamp }] : [] })
    if (path === '/conversations/screening') return json(stored)
    if (path.endsWith('/revisions/1')) return json(plan)
    return json({ items: [] })
  }))
  return calls
}

it('lets screening users switch real filter examples and edit a draft without sending a request', async () => {
  const calls = mockScreening()
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  expect(screen.getByRole('button', { name: '生成并筛选' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: '市场机会' })).not.toBeInTheDocument()
  const quickTasks = within(screen.getByRole('group', { name: '常用选股任务' }))
  expect(quickTasks.getAllByRole('button')).toHaveLength(3)
  for (const [label, prompt] of [
    ['趋势选股', '筛选收盘价高于20日均线，且近5个交易日涨幅大于3%的股票。'],
    ['研报选股', '找出研报中出现订单增长实际证据的公司，并列出对应原文。'],
    ['资讯选股', '找出近期有明确业务催化且能定位原始资讯的公司。'],
  ]) {
    await user.click(quickTasks.getByRole('button', { name: label }))
    expect(screen.getByLabelText('选股要求')).toHaveValue(prompt)
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  }
  expect(screen.queryByRole('heading', { name: '看看还能筛什么' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '选股示例' }))
  expect(screen.getByRole('heading', { name: '看看还能筛什么' })).toBeVisible()
  expect(screen.getByText(/暂不筛/)).toBeVisible()
  expect(screen.getByRole('button', { name: '找趋势走强的股票' })).toBeVisible()
  expect(screen.getByLabelText('默认行情日期')).toHaveValue('2026-09-30')
  expect(screen.getByRole('heading', { name: '选股对话' })).toBeVisible()
  expect(screen.queryByRole('navigation', { name: '本次选股进度' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '研报证据' }))
  expect(screen.getByRole('button', { name: '研报证据' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: '找研报里订单已落地的公司' }))
  await user.type(screen.getByLabelText('选股要求'), '，仅看已落地订单')
  expect(screen.getByLabelText('选股要求')).toHaveValue('找出研报中出现订单增长实际证据的公司，并列出对应原文。，仅看已落地订单')
  expect(screen.getByLabelText('选股要求')).toHaveFocus()
  expect(screen.getByRole('button', { name: '生成并筛选' })).toBeEnabled()
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it('carries the selected stock pool and date into the first screening request', async () => {
  const calls = mockScreening()
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.selectOptions(screen.getByLabelText('默认股票范围'), 'focus')
  fireEvent.change(screen.getByLabelText('默认行情日期'), { target: { value: '2026-09-28' } })
  if (screen.getByRole('button', { name: '选股示例' }).getAttribute('aria-expanded') === 'false') await user.click(screen.getByRole('button', { name: '选股示例' }))
  await user.click(screen.getByRole('button', { name: '找趋势走强的股票' }))
  await user.click(screen.getByRole('button', { name: '生成并筛选' }))
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/process'))).toBe(true))
  expect(calls.find(call => call.path === '/conversations' && call.method === 'POST')!.body).toMatchObject({ workflow_type: 'screening' })
  expect(calls.find(call => call.path.endsWith('/messages'))!.body.content).toBe(`筛选收盘价高于20日均线，且近5个交易日涨幅大于3%的股票。${screeningWorkspacePromptMarker}股票范围以界面设置为准：自选分组“重点观察”。\n行情截止日期以界面设置为准：2026-09-28。\n${autoExecutionInstruction}`)
})

it('sends visible defaults and automatically executes a complete plan', async () => {
  const calls = mockScreening(undefined, task, true)
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  if (screen.getByRole('button', { name: '选股示例' }).getAttribute('aria-expanded') === 'false') await user.click(screen.getByRole('button', { name: '选股示例' }))
  await user.click(screen.getByRole('button', { name: '找趋势走强的股票' }))
  await user.click(screen.getByRole('button', { name: '生成并筛选' }))
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/process'))).toBe(true))
  expect(calls.find(call => call.path.endsWith('/messages'))!.body.content).toContain(`${screeningWorkspacePromptMarker}未在要求中明确指定股票范围时，默认使用全部A股。\n未在要求中明确指定截止日期时，默认使用2026-09-30的行情。\n${autoExecutionInstruction}`)
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/execute'))).toBe(true))
})

it('keeps explicit control overrides in the request even when the description has a scope and date', async () => {
  const calls = mockScreening()
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.selectOptions(screen.getByLabelText('默认股票范围'), 'focus')
  fireEvent.change(screen.getByLabelText('默认行情日期'), { target: { value: '2026-09-28' } })
  fireEvent.change(screen.getByLabelText('选股要求'), { target: { value: '范围为600000.SH，截至2026-09-14，收盘价高于20日均线' } })
  await user.click(screen.getByRole('button', { name: '生成并筛选' }))
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/process'))).toBe(true))
  expect(calls.find(call => call.path.endsWith('/messages'))!.body.content).toContain(`${screeningWorkspacePromptMarker}股票范围以界面设置为准：自选分组“重点观察”。\n行情截止日期以界面设置为准：2026-09-28。`)
})

it('does not restore a research conversation passed through the shared initial conversation id', async () => {
  const stored: Conversation = { ...baseConversation, workflow_type: 'research', task_revision: 3, messages: [{ id: 'answer', role: 'assistant', content: '这是一条研究答复', source_refs: [], created_at: timestamp }] }
  const calls = mockScreening(stored)
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="screening" />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  expect(screen.getByRole('button', { name: '生成并筛选' })).toBeInTheDocument()
  expect(screen.queryByText('这是一条研究答复')).not.toBeInTheDocument()
  expect(calls.some(call => call.path === '/conversations/screening')).toBe(false)
  expect(calls.some(call => call.path.endsWith('/revisions/3'))).toBe(false)
})

it('opens saved schemes directly from the new screening entry and closes with Escape', async () => {
  const calls = mockScreening()
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  const reuseButton = screen.getByRole('button', { name: '打开我的方案' })
  await user.click(reuseButton)
  const library = screen.getByRole('dialog', { name: '历史与方案' })
  expect(within(library).getByRole('button', { name: '已保存方案' })).toHaveAttribute('aria-pressed', 'true')
  await waitFor(() => expect(calls.some(call => call.path === '/saved-screening-tasks')).toBe(true))
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: '历史与方案' })).not.toBeInTheDocument()
  expect(reuseButton).toHaveFocus()
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it('keeps restored plans inline, opens details explicitly and restores reading position and draft', async () => {
  vi.stubGlobal('innerWidth', 1280)
  const stored: Conversation = { ...baseConversation, task_revision: 1, messages: [{ id: 'request', role: 'user', content: '收盘价高于20日均线', source_refs: [], created_at: timestamp }], turns: [{ id: 'ready', user_message_id: 'request', base_revision: 0, state: 'succeeded', response_text: '方案已整理', result: { task_revision: 1, ready_to_execute: true }, created_at: timestamp, updated_at: timestamp }] }
  const calls = mockScreening(stored), user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  const card = await screen.findByRole('region', { name: '本次选股进展' })
  const input = screen.getByLabelText('选股要求')
  await waitFor(() => expect(input).toBeEnabled())
  await user.type(input, '增加成交量条件')
  expect(input).toHaveFocus()
  expect(screen.queryByRole('dialog', { name: '筛选方案与结果' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '筛选方案与结果' })).toHaveAttribute('aria-expanded', 'false')
  const log = screen.getByRole('log')
  Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 })
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1200 })
  log.scrollTop = 420; fireEvent.scroll(log)
  const trigger = within(card).getByRole('button', { name: '查看方案' })
  await user.click(trigger)
  const panel = await screen.findByRole('dialog', { name: '筛选方案与结果' })
  expect(panel).toHaveAttribute('aria-modal', 'false')
  expect(within(panel).getByText('我的理解')).toBeVisible()
  expect(within(panel).getByText('系统规则')).toBeVisible()
  log.scrollTop = 33
  await user.click(within(panel).getByRole('button', { name: '关闭筛选方案与结果' }))
  await waitFor(() => expect(log.scrollTop).toBe(420))
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(input).toHaveValue('增加成交量条件')
  expect(screen.getByRole('region', { name: '本次选股进展' })).toBe(card)
  expect(screen.queryByRole('dialog', { name: '筛选方案与结果' })).not.toBeInTheDocument()
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it('previews an edited plan without starting a run', async () => {
  const stored: Conversation = { ...baseConversation, task_revision: 1, messages: [{ id: 'request', role: 'user', content: '收盘价高于20日均线', source_refs: [], created_at: timestamp }], turns: [{ id: 'ready', user_message_id: 'request', base_revision: 0, state: 'succeeded', response_text: '方案已整理', result: { task_revision: 1, ready_to_execute: true }, created_at: timestamp, updated_at: timestamp }] }
  const calls = mockScreening(stored)
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  await openScreeningDetails(user)
  await user.click(screen.getByRole('button', { name: '修改条件' }))
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeVisible())
  await user.type(screen.getByLabelText('选股要求'), '增加成交量条件')
  if (screen.getByRole('button', { name: '选股设置' }).getAttribute('aria-expanded') === 'false') await user.click(screen.getByRole('button', { name: '选股设置' }))
  await user.click(screen.getByRole('button', { name: '只改方案' }))
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/messages'))).toBe(true))
  const content = String(calls.find(call => call.path.endsWith('/messages'))!.body.content)
  expect(content).toContain('更新方案但暂不执行')
  expect(content).not.toContain('更新条件后请开始筛选')
  expect(calls.some(call => call.path.endsWith('/execute'))).toBe(false)
})

it('keeps ranking scope, ties, missing policy and unresolved questions prominent while saving stays secondary', async () => {
  const stored: Conversation = { ...baseConversation, task_revision: 1 }
  const ranked: ScreeningTaskRevision = { ...task, scope: { ...task.scope, as_of: '2026-09-29', ranking: { ranking_universe: 'industry', top_n: 10, ties_policy: 'include_all', missing_policy: 'exclude_with_notice' } }, unresolved: [{ kind: 'ambiguous', source_quote: '行业内排名', question: '使用哪个行业分类？' }] }
  const calls = mockScreening(stored, ranked)
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  expect(await screen.findByText('行业内')).toBeVisible()
  expect(screen.getByText('前 10 名')).toBeVisible()
  expect(screen.getByText('保留全部并列')).toBeVisible()
  expect(screen.getByText('排除缺失并说明')).toBeVisible()
  expect(screen.getByRole('region', { name: '待澄清问题' })).toHaveTextContent('使用哪个行业分类？')
  expect(screen.getByRole('region', { name: '本次选股进展' })).toHaveTextContent('2026-09-29')
  await user.type(screen.getByLabelText('回答：使用哪个行业分类？'), '申万一级行业')
  await user.click(screen.getByRole('button', { name: '补充并继续筛选' }))
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/messages'))).toBe(true))
  const message = String(calls.find(call => call.path.endsWith('/messages'))!.body.content)
  expect(message).toContain('请根据以下回答修改筛选方案')
  expect(message).toContain('申万一级行业')
  expect(message).toContain('更新条件后请开始筛选')
  expect(calls.filter(call => call.path.endsWith('/messages'))).toHaveLength(1)
  expect(screen.queryByRole('dialog', { name: '筛选方案与结果' })).not.toBeInTheDocument()
})

it('shows a failed run read with a reload action instead of an endless loading or zero-match conclusion', async () => {
  const stored = { ...baseConversation, task_revision: 1, active_run_id: 'old-run' }
  let reads = 0
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    if (path === '/conversations') return json({ items: [stored] })
    if (path === '/conversations/screening') return json(stored)
    if (path.endsWith('/revisions/1')) return json(task)
    if (path.endsWith('/screening-runs')) return json({ items: [{ id: 'old-run', task_revision: 1, as_of: '2026-09-30', status: 'succeeded' }] })
    if (path.endsWith('/screening-runs/old-run')) { reads++; return new Response(JSON.stringify({ message: '读取运行中断' }), { status: 503, headers: { 'Content-Type': 'application/json' } }) }
    return json({ items: [] })
  })
  vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="screening" />)
  expect(await screen.findByText('筛选状态暂时无法读取')).toBeVisible()
  expect(screen.queryByText('本次没有找到符合条件的股票')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重新读取状态' }))
  await waitFor(() => expect(reads).toBeGreaterThan(1))
})

it('offers a preview-only path that sends no execution request', async () => {
  const calls = mockScreening()
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.type(screen.getByLabelText('选股要求'), '收盘价高于20日均线')
  if (screen.getByRole('button', { name: '选股设置' }).getAttribute('aria-expanded') === 'false') await user.click(screen.getByRole('button', { name: '选股设置' }))
  await user.click(screen.getByRole('button', { name: '只生成方案' }))
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/messages'))).toBe(true))
  const content = String(calls.find(call => call.path.endsWith('/messages'))!.body.content)
  expect(content).toContain('仅整理筛选方案，暂不执行')
  expect(content).not.toContain('不等待用户再次确认')
  expect(calls.some(call => call.path.endsWith('/execute'))).toBe(false)
})

it('starts a previewed plan explicitly from the inline card with its current revision', async () => {
  const timestamp = '2026-10-04T08:00:00Z'
  const stored: Conversation = {
    ...baseConversation,
    task_revision: 1,
    messages: [{ id: 'request', role: 'user', content: '仅整理筛选方案，暂不执行', source_refs: [], created_at: timestamp }],
    turns: [{ id: 'ready', user_message_id: 'request', base_revision: 0, state: 'succeeded', response_text: '方案已整理', result: { task_revision: 1, ready_to_execute: true, execution_authorized: false }, created_at: timestamp, updated_at: timestamp }],
  }
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path, method, body })
    if (path === '/conversations') return json({ items: [{ ...stored, title: '趋势候选' }] })
    if (path === '/conversations/screening') return json(stored)
    if (path.endsWith('/revisions/1')) return json(task)
    if (path.endsWith('/screening-runs')) return json({ items: [] })
    if (path.endsWith('/execute')) return json({ run_id: 'run' })
    return json({ items: [] })
  }))
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  expect(await screen.findByText('方案已生成，按要求暂不筛选')).toBeVisible()
  const start = await screen.findByRole('button', { name: '开始筛选' })
  await waitFor(() => expect(start).toBeEnabled())
  await user.click(start)
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/execute'))).toBe(true))
  const execute = calls.find(call => call.path.endsWith('/execute'))!
  expect(execute.body).toMatchObject({ action: 'button', revision: 1 })
  expect(typeof execute.body.request_id).toBe('string')
  expect(calls.filter(call => call.path.endsWith('/execute'))).toHaveLength(1)
})

it('keeps one inline card as screening completes and loads decisions only after an explicit click', async () => {
  vi.stubGlobal('innerWidth', 1280)
  let finished = false
  const stored = { ...baseConversation, task_revision: 1, active_run_id: 'latest', messages: [{ id: 'request', role: 'user', content: '趋势选股', source_refs: [], created_at: timestamp }] }
  const calls: { path: string; method: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    calls.push({ path, method: init?.method || 'GET' })
    if (path === '/conversations') return json({ items: [stored] })
    if (path === '/conversations/screening') return json(stored)
    if (path.endsWith('/revisions/1')) return json(task)
    if (path.endsWith('/screening-runs')) return json({ items: [{ id: 'latest', task_revision: 1, as_of: '2026-09-30', status: finished ? 'partial' : 'running' }] })
    if (path.endsWith('/screening-runs/latest')) return json({ id: 'latest', task_revision: 1, as_of: '2026-09-30', status: finished ? 'partial' : 'running', task, job: { state: finished ? 'succeeded' : 'running', progress: finished ? 1 : 0.4, message: finished ? '完成' : '已核对40只股票' }, result: { coverage: finished ? { target_total: 100, true_count: 3, false_count: 95, unknown_count: 2 } : undefined } })
    return json({ items: [], total: 0 })
  }))
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  const card = await screen.findByRole('region', { name: '本次选股进展' })
  await within(card).findByText('正在筛选')
  const input = screen.getByLabelText('选股要求')
  await waitFor(() => expect(input).toBeEnabled())
  await user.type(input, '等待核对后再改条件')
  const log = screen.getByRole('log')
  Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 })
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1200 })
  log.scrollTop = 300; fireEvent.scroll(log)
  finished = true
  await waitFor(() => expect(within(card).getByRole('status')).toHaveTextContent('筛选完成'), { timeout: 3500 })
  expect(screen.getByRole('region', { name: '本次选股进展' })).toBe(card)
  expect(input).toHaveFocus(); expect(input).toHaveValue('等待核对后再改条件')
  expect(log.scrollTop).toBe(300)
  expect(screen.getByRole('button', { name: '筛选结果已就绪' })).toBeVisible()
  expect(screen.queryByRole('dialog', { name: '筛选方案与结果' })).not.toBeInTheDocument()
  expect(calls.some(call => call.path.endsWith('/decisions'))).toBe(false)
  await user.click(within(card).getByRole('button', { name: '查看名单' }))
  const panel = await screen.findByRole('dialog', { name: '筛选方案与结果' })
  expect(within(panel).getByRole('tab', { name: '筛选结果' })).toHaveAttribute('aria-selected', 'true')
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/decisions'))).toBe(true))
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it('submits clarification once and retains the original preview-only execution boundary and unsent draft', async () => {
  const stored: Conversation = { ...baseConversation, task_revision: 1, messages: [{ id: 'preview', role: 'user', content: '仅整理筛选方案，暂不执行', source_refs: [], created_at: timestamp }] }
  const plan = { ...task, unresolved: [{ kind: 'ambiguous' as const, source_quote: '近期', question: '近期指多少个交易日？' }] }
  const calls = mockScreening(stored, plan), user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  await user.type(await screen.findByLabelText('回答：近期指多少个交易日？'), '20个交易日')
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.type(screen.getByLabelText('选股要求'), '排除已知异常记录')
  await user.click(screen.getByRole('button', { name: '补充并更新方案' }))
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/messages'))).toBe(true))
  const message = String(calls.find(call => call.path.endsWith('/messages'))!.body.content)
  expect(message).toContain('20个交易日'); expect(message).toContain('排除已知异常记录')
  expect(message).toContain('更新方案但暂不执行')
  expect(calls.filter(call => call.path.endsWith('/messages'))).toHaveLength(1)
  expect(calls.some(call => call.path.endsWith('/execute'))).toBe(false)
  expect(screen.queryByRole('dialog', { name: '筛选方案与结果' })).not.toBeInTheDocument()
})

it('uses a modal sheet only on a narrow viewport after an explicit request', async () => {
  vi.stubGlobal('innerWidth', 390)
  mockScreening({ ...baseConversation, task_revision: 1 })
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="screening" data={{ available: true, last_date: '2026-09-30' }} />)
  expect(screen.queryByRole('dialog', { name: '筛选方案与结果' })).not.toBeInTheDocument()
  const trigger = await screen.findByRole('button', { name: '查看方案' })
  await user.click(trigger)
  expect(screen.getByRole('dialog', { name: '筛选方案与结果' })).toHaveAttribute('aria-modal', 'true')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(screen.queryByRole('dialog', { name: '筛选方案与结果' })).not.toBeInTheDocument()
})

it('warns about unsupported valuation or industry fields before sending', async () => {
  mockScreening()
  const openData = vi.fn()
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" onOpenDataServices={openData} data={{ available: true, last_date: '2026-09-30' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.type(screen.getByLabelText('选股要求'), '筛选市盈率低于20且行业分类为银行的股票')
  const warning = screen.getByText(/本地选股暂不提供/).closest('p')!
  expect(warning).toBeVisible()
  await user.click(within(warning).getByRole('button', { name: '查看数据与服务' }))
  expect(openData).toHaveBeenCalled()
})
