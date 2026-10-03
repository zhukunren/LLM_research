import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api } from '../api'
import StockChartDialog from './StockChartDialog'
vi.mock('../api', () => ({ api: vi.fn() }))
it('lets keyboard users inspect the chart and keeps focus inside the dialog', async () => {
  const user = userEvent.setup()
  vi.mocked(api).mockResolvedValue({ items: [{ trade_date: '2026-09-10', open: 10, high: 11, low: 9, close: 10.5 }] })
  render(<StockChartDialog code="600000.SH" asOf="2026-09-10" onClose={vi.fn()} />)
  const chart = await screen.findByRole('img', { name: 'K线主图叠加指标走势' })
  expect(screen.getByRole('button', { name: '关闭走势' })).toHaveFocus()
  await user.tab()
  expect(chart).toHaveFocus()
  await user.keyboard('{ArrowLeft}')
  expect(screen.getByRole('status')).toHaveTextContent('2026-09-10')
  await user.tab()
  expect(screen.getByRole('button', { name: '关闭走势' })).toHaveFocus()
})
it('offers a retry for the same security and cutoff after a failed read', async () => {
  const user = userEvent.setup()
  vi.mocked(api).mockRejectedValueOnce(new Error('暂时无法读取行情')).mockResolvedValueOnce({ items: [] })
  render(<StockChartDialog code="600000.SH" asOf="2026-09-10" onClose={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: '重试行情' }))
  await waitFor(() => expect(screen.getByText('该日期之前没有可用行情。')).toBeVisible())
  expect(vi.mocked(api).mock.calls.every(([path]) => path.includes('600000.SH') && path.includes('as_of=2026-09-10'))).toBe(true)
})
