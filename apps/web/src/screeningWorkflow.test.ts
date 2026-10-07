import { expect, it } from 'vitest'
import { compositionIssues, executionDateIssue } from './screeningWorkflow'
import type { Asset, Node } from './pages/StrategyPage'

const pattern: Asset = { key: 'pattern:p1@1', label: '形态条件', pattern: { id: 'p1', version: 1, name: '形态条件', input_type: 'drawing', representation: 'price_path', target_bars: 20, points: [], candlesticks: [], params: { match_mode: 'recent', recent_bars: 30 }, created_at: '2026-10-04T00:00:00Z' } }
const reference: Node = { op: 'pattern_ref', pattern_id: 'p1', version: 1, match_mode: 'recent' }

it('accepts inherited pattern defaults after an override is cleared', () => {
  expect(compositionIssues({ op: 'all', children: [reference] }, [pattern])).toEqual([])
  expect(compositionIssues({ ...reference, recent_bars: 0 }, [pattern])).toEqual([expect.stringContaining('近期回看')])
})

it('requires a single complete subtree for exclusion and checks fixed versions', () => {
  const issues = compositionIssues({ op: 'not', children: [reference, { ...reference, version: 2 }] }, [pattern])
  expect(issues).toEqual(expect.arrayContaining([expect.stringContaining('排除关系'), expect.stringContaining('版本未载入')]))
})

it('rejects impossible dates and dates beyond the available data', () => {
  expect(executionDateIssue('2026-02-30', '2026-09-28')).toBeTruthy()
  expect(executionDateIssue('2026-09-29', '2026-09-28')).toContain('行情水位')
  expect(executionDateIssue('2026-09-28', '2026-09-28')).toBe('')
})
