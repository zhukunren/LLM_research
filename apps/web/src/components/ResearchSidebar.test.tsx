import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import ResearchSidebar from './ResearchSidebar'

vi.mock('../api', async original => ({ ...await original<typeof import('../api')>(), api: vi.fn() }))
const props = () => ({ page: 'screening' as const, revision: 0, mobileOpen: false, onClose: vi.fn(), onNavigate: vi.fn(), onNewResearch: vi.fn(), onNewScreening: vi.fn(), onSearch: vi.fn(), onConversation: vi.fn(), onAssistant: vi.fn(), onSettings: vi.fn() })

it('does not show advisor task shortcuts or intelligence desk button', async () => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  render(<ResearchSidebar {...props()} />)
  expect(screen.queryByRole('group', { name: '投顾常用任务' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '情报台' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '收评' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '个股分析' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '个股推荐理由' })).not.toBeInTheDocument()
})

it.each([false, true])('shows library and other navigation without intelligence shortcuts (mobile %s)', async mobileOpen => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const callbacks = props(), user = userEvent.setup()
  render(<ResearchSidebar {...callbacks} mobileOpen={mobileOpen} />)
  expect(screen.queryByRole('button', { name: '情报台' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '内置指标参考', hidden: true })).not.toBeInTheDocument()
  expect(callbacks.onAssistant).not.toHaveBeenCalled()
  expect(screen.queryByRole('group', { name: '快捷任务' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '研究对话' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '启动今日热点' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '资料库' }))
  expect(callbacks.onNavigate).toHaveBeenLastCalledWith('library')
  expect(screen.queryByRole('button', { name: '资讯库' })).not.toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.every(([path, options]) => path !== '/research-assistants' && !options?.method)).toBe(true)
})

it.each([false, true])('keeps three primary screening destinations and moves tools below them (mobile %s)', async mobileOpen => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const callbacks = props(), onScreeningView = vi.fn(), user = userEvent.setup()
  render(<ResearchSidebar {...callbacks} page="conditions" mobileOpen={mobileOpen} onScreeningView={onScreeningView} />)
  const navigation = within(screen.getByRole('navigation', { name: '主菜单' }))
  expect(navigation.getAllByRole('button').slice(0, 4).map(button => button.getAttribute('aria-label'))).toEqual(['开始选股', '选股方式', '我的方案', '筛选记录'])
  for (const name of ['技术选股', '形态选股', '资讯选股', '研报选股']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
  for (const name of ['条件组合', '条件库管理', '全部筛选记录']) expect(screen.queryByRole('button', { name, hidden: true })).not.toBeInTheDocument()
  await user.click(navigation.getByRole('button', { name: '开始选股' }))
  expect(callbacks.onNewScreening).toHaveBeenCalledOnce()
  await user.click(navigation.getByRole('button', { name: '我的方案' }))
  expect(onScreeningView).toHaveBeenLastCalledWith('saved')
  await user.click(navigation.getByRole('button', { name: '筛选记录' }))
  expect(onScreeningView).toHaveBeenLastCalledWith('history')
  expect(screen.getAllByRole('button', { name: '筛选记录' })).toHaveLength(1)
  await user.click(navigation.getByRole('button', { name: '更多工具' }))
  await user.click(navigation.getByRole('button', { name: 'QMT 脚本生成' }))
  expect(callbacks.onNavigate).toHaveBeenLastCalledWith('qmt')
})

it('keeps pinned history and archive recovery, excluding desk runs before pagination', async () => {
  const recent = [{ id: 'ordinary', title: '最新研究', entry_scope: 'screening', workflow_type: 'research', state: 'active', pinned: false }, { id: 'pinned', title: '置顶研究', entry_scope: 'screening', workflow_type: 'research', state: 'active', pinned: true }]
  vi.mocked(api).mockImplementation(async path => ({ items: path.includes('state=archived') ? [{ ...recent[0], id: 'archived', title: '已归档研究', state: 'archived' }] : recent } as never))
  const user = userEvent.setup(), callbacks = props()
  render(<ResearchSidebar {...callbacks} />)
  await screen.findByRole('button', { name: '继续研究：置顶研究' })
  const history = within(screen.getByRole('region', { name: '最近对话' }))
  expect(history.getAllByRole('button', { name: /^继续研究/ }).map(button => button.textContent)).toEqual(['置顶研究', '最新研究'])
  expect(vi.mocked(api).mock.calls[0][0]).toContain('exclude_intelligence=true')
  await user.click(history.getByRole('button', { name: '已归档' }))
  await user.click(await history.findByRole('button', { name: '继续研究：已归档研究' }))
  expect(callbacks.onConversation).toHaveBeenCalledWith('archived', 'screening', 'research')
})

it('ignores outdated history after a conversation update', async () => {
  let resolveOld!: (value: never) => void
  vi.mocked(api).mockImplementation(() => new Promise(resolve => { resolveOld = resolve }))
  const callbacks = props(), view = render(<ResearchSidebar {...callbacks} />)
  vi.mocked(api).mockResolvedValue({ items: [{ id: 'new', title: '最新研究', entry_scope: 'screening', workflow_type: 'research' }] } as never)
  view.rerender(<ResearchSidebar {...callbacks} revision={1} conversationId="new" />)
  await screen.findByRole('button', { name: '继续研究：最新研究' })
  await act(async () => resolveOld({ items: [{ id: 'old', title: '过期记录', entry_scope: 'screening' }] } as never))
  expect(screen.queryByRole('button', { name: /过期记录/ })).not.toBeInTheDocument()
})

it('focuses mobile navigation and restores focus after closing', async () => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const previous = document.createElement('button'); document.body.append(previous); previous.focus()
  const callbacks = props(), view = render(<ResearchSidebar {...callbacks} mobileOpen />)
  await waitFor(() => expect(screen.getByRole('button', { name: '关闭工作导航' })).toHaveFocus())
  await userEvent.keyboard('{Escape}')
  expect(callbacks.onClose).toHaveBeenCalledOnce()
  view.rerender(<ResearchSidebar {...callbacks} />)
  await waitFor(() => expect(previous).toHaveFocus())
  previous.remove()
})

it.each(['saved', 'compose', 'create', 'library'])('highlights the correct shared destination while in %s', async screeningView => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const onScreeningView = vi.fn()
  render(<ResearchSidebar {...props()} page="conditions" screeningView={screeningView} onScreeningView={onScreeningView} />)
  const center = screen.getByRole('button', { name: '我的方案' })
  expect(center).toHaveAttribute('aria-current', 'page')
  expect(screen.queryByRole('button', { name: '条件与组合', hidden: true })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '条件库管理' })).not.toBeInTheDocument()
  await userEvent.click(center)
  expect(onScreeningView).toHaveBeenCalledWith('saved')
})

it('remembers the method directory state and expands the active dedicated method', async () => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const callbacks = props(), choose = vi.fn(), user = userEvent.setup()
  const view = render(<ResearchSidebar {...callbacks} page="conditions" onScreeningMethod={choose} />)
  const folder = screen.getByRole('button', { name: '选股方式' })
  expect(folder).toHaveAttribute('aria-expanded', 'false')
  await user.click(folder)
  await user.click(screen.getByRole('button', { name: '研报选股' }))
  expect(choose).toHaveBeenCalledExactlyOnceWith('report')
  view.unmount()
  const restored = render(<ResearchSidebar {...callbacks} page="conditions" onScreeningMethod={choose} />)
  expect(screen.getByRole('button', { name: '选股方式' })).toHaveAttribute('aria-expanded', 'true')
  await user.click(screen.getByRole('button', { name: '选股方式' }))
  restored.rerender(<ResearchSidebar {...callbacks} page="conditions" screeningMethod="report" onScreeningMethod={choose} />)
  expect(screen.getByRole('button', { name: '选股方式' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: '研报选股' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('button', { name: '开始选股' })).not.toHaveAttribute('aria-current')
})
