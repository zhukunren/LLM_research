import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import Pagination from './Pagination'

it('moves between bounded result ranges without offering a page past the last record', async () => {
  const change = vi.fn(), user = userEvent.setup()
  const { rerender } = render(<Pagination offset={0} total={45} pageSize={20} onChange={change} />)
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '下一页' }))
  expect(change).toHaveBeenLastCalledWith(20)
  rerender(<Pagination offset={40} total={45} pageSize={20} onChange={change} />)
  expect(screen.getByText('41–45 / 45 条')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '上一页' }))
  expect(change).toHaveBeenLastCalledWith(20)
})

it('uses the server continuation offset and respects the end of its result list', async () => {
  const change = vi.fn(), user = userEvent.setup()
  const { rerender } = render(<Pagination offset={0} total={40} pageSize={20} nextOffset={12} onChange={change} />)
  await user.click(screen.getByRole('button', { name: '下一页' }))
  expect(change).toHaveBeenCalledWith(12)
  rerender(<Pagination offset={12} total={40} pageSize={20} nextOffset={null} onChange={change} />)
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
})

it('blocks pagination while a request is pending and when the result is empty', () => {
  const change = vi.fn()
  const { rerender } = render(<Pagination offset={20} total={60} pageSize={20} disabled onChange={change} />)
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  rerender(<Pagination offset={0} total={0} pageSize={20} onChange={change} />)
  expect(screen.getByText('共 0 条')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  expect(change).not.toHaveBeenCalled()
})

it('offers explicit bounded jumps only for large offset lists and suppresses duplicate pending requests', async () => {
  const change = vi.fn(), user = userEvent.setup()
  const view = render(<Pagination offset={0} total={123} pageSize={20} onChange={change} />)
  expect(screen.getByRole('button', { name: '首页' })).toBeDisabled()
  const input = screen.getByLabelText('跳转页码')
  await user.clear(input); await user.type(input, '6')
  expect(change).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '跳转' }))
  await user.click(screen.getByRole('button', { name: '跳转' }))
  expect(change.mock.calls).toEqual([[100]])
  view.rerender(<Pagination offset={100} total={123} pageSize={20} onChange={change} />)
  await user.click(screen.getByRole('button', { name: '末页' }))
  expect(change).toHaveBeenLastCalledWith(120)
  view.rerender(<Pagination offset={120} total={123} pageSize={20} onChange={change} />)
  expect(screen.getByRole('button', { name: '末页' })).toBeDisabled()
  view.rerender(<Pagination offset={0} total={123} pageSize={20} nextOffset={20} onChange={change} />)
  expect(screen.queryByLabelText('跳转页码')).not.toBeInTheDocument()
})
it('rejects invalid page entry, composing Enter, and any jump while loading', async () => {
  const change = vi.fn(), user = userEvent.setup()
  const view = render(<Pagination offset={20} total={200} pageSize={20} onChange={change} />)
  const input = screen.getByLabelText('跳转页码')
  for (const value of ['0', '11', '1.5', '-2', 'abc']) {
    await user.clear(input); await user.type(input, value)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: '跳转' })).toBeDisabled()
  }
  await user.clear(input); await user.type(input, '4')
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
  expect(change).not.toHaveBeenCalled()
  view.rerender(<Pagination offset={20} total={200} pageSize={20} onChange={change} disabled />)
  expect(input).toBeDisabled()
  for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
})
it('revalidates on total changes and never emits an out-of-range offset', async () => {
  const change = vi.fn(), user = userEvent.setup()
  const view = render(<Pagination offset={180} total={200} pageSize={20} onChange={change} />)
  view.rerender(<Pagination offset={180} total={123} pageSize={20} onChange={change} />)
  expect(screen.getByLabelText('跳转页码')).toHaveValue('7')
  await user.click(screen.getByRole('button', { name: '上一页' }))
  expect(change).toHaveBeenLastCalledWith(120)
  view.rerender(<Pagination offset={0} total={0} pageSize={20} onChange={change} />)
  expect(screen.queryByLabelText('跳转页码')).not.toBeInTheDocument()
})
