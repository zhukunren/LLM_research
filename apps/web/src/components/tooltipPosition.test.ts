import { expect, it } from 'vitest'
import { tooltipPosition } from './tooltipPosition'

it('keeps a right-edge tooltip inside a narrow viewport', () => {
  expect(tooltipPosition({ left: 284, top: 200, width: 24, height: 32 }, { width: 220, height: 50 }, { left: 0, top: 0, width: 320, height: 569 })).toEqual({ left: 88, top: 142 })
})
it('opens below an anchor at the top of the viewport', () => {
  expect(tooltipPosition({ left: 4, top: 4, width: 24, height: 32 }, { width: 180, height: 50 }, { left: 0, top: 0, width: 320, height: 569 })).toEqual({ left: 12, top: 44 })
})
it('respects a reduced and scrolled visual viewport', () => {
  const value = tooltipPosition({ left: 300, top: 320, width: 24, height: 32 }, { width: 280, height: 160 }, { left: 20, top: 100, width: 320, height: 240 })
  expect(value.left).toBe(48)
  expect(value.top).toBe(152)
})
