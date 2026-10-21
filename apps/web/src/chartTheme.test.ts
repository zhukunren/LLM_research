import { expect, it } from 'vitest'
import { chartAxisValue, chartPalette } from './chartTheme'

it('keeps large and very small axis values legible without turning them into zero', () => {
  expect(chartAxisValue(125000)).toBe('12.5万')
  expect(chartAxisValue(-230000000)).toBe('-2.3亿')
  expect(chartAxisValue(.0000123)).toBe('1.23e-5')
  expect(chartAxisValue(NaN)).toBe('—')
})
it('uses the same A-share direction colors as the rest of the workspace', () => {
  expect(chartPalette.up).toBe('#be414a')
  expect(chartPalette.down).toBe('#208575')
})
