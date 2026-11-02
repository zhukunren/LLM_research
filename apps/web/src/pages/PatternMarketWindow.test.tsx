import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type PatternMarketSource } from '../api'
import { SecuritiesProvider } from '../components/StockSearch'
import PatternPage from './PatternPage'

vi.mock('../api', () => ({ api: vi.fn() }))
const mocked = vi.mocked(api)
const bars = Array.from({ length: 12 }, (_, i) => ({ trade_date: `2026-09-${String(i + 1).padStart(2, '0')}`, open: 10 + i * .3, high: 12 + i * .3, low: 9 + i * .3, close: 11 + i * .3 }))
const source: PatternMarketSource = { snapshot_id: 'frozen-window', stock_code: '600000.SH', requested_start_date: '2026-09-01', requested_end_date: '2026-09-20', start_date: '2026-09-01', end_date: '2026-09-12', price_basis: 'unadjusted', bars, created_at: '2026-10-26' }
const candidates = ['000002.SZ', '600001.SH'].map((stock_code, i) => ({ stock_code, bars, similarity: 98 - i, start_date: bars[0].trade_date, end_date: bars.at(-1)!.trade_date }))
const saved = { id: 'market-template', version: 1, name: '真实区间', input_type: 'market_window', representation: 'ohlc_sequence', target_bars: bars.length, points: bars.map(bar => bar.close), candlesticks: bars.map(({ open, high, low, close }) => ({ open, high, low, close })), market_source: source, params: {}, created_at: '2026-10-26' }
beforeEach(() => {
  vi.clearAllMocks()
  mocked.mockImplementation(async (path, init) => {
    if (path === '/security-catalog') return { items: [{ stock_code: '600000.SH', name: '浦发银行', market: 'SH' }] }
    if (path === '/patterns/market-window') return source
    if (path === '/patterns') return init?.method === 'POST' ? saved : { items: [] }
    return { ...candidates[0], items: candidates, scope: '本地近期行情；已排除来源股票', as_of: '2026-09-20' }
  })
})

async function enterWindow() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: '形态匹配' }))
  await user.click(screen.getByRole('button', { name: '行情区间' }))
  expect(screen.getByRole('button', { name: '匹配相似形态' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '保存模板' })).toBeDisabled()
  await user.click(screen.getByRole('combobox', { name: '来源股票' }))
  await user.click(await screen.findByRole('option', { name: /浦发银行/ }))
  fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-01' } })
  fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-09-20' } })
  return user
}

it('loads actual candles, switches ranked matches, and saves the source snapshot', async () => {
  render(<SecuritiesProvider><PatternPage /></SecuritiesProvider>)
  const user = await enterWindow()
  await user.click(screen.getByRole('button', { name: '载入 K 线' }))
  await screen.findByText(/已载入 12 根真实日线/)
  expect(screen.getByLabelText('目标交易日数')).toHaveValue(12)
  expect(screen.getByLabelText('目标交易日数')).toBeDisabled()
  expect(screen.queryByText('蜡烛编辑')).not.toBeInTheDocument()
  expect(within(screen.getByLabelText('来源 K 线预览')).getByRole('img')).toBeInTheDocument()
  const target = screen.getByRole('region', { name: '目标形态' })
  await user.click(screen.getByRole('button', { name: '匹配相似形态' }))
  const results = screen.getByRole('complementary', { name: '相似K线样本' })
  const second = await within(results).findByRole('button', { name: /查看 600001.SH/ })
  await user.click(second)
  expect(second).toHaveAttribute('aria-pressed', 'true')
  expect(within(results).getByText('本地近期行情；已排除来源股票')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '保存模板' }))
  await screen.findByText('已保存 真实区间 v1')
  expect(screen.getByRole('tab', { name: '形态匹配' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('region', { name: '目标形态' })).toBe(target)
  expect(second).toHaveAttribute('aria-pressed', 'true')
  const body = JSON.parse(mocked.mock.calls.find(([path, init]) => path === '/patterns' && init?.method === 'POST')![1]!.body as string)
  expect(body).toMatchObject({ input_type: 'market_window', source_window_id: 'frozen-window', target_bars: 12, points: bars.map(bar => bar.close), candlesticks: saved.candlesticks })
})

it('restores the frozen interval and uses exact closes when comparing price paths', async () => {
  const view = render(<SecuritiesProvider><PatternPage /></SecuritiesProvider>)
  const user = await enterWindow()
  await user.click(screen.getByRole('button', { name: '载入 K 线' }))
  await screen.findByText(/已载入 12 根真实日线/)
  view.unmount()
  render(<SecuritiesProvider><PatternPage /></SecuritiesProvider>)
  expect(screen.getByLabelText('开始日期')).toHaveValue('2026-09-01')
  expect(screen.getByLabelText('目标交易日数')).toHaveValue(12)
  await user.click(screen.getByRole('button', { name: '走势曲线' }))
  await user.click(screen.getByRole('button', { name: '匹配相似形态' }))
  await screen.findByRole('button', { name: /查看 600001.SH/ })
  const call = mocked.mock.calls.find(([path]) => path === '/patterns/match?limit=12')!
  expect(JSON.parse(call[1]!.body as string)).toMatchObject({ source_window_id: 'frozen-window', representation: 'price_path', points: bars.map(bar => bar.close), candlesticks: [] })
  fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-09-25' } })
  expect(screen.queryByRole('button', { name: /查看 600001.SH/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '匹配相似形态' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '保存模板' })).toBeDisabled()
})

it('edits a saved market template without changing its source type or snapshot', async () => {
  mocked.mockImplementation(async path => path === '/patterns' ? { items: [saved] } : { bars: [], items: [], reason: '暂无候选' })
  render(<PatternPage />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: '我的形态' }))
  await user.click(await screen.findByRole('button', { name: '载入对照' }))
  expect(screen.getByRole('button', { name: '行情区间' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByLabelText('目标交易日数')).toHaveValue(12)
  expect(within(screen.getByLabelText('来源 K 线预览')).getByRole('img')).toBeInTheDocument()
  expect(screen.queryByRole('spinbutton', { name: 'OPEN' })).not.toBeInTheDocument()
})

it('shows interval errors and leaves matching disabled after a failed load', async () => {
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation(async (path, init) => {
    if (path === '/patterns/market-window') throw new Error('所选区间只有 5 根日线，请扩大区间')
    return initial(path, init)
  })
  render(<SecuritiesProvider><PatternPage /></SecuritiesProvider>)
  const user = await enterWindow()
  fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-21' } })
  await user.click(screen.getByRole('button', { name: '载入 K 线' }))
  expect(screen.getByRole('status')).toHaveTextContent('开始日期不能晚于结束日期')
  expect(mocked.mock.calls.some(([path]) => path === '/patterns/market-window')).toBe(false)
  fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-01' } })
  await user.click(screen.getByRole('button', { name: '载入 K 线' }))
  await screen.findByText('所选区间只有 5 根日线，请扩大区间')
  expect(within(screen.getByRole('region', { name: '形态来源设置' })).getByRole('status')).toHaveTextContent('所选区间只有 5 根日线，请扩大区间')
  expect(screen.getByRole('button', { name: '匹配相似形态' })).toBeDisabled()
})

it('ignores a late interval response after selecting another saved template', async () => {
  let finish: (value: unknown) => void = () => {}
  const initial = mocked.getMockImplementation()!
  mocked.mockImplementation(async (path, init) => path === '/patterns/market-window' ? new Promise(resolve => { finish = resolve }) : path === '/patterns' ? { items: [saved] } : initial(path, init))
  render(<SecuritiesProvider><PatternPage /></SecuritiesProvider>)
  const user = await enterWindow()
  await user.click(screen.getByRole('button', { name: '载入 K 线' }))
  await user.click(screen.getByRole('tab', { name: '我的形态' }))
  await user.click(await screen.findByRole('button', { name: '载入对照' }))
  await act(async () => finish({ ...source, snapshot_id: 'late', bars: bars.slice(0, 10) }))
  await waitFor(() => expect(screen.getByLabelText('目标交易日数')).toHaveValue(12))
  expect(screen.getByLabelText('模板名称')).toHaveValue('真实区间')
})
