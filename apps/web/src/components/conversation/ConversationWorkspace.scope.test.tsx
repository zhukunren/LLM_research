import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Conversation, ResearchScope } from '../../api'
import ConversationWorkspace from './ConversationWorkspace'

const timestamp = '2026-10-08T08:00:00Z'
const emptyScope: ResearchScope = { as_of: null, stock_codes: [], report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: null }
const oldScope: ResearchScope = { as_of: '2026-10-08', stock_codes: ['600000.SH'], report_lookback_calendar_days: 30, news_lookback_calendar_days: 7, price_basis: 'unadjusted' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function setup(failPatch: 'reject' | 'lost' | 'invalid' | false = false) {
  const firstTurn = { id: 'daily-first', user_message_id: 'daily-question', base_revision: 0, state: 'succeeded' as const, response_text: '今日热点已整理', result: {}, research_scope: { ...oldScope }, created_at: timestamp, updated_at: timestamp }
  let stored: Conversation = { id: 'old-research', task_id: 'old-research', entry_scope: 'news', workflow_type: 'research', task_revision: 0,
    research_scope: oldScope, research_scope_revision: 7, active_run_id: null, pending_execution: false, state: 'active',
    messages: [{ id: 'daily-question', role: 'user', content: '按北京时间2026-10-08检索今日热点', source_refs: [], created_at: timestamp }, { id: 'daily-answer', role: 'assistant', content: '今日热点已整理', source_refs: [], created_at: timestamp }],
    turns: [firstTurn], created_at: timestamp, updated_at: timestamp }
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = []
  let patchCount = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path, method, body })
    if (path === '/api/v1/conversations') return json({ items: [stored] })
    if (path === '/api/v1/conversations/old-research') return json(stored)
    if (path.endsWith('/research-scope')) {
      patchCount++
      if (failPatch === 'reject' && patchCount === 1) return json({ message: '研究范围版本已经变化，请读取最新状态' }, 409)
      if (failPatch === 'invalid' && patchCount === 1) return json({ research_scope: oldScope, research_scope_revision: 8 })
      stored = { ...stored, research_scope: { ...emptyScope }, research_scope_revision: 8 }
      if (failPatch === 'lost' && patchCount === 1) return json({ message: '范围更新响应丢失，请重试' }, 503)
      return json({ research_scope: stored.research_scope, research_scope_revision: 8 })
    }
    if (path.endsWith('/messages')) {
      stored = { ...stored, messages: [...stored.messages, { id: 'next-question', role: 'user', content: String(body.content), source_refs: [], created_at: timestamp }, { id: 'next-answer', role: 'assistant', content: '已按自然语言问题继续研究', source_refs: [], created_at: timestamp }] }
      return json({ message_id: 'next-question', turn_id: 'next-turn', state: 'succeeded', base_revision: 0 })
    }
    return json({ items: [] })
  }))
  return { calls, firstTurn, stored: () => stored }
}

describe('unrestricted research follow-ups', () => {
  it('leaves an assistant first-turn date intact and clears every inherited limit only for a new follow-up', async () => {
    const { calls, firstTurn, stored } = setup()
    const user = userEvent.setup()
    render(<ConversationWorkspace initialScope="news" initialConversationId="old-research" data={{ available: true, last_date: '2020-01-01' }} />)
    await screen.findByText('今日热点已整理')
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0)
    expect(screen.queryByLabelText('研究截止日')).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '研究要求' }), '比较美股与港股的最新产业动态')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('已按自然语言问题继续研究')
    const writes = calls.filter(call => call.method !== 'GET')
    expect(writes.map(call => call.path)).toEqual(['/api/v1/conversations/old-research/research-scope', '/api/v1/conversations/old-research/messages'])
    expect(writes[0].body).toEqual({ base_revision: 7, ...emptyScope })
    expect(writes[1].body).toMatchObject({ research_scope_revision: 8, content: '比较美股与港股的最新产业动态' })
    expect(stored().turns[0]).toBe(firstTurn)
    expect(firstTurn.research_scope).toEqual(oldScope)
    expect(stored().research_scope).toEqual(emptyScope)
  })

  it.each(['reject', 'lost', 'invalid'] as const)('keeps the draft and never submits under hidden limits if scope clearing is %s', async failure => {
    const { calls } = setup(failure)
    const user = userEvent.setup()
    render(<ConversationWorkspace initialScope="news" initialConversationId="old-research" />)
    await screen.findByText('今日热点已整理')
    await user.type(screen.getByRole('textbox', { name: '研究要求' }), '继续研究最新政策')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText(failure === 'reject' ? '研究范围版本已经变化，请读取最新状态' : failure === 'lost' ? '范围更新响应丢失，请重试' : '研究设置暂未更新，请稍后重试。')
    expect(calls.some(call => call.path.endsWith('/messages'))).toBe(false)
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    expect(screen.getByRole('textbox', { name: '研究要求' })).toHaveValue('继续研究最新政策')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('已按自然语言问题继续研究')
    expect(calls.filter(call => call.path.endsWith('/messages'))).toHaveLength(1)
    expect(calls.find(call => call.path.endsWith('/messages'))!.body.research_scope_revision).toBe(8)
    expect(calls.filter(call => call.path.endsWith('/research-scope'))).toHaveLength(failure === 'lost' ? 1 : 2)
  })
})
