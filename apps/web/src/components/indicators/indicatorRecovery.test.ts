import { expect, it } from 'vitest'
import { ApiRequestError } from '../../api'
import { indicatorRecovery } from './indicatorRecovery'

it.each([
  ['indicator_runtime_unavailable', 503, ['services', 'retry']],
  ['indicator_bars_not_found', 404, ['inputs', 'services']],
  ['indicator_stale_trial', 409, ['recalculate']],
  ['indicator_data_context_changed', 409, ['recalculate']],
  ['indicator_version_conflict', 409, ['refresh']],
  ['indicator_trial_not_found', 404, ['refresh']],
  ['indicator_not_found', 404, ['refresh']],
  ['indicator_execution_failed', 422, ['describe']],
  ['indicator_lookahead_detected', 422, ['describe']],
  ['indicator_request_conflict', 409, ['refresh']],
  ['indicator_cancelled', 409, ['retry']],
] as const)('uses the server category %s without hiding its original explanation', (code, status, actions) => {
  const result = indicatorRecovery(new ApiRequestError('服务端原始说明', status, code))
  expect(result.message).toBe('服务端原始说明')
  expect(result.actions).toEqual(actions)
  expect(result.guidance).not.toBe('')
})

it('does not infer a runtime failure from an arbitrary unknown message', () => {
  const result = indicatorRecovery(new Error('timeout: local permission warning'))
  expect(result.message).toBe('timeout: local permission warning')
  expect(result.actions).toEqual(['retry', 'services'])
  expect(result.guidance).not.toMatch(/权限不足|计算超时|运行环境不可用/)
})

it.each([
  [401, ['retry']], [403, []], [429, ['retry']], [502, ['services', 'retry']],
  [422, ['inputs', 'describe']], [409, ['refresh']], [418, ['retry', 'services']],
] as const)('falls back to the explicit HTTP status %s, not text matching', (status, actions) => {
  expect(indicatorRecovery(new ApiRequestError('原文', status, 'future_error')).actions).toEqual(actions)
})

it('preserves string errors and gives a neutral fallback for non-errors', () => {
  expect(indicatorRecovery('网络请求尚未完成').message).toBe('网络请求尚未完成')
  expect(indicatorRecovery(null).message).toBe('请求未完成，请重试。')
})

it('does not treat inherited object property names as server error categories', () => {
  expect(indicatorRecovery(new ApiRequestError('unknown category', 418, 'toString')).actions).toEqual(['retry', 'services'])
})
