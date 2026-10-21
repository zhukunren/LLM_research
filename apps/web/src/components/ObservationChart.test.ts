import { expect, it } from 'vitest'
import type { ScreeningTaskDecision } from '../api'
import { chartOption } from './ObservationChart'
import { chartPalette } from '../chartTheme'

const data = {
  bars: [
    { trade_date: '2026-10-15', open: 10, close: 11, low: 9, high: 12, volume: 100, quality_valid: true },
    { trade_date: '2026-10-16', open: 11, close: 10, low: 9, high: 12, volume: 999999, quality_valid: false },
  ],
  signal_date: '2026-10-15', cutoff: '2026-10-16', markers: [], decision: {} as ScreeningTaskDecision,
}
it('keeps the observation tooltip inside a narrow chart and uses shorter date labels', () => {
  const option = chartOption(data, 280)
  expect(option.tooltip.confine).toBe(true)
  expect(option.xAxis[1].axisLabel.formatter('2026-10-15')).toBe('10-15')
  expect(option.grid[0].left).toBe(48)
})
it('uses the shared market palette and suppresses invalid bars in both price and volume', () => {
  const option = chartOption(data)
  expect(option.series[0].itemStyle).toMatchObject({ color: chartPalette.up, color0: chartPalette.down })
  expect(option.series[0].data[1]).toEqual(['-', '-', '-', '-'])
  expect(option.series[1].data[1]).toMatchObject({ value: '-' })
})
