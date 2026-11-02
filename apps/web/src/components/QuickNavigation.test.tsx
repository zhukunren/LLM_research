import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import QuickNavigation from './QuickNavigation'

vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), api: vi.fn() }))
const callbacks = () => ({ onClose: vi.fn(), onNavigate: vi.fn(), onProject: vi.fn(), onConversation: vi.fn(), onNewResearch: vi.fn(), onSettings: vi.fn() })

it('finds a saved project and opens it by keyboard while restoring focus on close', async () => {
  vi.mocked(api).mockImplementation(async path => path === '/research-projects'
    ? { items: [{ id: 'p1', name: '算力订单', objective: '核对交付兑现', status: 'active' }] } as never
    : { items: [{ id: 'c1', title: '云厂商资本开支', entry_scope: 'news' }] } as never)
  const previous = document.createElement('button')
  document.body.append(previous); previous.focus()
  const props = callbacks()
  const user = userEvent.setup()
  const view = render(<QuickNavigation {...props} />)
  const input = screen.getByRole('combobox', { name: '搜索页面、项目或对话' })
  expect(input).toHaveFocus()
  await user.tab()
  expect(screen.getByRole('button', { name: '关闭快速导航' })).toHaveFocus()
  await user.tab()
  expect(input).toHaveFocus()
  await screen.findByRole('option', { name: /算力订单/ })
  await user.type(input, '交付兑现')
  await user.keyboard('{Enter}')
  expect(props.onProject).toHaveBeenCalledWith('p1')
  expect(props.onClose).toHaveBeenCalled()
  view.unmount()
  expect(previous).toHaveFocus()
  previous.remove()
})

it('keeps navigation usable when recent resource reads fail and recovers from no results', async () => {
  vi.mocked(api).mockRejectedValue(new Error('offline'))
  const props = callbacks()
  const user = userEvent.setup()
  render(<QuickNavigation {...props} />)
  await screen.findByText('项目或对话暂未加载。')
  const input = screen.getByRole('combobox')
  await user.type(input, '不存在的结果')
  expect(await screen.findByText('没有找到匹配项')).toBeInTheDocument()
  await user.click(await screen.findByRole('button', { name: '清除搜索' }))
  await user.type(input, '研报库')
  await user.keyboard('{Enter}')
  expect(props.onNavigate).toHaveBeenCalledWith('library')
})

it('keeps page shortcuts visible with many projects and finds screening conversations using multiple keywords', async () => {
  vi.mocked(api).mockImplementation(async path => path === '/research-projects'
    ? { items: Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, name: `项目 ${index}`, status: 'active' })) } as never
    : { items: [{ id: 'c1', title: '订单兑现', workflow_type: 'screening', entry_scope: 'report' }] } as never)
  const props = callbacks(), user = userEvent.setup()
  render(<QuickNavigation {...props} />)
  await screen.findByRole('option', { name: /订单兑现/ })
  expect(screen.getByRole('option', { name: /资料库/ })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: /数据与服务/ })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /研究助手/ })).not.toBeInTheDocument()
  await user.type(screen.getByRole('combobox'), '订单 选股')
  await screen.findByRole('option', { name: /订单兑现/ })
  expect(screen.getAllByRole('option')).toHaveLength(1)
  expect(screen.getByRole('option')).toHaveTextContent('继续选股对话')
  await user.keyboard('{Enter}')
  expect(props.onConversation).toHaveBeenCalledWith('c1', 'report')
})

it('does not offer the removed built-in reference page, including search', async () => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  const props = callbacks(), user = userEvent.setup()
  render(<QuickNavigation {...props} />)
  expect(screen.queryByRole('option', { name: /内置指标参考/ })).not.toBeInTheDocument()
  await user.type(screen.getByRole('combobox'), '内置指标参考')
  expect(screen.queryByRole('option')).not.toBeInTheDocument()
  await user.keyboard('{Enter}')
  expect(props.onNavigate).not.toHaveBeenCalled()
  await user.click(await screen.findByRole('button', { name: '清除搜索' }))
  expect(screen.getByRole('option', { name: /研报库/ })).toBeInTheDocument()
})


it('searches older history server-side and loads the next matching page', async () => {
  vi.mocked(api).mockImplementation(async path => {
    if (path === '/research-projects') return { items: [] } as never
    const url = new URL(path, 'https://test.local')
    if (url.searchParams.get('q') !== '旧主题') return { items: [] } as never
    const offset = Number(url.searchParams.get('offset'))
    return { items: Array.from({ length: offset ? 1 : 31 }, (_, i) => ({ id: `old-${offset + i}`, title: `旧主题 ${offset + i}`, entry_scope: 'news' })) } as never
  })
  const props = callbacks(), user = userEvent.setup()
  render(<QuickNavigation {...props} />)
  await user.type(screen.getByRole('combobox'), '旧主题')
  await screen.findByRole('option', { name: /旧主题 29 / })
  await user.click(screen.getByRole('button', { name: '加载更多历史匹配' }))
  await user.click(await screen.findByRole('option', { name: /旧主题 30 / }))
  expect(props.onConversation).toHaveBeenCalledWith('old-30', 'news')
})

it('ignores superseded search responses and composing Enter/Escape', async () => {
  let resolveOld: (value: unknown) => void = () => {}
  vi.mocked(api).mockImplementation(async path => {
    if (path.includes('q=old')) return new Promise(resolve => { resolveOld = resolve }) as never
    if (path.includes('q=new')) return { items: [{ id: 'new', title: 'new result', entry_scope: 'news' }] } as never
    return { items: [] } as never
  })
  const props = callbacks(), user = userEvent.setup()
  render(<QuickNavigation {...props} />)
  const input = screen.getByRole('combobox')
  await user.type(input, 'old')
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining('q=old'), expect.anything()))
  await user.clear(input); await user.type(input, 'new')
  await screen.findByRole('option', { name: /new result/ })
  await act(async () => resolveOld({ items: [{ id: 'old', title: 'new stale result', entry_scope: 'news' }] }))
  expect(screen.queryByText('new stale result')).not.toBeInTheDocument()
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 })
  expect(props.onClose).not.toHaveBeenCalled()
  expect(props.onConversation).not.toHaveBeenCalled()
})


it('retains matched rows on paging failure, retries the same page, and cancels on close', async () => {
  let attempts = 0
  const signals: AbortSignal[] = []
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/research-projects') return { items: [] } as never
    signals.push(options?.signal as AbortSignal)
    const url = new URL(path, 'https://test.local')
    if (url.searchParams.get('q') !== 'history') return { items: [] } as never
    if (url.searchParams.get('offset') === '30') {
      attempts++
      if (attempts === 1) throw new Error('offline')
      return { items: [{ id: 'last', title: 'history last', entry_scope: 'news' }] } as never
    }
    return { items: Array.from({ length: 31 }, (_, i) => ({ id: `h-${i}`, title: `history ${i}`, entry_scope: 'news' })) } as never
  })
  const user = userEvent.setup(), view = render(<QuickNavigation {...callbacks()} />)
  await user.type(screen.getByRole('combobox'), 'history')
  await screen.findByText('history 29')
  const more = screen.getByRole('button', { name: '加载更多历史匹配' })
  fireEvent.click(more); fireEvent.click(more)
  await screen.findByText('项目或对话暂未加载。')
  expect(attempts).toBe(1)
  expect(screen.getByText('history 0')).toBeInTheDocument()
  expect(more).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('history last')
  expect(attempts).toBe(2)
  expect(screen.getAllByRole('option')).toHaveLength(31)
  view.unmount()
  expect(signals.every(signal => signal.aborted)).toBe(true)
})
