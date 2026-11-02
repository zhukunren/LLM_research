import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import PatternPage from './PatternPage'
import { SecuritiesProvider } from '../components/StockSearch'
import { StockInteractionsProvider } from '../components/StockMentions'

vi.mock('../api', () => ({ api: vi.fn() }))
const mocked = vi.mocked(api)
const pattern = (id: string) => ({ id, version: 1, name: id + '目标形态', representation: 'price_path', input_type: 'drawing', points: Array.from({ length: 10 }, (_, i) => i / 9), params: {}, target_bars: 10 })
const sample = (code: string, date: string, score: number) => ({ stock_code: code, similarity: score, start_date: date, end_date: date, bars: [{ trade_date: date, open: 10, high: 12, low: 9, close: 11 }] })
beforeEach(() => vi.clearAllMocks())
async function loadSaved(user: ReturnType<typeof userEvent.setup>, name?: string) {
  await user.click(screen.getByRole('tab', { name: '我的形态' }))
  if (name) await user.click(within((await screen.findByRole('heading', { name })).closest('article')!).getByRole('button', { name: '载入对照' }))
  else await user.click(await screen.findByRole('button', { name: '载入对照' }))
}

it('opens focus drawing without changing the shape and exits with Escape', async () => {
  const user = userEvent.setup()
  const match = sample('600000.SH', '2026-09-28', 90)
  mocked.mockImplementation(async path => path === '/patterns' ? { items: [pattern('focus')] } : { ...match, items: [match], scope: '真实行情' })
  render(<PatternPage />)
  await loadSaved(user)
  const input = screen.getByLabelText('模板名称')
  const drawing = screen.getByRole('img', { name: '走势曲线编辑区' })
  const points = drawing.querySelector('polyline')?.getAttribute('points')
  await user.click(screen.getByRole('button', { name: '专注绘图' }))
  expect(screen.getByRole('dialog', { name: '专注绘图' })).toBeInTheDocument()
  expect(input).toHaveValue('focus目标形态')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: '专注绘图' })).not.toBeInTheDocument()
  expect(screen.getByRole('img', { name: '走势曲线编辑区' })).toBe(drawing)
  expect(drawing.querySelector('polyline')?.getAttribute('points')).toBe(points)
  expect(screen.getByRole('button', { name: '专注绘图' })).toHaveFocus()
})

it('keeps the target and reading position while switching ranked samples by keyboard', async () => {
  const user = userEvent.setup()
  const items = [sample('600000.SH', '2026-09-14', 99), sample('000002.SZ', '2026-09-15', 96)]
  mocked.mockImplementation(async path => path === '/patterns' ? { items: [pattern('ranked')] } : { ...items[0], items, scope: '真实行情', as_of: '2026-09-28' })
  render(<PatternPage />)
  await loadSaved(user)
  const target = screen.getByRole('region', { name: '目标形态' })
  const points = within(target).getByRole('img').querySelector('polyline')?.getAttribute('points')
  const samples = screen.getByRole('complementary', { name: '相似K线样本' })
  const second = await within(samples).findByRole('button', { name: /查看 000002.SZ/ })
  const reading = samples.querySelector('.pattern-comparison-result-list')!
  reading.scrollTop = 100
  second.focus()
  await user.keyboard('{Enter}')
  expect(second).toHaveAttribute('aria-pressed', 'true')
  expect(within(samples).getByRole('button', { name: /查看 600000.SH/ })).toHaveAttribute('aria-pressed', 'false')
  expect(within(screen.getByRole('region', { name: '候选K线对照' })).getByText('000002.SZ')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '目标形态' })).toBe(target)
  expect(within(target).getByRole('img').querySelector('polyline')?.getAttribute('points')).toBe(points)
  expect(reading.scrollTop).toBe(100)
  await user.click(screen.getByRole('tab', { name: '我的形态' }))
  await user.click(screen.getByRole('tab', { name: '形态匹配' }))
  expect(screen.getByRole('button', { name: /查看 000002.SZ/ })).toHaveAttribute('aria-pressed', 'true')
  expect(mocked.mock.calls.some(([path]) => path === '/patterns/ranked/best-match?version=1&limit=12')).toBe(true)
})

it('ignores a late saved-template response after loading a different target', async () => {
  const user = userEvent.setup()
  let old: (value: unknown) => void = () => {}
  const next = sample('000003.SZ', '2026-09-20', 92)
  mocked.mockImplementation(async path => path === '/patterns' ? { items: [pattern('old'), pattern('next')] } : path.includes('/old/') && path.includes('limit=12') ? new Promise(resolve => { old = resolve }) : { ...next, items: [next] })
  render(<PatternPage />)
  await loadSaved(user, 'old目标形态')
  await waitFor(() => expect(mocked.mock.calls.some(([path]) => path === '/patterns/old/best-match?version=1&limit=12')).toBe(true))
  await loadSaved(user, 'next目标形态')
  await screen.findByRole('button', { name: /查看 000003.SZ/ })
  await act(async () => old({ ...sample('600000.SH', '2026-09-14', 99), items: [sample('600000.SH', '2026-09-14', 99)] }))
  expect(screen.queryByRole('button', { name: /查看 600000.SH/ })).not.toBeInTheDocument()
  expect(screen.getByLabelText('模板名称')).toHaveValue('next目标形态')
})

it('selects a sample from its company name without opening the stock menu', async () => {
  const user = userEvent.setup()
  const items = [sample('600000.SH', '2026-09-14', 99), sample('000002.SZ', '2026-09-15', 96)]
  mocked.mockImplementation(async path => path === '/security-catalog'
    ? { items: [{ stock_code: '600000.SH', name: '浦发银行', market: 'SH' }, { stock_code: '000002.SZ', name: '万科A', market: 'SZ' }] }
    : path === '/patterns' ? { items: [pattern('stock-menu')] } : { ...items[0], items, scope: '真实行情' })
  render(<SecuritiesProvider><StockInteractionsProvider><PatternPage /></StockInteractionsProvider></SecuritiesProvider>)
  await loadSaved(user)
  const samples = screen.getByRole('complementary', { name: '相似K线样本' })
  const second = await within(samples).findByRole('button', { name: /查看 000002.SZ/ })
  await user.click(within(second).getByText('万科A'))
  expect(second).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '候选K线对照' })).getByText('万科A')).toBeInTheDocument()
})

it('retries matching errors and handles a market with no samples', async () => {
  const user = userEvent.setup()
  let attempts = 0
  mocked.mockImplementation(async path => {
    if (path === '/patterns') return { items: [pattern('empty-retry')] }
    if (path.includes('limit=12') && attempts++ === 0) throw new Error('行情更新中')
    return { bars: [], items: [], reason: '暂无本地真实行情' }
  })
  render(<PatternPage />)
  await loadSaved(user)
  expect(await screen.findByRole('alert')).toHaveTextContent('行情更新中')
  await user.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('暂无本地真实行情')).toBeInTheDocument()
  expect(within(screen.getByRole('complementary', { name: '相似K线样本' })).queryByRole('button', { name: /查看/ })).not.toBeInTheDocument()
})

it('keeps a partially edited candle sequence after leaving the workbench', async () => {
  const user = userEvent.setup()
  mocked.mockResolvedValue({ items: [] })
  const view = render(<PatternPage />)
  await user.click(screen.getByRole('button', { name: '手绘' }))
  await user.click(screen.getByRole('button', { name: '蜡烛图' }))
  await user.click(screen.getByText('编辑蜡烛 · 0 根'))
  await user.click(screen.getByRole('button', { name: '添加蜡烛' }))
  fireEvent.change(screen.getByLabelText('CLOSE'), { target: { value: '103' } })
  view.unmount()
  render(<PatternPage />)
  await user.click(screen.getByText('编辑蜡烛 · 1 根'))
  expect(screen.getByLabelText('CLOSE')).toHaveValue(103)
  expect(screen.getByLabelText('HIGH')).toHaveValue(103)
  expect(screen.getByRole('button', { name: '保存模板' })).toBeDisabled()
})
