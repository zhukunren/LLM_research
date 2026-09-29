import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ConversationWorkspace from './ConversationWorkspace'
import type { Conversation, ConversationSourceReference, ScreeningTaskRevision } from '../../api'

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

describe('ConversationWorkspace', () => {
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
    const input = await screen.findByLabelText('筛选要求')
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
      if (url.pathname === '/api/v1/conversations' && url.searchParams.has('scope')) return jsonResponse({ items: [{ id, entry_scope: 'screening', task_revision: stored.task_revision, active_run_id: stored.active_run_id, state: 'active', title: initialMessage.content, updated_at: stored.updated_at }] })
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

    render(<ConversationWorkspace />)
    await screen.findByText('筛选条件已确认，执行授权已记录。')
    await user.type(screen.getByLabelText('筛选要求'), '按这个筛')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByText('600000.SH')).toBeInTheDocument()
    await user.click(screen.getByText('600000.SH'))
    await user.click(screen.getByRole('button', { name: '追问这只股票' }))
    expect(screen.getByLabelText('筛选要求')).toHaveValue('为什么这次选中了600000.SH？')
    expect(calls.filter((call) => call.includes('/turns/turn-2/execute'))).toHaveLength(1)
    expect(screen.getByText('当前运行 · v1 · 2026-09-14')).toBeInTheDocument()
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
    await user.type(screen.getByLabelText('筛选要求'), '这页提到了哪些订单证据？')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await screen.findByText('我会基于所选研报页回答。')
    expect(submittedSources).toEqual([{ kind: 'report_page', source_id: 'doc-1', page_number: 2 }])
  })
})
