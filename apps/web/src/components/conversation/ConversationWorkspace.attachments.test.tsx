import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { Conversation, ConversationAttachment, ResearchAssistant } from '../../api'
import ConversationWorkspace from './ConversationWorkspace'

const at = '2026-10-08T12:00:00Z'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const profiles: ResearchAssistant[] = [
  { id: 'general', name: '通用投研', description: '综合研究', instructions: '核验来源', enabled: true, builtin: true, revision: 1, skill_hash: 'general' },
  { id: 'financial', name: '财报分析', description: '核验财务质量', instructions: '核验财报', enabled: true, builtin: true, revision: 1, skill_hash: 'financial' },
  { id: 'daily-hotspots', name: '今日热点', description: '自动检索今日资讯', instructions: '核验资讯', enabled: true, builtin: true, revision: 1, skill_hash: 'daily', launch_mode: 'immediate' },
]

function backend({ loseMessage = false, loseCreation = false }: { loseMessage?: boolean; loseCreation?: boolean } = {}) {
  let stored: Conversation | null = null
  const originals: ConversationAttachment[] = []
  const messages: Record<string, unknown>[] = []
  const creates: Record<string, unknown>[] = []
  const uploads: FormData[] = []
  const paths: string[] = []
  const createdByRequest = new Map<string, Conversation>()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
    const method = init?.method || 'GET'
    if (method !== 'GET') paths.push(path)
    if (path === '/research-assistants') return json({ items: profiles })
    if (path === '/research-models') return json({ account_tier: 'free', default_model_id: 'gpt-6-luna', default_reasoning_effort: 'high', discovery_status: 'verified', models: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna', description: '研究', available: true, unavailable_reason: null, default_reasoning_effort: 'high', reasoning_efforts: [{ id: 'high', label: '深入' }] }] })
    if (path === '/conversations' && method === 'GET') return json({ items: stored ? [stored] : [] })
    if (path === '/conversations' && method === 'POST') {
      const body = JSON.parse(String(init?.body)); creates.push(body)
      const previous = createdByRequest.get(body.request_id)
      const currentConversation: Conversation = previous || { id: createdByRequest.size ? `ghost-${createdByRequest.size + 1}` : 'file-chat', task_id: 'file-chat', entry_scope: 'screening', workflow_type: 'research', research_depth: 'standard',
        assistant: profiles.find(item => item.id === body.assistant_id) || profiles[0], assistant_revision: 0,
        task_revision: 0, model_id: 'gpt-6-luna', reasoning_effort: 'high', model_revision: 0, research_scope_revision: 0,
        research_scope: { as_of: null, stock_codes: [] }, pending_execution: false, active_run_id: null, state: 'active',
        messages: [], turns: [], created_at: at, updated_at: at }
      stored = currentConversation
      createdByRequest.set(body.request_id, currentConversation)
      if (loseCreation && creates.length === 1) return json({ message: '创建响应丢失' }, 503)
      const { messages: _messages, turns: _turns, ...metadata } = currentConversation
      return json(metadata)
    }
    if (path === '/conversations/file-chat/attachments' && method === 'POST') {
      const form = init?.body as FormData; uploads.push(form)
      const file = form.get('file') as File
      const requestId = String(form.get('request_id'))
      let item = originals.find(original => original.request_id === requestId)
      if (!item) {
        item = { id: `attachment-${originals.length + 1}`, conversation_id: 'file-chat', request_id: requestId,
          filename: file.name, media_type: file.type, bytes: file.size, sha256: 'sha', created_at: at,
          url: `/api/v1/conversations/file-chat/attachments/attachment-${originals.length + 1}/download` }
        originals.push(item)
      }
      return json(item, 201)
    }
    if (path === '/conversations/file-chat/attachments') return json({ items: originals })
    if (path === '/conversations/file-chat/messages') {
      const body = JSON.parse(String(init?.body)); messages.push(body)
      stored = { ...stored!, messages: [{ id: 'question', role: 'user', content: body.content, source_refs: [], attachments: originals, created_at: at },
        { id: 'answer', role: 'assistant', content: '已读取上传文件。', source_refs: [], created_at: at }],
        turns: [{ id: 'turn', user_message_id: 'question', base_revision: 0, state: 'succeeded', response_text: '已读取上传文件。', result: {}, attachments: originals, created_at: at, updated_at: at }] }
      if (loseMessage && messages.length === 1) return json({ message: '消息响应丢失' }, 503)
      return json({ message_id: 'question', turn_id: 'turn', state: 'succeeded', source_refs: [], attachments: originals })
    }
    if (path === '/conversations/file-chat/assistant') {
      const body = JSON.parse(String(init?.body))
      stored = { ...stored!, assistant: profiles.find(item => item.id === body.assistant_id), assistant_revision: stored!.assistant_revision! + 1 }
      return json({ assistant: stored.assistant, assistant_revision: stored.assistant_revision })
    }
    if (path === '/conversations/file-chat') return json(stored)
    return json({ items: [] })
  }))
  return { creates, uploads, messages, paths, originals, createdByRequest, getConversation: () => stored }
}

async function uploadFile(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getByRole('button', { name: '添加文件或研究助手' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '添加文件或研究助手' }))
  await user.click(screen.getByRole('menuitem', { name: '上传文件' }))
  await user.upload(screen.getByLabelText('上传研究文件'), new File(['财报原文'], 'quarterly.txt', { type: 'text/plain', lastModified: 10 }))
  await waitFor(() => expect(screen.getByRole('button', { name: '移除附件：quarterly.txt' })).toBeEnabled())
}

it('creates only conversation metadata on upload and sends attachment-only research explicitly', async () => {
  const state = backend(), user = userEvent.setup()
  render(<ConversationWorkspace initialNewDraft />)
  await uploadFile(user)
  expect(state.creates).toHaveLength(1)
  expect(state.uploads).toHaveLength(1)
  expect(state.messages).toHaveLength(0)
  expect(state.paths.some(path => path.endsWith('/process'))).toBe(false)
  expect(screen.queryByRole('combobox', { name: '研究助手' })).not.toBeInTheDocument()
  const form = screen.getByRole('textbox', { name: '研究要求' }).closest('form')!
  expect(within(form).getByRole('button', { name: /选择研究模型/ })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '发送' }))
  await screen.findByText('已读取上传文件。')
  expect(state.messages[0]).toMatchObject({ content: '请分析上传的文件', attachment_ids: ['attachment-1'] })
  expect(screen.getByRole('link', { name: '下载附件：quarterly.txt' })).toHaveAttribute('href', '/api/v1/conversations/file-chat/attachments/attachment-1/download')
  expect(screen.queryByRole('list', { name: '待发送附件' })).not.toBeInTheDocument()
})

it('restores text and attachment IDs after a failed send and retries its frozen client message', async () => {
  const state = backend({ loseMessage: true }), user = userEvent.setup()
  const first = render(<ConversationWorkspace initialNewDraft />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '请核对这份财报')
  await uploadFile(user)
  await user.click(screen.getByRole('button', { name: '发送' }))
  await screen.findByText('消息响应丢失')
  expect(screen.getByLabelText('研究要求')).toHaveValue('请核对这份财报')
  expect(screen.getByRole('list', { name: '待发送附件' })).toHaveTextContent('quarterly.txt')
  first.unmount()
  render(<ConversationWorkspace initialConversationId="file-chat" />)
  await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
  expect(screen.getByLabelText('研究要求')).toHaveValue('请核对这份财报')
  await user.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toHaveValue(''))
  expect(state.messages).toHaveLength(2)
  expect(state.messages[1]).toEqual(state.messages[0])
  expect(state.uploads).toHaveLength(1)
  expect(state.creates).toHaveLength(1)
  expect(screen.getByRole('log').querySelectorAll('.conversation-message.user')).toHaveLength(1)
})

it('changes methods without sending and keeps draft text and files when an immediate assistant is launched', async () => {
  const state = backend(), user = userEvent.setup(), onLaunchAssistant = vi.fn()
  render(<ConversationWorkspace initialNewDraft onLaunchAssistant={onLaunchAssistant} />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '尚未发送的问题')
  await uploadFile(user)
  await user.click(screen.getByRole('button', { name: '添加文件或研究助手' }))
  await user.click(screen.getByRole('menuitem', { name: '调用研究助手' }))
  await user.click(await screen.findByRole('menuitem', { name: '使用财报分析' }))
  await waitFor(() => expect(screen.getByLabelText('当前研究助手')).toHaveTextContent('财报分析'))
  expect(state.messages).toHaveLength(0)
  await user.click(screen.getByRole('button', { name: '添加文件或研究助手' }))
  await user.click(screen.getByRole('menuitem', { name: '调用研究助手' }))
  await user.click(await screen.findByRole('menuitem', { name: '启动今日热点' }))
  expect(onLaunchAssistant).toHaveBeenCalledExactlyOnceWith('daily-hotspots', '今日热点')
  expect(screen.getByLabelText('研究要求')).toHaveValue('尚未发送的问题')
  expect(screen.getByRole('list', { name: '待发送附件' })).toHaveTextContent('quarterly.txt')
  await user.click(screen.getByRole('button', { name: '移除研究助手，恢复通用投研' }))
  await waitFor(() => expect(screen.queryByLabelText('当前研究助手')).not.toBeInTheDocument())
  expect(state.messages).toHaveLength(0)
})

it('reuses metadata creation intent after a lost response and refresh instead of creating a ghost conversation', async () => {
  const state = backend({ loseCreation: true }), user = userEvent.setup()
  const first = render(<ConversationWorkspace initialNewDraft />)
  await waitFor(() => expect(screen.getByRole('button', { name: '添加文件或研究助手' })).toBeEnabled())
  await user.upload(screen.getByLabelText('上传研究文件'), new File(['财报原文'], 'quarterly.txt', { type: 'text/plain', lastModified: 10 }))
  await screen.findByText('创建响应丢失')
  expect(state.createdByRequest.size).toBe(1)
  expect(state.uploads).toHaveLength(0)
  const firstIntent = state.creates[0]
  expect(typeof firstIntent.request_id).toBe('string')
  first.unmount()
  render(<ConversationWorkspace initialNewDraft />)
  await screen.findByRole('button', { name: '重新选择：quarterly.txt' })
  await user.upload(screen.getByLabelText('重新选择原文件：quarterly.txt'), new File(['财报原文'], 'quarterly.txt', { type: 'text/plain', lastModified: 10 }))
  await screen.findByRole('button', { name: '移除附件：quarterly.txt' })
  expect(state.creates).toHaveLength(2)
  expect(state.creates[1]).toEqual(firstIntent)
  expect(state.createdByRequest.size).toBe(1)
  expect(state.uploads).toHaveLength(1)
  expect(state.messages).toHaveLength(0)
})

it('drops a withdrawn mode field from a restored creation intent while preserving its identity', async () => {
  sessionStorage.setItem('conversation.attachmentCreationRequests', JSON.stringify({
    'research:screening:new': { request_id: 'restored-file-intent', payload: {
      entry_scope: 'screening', workflow_type: 'research', research_depth: 'standard', assistant_id: 'general', interaction_mode: 'work',
    } },
  }))
  const state = backend(), user = userEvent.setup()
  render(<ConversationWorkspace initialNewDraft />)
  await uploadFile(user)
  expect(state.creates[0].request_id).toBe('restored-file-intent')
  expect(state.creates[0]).not.toHaveProperty('interaction_mode')
  expect(state.creates[0].workflow_type).toBe('research')
})
