import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { Conversation } from '../../api'
import { SecuritiesProvider } from '../StockSearch'
import ConversationWorkspace from './ConversationWorkspace'
vi.mock('./CompanyReportsPanel', () => ({ default: ({ stockCode }: { stockCode: string }) => <section>研报公司 {stockCode}</section> }))
vi.mock('./CompanyNewsPanel', () => ({ default: ({ stockCode }: { stockCode: string }) => <section>资讯公司 {stockCode}</section> }))
vi.mock('./CompanyMarketPanel', () => ({ default: ({ stockCode }: { stockCode: string }) => <section>行情公司 {stockCode}</section> }))

vi.mock('../CompanyFinancialsPanel', () => ({ default: ({ stockCode }: { stockCode: string }) => <section aria-label="标准财务与指标计算">财务公司 {stockCode}</section> }))
vi.mock('../DisclosuresPanel', () => ({ default: ({ stockCode }: { stockCode: string }) => <section aria-label="原始披露归档">披露公司 {stockCode}
  <form aria-label="披露内表单" onSubmit={event => event.preventDefault()}><button type="submit">执行资料操作</button></form>
</section> }))
const at = '2026-10-20T08:00:00Z'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const securities = [
  { stock_code: '000001.SZ', name: '平安银行', market: 'SZ' },
  { stock_code: '600000.SH', name: '浦发银行', market: 'SH' },
  { stock_code: '600519.SH', name: '贵州茅台', market: 'SH' },
  { stock_code: '000333.SZ', name: '美的集团', market: 'SZ' },
]
function backend({ catalogFailure = false, loseMessage = false, unavailableModel = false, failedOriginal = false } = {}) {
  let stored: Conversation | null = null, catalogCalls = 0
  if (failedOriginal) stored = {
    id: 'company-chat', task_id: 'company-chat', entry_scope: 'screening', workflow_type: 'research', task_revision: 0,
    active_run_id: null, pending_execution: false, state: 'active', created_at: at, updated_at: at,
    messages: [{ id: 'old-question', role: 'user', content: '当前研究公司：贵州茅台（600519.SH）。\n解释经营变化', source_refs: [], created_at: at }],
    turns: [{ id: 'old-turn', user_message_id: 'old-question', base_revision: 0, state: 'failed', response_text: null, result: {}, created_at: at, updated_at: at }],
  }
  const writes: { path: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    const method = init?.method || 'GET', body = init?.body ? JSON.parse(String(init.body)) : {}
    if (method !== 'GET') writes.push({ path, body })
    if (path === '/security-catalog') {
      catalogCalls++
      return catalogFailure && catalogCalls === 1 ? json({ message: '读取目录失败' }, 503) : json({ items: securities })
    }
    if (path === '/research-models') return json({ account_tier: 'free', default_model_id: 'model', default_reasoning_effort: 'high', discovery_status: 'verified',
      models: [{ id: 'model', label: '模型', available: !unavailableModel, default_reasoning_effort: 'high', reasoning_efforts: [{ id: 'high', label: '深入' }] }] })
    if (path === '/conversations' && method === 'GET') return json({ items: stored ? [stored] : [] })
    if (path === '/conversations' && method === 'POST') {
      stored = { id: 'company-chat', task_id: 'company-chat', entry_scope: 'screening', workflow_type: 'research',
        research_scope: { as_of: null, stock_codes: [] }, research_scope_revision: 0, task_revision: 0, active_run_id: null,
        pending_execution: false, state: 'active', messages: [], turns: [], created_at: at, updated_at: at }
      return json(stored)
    }
    if (path === '/conversations/company-chat/messages') {
      if (loseMessage && writes.filter(call => call.path.endsWith('/messages')).length === 1) return json({ message: '消息响应丢失' }, 503)
      stored = { ...stored!, messages: [...stored!.messages, { id: 'question', role: 'user', content: String(body.content), source_refs: [], created_at: at },
        { id: 'answer', role: 'assistant', content: '已处理公司问题', source_refs: [], created_at: at }] }
      return json({ message_id: 'question', turn_id: 'turn', state: 'succeeded', source_refs: [] })
    }
    if (path === '/conversations/company-chat') return json(stored)
    return json({ items: [] })
  }))
  return { writes }
}
async function mount(initialConversationId?: string) {
  const view = render(<SecuritiesProvider><ConversationWorkspace initialNewDraft={!initialConversationId} initialConversationId={initialConversationId} initialWorkflowType="research" /></SecuritiesProvider>)
  const input = screen.getByRole('textbox', { name: '研究要求' })
  await waitFor(() => expect(input).toBeEnabled())
  return { ...view, input, user: userEvent.setup() }
}

it('completes a command with keyboard navigation and opens the selected company without creating messages', async () => {
  const { writes } = backend(), { input, user } = await mount()
  await user.type(input, '/')
  expect(screen.getAllByRole('option')).toHaveLength(6)
  await user.keyboard('{ArrowDown}{Tab}')
  expect(input).toHaveValue('/披露 ')
  await user.type(input, '000333')
  const list = screen.getByRole('listbox', { name: '快捷命令建议' })
  expect(within(list).getByRole('option', { name: /美的集团/ })).toHaveAttribute('aria-selected', 'true')
  expect(input).toHaveAttribute('aria-activedescendant', within(list).getByRole('option').id)
  await user.keyboard('{Enter}')
  const dialog = await screen.findByRole('dialog', { name: '公司原始披露' })
  expect(await within(dialog).findByText('披露公司 000333.SZ')).toBeInTheDocument()
  expect(writes).toEqual([])
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: '公司原始披露' })).not.toBeInTheDocument()
  expect(input).toHaveFocus()
  expect(input).toHaveValue('')
})

it('opens financials by name, retains focus during mouse selection, and supports long aliases with lowercase codes', async () => {
  const { writes } = backend(), { input, user } = await mount()
  await user.type(input, '/查财务 茅台')
  await user.click(screen.getByRole('option', { name: /贵州茅台/ }))
  expect(await screen.findByText('财务公司 600519.SH')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '关闭公司财务' }))
  await user.type(input, '/打开原始披露 000333.sz')
  await user.click(screen.getByRole('button', { name: '执行命令' }))
  expect(await screen.findByText('披露公司 000333.SZ')).toBeInTheDocument()
  expect(writes).toEqual([])
})

it('switches the highlighted company, includes it in visible question text, and preserves retry identity after conversation creation', async () => {
  const { writes } = backend({ loseMessage: true }), { input, user } = await mount()
  await user.type(input, '/切换公司 银行')
  await user.keyboard('{ArrowDown}{Enter}')
  expect(screen.getByRole('group', { name: '当前研究公司' })).toHaveTextContent('浦发银行')
  expect(writes).toEqual([])
  await user.type(input, '解释这家公司的经营变化')
  await user.keyboard('{Enter}')
  await screen.findByText('消息响应丢失')
  await waitFor(() => expect(input).toBeEnabled())
  expect(screen.getByRole('group', { name: '当前研究公司' })).toHaveTextContent('600000.SH')
  await user.click(screen.getByRole('button', { name: '发送' }))
  await screen.findByText('已处理公司问题')
  const messages = writes.filter(call => call.path.endsWith('/messages'))
  expect(messages).toHaveLength(2)
  expect(messages[1].body).toEqual(messages[0].body)
  expect(messages[0].body.content).toBe('当前研究公司：浦发银行（600000.SH）。\n解释这家公司的经营变化')
  expect(writes.filter(call => call.path === '/conversations')).toHaveLength(1)
  await user.type(input, '/财务')
  await user.keyboard('{Enter}')
  expect(await screen.findByText('财务公司 600000.SH')).toBeInTheDocument()
})

it('does not execute during IME composition or send unknown, missing-company and multiline commands as model questions', async () => {
  const { writes } = backend(), { input, user } = await mount()
  await user.type(input, '/财务 贵州茅台')
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
  expect(screen.queryByRole('dialog', { name: '公司财务' })).not.toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('listbox', { name: '快捷命令建议' })).not.toBeInTheDocument()
  expect(input).toHaveValue('/财务 贵州茅台')
  await user.clear(input); await user.type(input, '/不存在')
  await user.keyboard('{Enter}')
  expect(screen.getByText(/未找到命令/)).toBeInTheDocument()
  await user.clear(input); await user.type(input, '/公司')
  await user.keyboard('{Enter}')
  expect(screen.getByText(/输入公司名称、六位股票代码/)).toBeInTheDocument()
  await user.clear(input); await user.type(input, '/财务 贵州茅台{Shift>}{Enter}{/Shift}再分析')
  await user.keyboard('{Enter}')
  expect(screen.getByText('请将命令和一家公司放在同一行。')).toBeInTheDocument()
  expect(writes).toEqual([])
})

it('retries a failed company catalog and keeps local commands available without a usable model', async () => {
  const { writes } = backend({ catalogFailure: true, unavailableModel: true }), { input, user } = await mount()
  await user.type(input, '/财务 贵州茅台')
  await user.click(await screen.findByRole('button', { name: '重试公司列表' }))
  await screen.findByRole('option', { name: /贵州茅台/ })
  await user.click(screen.getByRole('button', { name: '执行命令' }))
  expect(await screen.findByText('财务公司 600519.SH')).toBeInTheDocument()
  expect(writes).toEqual([])
})

it('clears company context for new research and lets clearing the chip preserve a normal draft', async () => {
  backend()
  const { input, user } = await mount()
  await user.type(input, '/公司 美的')
  await user.keyboard('{Enter}')
  await user.type(input, '保留这段草稿')
  await user.click(screen.getByRole('button', { name: '清除当前公司' }))
  expect(input).toHaveValue('保留这段草稿')
  expect(screen.queryByRole('group', { name: '当前研究公司' })).not.toBeInTheDocument()
  await user.clear(input); await user.type(input, '/公司 600519.SH')
  await user.keyboard('{Enter}')
  await user.click(screen.getByRole('button', { name: '新研究' }))
  expect(input).toHaveValue('')
  expect(screen.queryByRole('group', { name: '当前研究公司' })).not.toBeInTheDocument()
})

it('reprocesses an old failed question with its original company after switching the current company', async () => {
  const { writes } = backend({ failedOriginal: true }), { input, user } = await mount('company-chat')
  await user.type(input, '/公司 000333')
  await user.keyboard('{Enter}')
  expect(screen.getByRole('group', { name: '当前研究公司' })).toHaveTextContent('美的集团')
  await user.click(screen.getByRole('button', { name: '重新处理' }))
  await screen.findByText('已处理公司问题')
  expect(writes.find(call => call.path.endsWith('/messages'))!.body.content).toBe('当前研究公司：贵州茅台（600519.SH）。\n解释经营变化')
})

it('preserves an unsent draft while opening the current company and keeps panel forms separate from message submission', async () => {
  const { writes } = backend(), { input, user } = await mount()
  await user.type(input, '/公司 美的集团')
  await user.keyboard('{Enter}')
  await user.type(input, '尚未发送的草稿')
  await user.click(within(screen.getByRole('group', { name: '当前研究公司' })).getByRole('button', { name: '原始披露' }))
  const dialog = await screen.findByRole('dialog', { name: '公司原始披露' })
  await user.click(within(dialog).getByRole('button', { name: '执行资料操作' }))
  expect(writes).toEqual([])
  await user.click(within(dialog).getByRole('button', { name: '关闭公司原始披露' }))
  expect(input).toHaveValue('尚未发送的草稿')
  expect(input).toHaveFocus()
})

it('selects the new commands using the shared keyboard menu and opens the matched company', async () => {
  const { writes } = backend(), { input, user } = await mount()
  await user.type(input, '/')
  await user.keyboard('{ArrowUp}{Tab}')
  expect(input).toHaveValue('/行情 ')
  await user.type(input, '600519.sh')
  await user.keyboard('{Enter}')
  expect(await screen.findByText('行情公司 600519.SH')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  await user.type(input, '/研报 茅台')
  await user.keyboard('{Enter}')
  expect(await screen.findByText('研报公司 600519.SH')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  await user.type(input, '/资讯 000333')
  await user.keyboard('{Enter}')
  expect(await screen.findByText('资讯公司 000333.SZ')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(input).toHaveFocus()
  expect(writes).toEqual([])
})

it('uses the current company for every new command and leaves it intact when viewing another company', async () => {
  const { writes } = backend(), { input, user } = await mount()
  await user.type(input, '/公司 美的')
  await user.keyboard('{Enter}')
  for (const command of ['研报', '资讯', '行情']) {
    await user.type(input, '/' + command)
    await user.keyboard('{Enter}')
    expect(await screen.findByText(command + '公司 000333.SZ')).toBeInTheDocument()
    await user.keyboard('{Escape}')
  }
  await user.type(input, '/行情 600519')
  await user.keyboard('{Enter}')
  expect(await screen.findByText('行情公司 600519.SH')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.getByRole('group', { name: '当前研究公司' })).toHaveTextContent('000333.SZ')
  expect(writes).toEqual([])
})
