import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('./pages/ClientServicePage', () => ({ default: () => <h1>对客服务工作区</h1> }))
beforeAll(async () => {
  await Promise.all([import('./pages/ResearchWorkspace'), import('./pages/ScreeningWorkspace')])
}, 60000)

beforeEach(() => {
  window.history.replaceState(null, '', '#/research/new')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname
    return new Response(JSON.stringify(path === '/api/v1/data/status' ? { available: true, last_date: '2026-11-16' } : { items: [] }))
  }))
})


const tools = () => within(screen.getByRole('navigation', { name: '选股工具' }))
const toolsTrigger = () => tools().getByRole('button', { name: '选股工具' })

async function showTools(user: ReturnType<typeof userEvent.setup>) {
  const trigger = toolsTrigger()
  if (trigger.getAttribute('aria-expanded') !== 'true') await user.click(trigger)
  return tools()
}

async function openTool(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click((await showTools(user)).getByRole('button', { name }))
  expect(toolsTrigger()).toHaveAttribute('aria-expanded', 'false')
}

async function expectCurrentTool(user: ReturnType<typeof userEvent.setup>, name: string) {
  expect((await showTools(user)).getByRole('button', { name })).toHaveAttribute('aria-current', 'page')
  await user.keyboard('{Escape}')
}

it('returns from service to the same screening draft and restores it after reload', async () => {
  const user = userEvent.setup(), view = render(<App />)
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '保留研究问题')
  const firstResearchTab = screen.getByRole('tab', { selected: true })
  await user.click(screen.getByRole('button', { name: '新建任务' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toBeEnabled())
  await user.type(screen.getByLabelText('研究要求'), '另一份相同地址的研究草稿')
  await user.click(firstResearchTab)
  await user.click(screen.getByRole('button', { name: '选股对话' }))
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.type(screen.getByLabelText('选股要求'), '保留选股条件')
  const draft = screen.getByLabelText('选股要求')
  await user.click(screen.getByRole('button', { name: '切换到服务' }))
  await screen.findByRole('heading', { name: '对客服务工作区' })
  expect(screen.queryByRole('group', { name: '研究任务类型' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '切换到服务' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: '切换到研究' }))
  expect(screen.getByLabelText('选股要求')).toBe(draft)
  expect(draft).toHaveValue('保留选股条件')
  await user.click(screen.getByRole('button', { name: '切换到服务' }))
  await screen.findByRole('heading', { name: '对客服务工作区' })
  view.unmount(); render(<App />)
  await screen.findByRole('heading', { name: '对客服务工作区' })
  await user.click(screen.getByRole('button', { name: '切换到研究' }))
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toHaveValue('保留选股条件'))
  await user.click(screen.getByRole('button', { name: '研究对话' }))
  await waitFor(() => expect(screen.getByLabelText('研究要求')).toHaveValue('保留研究问题'))
  expect(screen.getByRole('tab', { selected: true }).id).toBe(firstResearchTab.id)
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
}, 15000)

it('keeps saved plans, condition management and history accessible from their old routes', async () => {
  window.history.replaceState(null, '', '#/screening?view=saved')
  const user = userEvent.setup()
  render(<App />)
  await screen.findByRole('heading', { name: '我的方案' })
  await expectCurrentTool(user, '管理方案')
  await user.click(screen.getByRole('button', { name: '管理条件库' }))
  await waitFor(() => expect(window.location.hash).toBe('#/screening?view=library'))
  const menu = await showTools(user)
  expect(menu.getByRole('button', { name: '条件库' })).toHaveAttribute('aria-current', 'page')
  expect(menu.getByRole('button', { name: '管理方案' })).not.toHaveAttribute('aria-current')
  expect(screen.queryByRole('button', { name: '研究项目' })).not.toBeInTheDocument()
  await openTool(user, '筛选记录')
  await screen.findByRole('textbox', { name: '搜索筛选记录' })
  expect(window.location.hash).toBe('#/screening?view=history')
  await expectCurrentTool(user, '筛选记录')
  expect(screen.queryByRole('group', { name: '研究任务类型' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '新建任务' }))
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  expect(screen.queryByRole('region', { name: '选择选股方式' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '引用方案' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '组合多个条件' }))
  await waitFor(() => expect(window.location.hash).toBe('#/screening?view=compose'))
  await expectCurrentTool(user, '组合选股')
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('discloses the tools on demand and returns keyboard focus after closing', async () => {
  window.history.replaceState(null, '', '#/screening/method/report')
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(screen.getByLabelText('专用选股要求')).toBeEnabled())
  const trigger = toolsTrigger()
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(tools().queryByRole('button', { name: '管理方案' })).not.toBeInTheDocument()
  trigger.focus()
  await user.keyboard('{Enter}')
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  const menu = tools()
  expect(menu.getByRole('group', { name: '条件工具' })).toBeVisible()
  expect(menu.getByRole('button', { name: '固定规则与试算' })).toBeVisible()
  expect(menu.queryByRole('button', { name: '研报选股' })).not.toBeInTheDocument()
  expect(within(menu.getByRole('group', { name: '管理与回看' })).getAllByRole('button')).toHaveLength(3)
  await user.tab()
  expect(menu.getByRole('button', { name: '组合选股' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(trigger).toHaveFocus()
  expect(screen.queryByRole('group', { name: '研究任务类型' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '新建任务' }))
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  expect(screen.getByRole('button', { name: '引用方案' })).toBeInTheDocument()
})

it('opens the fixed rules tool on the same tab and restores the composition and original draft', async () => {
  window.history.replaceState(null, '', '#/screening/new')
  const user = userEvent.setup(), view = render(<App />)
  const original = await screen.findByLabelText('选股要求')
  await waitFor(() => expect(original).toBeEnabled())
  fireEvent.change(original, { target: { value: '保留原任务中的选股条件' } })

  await openTool(user, '固定规则与试算')
  expect(await screen.findByRole('dialog', { name: '固定规则与试算' })).toBeVisible()
  expect(window.location.hash).toBe('#/screening/new')
  await user.keyboard('{Escape}')
  expect(original).toHaveValue('保留原任务中的选股条件')
  await openTool(user, '组合选股')
  const compositionName = await screen.findByRole('textbox', { name: '组合名称' })
  fireEvent.change(compositionName, { target: { value: '保留未保存的组合' } })
  for (const [label, hash] of [['条件库', '#/screening?view=library'], ['管理方案', '#/screening?view=saved'], ['筛选记录', '#/screening?view=history']] as const) {
    await openTool(user, label)
    await waitFor(() => expect(window.location.hash).toBe(hash))
    await expectCurrentTool(user, label)
  }
  await openTool(user, '组合选股')
  expect(screen.getByRole('textbox', { name: '组合名称' })).toBe(compositionName)
  expect(compositionName).toHaveValue('保留未保存的组合')
  const count = screen.getAllByRole('tab').length
  await openTool(user, '组合选股')
  expect(screen.getAllByRole('tab')).toHaveLength(count)
  view.unmount(); render(<App />)
  expect(await screen.findByRole('textbox', { name: '组合名称' })).toHaveValue('保留未保存的组合')
  await user.click(screen.getByRole('tab', { name: '新选股' }))
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toHaveValue('保留原任务中的选股条件'))
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
}, 20000)

it('brings a fixed shape version back to the originating conversation or composition', async () => {
  window.history.replaceState(null, '', '#/screening/new')
  const shape = {
    id: 'shape-one', version: 2, name: '双底样本', note: '', input_type: 'drawing',
    representation: 'price_path', target_bars: 12, points: [5, 4, 3, 2, 3, 4, 3, 2, 3, 4, 5, 6],
    candlesticks: [], params: { min_similarity: 87, match_mode: 'recent', recent_bars: 18 },
    created_at: '2026-11-17T08:00:00Z',
  }
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation((input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/v1/patterns') return Promise.resolve(new Response(JSON.stringify({ items: [shape] })))
    if (path.endsWith('/shape-one/best-match')) return Promise.resolve(new Response(JSON.stringify({ bars: [], items: [], reason: '样例没有相似行情' })))
    return fallback(input, init)
  })
  const user = userEvent.setup()
  render(<App />)
  const editor = await screen.findByLabelText('选股要求')
  await waitFor(() => expect(editor).toBeEnabled())
  const originalTabId = screen.getByRole('tab', { selected: true }).id
  fireEvent.change(editor, { target: { value: '保留原有成交量要求' } })
  async function openGallery() {
    await openTool(user, '选取形态样本')
    await screen.findByRole('heading', { name: '形态样本编辑' })
    await user.click(screen.getByRole('tab', { name: '我的形态' }))
    const sample = await screen.findByRole('heading', { name: '双底样本' })
    return within(sample.closest('article')!)
  }

  await user.click((await openGallery()).getByRole('button', { name: '带回选股对话' }))
  await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>('选股要求').value).toContain('双底样本'))
  expect(screen.getByLabelText<HTMLTextAreaElement>('选股要求').value).toContain('保留原有成交量要求')
  expect(screen.getByRole('tab', { selected: true }).id).toBe(originalTabId)
  expect(screen.getByLabelText('新增条件依据')).toHaveTextContent('双底样本 · v2')
  await openTool(user, '组合选股')
  const compositionName = await screen.findByRole('textbox', { name: '组合名称' })
  fireEvent.change(compositionName, { target: { value: '保留组合名称' } })
  await user.click((await openGallery()).getByRole('button', { name: '加入组合' }))
  await screen.findByText('已加入形态「双底样本」v2')
  expect(screen.getByRole('textbox', { name: '组合名称' })).toBe(compositionName)
  expect(compositionName).toHaveValue('保留组合名称')
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
}, 15000)

it('returns to an existing method task rather than opening a blank method draft', async () => {
  window.history.replaceState(null, '', '#/screening/task-one?scope=news&method=news')
  const timestamp = '2026-11-17T01:00:00Z'
  const stored = { id: 'task-one', task_id: 'task-one', entry_scope: 'news', workflow_type: 'screening', task_revision: 0, active_run_id: null, pending_execution: false, state: 'active', messages: [{ id: 'q', role: 'user', content: '原任务中的条件', source_refs: [], created_at: timestamp }], turns: [], created_at: timestamp, updated_at: timestamp }
  const defaultFetch = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation((input, init) => { const path = new URL(String(input), 'http://localhost').pathname; return /^\/api\/v1\/conversations\/task-(one|two)$/.test(path) ? Promise.resolve(new Response(JSON.stringify({ ...stored, id: path.endsWith('two') ? 'task-two' : 'task-one', task_id: path.endsWith('two') ? 'task-two' : 'task-one' }))) : defaultFetch(input, init) })
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  const input = screen.getByLabelText('选股要求')
  const originalTab = screen.getByRole('tab', { selected: true })
  fireEvent.change(input, { target: { value: '任务里的未发送追问' } })
  for (const name of ['条件库', '组合选股', '筛选记录']) await openTool(user, name)
  await user.click(originalTab)
  expect(screen.getByLabelText('选股要求')).toBe(input)
  expect(input).toHaveValue('任务里的未发送追问')
  expect(window.location.hash).toBe('#/screening/task-one?scope=news&method=news')
  expect(within(screen.getByRole('log')).getByText('原任务中的条件', { selector: 'p' })).toBeVisible()
  expect(screen.getAllByRole('tab')).toHaveLength(4)
  act(() => { window.history.pushState(null, '', '#/screening/task-two?scope=news&method=news'); window.dispatchEvent(new HashChangeEvent('hashchange')) })
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  fireEvent.change(screen.getByLabelText('选股要求'), { target: { value: '第二份资讯选股草稿' } })
  const secondTab = screen.getByRole('tab', { selected: true })
  await user.click(originalTab)
  expect(screen.getByLabelText('选股要求')).toBe(input)
  await openTool(user, '条件库')
  await user.click(originalTab)
  expect(screen.getByLabelText('选股要求')).toBe(input)
  expect(input).toHaveValue('任务里的未发送追问')
  await user.click(secondTab)
  expect(screen.getByLabelText('选股要求')).toHaveValue('第二份资讯选股草稿')
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
}, 15000)
