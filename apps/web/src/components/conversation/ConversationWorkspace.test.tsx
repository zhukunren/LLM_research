import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ConversationWorkspace from './ConversationWorkspace'
import type { Conversation, ConversationSourceReference, ScreeningTaskRevision, DataStatus } from '../../api'

it.each(['research', 'screening'] as const)('restores a first failed %s message with its draft, source and stable client identity', async workflow => {
  const user = userEvent.setup()
  const id = 'first-message-retry'
  let created = false
  let stored = conversation(id, { workflow_type: workflow })
  const writes: Record<string, unknown>[] = []
  let creations = 0
  const source = { reference: { kind: 'report_page' as const, source_id: 'document', page_number: 1 }, label: '失败重试的研报来源' }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/v1/conversations' && method === 'GET') return jsonResponse({ items: created ? [stored] : [] })
    if (path === '/api/v1/conversations' && method === 'POST') { created = true; creations++; return jsonResponse(stored) }
    if (path === `/api/v1/conversations/${id}/messages`) {
      const body = JSON.parse(String(init?.body)); writes.push(body)
      if (writes.length === 1) return jsonResponse({ message: '消息未保存，请重试' }, 503)
      stored = { ...stored, messages: [{ id: 'question', role: 'user', content: body.content, source_refs: body.source_refs, created_at: stored.created_at }],
        turns: [{ id: 'turn', user_message_id: 'question', base_revision: 0, state: 'awaiting_agent', response_text: null, result: {}, created_at: stored.created_at, updated_at: stored.updated_at }] }
      return jsonResponse({ message_id: 'question', turn_id: 'turn', source_refs: body.source_refs })
    }
    if (path.endsWith('/process')) {
      stored = { ...stored, messages: [...stored.messages, { id: 'answer', role: 'assistant', content: '重试已保存并处理', source_refs: [], created_at: stored.created_at }],
        turns: [{ ...stored.turns[0], state: 'succeeded', response_text: '重试已保存并处理' }] }
      return jsonResponse(stored.turns[0])
    }
    if (path === `/api/v1/conversations/${id}`) return jsonResponse(stored)
    return jsonResponse({ items: [], next_after: -1 })
  }))
  const label = workflow === 'research' ? '研究要求' : '选股要求'
  const submit = workflow === 'research' ? '发送' : '生成筛选方案'
  const view = render(<ConversationWorkspace initialWorkflowType={workflow} initialSource={source} />)
  await waitFor(() => expect(screen.getByLabelText(label)).toBeEnabled())
  await user.type(screen.getByLabelText(label), '需要保留的首次问题')
  await user.click(screen.getByRole('button', { name: submit }))
  await screen.findByText('消息未保存，请重试')
  await waitFor(() => expect(screen.getByLabelText(label)).toBeEnabled())
  expect(screen.getByLabelText(label)).toHaveValue('需要保留的首次问题')
  expect(screen.getByText(source.label)).toBeInTheDocument()
  view.unmount()
  render(<ConversationWorkspace initialWorkflowType={workflow} initialConversationId={id} />)
  await waitFor(() => expect(screen.getByLabelText(label)).toBeEnabled())
  expect(screen.getByLabelText(label)).toHaveValue('需要保留的首次问题')
  expect(screen.getByText(source.label)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: submit }))
  await screen.findByText('重试已保存并处理')
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  expect(creations).toBe(1)
  expect(stored.messages.filter(message => message.role === 'user')).toHaveLength(1)
  expect(JSON.parse(sessionStorage.getItem('conversation.drafts')!)[`${workflow}:screening:${id}`]).toBe('')
})

function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    task_id: id,
    entry_scope: 'screening',
    task_revision: 0,
    active_run_id: null,
    pending_execution: false,
    state: 'active',
    messages: [],
    turns: [],
    created_at: '2026-09-28T08:00:00+00:00',
    updated_at: '2026-09-28T08:00:00+00:00',
    ...overrides,
  }
}

function revision(id: string): ScreeningTaskRevision {
  return {
    task_id: id,
    revision: 1,
    original_user_messages: ['收盘价高于20日均线，筛一下'],
    conditions: [{
      condition_id: 'ma-close',
      library: 'technical',
      source_quote: '收盘价高于20日均线',
      description: '收盘价高于20日均线',
      expression: { op: 'indicator_compare', window: 20 },
    }],
    references: [{ reference_id: 'r-ma', condition_id: 'ma-close', parameter_overrides: {} }],
    logic_tree: { op: 'condition', reference_id: 'r-ma' },
    scope: {
      universe: { kind: 'all_a_shares', watchlist_id: null, stock_codes: [] },
      as_of: '2026-09-14',
      report_lookback_calendar_days: null,
      news_lookback_calendar_days: null,
      price_basis: null,
      ranking: null,
    },
    unresolved: [],
  }
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

it.each(['research', 'screening'] as const)('replays an accepted %s message after a lost response with original revisions and no duplicate UI message', async workflow => {
  const user = userEvent.setup()
  const id = 'accepted-message-replay'
  let stored = conversation(id, { workflow_type: workflow, research_scope_revision: 0 })
  let created = false
  const writes: Record<string, unknown>[] = []
  let processing = 0
  let scopeChanges = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    if (path.endsWith('/research-scope') && method === 'PATCH') { scopeChanges++; return jsonResponse({ message: '已接受回合重试不应修改范围' }, 409) }
    if (path === '/api/v1/conversations' && method === 'GET') return jsonResponse({ items: created ? [stored] : [] })
    if (path === '/api/v1/conversations' && method === 'POST') { created = true; return jsonResponse(stored) }
    if (path === `/api/v1/conversations/${id}/messages`) {
      const body = JSON.parse(String(init?.body)); writes.push(body)
      if (writes.length === 1) {
        stored = { ...stored, task_revision: workflow === 'screening' ? 1 : 0,
          research_scope_revision: workflow === 'research' ? 3 : 0,
          research_scope: { as_of: '2026-10-01', stock_codes: [] },
          messages: [{ id: 'original-question', role: 'user', content: body.content, source_refs: [], created_at: stored.created_at },
            { id: 'original-answer', role: 'assistant', content: '后台已完成原回合', source_refs: [], created_at: stored.created_at }],
          turns: [{ id: 'original-turn', user_message_id: 'original-question', base_revision: 0, state: 'succeeded', response_text: '后台已完成原回合', result: {}, created_at: stored.created_at, updated_at: stored.updated_at }] }
        return jsonResponse({ message: '原消息响应丢失' }, 503)
      }
      expect(body).toEqual(writes[0])
      return jsonResponse({ message_id: 'original-question', turn_id: 'original-turn', state: 'succeeded', idempotent_replay: true })
    }
    if (path.endsWith('/process')) { processing++; return jsonResponse(stored.turns[0]) }
    if (path.endsWith('/revisions/1')) return jsonResponse(revision(id))
    if (path === `/api/v1/conversations/${id}`) return jsonResponse(stored)
    return jsonResponse({ items: [] })
  }))
  render(<ConversationWorkspace initialWorkflowType={workflow} />)
  const label = workflow === 'research' ? '研究要求' : '选股要求'
  await waitFor(() => expect(screen.getByLabelText(label)).toBeEnabled())
  await user.type(screen.getByLabelText(label), '原始首次问题')
  await user.click(screen.getByRole('button', { name: workflow === 'research' ? '发送' : '生成筛选方案' }))
  await screen.findByText('原消息响应丢失')
  await screen.findByText('后台已完成原回合')
  await waitFor(() => expect(screen.getByLabelText(label)).toBeEnabled())
  expect(screen.getByLabelText(label)).toHaveValue('原始首次问题')
  await user.click(screen.getByRole('button', { name: workflow === 'research' ? '发送' : '发送修改' }))
  await waitFor(() => expect(screen.getByLabelText(label)).toHaveValue(''))
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  expect(processing).toBe(0)
  expect(scopeChanges).toBe(0)
  expect(screen.getByRole('log').querySelectorAll('.conversation-message.user')).toHaveLength(1)
})

it.each(['succeeded', 'failed'] as const)('keeps a new research conversation renderable after a metadata-only create when processing %s', async (state) => {
  const user = userEvent.setup()
  const id = 'metadata-only-create'
  let stored = conversation(id, { workflow_type: 'research', research_scope_revision: 0 })
  const writes: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    if (method !== 'GET') writes.push(path)
    if (path === '/api/v1/conversations' && method === 'GET') return jsonResponse({ items: [] })
    if (path === '/api/v1/conversations' && method === 'POST') {
      const { messages: _messages, turns: _turns, ...metadata } = stored
      return jsonResponse(metadata)
    }
    if (path.endsWith('/research-scope') && method === 'PATCH') {
      stored = { ...stored, research_scope: { as_of: '2026-10-05', stock_codes: [] }, research_scope_revision: 1 }
      return jsonResponse({ research_scope: stored.research_scope, research_scope_revision: 1 })
    }
    if (path.endsWith('/messages') && method === 'POST') {
      // Let React render the scope update before the full GET response arrives.
      await new Promise(resolve => setTimeout(resolve, 20))
      const message = { id: 'question', role: 'user' as const, content: '核验公告来源', source_refs: [], created_at: stored.created_at }
      stored = { ...stored, messages: [message] }
      return jsonResponse({ message_id: message.id, turn_id: 'turn', base_revision: 0, state: 'awaiting_agent' }, 202)
    }
    if (path.endsWith('/turns/turn/process')) {
      const answer = { id: 'answer', role: 'assistant' as const, content: state === 'succeeded' ? '已核验公告来源' : 'Codex 状态目录不可写', source_refs: [], created_at: stored.created_at }
      stored = { ...stored, messages: [...stored.messages, answer], turns: [{ id: 'turn', user_message_id: 'question', base_revision: 0, state, response_text: answer.content, result: {}, created_at: stored.created_at, updated_at: stored.updated_at }] }
      return jsonResponse(stored.turns[0])
    }
    if (path === `/api/v1/conversations/${id}`) return jsonResponse(stored)
    return jsonResponse({ items: [] })
  }))
  render(<ConversationWorkspace data={{ available: true, last_date: '2026-10-05' } as DataStatus} />)
  const input = await screen.findByLabelText('研究要求')
  await waitFor(() => expect(input).toBeEnabled())
  await user.type(input, '核验公告来源')
  await user.click(screen.getByRole('button', { name: '发送' }))
  expect(await screen.findByText(state === 'succeeded' ? '已核验公告来源' : 'Codex 状态目录不可写')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '研究对话' })).toBeInTheDocument()
  expect(writes.filter(path => path.endsWith('/messages'))).toHaveLength(1)
  expect(writes.some(path => path.endsWith('/research-scope'))).toBe(false)
})

describe('ConversationWorkspace', () => {
  it('accepts an asynchronous research job, preserves the user request and can stop it after acknowledgement', async () => {
    const user = userEvent.setup()
    const id = 'async-research'
    const created_at = '2026-09-30T00:00:00Z'
    let stored = conversation(id)
    let received = ''
    const writes: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = init?.method || 'GET'
      if (method === 'POST') writes.push(url.pathname)
      if (url.pathname === '/api/v1/conversations') return jsonResponse(method === 'POST' ? stored : { items: [] })
      if (url.pathname === `/api/v1/conversations/${id}`) return jsonResponse(stored)
      if (url.pathname.endsWith('/messages')) {
        received = JSON.parse(String(init?.body)).content
        stored = { ...stored, messages: [{ id: 'question', role: 'user', content: received, source_refs: [], created_at }],
          turns: [{ id: 'turn', user_message_id: 'question', base_revision: 0, state: 'awaiting_agent', response_text: null, result: {}, created_at, updated_at: created_at }] }
        return jsonResponse({ message_id: 'question', turn_id: 'turn', state: 'awaiting_agent' }, 202)
      }
      if (url.pathname.endsWith('/process')) {
        stored = { ...stored, turns: [{ ...stored.turns[0], job: { id: 'job', state: 'queued', progress: 0, message: '等待研究' } }] }
        return jsonResponse(stored.turns[0], 202)
      }
      if (url.pathname.endsWith('/cancel')) {
        stored = { ...stored, turns: [{ ...stored.turns[0], state: 'cancelled', response_text: '研究已停止' }],
          messages: [...stored.messages, { id: 'answer', role: 'assistant', content: '研究已停止', source_refs: [], created_at }] }
        return jsonResponse(stored.turns[0])
      }
      return jsonResponse({ items: [], next_after: -1 })
    }))
    const view = render(<ConversationWorkspace data={{ last_date: '2026-09-30' } as DataStatus} />)
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
    await user.type(screen.getByLabelText(/研究要求|选股要求/), '独立研究公司的订单与盈利质量')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '停止当前研究' })).toBeEnabled())
    expect(received).toBe('独立研究公司的订单与盈利质量')
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    await user.type(screen.getByLabelText(/研究要求|选股要求/), '下一条问题，先保留草稿')
    expect(screen.queryByRole('button', { name: '继续处理' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '停止当前研究' }))
    expect(await screen.findByText('研究已停止')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
    expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('下一条问题，先保留草稿')
    expect(writes.some(path => path.endsWith('/execute'))).toBe(false)
    view.unmount()
  })

  it('reconnects a restored running turn, unlocks the composer, and stops polling on completion', async () => {
    const user = userEvent.setup()
    const id = 'restored-running'
    const created_at = '2026-09-30T00:00:00+00:00'
    let stored = conversation(id, {
      messages: [{ id: 'question', role: 'user', content: '解释行情覆盖', source_refs: [], created_at }],
      turns: [{ id: 'processing', user_message_id: 'question', base_revision: 0, state: 'running',
        response_text: null, result: {}, created_at, updated_at: created_at }],
    })
    let reads = 0
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.pathname === '/api/v1/conversations') return jsonResponse({ items: [{ ...stored, title: '恢复研究' }] })
      if (url.pathname === `/api/v1/conversations/${id}`) { reads++; return jsonResponse(stored) }
      if (url.pathname.endsWith('/codex-events')) return jsonResponse({ items: [], next_after: -1 })
      return jsonResponse({ items: [] })
    }))
    const view = render(<ConversationWorkspace />)
    await screen.findAllByText('解释行情覆盖')
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    await user.type(screen.getByLabelText(/研究要求|选股要求/), '完成后继续核对来源')
    stored = {
      ...stored,
      messages: [...stored.messages, { id: 'answer', role: 'assistant', content: '后端已完成行情覆盖检查', source_refs: [], created_at }],
      turns: stored.turns.map(turn => ({ ...turn, state: 'succeeded', response_text: '后端已完成行情覆盖检查' })),
    }
    expect(await screen.findByText('后端已完成行情覆盖检查', {}, { timeout: 3000 })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText(/研究要求|选股要求/)).toBeEnabled())
    expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('完成后继续核对来源')
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
    const completedReads = reads
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1400)) })
    expect(reads).toBe(completedReads)
    expect(calls.some(call => call.startsWith('POST '))).toBe(false)
    view.unmount()
  })

  it('resumes an already-authorized execution after restoring a completed turn exactly once', async () => {
    const id = 'restored-authorized'
    let stored = conversation(id, { workflow_type: 'screening', task_revision: 1, pending_execution: true,
      messages: [{ id: 'request', role: 'user', content: '按这个筛', source_refs: [], created_at: '2026-09-30' }],
      turns: [{ id: 'ready', user_message_id: 'request', base_revision: 1, state: 'succeeded', response_text: '条件已核对',
        result: { ready_to_execute: true, execution_authorized: true, task_revision: 1 }, created_at: '2026-09-30', updated_at: '2026-09-30' }],
    })
    let submissions = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/v1/conversations') return jsonResponse({ items: [{ ...stored, title: '恢复已授权研究' }] })
      if (path === `/api/v1/conversations/${id}`) return jsonResponse(stored)
      if (path.endsWith('/revisions/1')) return jsonResponse(revision(id))
      if (path.endsWith('/execute') && init?.method === 'POST') {
        submissions++
        stored = { ...stored, pending_execution: false, active_run_id: 'restored-run' }
        return jsonResponse({ run_id: 'restored-run' }, 202)
      }
      if (path.endsWith('/screening-runs/restored-run')) return jsonResponse({
        id: 'restored-run', as_of: '2026-09-14', status: 'queued', task_revision: 1, task: revision(id),
        job_id: 'job', result: {}, job: { state: 'queued', progress: 0, message: '已恢复排队' },
      })
      if (path.endsWith('/screening-runs')) return jsonResponse({ items: stored.active_run_id
        ? [{ id: 'restored-run', task_revision: 1, as_of: '2026-09-14', status: 'queued', created_at: '2026-09-30' }] : [] })
      return jsonResponse({ items: [] })
    }))
    const view = render(<ConversationWorkspace initialWorkflowType="screening" />)
    await screen.findByText('已恢复排队')
    expect(submissions).toBe(1)
    expect(stored.pending_execution).toBe(false)
    view.unmount()
  })

  it('persists a user turn and shows its clarification without creating a run', async () => {
    const user = userEvent.setup()
    const id = 'conversation-1'
    let stored = conversation(id)
    const calls: string[] = []
    vi.stubGlobal('crypto', { randomUUID: () => 'client-message-1' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url.pathname}`)
      if (url.pathname === '/api/v1/conversations' && method === 'GET') return jsonResponse({ items: [] })
      if (url.pathname === '/api/v1/conversations' && method === 'POST') return jsonResponse(stored)
      if (url.pathname.endsWith('/messages') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { content: string }
        const message = { id: 'message-1', role: 'user' as const, content: body.content, source_refs: [], created_at: '2026-09-28T08:01:00+00:00' }
        stored = { ...stored, messages: [message] }
        return jsonResponse({ message_id: message.id, turn_id: 'turn-1', base_revision: 0, state: 'awaiting_agent' }, 202)
      }
      if (url.pathname.endsWith('/turns/turn-1/process')) {
        const assistant = { id: 'assistant-1', role: 'assistant' as const, content: '筛选范围是全部A股、自选池，还是指定的股票？', source_refs: [], created_at: '2026-09-28T08:02:00+00:00' }
        stored = {
          ...stored,
          messages: [...stored.messages, assistant],
          turns: [{ id: 'turn-1', user_message_id: 'message-1', base_revision: 0, state: 'awaiting_user', response_text: assistant.content, result: { ready_to_execute: false }, created_at: '2026-09-28T08:01:00+00:00', updated_at: '2026-09-28T08:02:00+00:00' }],
        }
        return jsonResponse(stored.turns[0])
      }
      if (url.pathname === `/api/v1/conversations/${id}`) return jsonResponse(stored)
      if (url.pathname.endsWith('/screening-runs')) return jsonResponse({ items: [] })
      return jsonResponse({ message: `Unhandled ${method} ${url.pathname}` }, 404)
    }))

    render(<ConversationWorkspace />)
    const input = await screen.findByLabelText(/研究要求|选股要求/)
    await user.type(input, '收盘价高于20日均线，筛一下')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByText('筛选范围是全部A股、自选池，还是指定的股票？')).toBeInTheDocument()
    expect(calls.some((call) => call.includes('/execute'))).toBe(false)
    expect(stored.task_revision).toBe(0)
  })

  it('queues an authorized run and displays its saved per-stock result', async () => {
    const user = userEvent.setup()
    const id = 'conversation-2'
    const initialMessage = { id: 'message-initial', role: 'user' as const, content: '收盘价高于20日均线，筛一下', source_refs: [], created_at: '2026-09-28T08:00:00+00:00' }
    const assistantMessage = { id: 'assistant-initial', role: 'assistant' as const, content: '筛选条件已确认，执行授权已记录。', source_refs: [], created_at: '2026-09-28T08:00:30+00:00' }
    let stored = conversation(id, {
      workflow_type: 'screening',
      task_revision: 1,
      messages: [initialMessage, assistantMessage],
      turns: [{ id: 'turn-initial', user_message_id: initialMessage.id, base_revision: 0, state: 'succeeded', response_text: assistantMessage.content, result: { ready_to_execute: true, execution_authorized: true }, created_at: '2026-09-28T08:00:00+00:00', updated_at: '2026-09-28T08:00:30+00:00' }],
    })
    const calls: string[] = []
    const runId = 'run-1'
    const runDetail = {
      id: runId,
      conversation_id: id,
      task_revision: 1,
      execution_request_id: 'request-1',
      job_id: 'job-1',
      as_of: '2026-09-14',
      status: 'partial',
      execution_version: 'screening-task-v1',
      task: revision(id),
      result: { coverage: { target_total: 1, true_count: 1, false_count: 0, unknown_count: 0, failed_count: 0, not_evaluated_count: 0 } },
      job: { state: 'partial', progress: 1, message: '筛选完成' },
    }
    vi.stubGlobal('crypto', { randomUUID: () => 'client-message-2' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url.pathname}`)
      if (url.pathname === '/api/v1/conversations' && url.searchParams.has('scope')) return jsonResponse({ items: [{ id, entry_scope: 'screening', workflow_type: 'screening', task_revision: stored.task_revision, active_run_id: stored.active_run_id, state: 'active', title: initialMessage.content, updated_at: stored.updated_at }] })
      if (url.pathname === `/api/v1/conversations/${id}`) return jsonResponse(stored)
      if (url.pathname.endsWith('/revisions/1')) return jsonResponse(revision(id))
      if (url.pathname === `/api/v1/conversations/${id}/screening-runs`) return jsonResponse({ items: stored.active_run_id ? [{ id: runId, task_revision: 1, as_of: '2026-09-14', status: 'partial', job_id: 'job-1', created_at: stored.updated_at, finished_at: stored.updated_at }] : [] })
      if (url.pathname.endsWith('/messages') && method === 'POST') {
        const message = { id: 'message-2', role: 'user' as const, content: '按这个筛', source_refs: [], created_at: '2026-09-28T08:03:00+00:00' }
        stored = { ...stored, messages: [...stored.messages, message] }
        return jsonResponse({ message_id: message.id, turn_id: 'turn-2', base_revision: 1, state: 'awaiting_agent' }, 202)
      }
      if (url.pathname.endsWith('/turns/turn-2/process')) return jsonResponse({ id: 'turn-2', result: { ready_to_execute: true } })
      if (url.pathname.endsWith('/turns/turn-2/execute')) {
        stored = { ...stored, active_run_id: runId, pending_execution: false }
        return jsonResponse({ run_id: runId, job_id: 'job-1', status: 'queued' }, 202)
      }
      if (url.pathname === `/api/v1/conversations/${id}/screening-runs/${runId}`) return jsonResponse(runDetail)
      if (url.pathname.endsWith(`/screening-runs/${runId}/decisions`)) return jsonResponse({ items: [{ stock_code: '600000.SH', state: 'true', evaluation_status: 'completed', reason_code: 'condition_met', condition_decisions: [{ condition_id: 'ma-close', reference_id: 'r-ma', state: 'true', evaluation_status: 'completed', reason_code: 'condition_met', explanation: '符合条件', actual_values: {}, thresholds: {}, units: {} }] }], total: 1, offset: 0, limit: 20 })
      return jsonResponse({ message: `Unhandled ${method} ${url.pathname}` }, 404)
    }))

    render(<ConversationWorkspace initialWorkflowType="screening" />)
    await screen.findByText('筛选条件已确认，执行授权已记录。')
    await user.type(screen.getByLabelText(/研究要求|选股要求/), '按这个筛')
    await user.click(screen.getByRole('button', { name: '发送修改' }))

    expect(await screen.findByText('600000.SH')).toBeInTheDocument()
    await user.click(screen.getByText('600000.SH'))
    await user.click(screen.getByRole('button', { name: '追问这只股票' }))
    expect(screen.getByLabelText(/研究要求|选股要求/)).toHaveValue('为什么这次选中了600000.SH？')
    expect(calls.filter((call) => call.includes('/turns/turn-2/execute'))).toHaveLength(1)
    expect(screen.getByText('当前运行 · v1')).toBeInTheDocument()
    expect(screen.getByText('数据截止日：2026-09-14')).toBeInTheDocument()
  })

  it('attaches a report page reference to the first message from a report page', async () => {
    const user = userEvent.setup()
    const id = 'report-conversation'
    let stored = conversation(id, { entry_scope: 'report' })
    let submittedSources: ConversationSourceReference[] = []
    vi.stubGlobal('crypto', { randomUUID: () => 'report-message' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const method = init?.method ?? 'GET'
      if (url.pathname === '/api/v1/conversations' && method === 'GET') return jsonResponse({ items: [] })
      if (url.pathname === '/api/v1/conversations' && method === 'POST') return jsonResponse(stored)
      if (url.pathname.endsWith('/messages') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { content: string; source_refs: ConversationSourceReference[] }
        submittedSources = body.source_refs
        stored = {
          ...stored,
          messages: [{ id: 'report-message', role: 'user' as const, content: body.content, source_refs: body.source_refs, created_at: '2026-09-28T08:01:00+00:00' }],
        }
        return jsonResponse({ message_id: 'report-message', turn_id: 'report-turn', base_revision: 0, state: 'awaiting_agent', source_refs: body.source_refs }, 202)
      }
      if (url.pathname.endsWith('/turns/report-turn/process')) {
        const assistant = { id: 'report-assistant', role: 'assistant' as const, content: '我会基于所选研报页回答。', source_refs: [], created_at: '2026-09-28T08:02:00+00:00' }
        stored = { ...stored, messages: [...stored.messages, assistant] }
        return jsonResponse({ id: 'report-turn', state: 'succeeded', result: { ready_to_execute: false } })
      }
      if (url.pathname === `/api/v1/conversations/${id}`) return jsonResponse(stored)
      if (url.pathname.endsWith('/screening-runs')) return jsonResponse({ items: [] })
      return jsonResponse({ message: `Unhandled ${method} ${url.pathname}` }, 404)
    }))

    render(<ConversationWorkspace
      initialScope="report"
      initialSource={{
        reference: { kind: 'report_page', source_id: 'doc-1', page_number: 2 },
        label: '订单研究 · 第 2 页',
      }}
    />)
    expect(await screen.findByText('订单研究 · 第 2 页')).toBeInTheDocument()
    await user.type(screen.getByLabelText(/研究要求|选股要求/), '这页提到了哪些订单证据？')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await screen.findByText('我会基于所选研报页回答。')
    expect(submittedSources).toEqual([{ kind: 'report_page', source_id: 'doc-1', page_number: 2 }])
  })
})
