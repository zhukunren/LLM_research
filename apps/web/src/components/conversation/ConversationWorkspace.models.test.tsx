import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../../api'
import type { ResearchModelCatalog } from '../../modelSelection'
import ConversationWorkspace from './ConversationWorkspace'

const catalog: ResearchModelCatalog = {
  account_tier: 'free', default_model_id: 'gpt-6-luna', default_reasoning_effort: 'high', discovery_status: 'verified',
  models: [
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', description: '日常研究', available: true, unavailable_reason: null, default_reasoning_effort: 'high', reasoning_efforts: [{ id: 'low', label: '轻量' }, { id: 'high', label: '深入' }, { id: 'max', label: '最大' }] },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: '轻量研究', available: true, unavailable_reason: null, default_reasoning_effort: 'high', reasoning_efforts: [{ id: 'low', label: '轻量' }, { id: 'high', label: '深入' }] },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: '复杂研究', available: false, unavailable_reason: '当前 Free 账户不可用', default_reasoning_effort: 'high', reasoning_efforts: [{ id: 'high', label: '深入' }] },
  ],
}
const at = '2026-10-08T08:00:00Z'
function original(overrides: Partial<Conversation> = {}): Conversation {
  return { id: 'model-conversation', task_id: 'model-conversation', entry_scope: 'screening', workflow_type: 'research', task_revision: 0,
    model_id: 'gpt-6-luna', reasoning_effort: 'high', model_revision: 7, active_run_id: null, pending_execution: false,
    state: 'active', messages: [], turns: [], created_at: at, updated_at: at, ...overrides }
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
type Body = Record<string, unknown>

function backend(existing?: Conversation) {
  const state = {
    conversation: existing,
    creates: [] as Body[], patches: [] as Body[], messages: [] as Body[],
    modelHandler: undefined as undefined | ((body: Body) => Response | Promise<Response>),
    messageHandler: undefined as undefined | ((body: Body) => Response | Promise<Response>),
    events: [] as { sequence: number; method: string; payload: unknown }[],
  }
  function updateModel(body: Body) {
    state.conversation = { ...state.conversation!, model_id: String(body.model_id), reasoning_effort: String(body.reasoning_effort), model_revision: Number(body.base_revision) + 1 }
    return json({ model_id: state.conversation.model_id, reasoning_effort: state.conversation.reasoning_effort, model_revision: state.conversation.model_revision })
  }
  function complete(body: Body) {
    state.conversation = { ...state.conversation!, messages: [{ id: 'question', role: 'user', content: String(body.content), source_refs: [], created_at: at }, { id: 'answer', role: 'assistant', content: '模型研究已完成', source_refs: [], created_at: at }],
      turns: [{ id: 'turn', user_message_id: 'question', base_revision: 0, state: 'succeeded', response_text: '模型研究已完成', result: {}, created_at: at, updated_at: at }] }
    return json({ message_id: 'question', turn_id: 'turn', state: 'succeeded', base_revision: 0 })
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Body : {}
    if (path === '/api/v1/research-models') return json(catalog)
    if (path === '/api/v1/conversations' && method === 'GET') return json({ items: state.conversation ? [state.conversation] : [] })
    if (path === '/api/v1/conversations' && method === 'POST') {
      state.creates.push(body)
      state.conversation = original({ model_id: String(body.model_id || 'gpt-6-luna'), reasoning_effort: String(body.reasoning_effort || 'high'), model_revision: 0 })
      return json(state.conversation)
    }
    if (path.endsWith('/model') && method === 'PATCH') { state.patches.push(body); return state.modelHandler ? state.modelHandler(body) : updateModel(body) }
    if (path.endsWith('/messages') && method === 'POST') { state.messages.push(body); return state.messageHandler ? state.messageHandler(body) : complete(body) }
    if (path.endsWith('/codex-events')) return json({ items: state.events, next_after: state.events.at(-1)?.sequence ?? -1 })
    if (path === '/api/v1/conversations/model-conversation') return json(state.conversation)
    return json({ items: [] })
  }))
  return { state, complete, updateModel }
}

async function ready() { await waitFor(() => expect(screen.getByRole('textbox', { name: '研究要求' })).toBeEnabled()) }

describe('conversation model integration', () => {
  it('uses session preferences, persists explicit draft choices and freezes model revision on the first message', async () => {
    sessionStorage.setItem('research.modelPreference', JSON.stringify({ model_id: 'gpt-5.6-luna', reasoning_effort: 'low' }))
    const { state } = backend()
    const user = userEvent.setup()
    render(<ConversationWorkspace />)
    await ready()
    expect(screen.queryByLabelText('研究深度')).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: '选择研究模型，GPT-5.6 Luna，轻量' }))
    await user.click(screen.getByRole('menuitemradio', { name: /GPT-6 Luna/ }))
    await user.click(screen.getByRole('button', { name: '选择研究模型，GPT-6 Luna，轻量' }))
    await user.click(screen.getByRole('menuitemradio', { name: '最大' }))
    expect(JSON.parse(sessionStorage.getItem('research.modelPreference')!)).toEqual({ model_id: 'gpt-6-luna', reasoning_effort: 'max' })
    await user.type(screen.getByRole('textbox', { name: '研究要求' }), '核对公司资料')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('模型研究已完成')
    expect(state.creates[0]).toMatchObject({ model_id: 'gpt-6-luna', reasoning_effort: 'max' })
    expect(state.messages[0]).toMatchObject({ model_revision: 0, content: '核对公司资料' })
  })

  it('updates an existing conversation only after the model PATCH succeeds and sends its new revision', async () => {
    sessionStorage.setItem('research.modelPreference', JSON.stringify({ model_id: 'gpt-5.6-luna', reasoning_effort: 'low' }))
    const { state, updateModel } = backend(original())
    let resolve!: (response: Response) => void
    state.modelHandler = () => new Promise<Response>(done => { resolve = done })
    const user = userEvent.setup()
    render(<ConversationWorkspace initialConversationId="model-conversation" />)
    await ready()
    await user.type(screen.getByRole('textbox', { name: '研究要求' }), '保留输入草稿')
    await user.click(await screen.findByRole('button', { name: '选择研究模型，GPT-6 Luna，深入' }))
    await user.click(screen.getByRole('menuitemradio', { name: /GPT-5.6 Luna/ }))
    expect(state.patches[0]).toEqual({ model_id: 'gpt-5.6-luna', reasoning_effort: 'high', base_revision: 7 })
    expect(screen.getByRole('button', { name: '选择研究模型，GPT-6 Luna，深入' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(JSON.parse(sessionStorage.getItem('research.modelPreference')!).reasoning_effort).toBe('low')
    await act(async () => { resolve(updateModel(state.patches[0])) })
    expect(await screen.findByRole('button', { name: '选择研究模型，GPT-5.6 Luna，深入' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: '研究要求' })).toHaveValue('保留输入草稿')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('模型研究已完成')
    expect(state.messages[0].model_revision).toBe(8)
  })

  it('keeps the stored selection and draft after a failed model PATCH', async () => {
    const { state } = backend(original())
    state.modelHandler = () => json({ detail: { code: 'conversation_conflict', message: '模型设置已变化，请读取最新状态' } }, 409)
    const user = userEvent.setup()
    render(<ConversationWorkspace initialConversationId="model-conversation" />)
    await ready()
    await user.type(screen.getByRole('textbox', { name: '研究要求' }), '待发送的原问题')
    await user.click(await screen.findByRole('button', { name: '选择研究模型，GPT-6 Luna，深入' }))
    await user.click(screen.getByRole('menuitemradio', { name: /GPT-5.6 Luna/ }))
    await screen.findByText('模型设置已变化，请读取最新状态')
    expect(await screen.findByRole('button', { name: '选择研究模型，GPT-6 Luna，深入' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: '研究要求' })).toHaveValue('待发送的原问题')
    expect(sessionStorage.getItem('research.modelPreference')).toBeNull()
  })

  it('blocks a confirmed unavailable saved model until the user explicitly switches', async () => {
    const { state } = backend(original({ model_id: 'gpt-6-astra' }))
    const user = userEvent.setup()
    render(<ConversationWorkspace initialConversationId="model-conversation" />)
    await ready()
    await user.type(screen.getByRole('textbox', { name: '研究要求' }), '等待换模型后发送')
    await screen.findByText('当前模型或推理档位不可用，请切换后发送。')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '切换模型' }))
    expect(await screen.findByRole('menuitemradio', { name: /GPT-6 Astra/ })).toBeDisabled()
    await user.click(screen.getByRole('menuitemradio', { name: /GPT-6 Luna/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    expect(state.patches[0].model_id).toBe('gpt-6-luna')
    expect(screen.getByRole('textbox', { name: '研究要求' })).toHaveValue('等待换模型后发送')
  })

  it('retries a lost response with the original model revision and client ID even after another client changes models', async () => {
    const { state, complete } = backend(original())
    state.messageHandler = body => {
      if (state.messages.length === 1) {
        complete(body)
        state.conversation = { ...state.conversation!, model_id: 'gpt-5.6-luna', reasoning_effort: 'low', model_revision: 8 }
        return json({ message: '消息响应丢失，请重试' }, 503)
      }
      return json({ message_id: 'question', turn_id: 'turn', state: 'succeeded', idempotent_replay: true })
    }
    const user = userEvent.setup()
    render(<ConversationWorkspace initialConversationId="model-conversation" />)
    await ready()
    await user.type(screen.getByRole('textbox', { name: '研究要求' }), '只处理一次的研究')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('消息响应丢失，请重试')
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: '研究要求' })).toHaveValue(''))
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1]).toEqual(state.messages[0])
    expect(state.messages[1].model_revision).toBe(7)
    expect(screen.getByRole('log').querySelectorAll('.conversation-message.user')).toHaveLength(1)
  })

  it('refreshes a definitely rejected stale attempt while retaining its draft for a safe retry', async () => {
    const { state, complete } = backend(original())
    state.messageHandler = body => {
      if (state.messages.length === 1) {
        state.conversation = { ...state.conversation!, model_revision: 8, reasoning_effort: 'low' }
        return json({ detail: { code: 'conversation_conflict', message: '模型设置已经变化，请读取最新状态后再发送' } }, 409)
      }
      return complete(body)
    }
    const user = userEvent.setup()
    render(<ConversationWorkspace initialConversationId="model-conversation" />)
    await ready()
    await user.type(screen.getByRole('textbox', { name: '研究要求' }), '基于最新模型再发送')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('模型设置已经变化，请读取最新状态后再发送')
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
    expect(screen.getByRole('textbox', { name: '研究要求' })).toHaveValue('基于最新模型再发送')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('模型研究已完成')
    expect(state.messages[1].model_revision).toBe(8)
    expect(state.messages[1].client_message_id).not.toBe(state.messages[0].client_message_id)
  })

  it('shows safe web-search progress and disables model switching during an active turn', async () => {
    const active = original({ messages: [{ id: 'question', role: 'user', content: '今日热点', source_refs: [], created_at: at }], turns: [{ id: 'turn', user_message_id: 'question', state: 'running', base_revision: 0, response_text: null, result: {}, created_at: at, updated_at: at }] })
    const { state } = backend(active)
    state.events = [{ sequence: 1, method: 'item/started', payload: { item: { type: 'webSearch', action: { type: 'search', query: 'PRIVATE_SEARCH_QUERY' } } } }]
    render(<ConversationWorkspace initialConversationId="model-conversation" />)
    expect(await screen.findByText('正在搜索网页')).toBeInTheDocument()
    expect(screen.queryByText('PRIVATE_SEARCH_QUERY')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择研究模型，GPT-6 Luna，深入' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('textbox', { name: '研究要求' }), { key: 'Enter' })
    expect(state.patches).toHaveLength(0)
  })
})
