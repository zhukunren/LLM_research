import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'

const assistants = [
  ['general', '通用投研'], ['financial', '财报分析'], ['reports', '研报解读'],
  ['supply-chain', '产业链研究'], ['risk', '风险复核'],
].map(([id, name]) => ({ id, name, description: `${name}预设方法`, instructions: '核对原文，保留证据。', enabled: true, builtin: true, revision: 1, skill_hash: id }))

beforeEach(() => window.history.replaceState(null, '', '/'))
afterEach(() => window.history.replaceState(null, '', '/'))

vi.mock('./pages/ResearchProjectsPage', () => ({ default: ({ onOpenConversation, initialProjectId }: { onOpenConversation: (id: string, scope: 'screening') => void; initialProjectId?: string }) => <><p>项目定位：{initialProjectId || '目录'}</p><button onClick={() => onOpenConversation('one', 'screening')}>打开项目对话</button></> }))
vi.mock('./pages/LibraryWorkspace', () => ({ default: () => <h1>资料阅读</h1> }))
vi.mock('./pages/ObservationPage', () => ({ default: ({ initialRunId, initialCandidateId, onLocationChange }: { initialRunId?: string; initialCandidateId?: string; onLocationChange: (tab: 'candidates' | 'batches', id: string) => void }) => <><h1>观察定位：{initialRunId || initialCandidateId || '目录'}</h1><button onClick={() => onLocationChange('candidates', 'candidate-two')}>选择第二候选</button><button onClick={() => onLocationChange('batches', 'run-two')}>选择第二批次</button></> }))
vi.mock('./pages/WorkbenchPage', async () => {
  const { default: Workspace } = await import('./components/conversation/ConversationWorkspace')
  return { default: ({ conversationId, conversationPrompt, onPromptConsumed, newResearchKey, onNewResearchConsumed, conversationWorkflowType, workflowOnly, onLocationChange, conversationNewDraft }: { conversationId?: string; conversationPrompt?: string; onPromptConsumed?: () => void; newResearchKey?: number; onNewResearchConsumed?: () => void; conversationWorkflowType?: 'research' | 'screening'; workflowOnly?: boolean; conversationNewDraft?: boolean; onLocationChange?: (id: string, scope: 'technical' | 'news' | 'report' | 'pattern' | 'screening', workflow: 'research' | 'screening') => void }) => <Workspace initialWorkflowType={workflowOnly ? 'screening' : conversationWorkflowType} initialConversationId={conversationId} initialNewDraft={conversationNewDraft} initialPrompt={conversationPrompt} onPromptConsumed={onPromptConsumed} newResearchKey={newResearchKey} onNewResearchConsumed={onNewResearchConsumed} onLocationChange={onLocationChange} /> }
})

it('opens research by default and moves projects and optional tools into the sidebar without starting jobs', async () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [] })))
  vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup()
  const view = render(<App />)
  const menu = within(screen.getByRole('navigation', { name: '主菜单' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(window.location.hash).toBe('#/research/new')
  expect(menu.getByRole('button', { name: '研究对话' })).toHaveAttribute('aria-current', 'page')
  expect(menu.queryByRole('button', { name: '首页' })).not.toBeInTheDocument()
  expect(menu.queryByRole('button', { name: '资讯库' })).not.toBeInTheDocument()
  expect(menu.getByRole('button', { name: '观察池' })).toBeInTheDocument()
  expect(menu.getByRole('button', { name: '研究助手' })).toBeInTheDocument()
  await user.click(menu.getByRole('button', { name: '研究项目' }))
  expect(await screen.findByRole('button', { name: '打开项目对话' })).toBeInTheDocument()
  await user.click(menu.getByRole('button', { name: '资料与工具' }))
  for (const name of ['资讯库', '技术指标库', '形态库', '研报库']) expect(menu.getByRole('button', { name })).toBeInTheDocument()
  await user.click(menu.getByRole('button', { name: '资讯库' }))
  await screen.findByRole('heading', { name: '资料阅读' })
  await user.click(menu.getByRole('button', { name: '研究项目' }))
  expect(window.location.hash).toBe('#/projects')
  view.unmount()
  render(<App />)
  expect(await screen.findByRole('button', { name: '打开项目对话' })).toBeInTheDocument()
  expect(fetcher.mock.calls.every(call => !(call as unknown as [unknown, RequestInit])[1]?.method)).toBe(true)
})
it('opens a saved screening conversation in condition screening instead of the research assistant', async () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  sessionStorage.setItem('app.page', JSON.stringify('research'))
  const date = '2026-10-04T08:00:00Z'
  const stored = { id: 'one', task_id: 'one', entry_scope: 'screening', workflow_type: 'screening', research_depth: 'standard', task_revision: 0, pending_execution: false, active_run_id: null, state: 'active', messages: [], turns: [], created_at: date, updated_at: date }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    return new Response(JSON.stringify(path === '/api/v1/conversations/one' ? stored : path === '/api/v1/conversations' ? { items: [{ ...stored, title: '订单选股' }] } : { items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  const user = userEvent.setup()
  render(<App />)
  await user.click(await screen.findByRole('button', { name: '打开项目对话' }))
  expect(await screen.findByRole('heading', { name: '新建选股方案' }, { timeout: 5000 })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '条件选股' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByLabelText('选股要求')).toBeInTheDocument()
  expect(screen.queryByLabelText('研究要求')).not.toBeInTheDocument()
})

it('restores a legacy home question and consumes explicit new research only once across navigation', async () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  sessionStorage.setItem('home.researchDraft', JSON.stringify('核对订单的实际兑现情况'))
  const fetcher = vi.fn(async (input: RequestInfo | URL, _options?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const response = url.pathname.endsWith('/data/status') ? { available: true, last_date: '2026-09-28' }
      : url.pathname.endsWith('/research-modes') ? { default_mode: 'research' }
      : { items: [] }
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup()
  render(<App />)
  expect(await screen.findByRole('heading', { name: '开始研究' }, { timeout: 5000 })).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: '工作台研究问题' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '继续未发送的问题' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toHaveValue('核对订单的实际兑现情况'))
  await user.keyboard('{Control>}k{/Control}')
  const search = await screen.findByRole('combobox', { name: '搜索页面、项目或对话' })
  await user.type(search, '开始新研究')
  await user.keyboard('{Enter}')
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toHaveValue(''))
  await user.type(screen.getByLabelText('研究要求'), '新的待完成草稿')
  await user.click(screen.getByRole('button', { name: '研究项目' }))
  await screen.findByRole('button', { name: '打开项目对话' })
  await user.click(screen.getByRole('button', { name: '研究对话' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(screen.getByLabelText('研究要求')).toHaveValue('新的待完成草稿')
  expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('returns to the chosen conversation and then an unsent draft after opening a project conversation', async () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  sessionStorage.setItem('app.page', JSON.stringify('research'))
  const date = '2026-10-03T08:00:00Z'
  const conversations = ['one', 'two'].map(id => ({ id, task_id: id, entry_scope: 'screening', research_mode: 'research', task_revision: 0, active_run_id: null, pending_execution: false, state: 'active', messages: [{ id: id + '-m', role: 'user', content: '研究' + id, source_refs: [], created_at: date }], turns: [], created_at: date, updated_at: date }))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const response = url.pathname.endsWith('/data/status') ? { available: true, last_date: '2026-09-28' }
      : url.pathname.endsWith('/research-modes') ? { default_mode: 'research' }
      : url.pathname === '/api/v1/conversations' ? { items: conversations.map(item => ({ ...item, title: '研究' + item.id })) }
      : conversations.find(item => url.pathname === '/api/v1/conversations/' + item.id) ?? { items: [] }
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  const user = userEvent.setup()
  render(<App />)
  await user.click(await screen.findByRole('button', { name: '打开项目对话' }))
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('研究one'))
  await user.click(await screen.findByRole('button', { name: '继续研究：研究two' }))
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('研究two'))
  if (screen.getByRole('button', { name: '资料与工具' }).getAttribute('aria-expanded') !== 'true') await user.click(screen.getByRole('button', { name: '资料与工具' }))
  await user.click(screen.getByRole('button', { name: '资讯库' }))
  await screen.findByRole('heading', { name: '资料阅读' })
  await user.click(screen.getByRole('button', { name: '研究对话' }))
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('研究two'))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '开始新研究' }))
  await user.type(screen.getByLabelText('研究要求'), '尚未发送的研究草稿')
  await user.click(screen.getByRole('button', { name: '研报库' }))
  await screen.findByRole('heading', { name: '资料阅读' })
  await user.click(screen.getByRole('button', { name: '研究对话' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  expect(screen.getByLabelText('研究要求')).toHaveValue('尚未发送的研究草稿')
})

function conversationResponse(id: string, workflow: 'research' | 'screening' = 'research') {
  const date = '2026-10-06T08:00:00Z'
  return { id, task_id: id, entry_scope: 'screening', workflow_type: workflow, research_depth: 'standard', task_revision: 0, pending_execution: false, active_run_id: null, state: 'active', messages: [{ id: id + '-message', role: 'user', content: '已有研究 ' + id, source_refs: [], created_at: date }], turns: [], created_at: date, updated_at: date }
}

function stubRouteApi(workflow: 'research' | 'screening' = 'research') {
  const fetcher = vi.fn(async (input: RequestInfo | URL, _options?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const response = url.pathname.endsWith('/data/status') ? { available: true, last_date: '2026-09-28' }
      : url.pathname.endsWith('/research-modes') ? { default_mode: 'research' }
        : url.pathname.endsWith('/research-assistants') ? { items: assistants }
        : /^\/api\/v1\/conversations\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith('research-modes') ? conversationResponse(url.pathname.split('/').at(-1)!, workflow)
          : { items: [] }
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetcher)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  return fetcher
}

it.each(['card', 'submenu'])('starts a financial research draft from the assistant %s and preserves its choice through history and reload without running a job', async entry => {
  window.history.replaceState(null, '', '#/research/new')
  sessionStorage.setItem('conversation.drafts', JSON.stringify({ 'research:screening:new': '此前的研究草稿' }))
  sessionStorage.setItem('conversation.assistantDrafts', JSON.stringify({ 'research:screening:new': 'general' }))
  const fetcher = stubRouteApi(), user = userEvent.setup()
  const view = render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toHaveValue('此前的研究草稿'))
  const menu = within(screen.getByRole('navigation', { name: '主菜单' }))
  await user.click(menu.getByRole('button', { name: '研究助手' }))
  await screen.findByRole('heading', { name: '研究助手' })
  expect(window.location.hash).toBe('#/assistants')
  expect(menu.getByRole('button', { name: '研究助手' })).toHaveAttribute('aria-current', 'page')
  const origin = entry === 'card'
    ? within(screen.getByRole('main'))
    : within(menu.getByRole('group', { name: '研究助手子入口' }))
  await user.click(await origin.findByRole('button', { name: '使用财报分析' }))
  await waitFor(() => expect(screen.getByRole('combobox', { name: '研究助手' })).toHaveValue('financial'))
  expect(window.location.hash).toBe('#/research/new')
  expect(screen.getByLabelText('研究要求')).toHaveValue('')
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '核对经营现金流与利润的差异')
  await user.click(menu.getByRole('button', { name: '观察池' }))
  await screen.findByRole('heading', { name: '观察定位：目录' })
  act(() => window.history.back())
  await waitFor(() => expect(screen.getByRole('combobox', { name: '研究助手' })).toHaveValue('financial'))
  expect(screen.getByLabelText('研究要求')).toHaveValue('核对经营现金流与利润的差异')
  view.unmount()
  render(<App />)
  await waitFor(() => expect(screen.getByRole('combobox', { name: '研究助手' })).toHaveValue('financial'))
  expect(screen.getByLabelText('研究要求')).toHaveValue('核对经营现金流与利润的差异')
  expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('opens a bookmarked conversation beyond the recent list, using URL before legacy session state and without starting work', async () => {
  sessionStorage.setItem('app.page', '"research"')
  localStorage.setItem('conversation.active.screening.research', 'old-conversation')
  window.history.replaceState(null, '', '#/research/bookmarked')
  const fetcher = stubRouteApi()
  const view = render(<App />)
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('已有研究 bookmarked'))
  expect(window.location.hash).toBe('#/research/bookmarked')
  expect(fetcher.mock.calls.some(([input]) => String(input).includes('conversations/old-conversation'))).toBe(false)
  expect(fetcher.mock.calls.some(([input]) => /\/filters|\/strategies|\/patterns\?/.test(String(input)))).toBe(false)
  view.unmount()
  sessionStorage.setItem('app.page', '"home"')
  render(<App />)
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('已有研究 bookmarked'))
  expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('canonicalizes a bookmarked conversation to its actual saved workflow before rendering an entry', async () => {
  window.history.replaceState(null, '', '#/research/saved-screen')
  const fetcher = stubRouteApi('screening')
  const historyLength = window.history.length
  render(<App />)
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('已有研究 saved-screen'))
  expect(window.location.hash).toBe('#/screening/saved-screen')
  expect(window.history.length).toBe(historyLength)
  expect(screen.getByLabelText('选股要求')).toBeInTheDocument()
  expect(screen.queryByLabelText('研究要求')).not.toBeInTheDocument()
  expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('restores project and conversation objects through browser history', async () => {
  window.history.replaceState(null, '', '#/projects/project-one')
  const fetcher = stubRouteApi()
  const user = userEvent.setup()
  render(<App />)
  expect(await screen.findByText('项目定位：project-one')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '打开项目对话' }))
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('已有研究 one'))
  act(() => window.history.back())
  expect(await screen.findByText('项目定位：project-one')).toBeInTheDocument()
  act(() => window.history.forward())
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('已有研究 one'))
  expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it.each([['candidates', 'candidate-one'], ['batches', 'run-one']])('opens, selects and restores a bookmarked observation %s', async (kind, id) => {
  window.history.replaceState(null, '', `#/observation/${kind}/${id}`)
  const fetcher = stubRouteApi()
  const user = userEvent.setup()
  render(<App />)
  expect(await screen.findByRole('heading', { name: `观察定位：${id}` })).toBeInTheDocument()
  const second = kind === 'candidates' ? 'candidate-two' : 'run-two'
  await user.click(screen.getByRole('button', { name: kind === 'candidates' ? '选择第二候选' : '选择第二批次' }))
  expect(await screen.findByRole('heading', { name: `观察定位：${second}` })).toBeInTheDocument()
  expect(window.location.hash).toBe(`#/observation/${kind}/${second}`)
  act(() => window.history.back())
  expect(await screen.findByRole('heading', { name: `观察定位：${id}` })).toBeInTheDocument()
  expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('shows a missing bookmarked conversation without silently opening or creating a different one', async () => {
  window.history.replaceState(null, '', '#/research/missing')
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const fetcher = vi.fn(async (input: RequestInfo | URL, _options?: RequestInit) => new Response(JSON.stringify(String(input).endsWith('/conversations/missing') ? { message: '找不到这段研究对话。' } : { items: [] }), { status: String(input).endsWith('/conversations/missing') ? 404 : 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  render(<App />)
  expect(await screen.findByText('找不到这段研究对话。')).toBeInTheDocument()
  expect(screen.queryByRole('log')).not.toBeInTheDocument()
  expect(window.location.hash).toBe('#/research/missing')
  expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it.each([['research', '研究要求'], ['screening', '选股要求']])('preserves an unsent %s draft when restoring its URL or browser Back, and clears it only on an explicit New action', async (workflow, inputLabel) => {
  window.history.replaceState(null, '', `#/${workflow}/new`)
  sessionStorage.setItem('conversation.drafts', JSON.stringify({ [`${workflow === 'research' ? 'research' : 'screening'}:screening:new`]: '已有未发送的研究草稿' }))
  const fetcher = stubRouteApi(), user = userEvent.setup()
  const view = render(<App />)
  await waitFor(() => expect(screen.getByLabelText(inputLabel)).toHaveValue('已有未发送的研究草稿'))
  if (screen.getByRole('button', { name: '资料与工具' }).getAttribute('aria-expanded') !== 'true') await user.click(screen.getByRole('button', { name: '资料与工具' }))
  await user.click(screen.getByRole('button', { name: '资讯库' }))
  await screen.findByRole('heading', { name: '资料阅读' })
  act(() => window.history.back())
  await waitFor(() => expect(screen.getByLabelText(inputLabel)).toHaveValue('已有未发送的研究草稿'))
  await user.click(screen.getByRole('button', { name: workflow === 'research' ? '开始新研究' : '新选股对话' }))
  await waitFor(() => expect(screen.getByLabelText(inputLabel)).toHaveValue(''))
  await user.type(screen.getByLabelText(inputLabel), '刷新后继续的草稿')
  view.unmount()
  render(<App />)
  await waitFor(() => expect(screen.getByLabelText(inputLabel)).toHaveValue('刷新后继续的草稿'))
  expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('publishes the new conversation URL after an explicit message without restarting or duplicating that message', async () => {
  window.history.replaceState(null, '', '#/research/new')
  const date = '2026-10-06T08:00:00Z'
  let stored: ReturnType<typeof conversationResponse> | null = null
  const writes: { path: string; body: unknown }[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost'), path = url.pathname
    if (init?.method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : {}
      writes.push({ path, body })
      if (path === '/api/v1/conversations') { stored = { ...conversationResponse('new-one'), messages: [] }; return new Response(JSON.stringify(stored)) }
      if (path.endsWith('/messages')) {
        stored = { ...stored!, messages: [{ id: 'user-one', role: 'user', content: body.content, source_refs: [], created_at: date }], turns: [] }
        return new Response(JSON.stringify({ message_id: 'user-one', turn_id: 'turn-one' }))
      }
      if (path.endsWith('/process')) {
        stored = { ...stored!, messages: [...stored!.messages, { id: 'assistant-one', role: 'assistant', content: '核对完成的研究答复', source_refs: [], created_at: date }] }
        return new Response(JSON.stringify({ id: 'turn-one', state: 'succeeded', result: {} }))
      }
    }
    const result = path.endsWith('/data/status') ? { available: true, last_date: '2026-09-28' }
      : path.endsWith('/research-modes') ? { default_mode: 'research' }
        : path === '/api/v1/conversations' ? { items: stored ? [{ ...stored, title: '新研究' }] : [] }
          : path === '/api/v1/conversations/new-one' ? stored : { items: [] }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetcher)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '核对订单兑现')
  await user.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('核对完成的研究答复'))
  expect(window.location.hash).toBe('#/research/new-one')
  expect(writes.filter(item => item.path.endsWith('/messages'))).toHaveLength(1)
  expect(writes.filter(item => item.path.endsWith('/process'))).toHaveLength(1)
  expect(writes.filter(item => item.path === '/api/v1/conversations')).toHaveLength(1)
  expect(writes.some(item => item.path.endsWith('/execute'))).toBe(false)
})
