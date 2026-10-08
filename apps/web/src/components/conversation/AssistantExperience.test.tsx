import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import ConversationWorkspace from './ConversationWorkspace'
import type { Conversation, ResearchAssistant } from '../../api'

const profiles: ResearchAssistant[] = ['general', 'financial', 'risk'].map((id, index) => ({ id, name: ['通用投研', '财报分析', '风险复核'][index], description: id, instructions: `研究方法 ${id}`, enabled: true, builtin: true, revision: 1, skill_hash: id }))
const date = '2026-10-07T12:00:00Z'
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

it('persists a draft assistant, submits it with its revision and restores the saved selection', async () => {
  let stored: Conversation | null = null
  const writes: { path: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      const body = init.body ? JSON.parse(String(init.body)) : {}; writes.push({ path, body })
      if (path === '/conversations') {
        stored = { id: 'one', task_id: 'one', entry_scope: 'screening', workflow_type: 'research', research_depth: 'standard', assistant: profiles.find(item => item.id === body.assistant_id)!, assistant_revision: 0, task_revision: 0, pending_execution: false, active_run_id: null, state: 'active', messages: [], turns: [], created_at: date, updated_at: date }
        return json(stored)
      }
      if (path.endsWith('/messages')) { stored!.messages = [{ id: 'user-one', role: 'user', content: body.content, source_refs: [], created_at: date }]; return json({ message_id: 'user-one', turn_id: 'turn-one' }) }
      if (path.endsWith('/process')) { stored!.messages.push({ id: 'answer', role: 'assistant', content: '测试答复', source_refs: [], created_at: date }); return json({ id: 'turn-one', state: 'succeeded', result: {} }) }
      if (path.endsWith('/assistant')) { stored!.assistant = profiles.find(item => item.id === body.assistant_id); stored!.assistant_revision = 1; return json({ assistant: stored!.assistant, assistant_revision: 1 }) }
    }
    return json(path === '/research-assistants' ? { items: profiles } : path === '/conversations/one' ? stored : path === '/conversations' ? { items: stored ? [stored] : [] } : { items: [] })
  }))
  const user = userEvent.setup()
  let view = render(<ConversationWorkspace initialNewDraft />)
  await waitFor(() => expect(screen.getByRole('button', { name: '添加文件或研究助手' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '添加文件或研究助手' }))
  await user.click(screen.getByRole('menuitem', { name: '调用研究助手' }))
  await user.click(await screen.findByRole('menuitem', { name: '使用财报分析' }))
  expect(writes).toHaveLength(0)
  view.unmount()
  view = render(<ConversationWorkspace initialNewDraft />)
  await waitFor(() => expect(screen.getByRole('button', { name: '添加文件或研究助手' })).toBeEnabled())
  expect(screen.getByLabelText('当前研究助手')).toHaveTextContent('财报分析')
  await user.type(screen.getByLabelText('研究要求'), '核验现金流')
  await user.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('测试答复'))
  expect(writes.find(item => item.path === '/conversations')?.body.assistant_id).toBe('financial')
  expect(writes.find(item => item.path.endsWith('/messages'))?.body.assistant_revision).toBe(0)
  view.unmount()
  render(<ConversationWorkspace initialConversationId="one" />)
  await waitFor(() => expect(screen.getByLabelText('当前研究助手')).toHaveTextContent('财报分析'))
  await waitFor(() => expect(screen.getByRole('button', { name: '添加文件或研究助手' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '添加文件或研究助手' }))
  await user.click(screen.getByRole('menuitem', { name: '调用研究助手' }))
  await user.click(await screen.findByRole('menuitem', { name: '使用风险复核' }))
  await waitFor(() => expect(screen.getByLabelText('当前研究助手')).toHaveTextContent('风险复核'))
  expect(writes.find(item => item.path.endsWith('/assistant'))?.body).toEqual({ assistant_id: 'risk', base_revision: 0 })
  expect(writes.filter(item => item.path.endsWith('/messages'))).toHaveLength(1)
})

it('offers a version update explicitly without replacing the conversation snapshot on catalog load', async () => {
  const { default: Select } = await import('../ResearchAssistantSelect')
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [{ ...profiles[1], name: '财报分析新版', revision: 2, skill_hash: 'new' }] })))
  const change = vi.fn(), user = userEvent.setup()
  render(<Select value="financial" snapshot={profiles[1]} disabled={false} onChange={change} />)
  await screen.findByRole('button', { name: '更新版本' })
  expect(change).not.toHaveBeenCalled()
  expect(screen.getByRole('option', { name: '财报分析' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '更新版本' }))
  expect(change).toHaveBeenCalledWith('financial')
})
