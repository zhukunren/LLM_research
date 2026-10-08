import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('./pages/ResearchProjectsPage', () => ({ default: () => <h1>研究项目目录</h1> }))

const timestamp = '2026-10-08T08:00:00+08:00'
const selectedModel = { model_id: 'gpt-5.6-luna', reasoning_effort: 'low' }
const assistant = {
  id: 'daily-hotspots', name: '今日热点', description: '检索今日最重要的资讯', instructions: '核对真实网页来源。',
  enabled: true, builtin: true, revision: 1, skill_hash: 'hotspot-skill', launch_mode: 'immediate',
  launch_label: '查看今日热点', launch_description: '立即搜索并核对原文。', default_prompt: '今日热点｜{as_of_date}',
}
const models = {
  models: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: '轻量研究', available: true, unavailable_reason: null,
    reasoning_efforts: [{ id: 'low', label: '轻量' }], default_reasoning_effort: 'low' }],
  default_model_id: 'gpt-5.6-luna', default_reasoning_effort: 'low', account_tier: 'free', discovery_status: 'verified',
}
const queuedConversation = {
  id: 'hotspot-conversation', task_id: 'hotspot-conversation', title: '今日热点', entry_scope: 'news', workflow_type: 'research',
  research_depth: 'standard', research_scope: { as_of: '2026-10-08', stock_codes: [] }, research_scope_revision: 0,
  assistant, assistant_revision: 0, ...selectedModel, model_revision: 0, task_revision: 0,
  pending_execution: false, active_run_id: null, state: 'active', created_at: timestamp, updated_at: timestamp,
  messages: [{ id: 'hotspot-question', role: 'user', content: '今日热点｜2026-10-08', source_refs: [], created_at: timestamp }],
  turns: [{ id: 'hotspot-turn', user_message_id: 'hotspot-question', base_revision: 0, workflow_type: 'research',
    state: 'awaiting_agent', response_text: null, result: {}, created_at: timestamp, updated_at: timestamp,
    job: { id: 'hotspot-job', state: 'queued', progress: 0, message: '等待开始研究' } }],
}
type Write = { path: string; body: Record<string, unknown> }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const accepted = (body: Record<string, unknown>, replay = false) => json({
  request_id: body.request_id, assistant_id: assistant.id, conversation_id: queuedConversation.id, turn_id: 'hotspot-turn',
  job_id: 'hotspot-job', state: 'awaiting_agent', job_state: 'queued', as_of_date: '2026-10-08', started_at: timestamp,
  timezone: 'Asia/Shanghai', assistant_revision: 1, skill_hash: assistant.skill_hash, idempotent_replay: replay,
}, 202)

function stubApi(onLaunch?: (body: Record<string, unknown>, count: number) => Response | Promise<Response>, existing?: typeof queuedConversation) {
  const writes: Write[] = []
  let launched = false
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (init?.method && init.method !== 'GET') {
      const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>
      writes.push({ path, body })
      if (path === '/api/v1/research-assistants/daily-hotspots/launch' && init.method === 'POST') {
        launched = true
        return onLaunch ? onLaunch(body, writes.length) : accepted(body)
      }
      return json({ message: 'Unexpected write in one-click launch' }, 400)
    }
    if (path === '/api/v1/research-assistants') return json({ items: [assistant], default_id: 'general' })
    if (path === '/api/v1/research-models') return json(models)
    if (path === '/api/v1/data/status') return json({ available: true, last_date: '2026-09-28' })
    if (path === '/api/v1/conversations') return json({ items: [...(launched ? [queuedConversation] : []), ...(existing ? [existing] : [])] })
    if (path === '/api/v1/conversations/hotspot-conversation') return json(queuedConversation)
    if (existing && path === `/api/v1/conversations/${existing.id}`) return json(existing)
    if (path.endsWith('/codex-events')) return json({ items: [], next_after: -1 })
    return json({ items: [] })
  })
  vi.stubGlobal('fetch', fetcher)
  return { writes, fetcher }
}

beforeEach(() => {
  window.history.replaceState(null, '', '#/assistants')
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  sessionStorage.setItem('research.modelPreference', JSON.stringify(selectedModel))
})
afterEach(() => window.history.replaceState(null, '', '/'))

it.each(['card', 'submenu', 'composer'])('launches from the %s once, opens the queued conversation, and reloads without sending another turn', async entry => {
  if (entry === 'composer') window.history.replaceState(null, '', '#/research/new')
  const { writes } = stubApi(), user = userEvent.setup()
  const view = render(<App />)
  if (entry === 'composer') {
    await waitFor(() => expect(screen.getByRole('button', { name: '添加文件或研究助手' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '添加文件或研究助手' }))
    await user.click(screen.getByRole('menuitem', { name: '调用研究助手' }))
    await user.click(await screen.findByRole('menuitem', { name: '启动今日热点' }))
  } else {
    const container = entry === 'card' ? screen.getByRole('main') : screen.getByRole('group', { name: '研究助手子入口' })
    await user.click(await within(container).findByRole('button', { name: '使用今日热点' }))
  }
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('今日热点｜2026-10-08'))
  expect(window.location.hash).toBe('#/research/hotspot-conversation?scope=news')
  expect(screen.getByRole('button', { name: '停止当前研究' })).toBeEnabled()
  expect(writes).toEqual([{ path: '/api/v1/research-assistants/daily-hotspots/launch', body: { request_id: expect.any(String), ...selectedModel } }])
  view.unmount()
  render(<App />)
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('今日热点｜2026-10-08'))
  expect(writes).toHaveLength(1)
  expect(screen.getByRole('button', { name: '停止当前研究' })).toBeEnabled()
})

it('launches a ready assistant from the composer without consuming the original draft or its uploaded files', async () => {
  const existing = { ...queuedConversation, id: 'draft-conversation', task_id: 'draft-conversation', title: '待分析材料',
    entry_scope: 'screening', messages: [], turns: [], assistant: { ...assistant, id: 'general', name: '通用投研', launch_mode: 'draft' } }
  const attachment = { id: 'report-file', conversation_id: existing.id, request_id: 'file-request', filename: '财务数据.csv',
    media_type: 'text/csv', bytes: 64, sha256: 'a'.repeat(64), created_at: timestamp,
    url: `/api/v1/conversations/${existing.id}/attachments/report-file/download` }
  const owner = `research:screening:${existing.id}`
  const savedAttachment = { requestId: 'file-request', name: attachment.filename, bytes: attachment.bytes, lastModified: 1,
    conversationId: existing.id, status: 'ready', attachment }
  sessionStorage.setItem('conversation.drafts', JSON.stringify({ [owner]: '请核对这份财务数据，问题尚未发送' }))
  sessionStorage.setItem('conversation.attachmentDrafts', JSON.stringify({ [owner]: [savedAttachment] }))
  window.history.replaceState(null, '', `#/research/${existing.id}`)
  const { writes } = stubApi(undefined, existing), user = userEvent.setup()
  const view = render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toHaveValue('请核对这份财务数据，问题尚未发送'))
  expect(within(screen.getByRole('list', { name: '待发送附件' })).getByText('财务数据.csv')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '添加文件或研究助手' }))
  await user.click(screen.getByRole('menuitem', { name: '调用研究助手' }))
  await user.click(await screen.findByRole('menuitem', { name: '启动今日热点' }))
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('今日热点｜2026-10-08'))
  expect(window.location.hash).toBe('#/research/hotspot-conversation?scope=news')
  expect(writes).toEqual([{ path: '/api/v1/research-assistants/daily-hotspots/launch', body: { request_id: expect.any(String), ...selectedModel } }])
  expect(screen.queryByRole('list', { name: '待发送附件' })).not.toBeInTheDocument()
  expect(JSON.parse(sessionStorage.getItem('conversation.drafts')!)[owner]).toBe('请核对这份财务数据，问题尚未发送')
  expect(JSON.parse(sessionStorage.getItem('conversation.attachmentDrafts')!)[owner]).toEqual([savedAttachment])
  act(() => window.history.back())
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toHaveValue('请核对这份财务数据，问题尚未发送'))
  expect(within(screen.getByRole('list', { name: '待发送附件' })).getByText('财务数据.csv')).toBeInTheDocument()
  view.unmount()
  render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toHaveValue('请核对这份财务数据，问题尚未发送'))
  expect(within(screen.getByRole('list', { name: '待发送附件' })).getByText('财务数据.csv')).toBeInTheDocument()
  expect(writes).toHaveLength(1)
})

it('recovers a lost launch response after refresh using the same request and frozen model only when the user retries', async () => {
  const { writes } = stubApi((body, count) => count === 1 ? json({ message: '启动响应中断，请重试。' }, 503) : accepted(body, true))
  const user = userEvent.setup(), view = render(<App />)
  await user.click(await within(screen.getByRole('main')).findByRole('button', { name: '使用今日热点' }))
  await screen.findByRole('button', { name: '继续启动' })
  expect(window.location.hash).toBe('#/assistants')
  expect(writes).toHaveLength(1)
  const original = writes[0]
  view.unmount()
  sessionStorage.setItem('research.modelPreference', JSON.stringify({ model_id: 'gpt-6-luna', reasoning_effort: 'high' }))
  render(<App />)
  await screen.findByText(/上次启动尚未确认/)
  await within(screen.getByRole('main')).findByRole('button', { name: '使用今日热点' })
  expect(writes).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: '继续启动' }))
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('今日热点｜2026-10-08'))
  expect(writes).toEqual([original, original])
  expect(original.body).toMatchObject(selectedModel)
  expect(window.location.hash).toBe('#/research/hotspot-conversation?scope=news')
  expect(screen.queryByRole('button', { name: '继续启动' })).not.toBeInTheDocument()
})

it('disables duplicate launches and keeps newer navigation when a delayed launch response arrives', async () => {
  let finish!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { finish = resolve })
  const { writes, fetcher } = stubApi(() => pending), user = userEvent.setup()
  render(<App />)
  await user.click(await within(screen.getByRole('main')).findByRole('button', { name: '使用今日热点' }))
  await screen.findByText('正在启动今日热点…')
  const launchButtons = screen.getAllByRole('button', { name: '使用今日热点' })
  expect(launchButtons).toHaveLength(2)
  for (const button of launchButtons) expect(button).toBeDisabled()
  await user.click(launchButtons[0])
  expect(writes).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: '研究项目' }))
  await screen.findByRole('heading', { name: '研究项目目录' })
  await act(async () => { finish(accepted(writes[0].body)); await pending })
  expect(window.location.hash).toBe('#/projects')
  expect(screen.getByRole('heading', { name: '研究项目目录' })).toBeInTheDocument()
  expect(screen.queryByRole('log')).not.toBeInTheDocument()
  expect(fetcher.mock.calls.some(([input]) => new URL(String(input), 'http://localhost').pathname === '/api/v1/conversations/hotspot-conversation')).toBe(false)
  expect(writes).toHaveLength(1)
})
