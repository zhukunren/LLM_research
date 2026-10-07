import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ConversationWorkspace from './ConversationWorkspace'
import type { Conversation } from '../../api'
import { SecuritiesProvider } from '../StockSearch'

vi.mock('./ProjectMembership', () => ({ default: () => <span>项目归属</span> }))
const date = '2026-10-04T08:00:00Z'
const research = (): Conversation => ({ id: 'research', task_id: 'legacy', entry_scope: 'report', workflow_type: 'research', research_depth: 'standard', task_revision: 4, active_run_id: 'old-run', pending_execution: true,
  research_scope: { as_of: '2026-09-14', stock_codes: ['600000.SH'] }, research_scope_revision: 7,
  state: 'active', messages: [{ id: 'answer', role: 'assistant', content: '订单证据需要进一步核验。', source_refs: [], created_at: date }],
  turns: [{ id: 'legacy-ready', user_message_id: 'old-request', base_revision: 4, state: 'succeeded', response_text: '', result: { task_revision: 4, ready_to_execute: true, execution_authorized: true }, created_at: date, updated_at: date }], created_at: date, updated_at: date })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function mockResearch(intercept?: (path: string, body: Record<string, unknown>, method: string) => Response | undefined) {
  let stored = research()
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path, method, body })
    const response = intercept?.(path, body, method)
    if (response) return response
    if (path === '/conversations') return json({ items: [{ ...stored, title: '订单研究' }] })
    if (path === '/security-catalog') return json({ items: [{ stock_code: '600000.SH', name: '浦发银行', market: 'SH' }] })
    if (path === '/conversations/research') return json(stored)
    if (path.endsWith('/research-scope')) { stored = { ...stored, research_scope: { as_of: String(body.as_of), stock_codes: body.stock_codes as string[] }, research_scope_revision: 8 }; return json({ research_scope: stored.research_scope, research_scope_revision: 8 }) }
    return json({ items: [] })
  }))
  return calls
}

it('keeps a research conversation with a legacy task away from screening data and execution', async () => {
  const calls = mockResearch()
  render(<ConversationWorkspace initialWorkflowType="research" initialScope="report" initialConversationId="research" data={{ available: true, last_date: '2026-09-30' }} />)
  await screen.findByText('订单证据需要进一步核验。')
  expect(screen.queryByRole('heading', { name: '筛选方案' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '确认并开始筛选' })).not.toBeInTheDocument()
  expect(calls.some(call => /screening-runs|revisions|execute/.test(call.path))).toBe(false)
  expect(within(screen.getByLabelText('研究深度')).getAllByRole('option').map(option => option.textContent)).toEqual(['普通', '深入'])
  expect(screen.getByRole('button', { name: '转为选股草稿' })).toBeInTheDocument()
})

it('saves research scope with its own revision and sends it without changing a screening task', async () => {
  const calls = mockResearch((path, _body, method) => path.endsWith('/messages') && method === 'POST' ? json({ message_id: 'question', turn_id: 'turn' }) : path.endsWith('/process') ? json({ result: { ready_to_execute: true } }) : undefined)
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="research" initialScope="report" initialConversationId="research" data={{ available: true, last_date: '2026-09-30' }} />)
  await screen.findByText('订单证据需要进一步核验。')
  await user.click(screen.getByText(/^研究范围：/))
  fireEvent.change(screen.getByLabelText('研究截止日'), { target: { value: '2026-09-13' } })
  fireEvent.change(screen.getByLabelText('研究股票代码'), { target: { value: '000001.sz, 600000.SH' } })
  await user.click(screen.getByRole('button', { name: '保存研究范围' }))
  await screen.findByText('研究范围已保存。')
  expect(calls.find(call => call.path.endsWith('/research-scope'))!.body).toEqual({ base_revision: 7, as_of: '2026-09-13', stock_codes: ['000001.SZ', '600000.SH'] })
  await user.type(screen.getByLabelText('研究要求'), '继续核对订单')
  await user.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(calls.some(call => call.path.endsWith('/process'))).toBe(true))
  expect(calls.find(call => call.path.endsWith('/messages'))!.body).toMatchObject({ base_revision: 4, research_scope_revision: 8, content: '继续核对订单' })
  expect(calls.some(call => /\/scope$|\/execute$/.test(call.path))).toBe(false)
})

it('requires editable conditions before creating a linked screening draft, with no turn processing', async () => {
  const navigate = vi.fn()
  const calls = mockResearch(path => path.endsWith('/screening-draft') ? json({ conversation_id: 'draft', turn_id: null, draft_prompt: '请核对订单落地条件', source: { source_conversation_id: 'research', source_message_id: 'answer' } }) : undefined)
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="research" initialScope="report" initialConversationId="research" onOpenConversation={navigate} />)
  await user.click(await screen.findByRole('button', { name: '转为选股草稿' }))
  expect((screen.getByLabelText('可执行选股条件') as HTMLTextAreaElement).value).toContain('订单证据需要进一步核验。')
  await user.clear(screen.getByLabelText('可执行选股条件'))
  expect(screen.getByRole('button', { name: '创建选股草稿' })).toBeDisabled()
  await user.type(screen.getByLabelText('可执行选股条件'), '近30日有订单实际落地的原文证据')
  await user.click(screen.getByRole('button', { name: '创建选股草稿' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('draft', 'screening', 'screening', '请核对订单落地条件'))
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
  expect(calls.find(call => call.path.endsWith('/screening-draft'))!.body).toMatchObject({ request_id: expect.any(String), source_message_id: 'answer', instructions: '近30日有订单实际落地的原文证据' })
  expect(calls.some(call => /messages|process|execute/.test(call.path))).toBe(false)
})

it('restores the editable draft and original research link without sending or processing it', async () => {
  const navigate = vi.fn()
  const stored = { ...research(), id: 'draft', workflow_type: 'screening', task_revision: 0, pending_execution: false, active_run_id: null, turns: [], messages: [], screening_draft_source: { source_conversation_id: 'research', source_message_id: 'answer', instructions: '订单落地', draft_prompt: '请核对订单落地条件', request_id: 'handoff' } }
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    calls.push(init?.method ?? 'GET')
    return json(path === '/api/v1/conversations' ? { items: [{ ...stored, title: '订单条件草稿' }] } : path === '/api/v1/conversations/draft' ? stored : { items: [] })
  }))
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="draft" onOpenConversation={navigate} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toHaveValue('请核对订单落地条件'))
  await user.type(screen.getByLabelText('选股要求'), '，只看已投产')
  expect(screen.getByLabelText('选股要求')).toHaveValue('请核对订单落地条件，只看已投产')
  await user.click(screen.getByRole('button', { name: '查看原研究' }))
  expect(navigate).toHaveBeenCalledWith('research', 'screening', 'research')
  expect(calls.every(method => method === 'GET')).toBe(true)
})

it('adds a user-selected research candidate with validation notes and an answer source', async () => {
  const calls = mockResearch(path => path === '/observation/research-candidates' ? json({ id: 'candidate', source_kind: 'research_candidate' }) : undefined)
  const user = userEvent.setup()
  render(<SecuritiesProvider><ConversationWorkspace initialWorkflowType="research" initialScope="report" initialConversationId="research" /></SecuritiesProvider>)
  await user.click(await screen.findByRole('button', { name: '加入观察' }))
  expect(screen.getByRole('button', { name: '保存研究候选' })).toBeDisabled()
  await user.type(screen.getByLabelText('观察候选股票代码'), '600000.sh')
  await user.click(screen.getByText('验证计划与失效条件'))
  await user.type(screen.getByLabelText('观察候选验证事项'), '下一季核对收入兑现')
  await user.type(screen.getByLabelText('观察候选失效条件'), '订单取消')
  await user.click(screen.getByRole('button', { name: '保存研究候选' }))
  await screen.findByText('已加入研究候选观察。')
  expect(calls.find(call => call.path === '/observation/research-candidates')!.body).toMatchObject({ conversation_id: 'research', source_message_id: 'answer', stock_code: '600000.SH', verification: '下一季核对收入兑现', invalidation: '订单取消', request_id: expect.any(String) })
  expect(calls.some(call => /execute|screening-runs/.test(call.path))).toBe(false)
})
