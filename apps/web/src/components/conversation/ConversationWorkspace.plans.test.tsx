import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import ConversationWorkspace from './ConversationWorkspace'

const timestamp = '2026-11-17T01:00:00Z'
const saved = { id: 'saved-plan', name: '量价趋势', version: 2, task: {}, created_at: timestamp }
const strategy = { id: 'combination', name: '订单与回购组合', version: 3, tree: {}, top_n: 30, created_at: timestamp }
const writes: { path: string; body: Record<string, unknown> }[] = []
beforeEach(() => {
  writes.length = 0
  let current = { id: 'current', task_id: 'current', entry_scope: 'screening', workflow_type: 'screening', task_revision: 0, active_run_id: null, pending_execution: false, state: 'active', messages: [] as Record<string, unknown>[], turns: [], created_at: timestamp, updated_at: timestamp }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (init?.method && init.method !== 'GET') writes.push({ path, body })
    const value = path === '/api/v1/saved-screening-tasks' ? { items: [saved] }
      : path === '/api/v1/strategies' ? { items: [strategy] }
      : path === '/api/v1/conversations' && init?.method === 'POST' ? current
      : path === '/api/v1/conversations/current/messages' ? (() => { current = { ...current, messages: [{ id: 'message', role: 'user', content: body.content, source_refs: body.source_refs, created_at: timestamp }] }; return { message_id: 'message', turn_id: 'turn', state: 'succeeded', base_revision: 0, source_refs: body.source_refs } })()
      : path === '/api/v1/conversations/current' ? current : { items: [] }
    return new Response(JSON.stringify(value))
  }))
})

async function choose(user: ReturnType<typeof userEvent.setup>, name = '量价趋势', version = 2) {
  await user.click(screen.getByRole('button', { name: '引用方案' }))
  await user.click(await screen.findByRole('button', { name: `引用方案 ${name} 第 ${version} 版` }))
}

it.each([['量价趋势', 2, 'saved_screening_task', 'saved-plan'], ['订单与回购组合', 3, 'screening_strategy', 'combination']] as const)('attaches %s without writes, preserves the draft on reload, and submits its pinned reference only on execution', async (name, version, kind, id) => {
  const user = userEvent.setup(), view = render(<ConversationWorkspace initialNewDraft initialWorkflowType="screening" data={{ available: true, last_date: '2026-11-16' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  expect(screen.queryByRole('button', { name: '我的指标' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('选股要求'), { target: { value: '同时核对订单是否实际增长' } })
  await choose(user, name, version)
  expect(screen.getByLabelText('引用的选股方案')).toHaveTextContent(`@${name} · v${version}`)
  expect(screen.getByLabelText('选股要求')).toHaveValue('同时核对订单是否实际增长')
  expect(writes).toHaveLength(0)
  view.unmount(); render(<ConversationWorkspace initialNewDraft initialWorkflowType="screening" data={{ available: true, last_date: '2026-11-16' }} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '执行选股' })).toBeEnabled())
  expect(screen.getByLabelText('引用的选股方案')).toHaveTextContent(name)
  expect(writes).toHaveLength(0)
  await user.click(screen.getByRole('button', { name: '执行选股' }))
  await waitFor(() => expect(writes.some(item => item.path.endsWith('/messages'))).toBe(true))
  const message = writes.find(item => item.path.endsWith('/messages'))!
  expect(message.body.source_refs).toEqual([{ kind, source_id: id, version }])
  expect(message.body.execute_plan).toBe(true)
  expect(message.body.content).toContain('请执行选股')
  expect(message.body.content).toContain('同时核对订单是否实际增长')
  expect(message.body.content).toContain('2026-11-16')
  await waitFor(() => expect(screen.queryByLabelText('引用的选股方案')).not.toBeInTheDocument())
})

it('executes an attached plan with an empty text draft and supports removing or replacing the reference', async () => {
  const user = userEvent.setup()
  render(<ConversationWorkspace initialNewDraft initialWorkflowType="screening" data={{ available: true, last_date: '2026-11-16' }} />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await choose(user)
  await user.click(screen.getByRole('button', { name: '移除方案引用' }))
  expect(screen.queryByLabelText('引用的选股方案')).not.toBeInTheDocument()
  expect(writes).toHaveLength(0)
  await choose(user)
  await choose(user, '订单与回购组合', 3)
  expect(screen.getAllByLabelText('引用的选股方案')).toHaveLength(1)
  expect(screen.getByLabelText('引用的选股方案')).toHaveTextContent('订单与回购组合')
  expect(screen.getByRole('button', { name: '执行选股' })).toBeEnabled()
  expect(writes).toHaveLength(0)
  await user.click(screen.getByRole('button', { name: '执行选股' }))
  await waitFor(() => expect(writes.some(item => item.path.endsWith('/messages'))).toBe(true))
})

it('keeps available plans selectable when one catalog fails, and retries the failed catalog', async () => {
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation((input, init) => String(input).includes('/strategies?') ? Promise.resolve(new Response(JSON.stringify({ detail: '读取失败' }), { status: 503 })) : fallback(input, init))
  const user = userEvent.setup()
  render(<ConversationWorkspace initialNewDraft initialWorkflowType="screening" />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '引用方案' }))
  await screen.findByText(/条件组合读取失败/)
  expect(within(screen.getByRole('dialog', { name: '引用方案' })).getByRole('button', { name: '引用方案 量价趋势 第 2 版' })).toBeEnabled()
  vi.mocked(fetch).mockImplementation(fallback)
  await user.click(screen.getByRole('button', { name: '重新读取方案' }))
  await screen.findByRole('button', { name: '引用方案 订单与回购组合 第 3 版' })
  expect(writes).toHaveLength(0)
})

it('retains the original pinned plan when retrying a failed submitted request', async () => {
  const fallback = vi.mocked(fetch).getMockImplementation()!
  const original = { id: 'original', role: 'user', content: '请执行引用的方案', source_refs: [{ kind: 'saved_screening_task', source_id: saved.id, version: saved.version, title: saved.name, snapshot: { conditions: [] }, execution_requested: true }], created_at: timestamp }
  const stored = { id: 'current', task_id: 'current', entry_scope: 'screening', workflow_type: 'screening', state: 'active', task_revision: 0, pending_execution: false, active_run_id: null, messages: [original], turns: [{ id: 'failed', user_message_id: 'original', state: 'failed', response_text: null, result: {}, created_at: timestamp, updated_at: timestamp }], created_at: timestamp, updated_at: timestamp }
  vi.mocked(fetch).mockImplementation((input, init) => new URL(String(input), 'http://localhost').pathname === '/api/v1/conversations/current' ? Promise.resolve(new Response(JSON.stringify(stored))) : fallback(input, init))
  const user = userEvent.setup()
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="current" />)
  await user.click(await screen.findByRole('button', { name: '重新处理' }))
  await waitFor(() => expect(writes.some(item => item.path.endsWith('/messages'))).toBe(true))
  expect(writes.find(item => item.path.endsWith('/messages'))!.body.source_refs).toEqual([{ kind: 'saved_screening_task', source_id: saved.id, version: saved.version }])
  expect(writes.find(item => item.path.endsWith('/messages'))!.body.execute_plan).toBe(true)
})
