import { expect, it } from 'vitest'
import { indicatorSaveRequestId, indicatorScreeningPrompt, parameterError, type SavedIndicator } from './dynamicIndicators'

const record: SavedIndicator = {
  id: 'saved', name: '波动率偏离', version: 3, definition_hash: 'def', code_hash: 'code', created_at: '2026-01-01',
  definition: { name: '波动率偏离', description: '数值时序', formula: 'deviation', original_prompt: '波动率偏离', outputs: [{ name: 'value', label: '偏离值', unit: '', kind: 'line', placement: 'pane' }], program: { contract_version: 'python-indicator-v1', source_code: 'compute', required_fields: ['close'], required_history_bars: 20, parameters: { window: 20 }, parameter_specs: { window: { type: 'integer', label: '窗口', minimum: 2, maximum: 250 } } } },
}
it('does not accidentally request a current date when reusing a historical screening scope', () => {
  const prompt = indicatorScreeningPrompt(record, 'value', 'gt', 0)
  expect(prompt).toContain('沿用已有选股方案的股票范围与截止日期')
  expect(prompt).not.toMatch(/最新|当前|今天|今日/)
  expect(prompt).toContain('version=3')
  expect(prompt).toContain('threshold=0')
  expect(prompt).toContain('缺失和预热期保留 unknown')
})
it('preserves idempotent request IDs across drawer lifecycles without conflating different saves', () => {
  const key = JSON.stringify({ trial_id: 'one', name: 'name', confirmed: true })
  const first = indicatorSaveRequestId(key)
  expect(indicatorSaveRequestId(key)).toBe(first)
  expect(indicatorSaveRequestId(key + 'different')).not.toBe(first)
})
it('bounds saved retry identities and tolerates corrupted storage', () => {
  sessionStorage.setItem('dynamicIndicators.saveRequests', '{broken')
  expect(indicatorSaveRequestId('one')).toBeTruthy()
  for (let index = 0; index < 60; index++) indicatorSaveRequestId(String(index))
  expect(JSON.parse(sessionStorage.getItem('dynamicIndicators.saveRequests')!)).toHaveLength(50)
})
it('validates integer, finite, and upper-bound parameters', () => {
  expect(parameterError(record.definition, { window: 20.5 })).toContain('整数')
  expect(parameterError(record.definition, { window: Infinity })).toContain('有效数值')
  expect(parameterError(record.definition, { window: 251 })).toContain('不能大于')
  expect(parameterError(record.definition, { window: 2 })).toBe('')
})
