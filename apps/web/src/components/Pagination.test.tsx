import { render, screen } from '@testing-library/react'
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
