import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import LibraryWorkspace from './LibraryWorkspace'
import type { LibrarySeed } from '../libraryContext'

vi.mock('./ReportPage', async () => {
  const { useState } = await import('react')
  return { default: ({ onDescribe, onDefineCondition }: { onDescribe: (source: Omit<LibrarySeed, 'id'>) => void; onDefineCondition: (source: Omit<LibrarySeed, 'id'>) => void }) => {
    const [page, setPage] = useState(3)
    const source = { source_document_id: 'report1', source_page: page, title: '订单报告' }
    return <><p>当前原文第 {page} 页</p><button onClick={() => onDescribe(source)}>研究当前资料</button><button onClick={() => onDefineCondition(source)}>用于选股</button><button onClick={() => setPage(page + 1)}>下一页原文</button></>
  } }
})
vi.mock('./NewsPage', () => ({ default: () => null }))
vi.mock('../components/DisclosuresPanel', () => ({ default: () => null }))
const stamp = '2026-10-28T00:00:00Z'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const catalog = { account_tier: 'free', default_model_id: 'qa-model', default_reasoning_effort: 'high', discovery_status: 'verified', models: [{ id: 'qa-model', label: '测试模型', description: '测试', available: true, unavailable_reason: null, default_reasoning_effort: 'high', reasoning_efforts: [{ id: 'high', label: '深入' }] }] }
beforeAll(async () => { await import('../components/conversation/ConversationWorkspace') }, 30000)

function mockApi(failFirst = false) {
  let failed = false
  const messages: Record<string, unknown>[] = [], created: Record<string, unknown>[] = []
  let conversation: Record<string, unknown> = {}
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (path === '/research-models') return json(catalog)
    if (path === '/conversations' && method === 'POST') {
      created.push(body)
      conversation = { id: 'c1', task_id: 'c1', entry_scope: body.entry_scope, workflow_type: body.workflow_type, research_mode: body.workflow_type, research_depth: 'standard', model_id: 'qa-model', reasoning_effort: 'high', state: 'active', task_revision: 0, pending_execution: false, active_run_id: null, messages: [], turns: [], created_at: stamp, updated_at: stamp }
      return json(conversation)
    }
    if (path === '/conversations/c1') return json(conversation)
    if (path === '/conversations/c1/messages' && method === 'POST') {
      messages.push(body)
      if (failFirst && !failed) { failed = true; return json({ message: '连接暂时中断' }, 503) }
      conversation.messages = [{ id: 'm1', role: 'user', content: body.content, source_refs: body.source_refs, created_at: stamp }]
      conversation.turns = [{ id: 't1', user_message_id: 'm1', state: 'awaiting_agent', response_text: '', result: {}, created_at: stamp, updated_at: stamp }]
      return json({ message_id: 'm1', turn_id: 't1', state: 'awaiting_agent', base_revision: 0, source_refs: body.source_refs })
    }
    if (path.endsWith('/process') && method === 'POST') {
      const turn = { id: 't1', user_message_id: 'm1', state: 'succeeded', response_text: '订单研究答复已保存。', result: { ready_to_execute: false }, created_at: stamp, updated_at: stamp }
      conversation.turns = [turn]
      conversation.messages = [...conversation.messages as object[], { id: 'a1', role: 'assistant', content: turn.response_text, turn_id: 't1', source_refs: [], created_at: stamp }]
      return json(turn)
    }
    return json({ items: [], total: 0, next_offset: null })
  })
  vi.stubGlobal('fetch', fetcher)
  return { fetcher, created, messages }
}
beforeEach(() => window.history.replaceState(null, '', '#/library?type=reports'))
const props = () => ({ scope: 'report' as const, data: { available: true, last_date: '2026-10-27' }, onConversation: vi.fn(), onCompose: vi.fn(), onSettings: vi.fn() })

it('keeps reading and navigation in place, isolates drafts by source page and workflow, and restores them after remount', async () => {
  const api = mockApi(), callbacks = props(), user = userEvent.setup()
  sessionStorage.setItem('conversation.drafts', JSON.stringify({ 'research:report:new': '普通工作区草稿' }))
  const view = render(<LibraryWorkspace {...callbacks} />)
  await user.click(await screen.findByRole('button', { name: '研究当前资料' }))
  const dialog = await screen.findByRole('dialog', { name: '研究当前资料' })
  const input = await within(dialog).findByLabelText('研究要求')
  await waitFor(() => expect(input).toBeEnabled())
  await user.clear(input); await user.type(input, '保留这一页的研究问题')
  await user.click(within(dialog).getByRole('button', { name: '关闭资料助手' }))
  expect(screen.getByText('当前原文第 3 页')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '用于选股' }))
  const screening = await screen.findByRole('dialog', { name: '用于选股' })
  await waitFor(() => expect((within(screening).getByLabelText('选股要求') as HTMLTextAreaElement).value).toContain('先形成草稿'))
  await user.click(within(screening).getByRole('button', { name: '关闭资料助手' }))
  await user.click(screen.getByRole('button', { name: '研究当前资料' }))
  expect(screen.getByLabelText('研究要求')).toHaveValue('保留这一页的研究问题')
  await user.click(screen.getByRole('button', { name: '关闭资料助手' }))
  view.unmount()
  render(<LibraryWorkspace {...callbacks} />)
  await user.click(await screen.findByRole('button', { name: '研究当前资料' }))
  expect(await screen.findByLabelText('研究要求')).toHaveValue('保留这一页的研究问题')
  await user.click(screen.getByRole('button', { name: '关闭资料助手' }))
  await user.click(screen.getByRole('button', { name: '下一页原文' }))
  await user.click(screen.getByRole('button', { name: '研究当前资料' }))
  expect(await screen.findByLabelText('研究要求')).not.toHaveValue('保留这一页的研究问题')
  expect(screen.getByRole('dialog')).toHaveTextContent('订单报告 · 第4页')
  expect(api.created).toHaveLength(0)
  expect(callbacks.onConversation).not.toHaveBeenCalled()
  expect(window.location.hash).toBe('#/library?type=reports')
  expect(JSON.parse(sessionStorage.getItem('conversation.drafts')!)).toEqual({ 'research:report:new': '普通工作区草稿' })
})

it('retries the same source-bound message after closing, keeps the conversation identity, and shows answers in the reading drawer', async () => {
  const api = mockApi(true), callbacks = props(), user = userEvent.setup()
  render(<LibraryWorkspace {...callbacks} />)
  await user.click(await screen.findByRole('button', { name: '研究当前资料' }))
  const dialog = await screen.findByRole('dialog', { name: '研究当前资料' })
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '发送' })).toBeEnabled())
  await user.click(within(dialog).getByRole('button', { name: '发送' }))
  await within(dialog).findByText('连接暂时中断')
  await user.click(within(dialog).getByRole('button', { name: '关闭资料助手' }))
  await user.click(screen.getByRole('button', { name: '研究当前资料' }))
  await user.click(screen.getByRole('button', { name: '发送' }))
  expect(await screen.findByText('订单研究答复已保存。')).toBeInTheDocument()
  expect(api.created).toHaveLength(1)
  expect(api.messages).toHaveLength(2)
  expect(api.messages[0]).toEqual(api.messages[1])
  expect(api.messages[0].source_refs).toEqual([{ kind: 'report_page', source_id: 'report1', page_number: 3 }])
  expect(callbacks.onConversation).not.toHaveBeenCalled()
  expect(window.location.hash).toBe('#/library?type=reports')
  await user.click(screen.getByRole('button', { name: '成果与文件' }))
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByRole('region', { name: '研究成果' })).toBeInTheDocument()
})
