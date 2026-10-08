import { render, screen } from '@testing-library/react'
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
  expect(screen.getByText('没有找到匹配项')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '清除搜索' }))
  await user.type(input, '研报库')
  await user.keyboard('{Enter}')
  expect(props.onNavigate).toHaveBeenCalledWith('reports')
})

it('keeps page shortcuts visible with many projects and finds screening conversations using multiple keywords', async () => {
  vi.mocked(api).mockImplementation(async path => path === '/research-projects'
    ? { items: Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, name: `项目 ${index}`, status: 'active' })) } as never
    : { items: [{ id: 'c1', title: '订单兑现', workflow_type: 'screening', entry_scope: 'report' }] } as never)
  const props = callbacks(), user = userEvent.setup()
  render(<QuickNavigation {...props} />)
  await screen.findByRole('option', { name: /订单兑现/ })
  expect(screen.getByRole('option', { name: /研报库/ })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: /数据与服务/ })).toBeInTheDocument()
  await user.type(screen.getByRole('combobox'), '订单 选股')
  expect(screen.getAllByRole('option')).toHaveLength(1)
  expect(screen.getByRole('option')).toHaveTextContent('继续选股对话')
  await user.keyboard('{Enter}')
  expect(props.onConversation).toHaveBeenCalledWith('c1', 'report')
})
