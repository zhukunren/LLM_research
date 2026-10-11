import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { Conversation, ConversationTurn, ResearchScope } from '../../api'
import { SecuritiesProvider } from '../StockSearch'
import ConversationWorkspace from './ConversationWorkspace'
import { researchAnswerExcerpt, researchAnswerSecurityCodes, uniqueResearchSecurity } from './researchResultNextSteps'

vi.mock('./ProjectMembership', () => ({ default: () => <span>项目归属</span> }))
const timestamp = '2026-10-06T00:00:00Z'
const securities = [{ stock_code: '600000.SH', name: '浦发银行', market: 'SH' }, { stock_code: '000001.SZ', name: '平安银行', market: 'SZ' }]
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
function research(frozenCodes = ['600000.SH']): Conversation {
  const turn: ConversationTurn & { research_scope: ResearchScope } = { id: 'turn', user_message_id: 'question', base_revision: 0, state: 'succeeded', response_text: '经营改善仍需核对现金流。', result: {}, research_scope: { as_of: '2026-09-28', stock_codes: frozenCodes }, created_at: timestamp, updated_at: timestamp }
  return { id: 'research', task_id: 'research', entry_scope: 'report', workflow_type: 'research', task_revision: 0, active_run_id: null, pending_execution: false, state: 'active', research_scope: { as_of: '2026-10-06', stock_codes: ['000001.SZ'] },
    messages: [{ id: 'question', role: 'user', content: '核对现金流', source_refs: [], created_at: timestamp }, { id: 'answer', role: 'assistant', content: '经营改善仍需核对现金流。', source_refs: [], created_at: timestamp }], turns: [turn], created_at: timestamp, updated_at: timestamp }
}
function restore(stored = research()) {
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path, method, body })
    if (path === '/security-catalog') return json({ items: securities })
    if (path === '/conversations') return json({ items: [{ ...stored, title: '现金流研究' }] })
    if (path === '/conversations/research') return json(stored)
    if (path.endsWith('/notes/from-message')) return json({ id: 'note', project_id: 'inbox' })
    if (path.endsWith('/screening-draft')) return json({ conversation_id: 'draft', turn_id: null, draft_prompt: String(body.instructions), source: { source_conversation_id: 'research', source_message_id: 'answer' } })
    return json({ items: [], id: 'candidate' })
  }))
  return calls
}
function renderResearch(props: { onOpenConversation?: (...args: [string, ...unknown[]]) => void; onLocationChange?: (id: string, scope: 'report' | 'technical' | 'news' | 'pattern' | 'screening', workflow: 'research' | 'screening') => void } = {}) {
  return render(<SecuritiesProvider><ConversationWorkspace initialWorkflowType="research" initialScope="report" initialConversationId="research" {...props} /></SecuritiesProvider>)
}

it('regenerates the selected answer without adding a new visible question', async () => {
  const calls = restore(), originalFetch = globalThis.fetch, user = userEvent.setup()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/answers/regenerate')) {
      calls.push({ path: '/conversations/research/answers/regenerate', method: 'POST', body: JSON.parse(String(init?.body)) })
      return json({ conversation_id: 'research', turn_id: 'regenerated-turn' })
    }
    return originalFetch(input, init)
  }))
  renderResearch()
  await user.click(await screen.findByRole('button', { name: '重新生成答案' }))
  await screen.findByText('正在重新生成，原回答已保留。')
  expect(calls.filter(call => call.method === 'POST')).toEqual([{ path: '/conversations/research/answers/regenerate', method: 'POST', body: { message_id: 'answer', request_id: expect.any(String) } }])
})

it('opens a branch through the answer menu and navigates to the returned conversation', async () => {
  const calls = restore(), originalFetch = globalThis.fetch, user = userEvent.setup(), navigate = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/answers/branch')) {
      calls.push({ path: '/conversations/research/answers/branch', method: 'POST', body: JSON.parse(String(init?.body)) })
      return json({ conversation_id: 'branch', turn_id: null })
    }
    return originalFetch(input, init)
  }))
  renderResearch({ onOpenConversation: navigate })
  await user.click(await screen.findByRole('button', { name: '更多回答操作' }))
  await user.click(screen.getByRole('menuitem', { name: /打开新对话分支/ }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('branch', 'report', 'research'))
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
  expect(calls.find(call => call.method === 'POST')!.body.message_id).toBe('answer')
})

it('switches preserved answer versions without extra requests or repeated user messages', async () => {
  const stored = research()
  stored.messages.push({ ...stored.messages[0], id: 'shadow', regeneration_of: 'question' },
    { ...stored.messages[1], id: 'second-answer', regeneration_of: 'answer', content: '新版本现金流结论' })
  const calls = restore(stored), user = userEvent.setup()
  renderResearch()
  await screen.findByText('新版本现金流结论')
  expect(screen.queryByText('经营改善仍需核对现金流。')).not.toBeInTheDocument()
  expect(screen.getByRole('group', { name: '回答版本' })).toHaveTextContent('2 / 2')
  await user.click(screen.getByRole('button', { name: '上一个回答版本' }))
  expect(screen.getByText('经营改善仍需核对现金流。')).toBeInTheDocument()
  expect(screen.getAllByText('核对现金流', { selector: '.conversation-plain-message' })).toHaveLength(1)
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it('saves a completed answer without starting another workflow', async () => {
  const calls = restore(), user = userEvent.setup()
  renderResearch()
  const next = await screen.findByRole('region', { name: '研究答复操作' })
  await user.click(within(next).getByRole('button', { name: '保存为研究笔记' }))
  await screen.findByText('已保存为研究笔记')
  expect(within(next).getByRole('button', { name: '保存为研究笔记' })).toBeDisabled()
  expect(calls.filter(call => call.method !== 'GET').map(call => call.path)).toEqual(['/conversations/research/notes/from-message'])
})

it('prefills only the answer frozen company and an editable excerpt, leaving optional plans blank', async () => {
  const calls = restore(), user = userEvent.setup()
  renderResearch()
  await user.click(await screen.findByRole('button', { name: '加入观察' }))
  await screen.findByText('已选择：浦发银行（600000.SH）')
  expect(screen.getByLabelText('观察候选备注')).toHaveValue('经营改善仍需核对现金流。')
  const optional = screen.getByText('验证计划与失效条件').closest('details')!
  expect(optional).not.toHaveAttribute('open')
  expect(screen.getByLabelText('观察候选验证事项')).toHaveValue('')
  expect(screen.getByLabelText('观察候选失效条件')).toHaveValue('')
  fireEvent.change(screen.getByLabelText('观察候选备注'), { target: { value: '核对下一季经营现金流' } })
  await user.click(screen.getByRole('button', { name: '保存研究候选' }))
  await screen.findByText('已加入研究候选观察。')
  expect(calls.find(call => call.path === '/observation/research-candidates' && call.method === 'POST')!.body).toMatchObject({ conversation_id: 'research', source_message_id: 'answer', stock_code: '600000.SH', note: '核对下一季经营现金流', verification: '', invalidation: '', request_id: expect.any(String) })
  expect(calls.some(call => /process|execute|screening-runs/.test(call.path))).toBe(false)
})

it('lets a user choose by company name or six digit code instead of guessing from multiple companies', async () => {
  const calls = restore(research(['600000.SH', '000001.SZ'])), user = userEvent.setup()
  renderResearch()
  await user.click(await screen.findByRole('button', { name: '加入观察' }))
  expect(screen.getByRole('button', { name: '保存研究候选' })).toBeDisabled()
  await user.type(screen.getByRole('combobox', { name: '观察候选股票代码' }), '平安')
  await user.click(screen.getByRole('option', { name: /平安银行/ }))
  expect(screen.getByRole('button', { name: '保存研究候选' })).toBeEnabled()
  await user.click(screen.getByRole('combobox', { name: '观察候选股票代码' }))
  await user.type(screen.getByRole('combobox', { name: '观察候选股票代码' }), '600000')
  await user.click(screen.getByRole('option', { name: /浦发银行/ }))
  await user.click(screen.getByRole('button', { name: '保存研究候选' }))
  await waitFor(() => expect(calls.some(call => call.method === 'POST')).toBe(true))
  expect(calls.find(call => call.method === 'POST')!.body.stock_code).toBe('600000.SH')
})

it('clears a prior selection on editing and cannot save an unmatched company or unknown full code', async () => {
  const calls = restore(), user = userEvent.setup()
  renderResearch()
  await user.click(await screen.findByRole('button', { name: '加入观察' }))
  expect(screen.getByRole('button', { name: '保存研究候选' })).toBeEnabled()
  const input = screen.getByRole('combobox', { name: '观察候选股票代码' })
  await user.type(input, '不存在的公司')
  expect(screen.getByRole('button', { name: '保存研究候选' })).toBeDisabled()
  await user.clear(input)
  await user.type(input, '999999.SH')
  expect(screen.getByRole('button', { name: '保存研究候选' })).toBeDisabled()
  fireEvent.submit(screen.getByRole('form', { name: '加入研究候选观察' }))
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(0)
})

it('creates an editable screening draft from the research excerpt without processing or executing it', async () => {
  const calls = restore(), navigate = vi.fn(), user = userEvent.setup()
  renderResearch({ onOpenConversation: navigate })
  await user.click(await screen.findByRole('button', { name: '更多回答操作' }))
  await user.click(screen.getByRole('menuitem', { name: '转为选股草稿' }))
  const input = screen.getByLabelText('可执行选股条件')
  expect((input as HTMLTextAreaElement).value).toContain('经营改善仍需核对现金流。')
  fireEvent.change(input, { target: { value: '只筛选有经营现金流实际改善证据的公司' } })
  await user.click(screen.getByRole('button', { name: '创建选股草稿' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('draft', 'screening', 'screening', '只筛选有经营现金流实际改善证据的公司'))
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
  expect(calls.find(call => call.method === 'POST')!.body).toMatchObject({ source_message_id: 'answer', instructions: '只筛选有经营现金流实际改善证据的公司' })
  expect(calls.some(call => /messages|process|execute/.test(call.path))).toBe(false)
})

it('keeps failed research away from next-step actions', async () => {
  const stored = research()
  stored.turns[0].state = 'failed'
  restore(stored)
  renderResearch()
  await screen.findByText('这次研究未能完成')
  expect(screen.queryByRole('region', { name: '研究答复操作' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '加入观察' })).not.toBeInTheDocument()
})

it('makes answering the clarification the next step while research is waiting for the user', async () => {
  const stored = research()
  stored.turns[0].state = 'awaiting_user'
  const calls = restore(stored), user = userEvent.setup()
  renderResearch()
  await user.click(await screen.findByRole('button', { name: '补充研究要求' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toHaveFocus())
  expect(screen.queryByRole('button', { name: '保存为研究笔记' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '加入观察' })).not.toBeInTheDocument()
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it('does not repeat a clarification prompt after the user has already followed up', async () => {
  const stored = research()
  stored.turns[0].state = 'awaiting_user'
  stored.messages.push({ ...stored.messages[0], id: 'followup', content: '请核对浦发银行。' }, { ...stored.messages[1], id: 'final-answer', content: '经营现金流证据如下。' })
  stored.turns.push({ ...stored.turns[0], id: 'followup-turn', user_message_id: 'followup', state: 'succeeded', response_text: '经营现金流证据如下。' })
  restore(stored)
  renderResearch()
  await screen.findByText('经营现金流证据如下。')
  expect(screen.queryByRole('button', { name: '补充研究要求' })).not.toBeInTheDocument()
  expect(screen.getAllByRole('region', { name: '研究答复操作' })).toHaveLength(1)
})

it('identifies only unambiguous recognized source companies and ignores the mutable current scope', () => {
  const stored = research([])
  stored.messages[0].source_refs = [{ kind: 'security', source_id: '600000.SH' }]
  expect(uniqueResearchSecurity(researchAnswerSecurityCodes(stored, stored.messages[1]), securities)?.name).toBe('浦发银行')
  stored.messages[1].source_refs = [{ kind: 'news_item', stock_codes: ['999999.SH'] }]
  expect(uniqueResearchSecurity(researchAnswerSecurityCodes(stored, stored.messages[1]), securities)).toBeUndefined()
  stored.messages[0].source_refs = [{ kind: 'report_page', stock_code: '600000.SH', security_binding_status: 'pending' }]
  stored.messages[1].source_refs = []
  expect(researchAnswerSecurityCodes(stored, stored.messages[1])).toEqual([])
  expect(researchAnswerExcerpt('## 结论\n尚未证实增长。\n```python\nprint(1)\n```\n[原始公告](https://example.com)')).toBe('尚未证实增长。 原始公告')
})

it('reports the accepted conversation identity and an explicit new draft without writing data', async () => {
  const calls = restore(), location = vi.fn(), user = userEvent.setup()
  renderResearch({ onLocationChange: location })
  await screen.findByRole('region', { name: '研究答复操作' })
  expect(location).toHaveBeenCalledWith('research', 'report', 'research')
  await user.click(screen.getByRole('button', { name: '新研究' }))
  expect(location).toHaveBeenLastCalledWith('', 'report', 'research')
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it.each(['加入观察', '转为选股草稿'])('opens %s above the reading layout with keyboard focus and restores the launcher on close', async name => {
  const calls = restore(), user = userEvent.setup()
  const { container } = renderResearch()
  const launch = await screen.findByRole('button', { name: name === '转为选股草稿' ? '更多回答操作' : name })
  await user.click(launch)
  if (name === '转为选股草稿') await user.click(screen.getByRole('menuitem', { name }))
  const dialog = screen.getByRole('dialog', { name: name === '加入观察' ? '加入研究候选观察' : '研究转选股草稿' })
  expect(container).not.toContainElement(dialog)
  expect(dialog).toHaveAttribute('aria-modal', 'true')
  expect(within(dialog).getByRole('button', { name: '关闭研究操作' })).toHaveFocus()
  expect(document.body.style.overflow).toBe('hidden')
  await user.tab({ shift: true })
  expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus()
  await user.tab()
  expect(within(dialog).getByRole('button', { name: '关闭研究操作' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: dialog.getAttribute('aria-label')! })).not.toBeInTheDocument()
  expect(launch).toHaveFocus()
  expect(document.body.style.overflow).toBe('')
  expect(calls.every(call => call.method === 'GET')).toBe(true)
})

it('closes the stock choices before closing the observation window when Escape is pressed', async () => {
  restore()
  const user = userEvent.setup()
  renderResearch()
  await user.click(await screen.findByRole('button', { name: '加入观察' }))
  await user.type(screen.getByRole('combobox', { name: '观察候选股票代码' }), '平安')
  expect(screen.getByRole('listbox')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: '加入研究候选观察' })).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: '加入研究候选观察' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '加入观察' })).toHaveFocus()
})

it('keeps an unsuccessful save and its editable fields visible inside the window', async () => {
  restore()
  const fetcher = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/observation/research-candidates')) return new Response(JSON.stringify({ detail: '连接暂时中断' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    return fetcher(input, init)
  }))
  const user = userEvent.setup()
  renderResearch()
  await user.click(await screen.findByRole('button', { name: '加入观察' }))
  fireEvent.change(screen.getByLabelText('观察候选备注'), { target: { value: '保留我补充的关注理由' } })
  await user.click(screen.getByRole('button', { name: '保存研究候选' }))
  const dialog = screen.getByRole('dialog', { name: '加入研究候选观察' })
  expect(await within(dialog).findByText(/暂时未能保存，当前内容已保留/)).toBeInTheDocument()
  expect(within(dialog).getByLabelText('观察候选备注')).toHaveValue('保留我补充的关注理由')
  expect(within(dialog).getByRole('button', { name: '保存研究候选' })).toBeEnabled()
  expect(within(dialog).getByRole('button', { name: '关闭研究操作' })).toBeEnabled()
})
