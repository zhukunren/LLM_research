import { expect, it } from 'vitest'
import { placeStockOptions } from './stockSearchLayout'

it('opens below when the visible content fits, even if there is more room above', () => {
  expect(placeStockOptions({ top: 500, bottom: 540 }, { top: 0, bottom: 640 }, 60)).toEqual({ above: false, maxHeight: 94 })
})

it('opens above a field near the bottom of a drawer', () => {
  expect(placeStockOptions({ top: 480, bottom: 524 }, { top: 90, bottom: 570 }, 400)).toEqual({ above: true, maxHeight: 320 })
})

it('limits the list to its clipping scroll container', () => {
  expect(placeStockOptions({ top: 420, bottom: 464 }, { top: 200, bottom: 500 }, 400)).toEqual({ above: true, maxHeight: 214 })
})

it('uses the reduced visible viewport and never returns a negative height', () => {
  expect(placeStockOptions({ top: 290, bottom: 334 }, { top: 0, bottom: 360 }, 400)).toEqual({ above: true, maxHeight: 284 })
  expect(placeStockOptions({ top: 90, bottom: 150 }, { top: 100, bottom: 140 }, 400).maxHeight).toBe(0)
})
