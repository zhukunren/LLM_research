import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import TechnicalBrowser from './TechnicalBrowser'

vi.mock('../api', () => ({ api: vi.fn() }))
const mocked = vi.mocked(api)

const bars = [
  { trade_date: '2026-09-12', open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
  { trade_date: '2026-09-13', open: 10.5, high: 12, low: 10, close: 11.5, volume: 120 },
  { trade_date: '2026-09-14', open: 11.5, high: 13, low: 11, close: 12.5, volume: 140 },
]

function preview(indicator: string, placement: 'overlay' | 'pane') {
  const lines = indicator === 'bollinger'
    ? [{ id: 'bollinger_upper', label: '上轨', color: '#b5793b', values: [null, 12, 13] }, { id: 'bollinger_middle', label: '中轨', color: '#4c7eb1', values: [null, 11, 12] }, { id: 'bollinger_lower', label: '下轨', color: '#b5793b', values: [null, 10, 11] }]
    : indicator === 'rsi'
      ? [{ id: 'rsi', label: 'RSI 14', color: '#7b62a3', values: [null, 45, 55] }]
      : [{ id: 'sma', label: 'SMA 20', color: '#d66755', values: [null, 11, 12] }]
  return { indicator, window: indicator === 'rsi' ? 14 : 20, stock_code: '600000.SH', as_of: '2026-09-14', current: 12, previous: 11, state: 'known', warning: '测试行情', series: [], chart: { placement, lines, histogram: null, reference_lines: indicator === 'rsi' ? [30, 70] : [], bars } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.mockImplementation(async (path, options) => {
    if (path === '/indicators') return { items: [{ id: 'sma', name: '简单移动平均线', min_window: 2, max_window: 250 }, { id: 'bollinger', name: '布林带', min_window: 2, max_window: 250 }, { id: 'rsi', name: '相对强弱指标', min_window: 2, max_window: 100 }] }
    const body = JSON.parse(String(options?.body))
    return preview(body.indicator, body.indicator === 'rsi' ? 'pane' : 'overlay')
  })
})

it('overlays price-scale indicators on candles and puts RSI in a sub-pane', async () => {
  const user = userEvent.setup()
  render(<TechnicalBrowser data={{ available: true, last_date: '2026-09-14' } as never} onDescribe={vi.fn()} />)
  expect(await screen.findByRole('img', { name: 'K线主图叠加指标走势' })).toBeInTheDocument()
  expect(screen.getByText('SMA 20')).toBeInTheDocument()
  expect(screen.getByLabelText('股票或指数')).toHaveValue('000001.SH')
  expect(screen.queryByRole('button', { name: /查看实际指标/ })).not.toBeInTheDocument()
  const request = mocked.mock.calls.find(([path]) => path === '/indicators/preview')!
  expect(JSON.parse(request[1]!.body as string).stock_code).toBe('000001.SH')
  vi.stubGlobal('PointerEvent', MouseEvent)
  const chart = screen.getByRole('img', { name: 'K线主图叠加指标走势' })
  vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 720, height: 298 } as DOMRect)
  fireEvent.pointerMove(chart, { clientX: 374, clientY: 100 })
  expect(screen.getByRole('status')).toHaveTextContent('2026-09-13')
  expect(screen.getByRole('status')).toHaveTextContent('SMA 20 11')
  fireEvent.pointerLeave(chart)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /相对强弱指标/ }))
  expect(await screen.findByRole('img', { name: 'K线主图和指标副图走势' })).toBeInTheDocument()
  expect(screen.getByText('RSI 14')).toBeInTheDocument()
})

it('renders all three Bollinger lines together on the price chart', async () => {
  const user = userEvent.setup()
  render(<TechnicalBrowser data={{ available: true, last_date: '2026-09-14' } as never} onDescribe={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: /布林带/ }))
  await screen.findByRole('img', { name: 'K线主图叠加指标走势' })
  expect(screen.getByText('上轨')).toBeInTheDocument()
  expect(screen.getByText('中轨')).toBeInTheDocument()
  expect(screen.getByText('下轨')).toBeInTheDocument()
})

it('finds indicators by abbreviation and recovers from an empty search', async () => {
  const user = userEvent.setup()
  render(<TechnicalBrowser data={{ available: true, last_date: '2026-09-14' } as never} onDescribe={vi.fn()} />)
  await screen.findByRole('button', { name: /相对强弱指标/ })
  const search = screen.getByRole('searchbox', { name: '搜索技术指标' })
  await user.type(search, 'rsi')
  expect(screen.getByRole('button', { name: /相对强弱指标/ })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /布林带/ })).not.toBeInTheDocument()
  await user.clear(search); await user.type(search, '不存在的指标')
  expect(screen.getByText('没有匹配的指标。')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '查看全部指标' }))
  expect(screen.getByRole('button', { name: /布林带/ })).toBeInTheDocument()
})
it('keeps indicator catalog failures visible when preview loading completes', async () => {
  mocked.mockImplementation(async path => {
    if (path === '/indicators') throw new Error('目录暂不可用')
    return preview('sma', 'overlay')
  })
  render(<TechnicalBrowser data={{ available: true, last_date: '2026-09-14' } as never} onDescribe={vi.fn()} />)
  await screen.findByRole('img', { name: 'K线主图叠加指标走势' })
  expect(screen.getByRole('alert')).toHaveTextContent('目录暂不可用')
})
