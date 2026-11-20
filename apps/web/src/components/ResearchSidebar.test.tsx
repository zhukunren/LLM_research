import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import ResearchSidebar from './ResearchSidebar'

vi.mock('../api', async original => ({ ...await original<typeof import('../api')>(), api: vi.fn() }))
const props = () => ({ page: 'screening' as const, revision: 0, mobileOpen: false, onClose: vi.fn(), onNavigate: vi.fn(), onResearch: vi.fn(), onNewResearch: vi.fn(), onNewScreening: vi.fn(), onSearch: vi.fn(), onConversation: vi.fn(), onAssistant: vi.fn(), onSettings: vi.fn() })

it.each([false, true])('keeps shared research navigation stable for both task types (mobile %s)', async mobileOpen => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const callbacks = props(), user = userEvent.setup()
  const view = render(<ResearchSidebar {...callbacks} mobileOpen={mobileOpen} />)
  const menu = within(screen.getByRole('navigation', { name: '主菜单' }))
  const researchButtons = menu.getAllByRole('button').map(button => button.getAttribute('aria-label'))
  view.rerender(<ResearchSidebar {...callbacks} page="conditions" workspace="screening" mobileOpen={mobileOpen} />)
  expect(menu.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(researchButtons)
  for (const name of ['选股方式', '我的方案', '筛选记录', '情报台']) expect(menu.queryByRole('button', { name })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '切换到选股' })).not.toBeInTheDocument()
  await user.click(menu.getByRole('button', { name: '新建任务' }))
  expect(callbacks.onNewScreening).toHaveBeenCalledOnce()
  await user.click(menu.getByRole('button', { name: '资料库' }))
  expect(callbacks.onNavigate).toHaveBeenLastCalledWith('library')
  await user.click(menu.getByRole('button', { name: '研究工具' }))
  await user.click(menu.getByRole('button', { name: 'QMT 脚本生成' }))
  expect(callbacks.onNavigate).toHaveBeenLastCalledWith('qmt')
  await user.click(menu.getByRole('button', { name: '形态库' }))
  expect(callbacks.onNavigate).toHaveBeenLastCalledWith('patterns')
  expect(callbacks.onAssistant).not.toHaveBeenCalled()
})

it('promotes client service to its own area and returns to the previous research context', async () => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const callbacks = props(), user = userEvent.setup()
  const view = render(<ResearchSidebar {...callbacks} />)
  expect(screen.getByRole('button', { name: '切换到研究' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: '切换到服务' }))
  expect(callbacks.onNavigate).toHaveBeenLastCalledWith('client-service')
  const onServiceView = vi.fn()
  view.rerender(<ResearchSidebar {...callbacks} page="client-service" onServiceView={onServiceView} />)
  expect(screen.getByRole('button', { name: '切换到服务' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: '时点卡片' })).toHaveAttribute('aria-current', 'page')
  expect(screen.queryByRole('region', { name: '最近任务' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '生成建议' }))
  expect(onServiceView).toHaveBeenLastCalledWith('suggestions')
  await user.click(screen.getByRole('button', { name: '数据与连接' }))
  expect(callbacks.onSettings).toHaveBeenCalledOnce()
  await user.click(screen.getByRole('button', { name: '切换到研究' }))
  expect(callbacks.onResearch).toHaveBeenCalledOnce()
})

it('merges research and screening history while keeping pinned items and archive recovery', async () => {
  const recent = [
    { id: 'ordinary', title: '最新研究', entry_scope: 'screening', workflow_type: 'research', state: 'active', pinned: false },
    { id: 'selection', title: '订单选股', entry_scope: 'news', workflow_type: 'screening', state: 'active', pinned: false },
    { id: 'pinned', title: '置顶研究', entry_scope: 'screening', workflow_type: 'research', state: 'active', pinned: true },
  ]
  vi.mocked(api).mockImplementation(async path => ({ items: path.includes('state=archived') ? [{ ...recent[1], id: 'archived', title: '已归档选股', state: 'archived' }] : recent } as never))
  const user = userEvent.setup(), callbacks = props()
  render(<ResearchSidebar {...callbacks} />)
  await screen.findByRole('button', { name: '继续研究：置顶研究' })
  const history = within(screen.getByRole('region', { name: '最近任务' }))
  expect(history.getAllByRole('button', { name: /^继续/ }).map(button => button.getAttribute('aria-label'))).toEqual(['继续研究：置顶研究', '继续研究：最新研究', '继续选股：订单选股'])
  expect(vi.mocked(api).mock.calls[0][0]).toContain('exclude_intelligence=true')
  expect(vi.mocked(api).mock.calls[0][0]).not.toContain('workflow_type=')
  await user.click(history.getByRole('button', { name: '继续选股：订单选股' }))
  expect(callbacks.onConversation).toHaveBeenLastCalledWith('selection', 'news', 'screening')
  await user.click(history.getByRole('button', { name: '已归档' }))
  await user.click(await history.findByRole('button', { name: '继续选股：已归档选股' }))
  expect(callbacks.onConversation).toHaveBeenLastCalledWith('archived', 'news', 'screening')
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
