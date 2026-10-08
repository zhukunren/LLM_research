import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api, type ResearchAssistant } from '../api'
import ResearchSidebar from './ResearchSidebar'

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), api: vi.fn() }))
const props = () => ({ page: 'screening' as const, revision: 0, mobileOpen: false, onClose: vi.fn(), onNavigate: vi.fn(), onNewResearch: vi.fn(), onSearch: vi.fn(), onConversation: vi.fn(), onAssistant: vi.fn(), onSettings: vi.fn() })
const assistants: ResearchAssistant[] = [
  ['general', '通用投研'], ['financial', '财报分析'], ['reports', '研报解读'],
  ['supply-chain', '产业链研究'], ['risk', '风险复核'],
].map(([id, name]) => ({ id, name, description: name, instructions: '保留证据。', enabled: true, builtin: true, revision: 1, skill_hash: id }))

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
  render(<ResearchSidebar {...callbacks} conversationId="one" />)
  expect(screen.queryByRole('button', { name: '研报库' })).not.toBeInTheDocument()
  expect(await screen.findByRole('button', { name: '继续研究：订单研究' })).toHaveAttribute('aria-current', 'page')
  await user.click(screen.getByRole('button', { name: '继续选股：趋势筛选' }))
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
