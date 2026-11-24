import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import DailySignalsPage from './DailySignalsPage'
import { dailySignalsEndpoint, parseDailySignals, signalPercent, sortDailyStrategies } from '../dailySignals'
import { StockInteractionsProvider } from '../components/StockMentions'

const strategy = (id: string, extra: Record<string, unknown> = {}) => ({
  strategy_name: id, strategy_title: id, generation_id: 'generation-1',
  buy_signals: [], sell_signals: [], buy_count: 0, sell_count: 0, covers_date: true,
  win_rate: 0, avg_trade_return: -0.025, ann_return: null,
  sample_count: 2, known_pnl_count: 2, sample_start: '2026-11-01', sample_end: '2026-11-10',
  ann_return_start: '', ann_return_end: '', ann_return_day_count: 0, data_end: '2026-11-12', ...extra,
})
const activeTitle = '量价突破趋势动量'
const inactiveTitle = '市场广度冲击温和领涨'
const uncoveredTitle = '深度缺口反转'
const payload = {
  schema_version: 1, date: '2026-11-12', dates: ['2026-11-10', '2026-11-12'], n: 20, unavailable_count: 1,
  strategies: [
    strategy('signal-first', { strategy_title: activeTitle, buy_signals: [{ code: '300001.SZ', name: '' }], buy_count: 1 }),
    strategy('signal-second', { strategy_title: inactiveTitle }),
    strategy('signal-third', { strategy_title: uncoveredTitle, covers_date: false, buy_signals: [{ code: '600000.SH', name: '旧信号' }], win_rate: 0.9 }),
  ], extra_future_field: true,
}
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
afterEach(() => vi.unstubAllGlobals())

it('reads the named strategies from the local endpoint, preserves zero/null, and separates uncovered data from no signals', async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => response(url.startsWith(dailySignalsEndpoint) ? payload : { items: [] })); vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup(); render(<DailySignalsPage />)
  const active = await screen.findByRole('article', { name: activeTitle })
  expect(screen.getAllByRole('article')).toHaveLength(2)
  const missing = screen.getByRole('article', { name: uncoveredTitle })
  expect(within(active).getByRole('heading', { name: activeTitle })).toBeInTheDocument()
  expect(within(active).getByText('300001.SZ')).toBeInTheDocument()
  expect(within(active).getByText('0.00%')).toBeInTheDocument()
  expect(within(active).getByText('-2.50%')).toBeInTheDocument()
  expect(within(active).getByText('—')).toBeInTheDocument()
  expect(within(missing).getByText('数据未覆盖该日')).toBeInTheDocument()
  expect(within(missing).queryByText('旧信号')).not.toBeInTheDocument()
  expect(within(missing).queryByText('90.00%')).not.toBeInTheDocument()
  expect(screen.queryByText('当日无信号')).not.toBeInTheDocument()
  expect(screen.queryByRole('article', { name: inactiveTitle })).not.toBeInTheDocument()
  await user.click(screen.getByLabelText('仅看有信号的策略'))
  expect(screen.getAllByRole('article')).toHaveLength(3)
  expect(screen.getByRole('article', { name: inactiveTitle })).toHaveTextContent('当日无信号')
  const signalCalls = fetcher.mock.calls.filter(([url]) => url.startsWith(dailySignalsEndpoint))
  expect(signalCalls).toHaveLength(1)
  const [url, init] = signalCalls[0]
  expect(url).toBe('/api/v1/daily-signals/signals?n=20')
  expect(init?.credentials).toBe('same-origin')
})

it('shows stock position percentages and dates without requesting trading quantities', async () => {
  const results = { ...payload, strategies: [strategy('positions', {
    buy_signals: [
      { code: '300001.SZ', name: '已成交', position_ratio: 0.125, position_date: '2026-11-13', qty: 100 },
      { code: '300002.SZ', name: '待成交' },
    ],
    sell_signals: [{ code: '600000.SH', name: '已卖出', position_ratio: 0, position_date: '2026-11-11' }],
  })] }
  const fetcher = vi.fn(async (_url: string) => response(results))
  vi.stubGlobal('fetch', fetcher)
  render(<DailySignalsPage />)
  const buyPosition = await screen.findByText(/买入后仓位 12.50%/)
  expect(buyPosition).toHaveTextContent('11-13成交')
  expect(buyPosition.querySelector('time')).toHaveAttribute('datetime', '2026-11-13')
  expect(screen.getByText('仓位待确认')).toBeInTheDocument()
  expect(screen.getByText('卖出前仓位 0.00%')).toHaveAttribute('title', expect.stringContaining('2026-11-11'))
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${dailySignalsEndpoint}?n=20`])
  expect(screen.queryByText(/100手|100股|量 —/)).not.toBeInTheDocument()
})

it('queries an explicit historical date and sample count, then returns to the latest cache without a date parameter', async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (!url.startsWith(dailySignalsEndpoint)) return response({ items: [] })
    const params = new URL(url, 'http://localhost').searchParams
    return response({ ...payload, date: params.get('date') || payload.date, n: Number(params.get('n')) })
  }); vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup(); render(<DailySignalsPage />)
  await screen.findByRole('heading', { name: '2026-11-12' })
  fireEvent.change(screen.getByLabelText('查询日期'), { target: { value: '2026-11-10' } })
  fireEvent.change(screen.getByLabelText('近 N 笔样本'), { target: { value: '10' } })
  await user.click(screen.getByRole('button', { name: '查询 / 刷新' }))
  await screen.findByRole('heading', { name: '2026-11-10' })
  expect(fetcher.mock.calls.filter(([url]) => url.startsWith(dailySignalsEndpoint)).at(-1)?.[0]).toContain('n=10&date=2026-11-10')
  await user.click(screen.getByRole('button', { name: '最新缓存' }))
  await screen.findByRole('heading', { name: '2026-11-12' })
  expect(fetcher.mock.calls.filter(([url]) => url.startsWith(dailySignalsEndpoint)).at(-1)?.[0]).toBe('/api/v1/daily-signals/signals?n=10')
})

it('uses the upstream title for searching, chart context, and signal marker tooltips', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.startsWith(dailySignalsEndpoint) ? payload : url.includes('/daily-signals/chart/') ? {
    items: [{ trade_date: payload.date, open: 10, high: 12, low: 9, close: 11, volume: 100 }], volume_unit: '手',
  } : { items: [] })))
  const user = userEvent.setup()
  render(<StockInteractionsProvider><DailySignalsPage /></StockInteractionsProvider>)
  await screen.findByRole('article', { name: activeTitle })
  const search = screen.getByRole('searchbox', { name: '筛选策略或股票' })
  await user.type(search, activeTitle)
  expect(screen.getAllByRole('article')).toHaveLength(1)
  await user.clear(search)
  await user.type(search, '300001')
  expect(screen.getByRole('article', { name: activeTitle })).toBeInTheDocument()
  await user.click(screen.getByRole('link', { name: '查看300001.SZ行情' }))
  const chart = await screen.findByRole('dialog', { name: '筛选当日的股票走势' })
  expect(await within(chart).findByText(`${activeTitle} · 标记为所选日期的策略信号`)).toBeInTheDocument()
  expect(within(chart).getByLabelText(`${payload.date}买入信号`).querySelector('title')).toHaveTextContent(`${payload.date} 买入 · ${activeTitle}`)
})

it('shows service/protocol failures and can retry without turning a failed request into no signals', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ ...payload, schema_version: 2 }))
    .mockResolvedValueOnce(response({ ...payload, strategies: [], unavailable_count: 3 }))
  vi.stubGlobal('fetch', fetcher)
  const user = userEvent.setup(); render(<DailySignalsPage />)
  expect(await screen.findByRole('alert')).toHaveTextContent('暂不支持此信号数据版本')
  expect(screen.queryByText('当前范围没有买卖信号')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(await screen.findByText(/3 个策略未载入/)).toBeInTheDocument()
  expect(screen.getByText('查询日暂无可判断的信号数据')).toBeInTheDocument()
  expect(screen.queryByText('当前范围没有买卖信号')).not.toBeInTheDocument()
})

it('ignores added fields and refuses missing coverage or non-finite metrics', () => {
  expect(parseDailySignals(payload).strategies[0].win_rate).toBe(0)
  expect(signalPercent(null)).toBe('—')
  expect(signalPercent(0)).toBe('0.00%')
  expect(() => parseDailySignals({ ...payload, strategies: [strategy('bad', { covers_date: undefined })] })).toThrow('日期覆盖状态')
  expect(() => parseDailySignals({ ...payload, strategies: [strategy('bad', { avg_trade_return: Infinity })] })).toThrow('收益统计')
})


it('sorts numeric metrics in either direction with missing and uncovered values always last', () => {
  const data = parseDailySignals({ ...payload, strategies: [
    strategy('zero', { win_rate: 0 }), strategy('high', { win_rate: 0.8 }),
    strategy('missing', { win_rate: null }), strategy('uncovered', { covers_date: false, win_rate: 1 }),
  ] }).strategies
  expect(sortDailyStrategies(data, { key: 'win_rate', direction: 'desc' }).map(s => s.strategy_name)).toEqual(['high', 'zero', 'missing', 'uncovered'])
  expect(sortDailyStrategies(data, { key: 'win_rate', direction: 'asc' }).map(s => s.strategy_name)).toEqual(['zero', 'high', 'missing', 'uncovered'])
  expect(data[0].strategy_name).toBe('zero')
})
