import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MarketIndicatorChart } from './MarketIndicatorChart'

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

it('keeps a stable latest-data readout and announces only keyboard inspection', () => {
  render(<MarketIndicatorChart chart={preview('sma', 'overlay').chart} containerWidth={280} />)
  expect(screen.getByRole('group', { name: '行情数据' })).toHaveTextContent('最近 2026-09-14')
  const chart = screen.getByRole('img', { name: 'K线主图叠加指标走势' })
  vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 280, 258))
  fireEvent(chart, new MouseEvent('pointerdown', { bubbles: true, clientX: 160, clientY: 100 }))
  expect(screen.getByRole('status')).toHaveTextContent('2026-09-13')
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'off')
  fireEvent.keyDown(chart, { key: 'Home' })
  expect(screen.getByRole('status')).toHaveTextContent('2026-09-12')
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
  fireEvent.pointerLeave(chart)
  expect(screen.getByRole('status')).toHaveTextContent('2026-09-12')
  fireEvent.blur(chart)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByRole('group', { name: '行情数据' })).toHaveTextContent('最近 2026-09-14')
})

it('does not publish invalid OHLC values in the latest-data readout', () => {
  const current = preview('sma', 'overlay').chart
  render(<MarketIndicatorChart chart={{ ...current, bars: current.bars.map((bar, index) => ({ ...bar, quality_valid: index !== 2 })) }} />)
  expect(screen.getByRole('group', { name: '行情数据' })).toHaveTextContent('收 —')
})

it('resets inspection safely when a new date range contains fewer bars', () => {
  const current = preview('sma', 'overlay').chart
  const { rerender } = render(<MarketIndicatorChart chart={current} />)
  fireEvent.keyDown(screen.getByRole('img', { name: 'K线主图叠加指标走势' }), { key: 'End' })
  expect(screen.getByRole('status')).toHaveTextContent('2026-09-14')
  rerender(<MarketIndicatorChart chart={{ ...current, bars: current.bars.slice(0, 1), lines: current.lines.map(line => ({ ...line, values: line.values.slice(0, 1) })) }} />)
  expect(screen.getByRole('group', { name: '行情数据' })).toHaveTextContent('最近 2026-09-12')
})

it('keeps a one-sided histogram inside its chart with a visible zero baseline', () => {
  const current = preview('rsi', 'pane').chart
  render(<MarketIndicatorChart chart={{ ...current, lines: [], reference_lines: [], histogram: { id: 'volume', label: '示例柱值', color: '#00337a', values: [10, 11, 12] } }} containerWidth={280} />)
  const chart = screen.getByRole('img', { name: 'K线主图和指标副图走势' })
  for (const bar of chart.querySelectorAll('.indicator-histogram')) {
    expect(Number(bar.getAttribute('y'))).toBeGreaterThanOrEqual(180)
    expect(Number(bar.getAttribute('y')) + Number(bar.getAttribute('height'))).toBeLessThanOrEqual(318)
  }
})

