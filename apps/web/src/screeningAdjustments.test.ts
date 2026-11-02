import { expect, it } from 'vitest'
import { screeningAdjustments } from './screeningAdjustments'
import type { ScreeningTaskRevision } from './api'

const condition = (value: Partial<ScreeningTaskRevision['conditions'][number]>) => ({
  condition_id: 'c1', library: 'technical', source_quote: '原始要求', description: '收盘价 > SMA(20)（含当日）', expression: {},
  ...value,
})

const task = (conditions: ScreeningTaskRevision['conditions']) => ({ conditions } as ScreeningTaskRevision)

it('suggests a looser return threshold and a shorter MA window', () => {
  const result = screeningAdjustments(task([
    condition({ condition_id: 'trend', program: { parameters: { window: 20 }, parameter_specs: { window: { label: '均线周期' } } } }),
    condition({
      condition_id: 'momentum',
      description: '(收盘价 / 5个交易日前收盘价 - 1) × 100 > 3%',
      program: { parameters: { window: 5, threshold: 3 }, parameter_specs: { threshold: { label: '涨幅阈值' } } },
    }),
  ]))
  expect(result.map(item => item.label)).toEqual(['把均线周期从 20 日缩短到 15 日', '把涨幅阈值从 3% 放宽到 2%'])
  expect(result[1].prompt).toContain('然后重新筛选')
})

it('loosens an oversold RSI threshold and a volume threshold in the correct direction', () => {
  const result = screeningAdjustments(task([
    condition({ condition_id: 'rsi', description: 'RSI14 < 30', program: { parameters: { window: 14, threshold: 30 } } }),
    condition({ condition_id: 'volume', description: '当日成交量 > 前20日均量的1.5倍', program: { parameters: { threshold: 1.5 } } }),
  ]))
  expect(result.map(item => item.label)).toEqual(['把 RSI 阈值从 30 放宽到 35', '把放量阈值从 1.5 倍放宽到 1.2 倍'])
})

it('does not invent adjustments without known program parameters', () => {
  expect(screeningAdjustments(task([condition({ description: '收盘价高于20日均线' })]))).toEqual([])
  expect(screeningAdjustments(null)).toEqual([])
})
