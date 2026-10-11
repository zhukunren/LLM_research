import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Conversation, ConversationMessage } from '../../api'
import ResearchAnswerTools from './ResearchAnswerTools'
import { answerSources } from './collectAnswerSources'
import { displayedMessages } from './answerVersions'

const question: ConversationMessage = { id: 'question', role: 'user', content: '核对订单', source_refs: [], created_at: '2026-10-10T00:00:00Z' }
const message: ConversationMessage = { ...question, id: 'answer', role: 'assistant', content: '查看[公告原文](https://example.com/notice)。', source_refs: [] }
const conversation = { id: 'research', entry_scope: 'report', messages: [question, message], turns: [], title: '订单研究' } as unknown as Conversation
const callbacks = () => ({ onSave: vi.fn(), onCopy: vi.fn(), onObserve: vi.fn(), onDraft: vi.fn(), onRegenerate: vi.fn(), onBranch: vi.fn() })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => json({ items: [], configured: true, share: null }))))

it('offers compact labelled icons and invokes only the chosen action', async () => {
  const handlers = callbacks(), user = userEvent.setup()
  render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...handlers} />)
  const toolbar = screen.getByRole('group', { name: '回答操作' })
  expect(within(toolbar).getAllByRole('button')).toHaveLength(6)
  await user.click(within(toolbar).getByRole('button', { name: '复制答复' }))
  await user.click(within(toolbar).getByRole('button', { name: '重新生成答案' }))
  expect(handlers.onCopy).toHaveBeenCalledOnce(); expect(handlers.onRegenerate).toHaveBeenCalledOnce()
  expect(handlers.onSave).not.toHaveBeenCalled(); expect(handlers.onBranch).not.toHaveBeenCalled()
})

it('opens actual answer citations in a drawer and restores keyboard focus', async () => {
  const user = userEvent.setup(), { container } = render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  const trigger = screen.getByRole('button', { name: '更多回答操作' })
  await user.click(trigger)
  await user.click(screen.getByRole('menuitem', { name: /查看来源/ }))
  const drawer = screen.getByRole('dialog', { name: '回答来源' })
  expect(container).not.toContainElement(drawer)
  expect(within(drawer).getByRole('link', { name: '公告原文' })).toHaveAttribute('href', 'https://example.com/notice')
  expect(within(drawer).getByRole('button', { name: '关闭回答来源' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(trigger).toHaveFocus()
})

it('creates a public snapshot link and copies it after publication', async () => {
  const user = userEvent.setup(), clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? json({ id: 'share', url: 'https://share.example.test/s/snapshot-token' }) : json({ configured: true, share: null }))
  vi.stubGlobal('fetch', fetcher)
  render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  await user.click(screen.getByRole('button', { name: '分享答复' }))
  const dialog = screen.getByRole('dialog', { name: '分享研究答复' })
  await user.click(await within(dialog).findByRole('button', { name: '创建分享链接' }))
  await user.click(await within(dialog).findByRole('button', { name: '复制链接' }))
  expect(clipboard).toHaveBeenCalledWith('https://share.example.test/s/snapshot-token')
  expect(fetcher.mock.calls.find(call => call[1]?.method === 'POST')?.[1]?.body).toContain('request_id')
  expect(within(dialog).getByRole('button', { name: '已复制链接' })).toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: '下载对话文件' })).toBeInTheDocument()
})

it('supports menu keyboard navigation and branching without triggering regeneration', async () => {
  const user = userEvent.setup(), handlers = callbacks()
  render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...handlers} />)
  screen.getByRole('button', { name: '更多回答操作' }).focus()
  await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
  expect(handlers.onBranch).toHaveBeenCalledOnce()
  expect(handlers.onRegenerate).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

it('keeps reading, copying and sharing available during research while writes are locked', async () => {
  const user = userEvent.setup()
  render(<ResearchAnswerTools conversation={conversation} message={message} locked saved={false} savingNote={false} {...callbacks()} />)
  for (const name of ['重新生成答案', '保存为研究笔记', '加入观察']) expect(screen.getByRole('button', { name })).toBeDisabled()
  expect(screen.getByRole('button', { name: '复制答复' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: '更多回答操作' }))
  expect(screen.getByRole('menuitem', { name: /查看来源/ })).toBeEnabled()
  expect(screen.getByRole('menuitem', { name: /打开新对话分支/ })).toBeDisabled()
})

it('shows missing sources explicitly instead of inventing citations', async () => {
  const user = userEvent.setup()
  render(<ResearchAnswerTools conversation={conversation} message={{ ...message, content: '尚待核实' }} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  await user.click(screen.getByRole('button', { name: '更多回答操作' }))
  await user.click(screen.getByRole('menuitem', { name: /查看来源/ }))
  expect(await screen.findByText('这条答复没有附可查看的来源。')).toBeInTheDocument()
})

it('deduplicates web citations and excludes commands from source discovery', () => {
  const refs = answerSources({ ...message, content: '[说明](https://example.com/a_(b))\nhttps://example.com/notice\n```python\nurl="https://private.test"\n```',
    source_refs: [{ kind: 'web', title: '公告原文', url: 'https://example.com/notice' }] })
  expect(refs).toHaveLength(2)
  expect(refs.map(item => item.url)).toEqual(['https://example.com/notice', 'https://example.com/a_(b)'])
})

it('renders a selected answer version once, keeping the original dialogue position', () => {
  const messages = [question, message, { ...question, id: 'shadow', regeneration_of: question.id }, { ...message, id: 'new-answer', content: '新结论', regeneration_of: message.id }]
  expect(displayedMessages(messages).map(item => item.id)).toEqual(['question', 'new-answer'])
  expect(displayedMessages(messages, { answer: 'answer' }).map(item => item.id)).toEqual(['question', 'answer'])
  expect(messages).toHaveLength(4)
})
