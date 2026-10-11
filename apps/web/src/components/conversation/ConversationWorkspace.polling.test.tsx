import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../../api'
import ConversationWorkspace from './ConversationWorkspace'

const startedAt = '2026-10-11T02:00:00.000Z'
type Event = { sequence: number; method: string; payload: Record<string, unknown> }

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
}

function runningConversation(): Conversation {
  return {
    id: 'polling-research', task_id: 'polling-research', entry_scope: 'screening', workflow_type: 'research',
    task_revision: 0, active_run_id: null, pending_execution: false, state: 'active',
    created_at: startedAt, updated_at: startedAt,
    messages: [{ id: 'question', role: 'user', content: '核对研究进展', source_refs: [], created_at: startedAt }],
    turns: [{ id: 'turn', user_message_id: 'question', base_revision: 0, state: 'running',
      response_text: null, result: {}, created_at: startedAt, updated_at: startedAt,
      job: { id: 'job', state: 'running', progress: 0, message: '正在研究' } }],
  }
}

async function openRunningConversation(events: Event[]) {
  const stored = runningConversation()
  const cursors: number[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/v1/conversations') return json({ items: [stored] })
    if (url.pathname === `/api/v1/conversations/${stored.id}`) return json(stored)
    if (url.pathname.endsWith('/codex-events')) {
      const after = Number(url.searchParams.get('after'))
      const limit = Number(url.searchParams.get('limit'))
      cursors.push(after)
      const remaining = events.filter(event => event.sequence > after)
      const items = remaining.slice(0, limit)
      return json({ items, next_after: items.at(-1)?.sequence ?? after, has_more: remaining.length > limit })
    }
    return json({ items: [] })
  }))
  await act(async () => {
    render(<ConversationWorkspace initialConversationId={stored.id} initialWorkflowType="research" />)
  })
  return cursors
}

afterEach(() => vi.useRealTimers())

describe('research event polling', () => {
  it('advances past the final page so commentary deltas are applied only once', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(startedAt)
    // The commentary starts on one page; its incomplete delta is on the tail
    // page. Replaying that tail must not append the same text a second time.
    const events: Event[] = [
      { sequence: 0, method: 'item/started', payload: { item: { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: '' } } },
      ...Array.from({ length: 499 }, (_, index) => ({ sequence: index + 1, method: 'ignored/event', payload: {} })),
      { sequence: 500, method: 'item/agentMessage/delta', payload: { itemId: 'commentary', delta: '正在核对原始公告。' } },
    ]
    const cursors = await openRunningConversation(events)
    expect(cursors).toEqual([-1, 499])
    expect(screen.getByText('正在核对原始公告。', { selector: '.research-progress-commentary' })).toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(2400) })

    expect(cursors).toEqual([-1, 499, 500, 500])
    expect(screen.getByText('正在核对原始公告。', { selector: '.research-progress-commentary' })).toBeInTheDocument()
    expect(screen.queryByText('正在核对原始公告。正在核对原始公告。')).not.toBeInTheDocument()
  })

  it('does not treat an unchanged final event page as fresh progress during a long wait', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(startedAt)
    const cursors = await openRunningConversation([
      { sequence: 7, method: 'turn/started', payload: {} },
    ])
    expect(cursors).toEqual([-1])

    await act(async () => { await vi.advanceTimersByTimeAsync(91200) })

    expect(cursors.slice(1).length).toBeGreaterThan(1)
    expect(cursors.slice(1).every(cursor => cursor === 7)).toBe(true)
    expect(screen.getByText('仍在处理，可继续等待或停止。')).toBeInTheDocument()
  })
})
