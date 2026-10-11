import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api, type ResearchAssistant } from '../api'
import ResearchSidebar from './ResearchSidebar'

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), api: vi.fn() }))
const props = () => ({ page: 'screening' as const, revision: 0, mobileOpen: false, onClose: vi.fn(), onNavigate: vi.fn(), onNewResearch: vi.fn(), onNewScreening: vi.fn(), onSearch: vi.fn(), onConversation: vi.fn(), onAssistant: vi.fn(), onSettings: vi.fn() })

it('keeps pinned conversations first and reads archives separately', async () => {
  const recent = [{ id: 'ordinary', title: '最新研究', entry_scope: 'screening', workflow_type: 'research', state: 'active', pinned: false },
    { id: 'pinned', title: '置顶研究', entry_scope: 'screening', workflow_type: 'research', state: 'active', pinned: true }]
  vi.mocked(api).mockImplementation(async path => ({ items: path.includes('state=archived') ? [
    { ...recent[0], id: 'archived', title: '已归档研究', state: 'archived' },
  ] : recent } as never))
  const user = userEvent.setup()
  render(<ResearchSidebar {...props()} />)
  await screen.findByRole('button', { name: '继续研究：置顶研究' })
  const history = within(screen.getByRole('region', { name: '最近对话' }))
  expect(history.getAllByRole('button', { name: /^继续研究/ }).map(button => button.textContent)).toEqual(['置顶研究', '最新研究'])
  expect(history.getByLabelText('已置顶')).toBeInTheDocument()
  await user.click(history.getByRole('button', { name: '已归档' }))
  expect(await history.findByRole('button', { name: '继续研究：已归档研究' })).toBeInTheDocument()
  expect(history.queryByRole('button', { name: '继续研究：最新研究' })).not.toBeInTheDocument()
  await user.click(history.getByRole('button', { name: '返回最近' }))
  expect(await history.findByRole('button', { name: '继续研究：最新研究' })).toBeInTheDocument()
})

it('puts advanced tools behind a disclosure and keeps conversations separate from all screening runs', async () => {
  vi.mocked(api).mockResolvedValue({ items: [{ id: 'screen-one', title: '旧选股对话', entry_scope: 'technical', workflow_type: 'screening' }] } as never)
  const callbacks = props(), onScreeningView = vi.fn(), user = userEvent.setup()
  const view = render(<ResearchSidebar {...callbacks} page="conditions" onScreeningView={onScreeningView} />)
  expect(screen.queryByRole('button', { name: '我的条件' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '高级组合' })).not.toBeInTheDocument()
  const history = screen.getByRole('region', { name: '最近选股' })
  await user.click(await within(history).findByRole('button', { name: '继续选股：旧选股对话' }))
  expect(callbacks.onConversation).toHaveBeenCalledWith('screen-one', 'technical', 'screening')
  await user.click(within(history).getByRole('button', { name: '全部筛选记录' }))
  expect(onScreeningView).toHaveBeenCalledWith('history')
  await user.click(screen.getByRole('button', { name: '我的方案' }))
  expect(onScreeningView).toHaveBeenCalledWith('saved')
  const advanced = screen.getByRole('button', { name: '高级工具' })
  advanced.focus(); await user.keyboard('{Enter}')
  await user.click(screen.getByRole('button', { name: '高级组合' }))
  expect(onScreeningView).toHaveBeenCalledWith('compose')
  await user.click(advanced)
  view.rerender(<ResearchSidebar {...callbacks} page="conditions" screeningView="library" onScreeningView={onScreeningView} />)
  expect(screen.getByRole('button', { name: '我的条件' })).toHaveAttribute('aria-current', 'page')
})
const assistants: ResearchAssistant[] = [
  ['general', '通用投研'], ['financial', '财报分析'], ['reports', '研报解读'],
  ['supply-chain', '产业链研究'], ['risk', '风险复核'],
].map(([id, name]) => ({ id, name, description: name, instructions: '保留证据。', enabled: true, builtin: true, revision: 1, skill_hash: id }))
const tasks: ResearchAssistant[] = [
  ['daily-hotspots', '今日热点'], ['policy-tracker', '政策追踪'], ['industry-updates', '产业动态'],
].map(([id, name]) => ({ ...assistants[0], id, name, launch_mode: 'immediate', launch_description: '自动检索并整理来源' }))

it('keeps observation and assistants as primary entries, with the five presets beneath assistants', async () => {
  vi.mocked(api).mockImplementation(async path => ({ items: path === '/research-assistants' ? [...assistants,
    { ...assistants[0], id: 'custom', name: '自定义助手', builtin: false },
    { ...assistants[0], id: 'disabled', name: '停用助手', enabled: false },
  ] : [] } as never))
  const callbacks = props(), user = userEvent.setup()
  render(<ResearchSidebar {...callbacks} />)
  const menu = within(screen.getByRole('navigation', { name: '主菜单' }))
  expect(menu.getByRole('button', { name: '观察池' })).toBeInTheDocument()
  expect(menu.getByRole('button', { name: '研究助手' })).toHaveAttribute('aria-expanded', 'false')
  expect(menu.queryByRole('button', { name: '使用财报分析' })).not.toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.some(([path]) => path === '/research-assistants')).toBe(false)
  await user.click(menu.getByRole('button', { name: '观察池' }))
  expect(callbacks.onNavigate).toHaveBeenCalledWith('watchlist')
  await user.click(menu.getByRole('button', { name: '研究助手' }))
  await menu.findByRole('button', { name: '使用财报分析' })
  expect(callbacks.onNavigate).toHaveBeenCalledWith('assistants')
  expect(menu.getByRole('button', { name: '研究助手' })).toHaveAttribute('aria-expanded', 'true')
  const children = within(menu.getByRole('group', { name: '研究助手子入口' }))
  for (const assistant of assistants) expect(children.getByRole('button', { name: `使用${assistant.name}` })).toBeInTheDocument()
  expect(menu.queryByRole('button', { name: '使用自定义助手' })).not.toBeInTheDocument()
  expect(menu.queryByRole('button', { name: '使用停用助手' })).not.toBeInTheDocument()
  expect(menu.queryByRole('button', { name: '研报库' })).not.toBeInTheDocument()
  await user.click(menu.getByRole('button', { name: '使用财报分析' }))
  expect(callbacks.onAssistant).toHaveBeenCalledExactlyOnceWith('financial')
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('keeps tools collapsed, resumes the correct workflow, and reveals tool navigation when requested', async () => {
  vi.mocked(api).mockResolvedValue({ items: [{ id: 'one', title: '订单研究', entry_scope: 'report', workflow_type: 'research' }, { id: 'two', title: '趋势筛选', entry_scope: 'technical', workflow_type: 'screening' }] } as never)
  const callbacks = props(), user = userEvent.setup()
  const view = render(<ResearchSidebar {...callbacks} conversationId="one" />)
  expect(screen.queryByRole('button', { name: '研报库' })).not.toBeInTheDocument()
  expect(await screen.findByRole('button', { name: '继续研究：订单研究' })).toHaveAttribute('aria-current', 'page')
  expect(screen.queryByRole('button', { name: '继续选股：趋势筛选' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '切换到选股' }))
  expect(callbacks.onNavigate).toHaveBeenCalledWith('conditions')
  view.rerender(<ResearchSidebar {...callbacks} page="conditions" />)
  await user.click(await screen.findByRole('button', { name: '继续选股：趋势筛选' }))
  expect(callbacks.onConversation).toHaveBeenCalledWith('two', 'technical', 'screening')
  await user.click(screen.getByRole('button', { name: '资料与工具' }))
  await user.click(screen.getByRole('button', { name: '研报库' }))
  expect(callbacks.onNavigate).toHaveBeenCalledWith('reports')
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('can collapse and reopen the assistant child entries while on the assistant page', async () => {
  vi.mocked(api).mockImplementation(async path => ({ items: path === '/research-assistants' ? assistants : [] } as never))
  const callbacks = props(), user = userEvent.setup()
  render(<ResearchSidebar {...callbacks} page="assistants" />)
  await screen.findByRole('button', { name: '使用风险复核' })
  const parent = screen.getByRole('button', { name: '研究助手' })
  expect(parent).toHaveAttribute('aria-current', 'page')
  await user.click(parent)
  expect(parent).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('button', { name: '使用风险复核' })).not.toBeInTheDocument()
  await user.click(parent)
  expect(parent).toHaveAttribute('aria-expanded', 'true')
  expect(await screen.findByRole('button', { name: '使用风险复核' })).toBeInTheDocument()
  expect(callbacks.onNavigate).not.toHaveBeenCalled()
})

it('expands assistant choices in the mobile navigation so a preset can be chosen directly', async () => {
  vi.mocked(api).mockImplementation(async path => ({ items: path === '/research-assistants' ? assistants : [] } as never))
  const callbacks = props(), user = userEvent.setup()
  render(<ResearchSidebar {...callbacks} mobileOpen />)
  const dialog = within(screen.getByRole('dialog', { name: '工作导航' }))
  await user.click(dialog.getByRole('button', { name: '研究助手' }))
  await user.click(await dialog.findByRole('button', { name: '使用财报分析' }))
  expect(callbacks.onAssistant).toHaveBeenCalledExactlyOnceWith('financial')
  expect(callbacks.onNavigate).not.toHaveBeenCalled()
  expect(callbacks.onClose).not.toHaveBeenCalled()
})

it('ignores an outdated history response after a conversation update', async () => {
  let resolveOld!: (value: never) => void
  vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  const callbacks = props()
  const view = render(<ResearchSidebar {...callbacks} />)
  vi.mocked(api).mockResolvedValue({ items: [{ id: 'new', title: '最新研究', entry_scope: 'screening', workflow_type: 'research' }] } as never)
  view.rerender(<ResearchSidebar {...callbacks} revision={1} conversationId="new" />)
  await screen.findByRole('button', { name: '继续研究：最新研究' })
  await act(async () => resolveOld({ items: [{ id: 'old', title: '过期记录', entry_scope: 'screening' }] } as never))
  expect(screen.queryByRole('button', { name: /过期记录/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '继续研究：最新研究' })).toHaveAttribute('aria-current', 'page')
})

it('focuses the mobile close button and returns focus after closing', async () => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const previous = document.createElement('button'); document.body.append(previous); previous.focus()
  const callbacks = props(), user = userEvent.setup()
  const view = render(<ResearchSidebar {...callbacks} mobileOpen />)
  expect(screen.getByRole('dialog', { name: '工作导航' })).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: '关闭工作导航' })).toHaveFocus())
  await user.keyboard('{Escape}')
  expect(callbacks.onClose).toHaveBeenCalledOnce()
  view.rerender(<ResearchSidebar {...callbacks} />)
  await waitFor(() => expect(previous).toHaveFocus())
  previous.remove()
})

it.each([false, true])('offers one primary screening start independently of tools (mobile: %s)', async mobileOpen => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const callbacks = props(), user = userEvent.setup()
  render(<ResearchSidebar {...callbacks} mobileOpen={mobileOpen} page="conditions" />)
  const menu = within(screen.getByRole('navigation', { name: '主菜单' }))
  const start = menu.getByRole('button', { name: '开始选股' })
  expect(menu.getAllByRole('button')[0]).toHaveAccessibleName('开始选股')
  expect(start).toHaveClass('chat-new')
  expect(start).toHaveAttribute('aria-current', 'page')
  expect(menu.getByRole('button', { name: '资料与工具' })).toHaveAttribute('aria-expanded', 'false')
  await user.click(start)
  expect(callbacks.onNewScreening).toHaveBeenCalledOnce()
  expect(callbacks.onNewResearch).not.toHaveBeenCalled()
  expect(callbacks.onNavigate).not.toHaveBeenCalled()
  await user.click(menu.getByRole('button', { name: '资料与工具' }))
  expect(menu.getAllByRole('button', { name: '开始选股' })).toHaveLength(1)
  expect(menu.queryByRole('button', { name: '条件选股' })).not.toBeInTheDocument()
  expect(menu.queryByRole('button', { name: '开始新研究' })).not.toBeInTheDocument()
  expect(menu.queryByRole('button', { name: '研究助手' })).not.toBeInTheDocument()
  expect(menu.getByRole('button', { name: '我的方案' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '切换到研究' }))
  expect(callbacks.onNavigate).toHaveBeenCalledWith('screening')
})

it('prioritizes immediate assistant tasks and passes their launch contract directly', async () => {
  vi.mocked(api).mockImplementation(async path => ({ items: path === '/research-assistants' ? [...assistants, ...tasks] : [] } as never))
  const callbacks = props(), user = userEvent.setup()
  render(<ResearchSidebar {...callbacks} page="assistants" />)
  await screen.findByRole('button', { name: '使用今日热点' })
  const children = within(screen.getByRole('group', { name: '研究助手子入口' }))
  expect(children.getAllByRole('button').slice(0, 3).map(button => button.textContent)).toEqual(tasks.map(item => item.name))
  await user.click(children.getByRole('button', { name: '使用今日热点' }))
  expect(callbacks.onAssistant).toHaveBeenCalledExactlyOnceWith('daily-hotspots', 'immediate', '今日热点')
  await user.click(children.getByRole('button', { name: '使用财报分析' }))
  expect(callbacks.onAssistant).toHaveBeenLastCalledWith('financial')
})

it('disables immediate launch entries while busy and keeps research methods accessible', async () => {
  vi.mocked(api).mockImplementation(async path => ({ items: path === '/research-assistants' ? [...assistants, ...tasks] : [] } as never))
  const callbacks = props(), user = userEvent.setup()
  const view = render(<ResearchSidebar {...callbacks} page="assistants" busy />)
  await screen.findByRole('button', { name: '使用今日热点' })
  for (const task of tasks) expect(screen.getByRole('button', { name: `使用${task.name}` })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '使用今日热点' }))
  expect(callbacks.onAssistant).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '使用财报分析' })).toBeEnabled()
  view.rerender(<ResearchSidebar {...callbacks} page="assistants" busy={false} />)
  await user.click(screen.getByRole('button', { name: '使用政策追踪' }))
  expect(callbacks.onAssistant).toHaveBeenCalledExactlyOnceWith('policy-tracker', 'immediate', '政策追踪')
})
