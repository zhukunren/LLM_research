import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import PatternPage from './PatternPage'

vi.mock('../api', () => ({ api: vi.fn() }))
const mocked = vi.mocked(api)
const pattern = (id: string) => ({ id, version: 1, name: id + '目标形态', representation: 'price_path', input_type: 'drawing', points: Array.from({ length: 10 }, (_, i) => i), params: {}, target_bars: 10 })
const sample = (code: string, date: string, score: number) => ({ stock_code: code, similarity: score, start_date: date, end_date: date, bars: [{ trade_date: date, open: 10, high: 12, low: 9, close: 11 }] })
beforeEach(() => vi.clearAllMocks())

it('opens focus drawing without changing the shape and exits with Escape', async () => {
  const user = userEvent.setup()
  const match = sample('600000.SH', '2026-09-28', 90)
  mocked.mockImplementation(async path => path === '/patterns' ? { items: [pattern('focus')] } : { ...match, items: [match], scope: '真实行情' })
  render(<PatternPage />)
  await user.click(await screen.findByRole('button', { name: '编辑形态' }))
  expect(screen.getByRole('button', { name: '用文字描述走势' })).toHaveAttribute('aria-expanded', 'false')
  const input = screen.getByLabelText('模板名称')
  const points = screen.getByRole('img', { name: '走势曲线编辑区' }).querySelector('polyline')?.getAttribute('points')
  await user.click(screen.getByRole('button', { name: '专注绘图' }))
  expect(screen.getByRole('dialog', { name: '专注绘图' })).toBeInTheDocument()
  expect(input).toHaveValue('focus目标形态')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: '专注绘图' })).not.toBeInTheDocument()
  expect(screen.getByRole('img', { name: '走势曲线编辑区' }).querySelector('polyline')?.getAttribute('points')).toBe(points)
})

it('shows compact candles with ranked thumbnails and switches the main chart by keyboard', async () => {
  const user = userEvent.setup()
  const items = [sample('600000.SH', '2026-09-14', 99), sample('000002.SZ', '2026-09-15', 96)]
  mocked.mockImplementation(async path => path === '/patterns' ? { items: [pattern('ranked')] } : { ...items[0], items, scope: '真实行情', as_of: '2026-09-28' })
  render(<PatternPage />)
  const chart = await screen.findByRole('img', { name: 'K线主图叠加指标走势' })
  expect(chart).toHaveStyle({ height: '220px' })
  expect(mocked.mock.calls.some(([path]) => path === '/patterns/ranked/best-match?version=1&limit=12')).toBe(true)
  const samples = screen.getByRole('region', { name: '相似K线样本' })
  const second = within(samples).getByRole('button', { name: /查看 000002.SZ/ })
  second.focus()
  await user.keyboard('{Enter}')
  expect(second).toHaveAttribute('aria-pressed', 'true')
  expect(within(samples).getByRole('button', { name: /查看 600000.SH/ })).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByText(/000002.SZ · 2026-09-15 至 2026-09-15/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '原始曲线' }))
  await user.click(screen.getByRole('button', { name: 'K线' }))
  expect(screen.getByText(/000002.SZ · 2026-09-15 至 2026-09-15/)).toBeInTheDocument()
})

it('ignores a late match response after changing the selected pattern', async () => {
  const user = userEvent.setup()
  let old: (value: unknown) => void = () => {}
  const next = sample('000003.SZ', '2026-09-20', 92)
  mocked.mockImplementation(async path => path === '/patterns' ? { items: [pattern('old'), pattern('next')] } : path.includes('/old/') ? new Promise(resolve => { old = resolve }) : { ...next, items: [next] })
  render(<PatternPage />)
  await waitFor(() => expect(mocked.mock.calls.some(([path]) => path.includes('/old/'))).toBe(true))
  await user.click(screen.getByRole('button', { name: /next目标形态/ }))
  await screen.findByRole('button', { name: /查看 000003.SZ/ })
  await act(async () => old({ ...sample('600000.SH', '2026-09-14', 99), items: [sample('600000.SH', '2026-09-14', 99)] }))
  expect(screen.queryByRole('button', { name: /查看 600000.SH/ })).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'next目标形态' })).toBeInTheDocument()
})

it('retries matching errors and handles a market with no samples', async () => {
  const user = userEvent.setup()
  let attempts = 0
  mocked.mockImplementation(async path => {
    if (path === '/patterns') return { items: [pattern('empty-retry')] }
    if (attempts++ === 0) throw new Error('行情更新中')
    return { bars: [], items: [], reason: '暂无本地真实行情' }
  })
  render(<PatternPage />)
  expect(await screen.findByRole('alert')).toHaveTextContent('行情更新中')
  await user.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('暂无本地真实行情')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '相似K线样本' })).not.toBeInTheDocument()
})
