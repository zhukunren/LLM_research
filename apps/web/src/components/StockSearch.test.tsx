import { useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import StockSearch, { SecuritiesProvider } from './StockSearch'

vi.mock('../api', () => ({ api: vi.fn() }))
beforeEach(() => vi.mocked(api).mockResolvedValue({ items: [
  { stock_code: '000001.SZ', name: '平安银行', market: 'SZ' },
  { stock_code: '600000.SH', name: '浦发银行', market: 'SH' },
] }))

it('keeps keyboard focus in the input while selecting and committing a highlighted security', async () => {
  const user = userEvent.setup(), change = vi.fn()
  function Harness() {
    const [value, setValue] = useState('000001.SZ')
    return <StockSearch value={value} onChange={code => { setValue(code); change(code) }} />
  }
  render(<SecuritiesProvider><Harness /></SecuritiesProvider>)
  const input = screen.getByRole('combobox', { name: '搜索股票' })
  await waitFor(() => expect(input).toHaveValue('平安银行'))
  await user.click(input)
  const list = screen.getByRole('listbox')
  await user.keyboard('{ArrowDown}')
  const selected = within(list).getByRole('option', { name: /浦发银行/ })
  expect(selected).toHaveAttribute('aria-selected', 'true')
  expect(input).toHaveAttribute('aria-activedescendant', selected.id)
  expect(input).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(change).toHaveBeenCalledWith('600000.SH')
  expect(input).toHaveValue('浦发银行')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
})

it('closes an open list when the field becomes disabled', async () => {
  const user = userEvent.setup(), change = vi.fn()
  const { rerender } = render(<SecuritiesProvider><StockSearch value="000001.SZ" onChange={change} /></SecuritiesProvider>)
  const input = screen.getByRole('combobox', { name: '搜索股票' })
  await waitFor(() => expect(input).toHaveValue('平安银行'))
  await user.click(input)
  expect(screen.getByRole('listbox')).toBeInTheDocument()
  rerender(<SecuritiesProvider><StockSearch value="000001.SZ" onChange={change} disabled /></SecuritiesProvider>)
  expect(input).toBeDisabled()
  expect(input).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(change).not.toHaveBeenCalled()
})

it('dismisses uncommitted keyboard selection with Escape', async () => {
  const user = userEvent.setup(), change = vi.fn(), parentEscape = vi.fn()
  render(<SecuritiesProvider><div onKeyDown={event => { if (event.key === 'Escape') parentEscape() }}><StockSearch value="000001.SZ" onChange={change} /></div></SecuritiesProvider>)
  const input = screen.getByRole('combobox', { name: '搜索股票' })
  await waitFor(() => expect(input).toHaveValue('平安银行'))
  await user.click(input)
  await user.keyboard('{ArrowDown}{Escape}')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(input).toHaveValue('平安银行')
  expect(change).not.toHaveBeenCalled()
  expect(parentEscape).not.toHaveBeenCalled()
  await user.keyboard('{Escape}')
  expect(parentEscape).toHaveBeenCalledOnce()
})
