import { act, render, screen, waitFor, within } from '@testing-library/react'
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
  expect(within(toolbar).getAllByRole('button')).toHaveLength(8)
  await user.click(within(toolbar).getByRole('button', { name: '复制答复' }))
  await user.click(within(toolbar).getByRole('button', { name: '重新生成答案' }))
  expect(handlers.onCopy).toHaveBeenCalledOnce(); expect(handlers.onRegenerate).toHaveBeenCalledOnce()
  expect(handlers.onSave).not.toHaveBeenCalled(); expect(handlers.onBranch).not.toHaveBeenCalled()
})

it('opens actual answer citations in a drawer and restores keyboard focus', async () => {
  const user = userEvent.setup(), { container } = render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  const trigger = screen.getByRole('button', { name: '查看依据' })
  await user.click(trigger)
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
  expect(within(dialog).getByRole('button', { name: '下载已加载对话' })).toBeInTheDocument()
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
  for (const name of ['重新生成答案', '保存为研究笔记', '加入关注']) expect(screen.getByRole('button', { name })).toBeDisabled()
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

it('labels the downloaded file as a loaded fragment and keeps the selected-answer cutoff', async () => {
  const user = userEvent.setup()
  const blobs: Blob[] = []
  const createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:preview' })
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = vi.fn() })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const later: ConversationMessage = { ...message, id: 'later', content: '后续回答不应导出' }
  render(<ResearchAnswerTools conversation={{ ...conversation, messages: [question, message, later] }} message={message} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  await user.click(screen.getByRole('button', { name: '分享答复' }))
  expect(screen.getByText('下载仅包含当前已加载的消息，截至所选回答；较早的对话可能未包含。')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '下载已加载对话' }))
  expect(click).toHaveBeenCalledOnce()
  expect(click.mock.instances[0]).toHaveAttribute('download', '研究对话-已加载片段.md')
  const content = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blobs[0]) })
  expect(content).toContain('当前已加载的对话片段，截至所选回答；可能不包含更早的消息。')
  expect(content).toContain(question.content)
  expect(content).toContain(message.content)
  expect(content).not.toContain(later.content)
})


it.each(['create', 'revoke'] as const)('keeps the %s result when the share dialog is closed and reopened during a write', async operation => {
  const user = userEvent.setup()
  const snapshot = { id: 'share', url: 'https://share.example.test/s/snapshot-token' }
  let finishWrite!: (value: Response) => void
  let finishRead!: (value: Response) => void
  let reads = 0
  const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'DELETE') return new Promise<Response>(resolve => { finishWrite = resolve })
    reads += 1
    if (reads === 1) return Promise.resolve(json({ configured: true, share: operation === 'create' ? null : snapshot }))
    return new Promise<Response>(resolve => { finishRead = resolve })
  })
  vi.stubGlobal('fetch', fetcher)
  render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  await user.click(screen.getByRole('button', { name: '分享答复' }))
  const action = await screen.findByRole('button', { name: operation === 'create' ? '创建分享链接' : '撤销分享链接' })
  await waitFor(() => expect(action).toBeEnabled())
  await user.click(action)
  await user.click(screen.getByRole('button', { name: '关闭分享' }))
  expect(screen.getByRole('button', { name: '分享答复' })).toHaveFocus()
  await user.click(screen.getByRole('button', { name: '分享答复' }))
  await act(async () => finishWrite(json(operation === 'create' ? snapshot : {})))
  // A previously started read may ignore cancellation and carry the old snapshot.
  if (finishRead) await act(async () => finishRead(json({ configured: true, share: operation === 'create' ? null : snapshot })))
  if (operation === 'create') expect(screen.getByRole('textbox', { name: '研究对话分享链接' })).toHaveValue(snapshot.url)
  else {
    expect(screen.queryByRole('textbox', { name: '研究对话分享链接' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '创建分享链接' })).toBeEnabled()
  }
  expect(fetcher.mock.calls.filter(call => call[1]?.method === (operation === 'create' ? 'POST' : 'DELETE'))).toHaveLength(1)
})

it('ignores a stale share lookup that finishes after revocation', async () => {
  const user = userEvent.setup()
  const snapshot = { id: 'share', url: 'https://share.example.test/s/snapshot-token' }
  let finishRead!: (value: Response) => void
  let reads = 0
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') return Promise.resolve(json({}))
    reads += 1
    return reads === 1 ? Promise.resolve(json({ configured: true, share: snapshot })) : new Promise<Response>(resolve => { finishRead = resolve })
  }))
  render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  await user.click(screen.getByRole('button', { name: '分享答复' }))
  await screen.findByRole('textbox', { name: '研究对话分享链接' })
  await user.click(screen.getByRole('button', { name: '关闭分享' }))
  await user.click(screen.getByRole('button', { name: '分享答复' }))
  await user.click(screen.getByRole('button', { name: '撤销分享链接' }))
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '研究对话分享链接' })).not.toBeInTheDocument())
  await act(async () => finishRead(json({ configured: true, share: snapshot })))
  expect(screen.queryByRole('textbox', { name: '研究对话分享链接' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '创建分享链接' })).toBeEnabled()
})

it('keeps a failed pending creation retryable after the share dialog is reopened', async () => {
  const user = userEvent.setup()
  const snapshot = { id: 'share', url: 'https://share.example.test/s/retried-snapshot' }
  let rejectWrite!: (reason: Error) => void
  let writes = 0
  const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'POST') return Promise.resolve(json({ configured: true, share: null }))
    writes += 1
    return writes === 1 ? new Promise<Response>((_resolve, reject) => { rejectWrite = reject }) : Promise.resolve(json(snapshot))
  })
  vi.stubGlobal('fetch', fetcher)
  render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  await user.click(screen.getByRole('button', { name: '分享答复' }))
  const create = await screen.findByRole('button', { name: '创建分享链接' })
  await waitFor(() => expect(create).toBeEnabled())
  await user.click(create)
  await user.click(screen.getByRole('button', { name: '关闭分享' }))
  await user.click(screen.getByRole('button', { name: '分享答复' }))
  expect(screen.getByRole('button', { name: '正在创建…' })).toBeDisabled()
  await act(async () => rejectWrite(new Error('分享服务暂时不可用')))
  expect(screen.getByRole('alert')).toHaveTextContent('暂时无法连接本地服务，请稍后重试。')
  expect(screen.getByRole('button', { name: '创建分享链接' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: '创建分享链接' }))
  expect(await screen.findByRole('textbox', { name: '研究对话分享链接' })).toHaveValue(snapshot.url)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  const requests = fetcher.mock.calls.filter(call => call[1]?.method === 'POST')
  expect(requests).toHaveLength(2)
  expect(requests[1][1]?.body).toBe(requests[0][1]?.body)
})

it('highlights actual evidence and exposes screening as a confirmed draft action', async () => {
  const handlers = callbacks(), user = userEvent.setup()
  render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...handlers} />)
  const toolbar = screen.getByRole('group', { name: '回答操作' })
  expect(within(toolbar).getByRole('button', { name: '查看依据' })).toHaveAttribute('data-primary-action', 'true')
  expect(within(toolbar).getByRole('button', { name: '加入关注' })).not.toHaveAttribute('data-primary-action', 'true')
  await user.click(within(toolbar).getByRole('button', { name: '转为选股草稿' }))
  expect(handlers.onDraft).toHaveBeenCalledOnce()
})

it('prefers notes only with the answer own structured summary and remains neutral otherwise', () => {
  const plain = { ...message, turn_id: 'answer-turn', content: '没有附来源的答复' }
  const withSummary = { ...conversation, turns: [{ id: 'answer-turn', result: { research_summary: { version: 1, conclusion: '结论' } } }] } as unknown as Conversation
  const view = render(<ResearchAnswerTools conversation={withSummary} message={plain} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  expect(screen.getByRole('button', { name: '保存为研究笔记' })).toHaveAttribute('data-primary-action', 'true')
  view.rerender(<ResearchAnswerTools conversation={conversation} message={plain} locked saved={false} savingNote={false} {...callbacks()} />)
  expect(view.container.querySelector('[data-primary-action="true"]')).toBeNull()
  expect(within(screen.getByRole('group', { name: '回答操作' })).getByRole('button', { name: '转为选股草稿' })).toBeDisabled()
})

it('copies original answer with only recorded provenance and keeps ordinary copy', async () => {
  const user = userEvent.setup(), clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(), handlers = callbacks()
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [{ kind: 'web', title: '公告原文', url: 'https://example.com/notice', published_at: '2026-09-30', retrieved_at: '2026-10-10T01:00:00Z' }, { kind: 'financial', source_id: 'fact-id', title: '财务原值', report_period: '2025-12-31', unit: '元', excerpt: '12340000000 元' }] })))
  render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...handlers} />)
  await user.click(screen.getByRole('button', { name: '更多回答操作' }))
  await user.click(screen.getByRole('menuitem', { name: '复制并附来源/日期' }))
  expect(await screen.findByText('已复制答复及已有来源信息')).toBeInTheDocument()
  const text = clipboard.mock.calls[0][0]
  expect(text).toContain(message.content)
  expect(text).toContain('答复记录时间：2026-10-10T00:00:00Z')
  expect(text).toContain('发布日期：2026-09-30')
  expect(text).toContain('抓取时间：2026-10-10T01:00:00Z')
  expect(text).toContain('报告期：2025-12-31')
  expect(text).toContain('12340000000 元')
  expect(text).not.toContain('发布日期：2026-10-10')
  await user.click(screen.getByRole('button', { name: '复制答复' }))
  expect(handlers.onCopy).toHaveBeenCalledOnce()
})
it('reports clipboard refusal without claiming a successful provenance copy', async () => {
  const user = userEvent.setup(); vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('剪贴板拒绝'))
  render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  await user.click(screen.getByRole('button', { name: '更多回答操作' }))
  await user.click(screen.getByRole('menuitem', { name: '复制并附来源/日期' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('剪贴板拒绝')
  expect(screen.queryByText('已复制答复及已有来源信息')).not.toBeInTheDocument()
})

it('does not copy a late source response after the answer identity changes', async () => {
  const user = userEvent.setup(), clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  let finish!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  const view = render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  await user.click(screen.getByRole('button', { name: '更多回答操作' }))
  await user.click(screen.getByRole('menuitem', { name: '复制并附来源/日期' }))
  view.rerender(<ResearchAnswerTools conversation={conversation} message={{ ...message, id: 'other', content: '新答复' }} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  await act(async () => finish(json({ items: [] })))
  expect(clipboard).not.toHaveBeenCalled()
  expect(screen.queryByText('已复制答复及已有来源信息')).not.toBeInTheDocument()
})

it('does not silently copy partial provenance when the source read fails', async () => {
  const user = userEvent.setup(), clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: '来源暂不可读' }), { status: 503, headers: { 'Content-Type': 'application/json' } })))
  render(<ResearchAnswerTools conversation={conversation} message={message} locked={false} saved={false} savingNote={false} {...callbacks()} />)
  await user.click(screen.getByRole('button', { name: '更多回答操作' }))
  await user.click(screen.getByRole('menuitem', { name: '复制并附来源/日期' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('来源暂不可读')
  expect(clipboard).not.toHaveBeenCalled()
})
