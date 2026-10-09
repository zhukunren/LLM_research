import { expect, it } from 'vitest'
import type { Asset, Node } from './pages/StrategyPage'
import { addTransferConditions, moveTransferItems, referencedConditionKeys, removeTransferItems, transferItems, updateTransferItem } from './conditionTransfer'

const ref = (id: string): Node => ({ op: 'filter_ref', filter_id: id, version: 1, score_weight: 1 })
const asset = (id: string): Asset => ({ key: `filter:${id}@1`, label: id, filter: { id, version: 1, name: id, library: 'technical', expression: {}, description: id, created_at: '' } })

it('adds distinct versions once and retains a NOT group with all of its parameters', () => {
  const nested: Node = { op: 'not', children: [{ ...ref('a'), score_weight: 3, parameter_overrides: { value: 20 } }] }
  const tree: Node = { op: 'any', children: [nested] }
  const next = addTransferConditions(tree, [asset('a'), asset('b'), asset('b')])
  expect(next).toEqual({ op: 'any', children: [nested, ref('b')] })
  expect(next.children![0]).toBe(nested)
  expect([...referencedConditionKeys(next)]).toEqual(['filter:a@1', 'filter:b@1'])
  expect(addTransferConditions(next, [asset('a'), asset('b')])).toBe(next)
})

it('keeps an excluded root whole when adding and removing conditions', () => {
  const root: Node = { op: 'not', children: [{ op: 'any', children: [ref('a'), ref('b')] }] }
  expect(transferItems(root)).toEqual([root])
  const next = addTransferConditions(root, [asset('c')])
  expect(next).toEqual({ op: 'all', children: [root, ref('c')] })
  expect(removeTransferItems(next, new Set([root]))).toEqual({ op: 'all', children: [ref('c')] })
  expect(removeTransferItems(root, new Set([root]))).toEqual({ op: 'all', children: [] })
  expect(root.children![0].op).toBe('any')
})

it('moves multiple selected entries stably without changing their parameters or group logic', () => {
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(ref)
  b.parameter_overrides = { threshold: 12 }; d.score_weight = 4
  const tree: Node = { op: 'any', children: [a, b, c, d, e] }, selected = new Set([b, d])
  expect(moveTransferItems(tree, selected, 'top').children).toEqual([b, d, a, c, e])
  expect(moveTransferItems(tree, selected, 'bottom').children).toEqual([a, c, e, b, d])
  expect(moveTransferItems(tree, selected, 'up').children).toEqual([b, a, d, c, e])
  expect(moveTransferItems(tree, selected, 'down').children).toEqual([a, c, b, e, d])
  expect(moveTransferItems(tree, new Set([a]), 'up')).toBe(tree)
  expect(tree.children).toEqual([a, b, c, d, e])
  expect(moveTransferItems(tree, selected, 'top').op).toBe('any')
})

it('uses the same pattern defaults as the logic editor', () => {
  const pattern: Asset = { key: 'pattern:p@2', label: '形态', pattern: { id: 'p', name: '形态', version: 2, input_type: 'drawing', representation: 'price_path', target_bars: 30, points: [], candlesticks: [], params: { min_similarity: 88, match_mode: 'recent', recent_bars: 12 }, created_at: '' } }
  expect(addTransferConditions({ op: 'all', children: [] }, [pattern]).children).toEqual([{ op: 'pattern_ref', pattern_id: 'p', version: 2, score_weight: 1, min_similarity: 88, match_mode: 'recent', recent_bars: 12 }])
})

it('updates only the edited entry, including single root entries', () => {
  const a = ref('a'), nested: Node = { op: 'not', children: [ref('b')] }
  const tree: Node = { op: 'any', children: [a, nested] }, updated = { ...a, score_weight: 5 }
  expect(updateTransferItem(tree, 0, updated)).toEqual({ op: 'any', children: [updated, nested] })
  expect(updateTransferItem(tree, 0, updated).children![1]).toBe(nested)
  expect(updateTransferItem(nested, 0, updated)).toBe(updated)
  expect(updateTransferItem(tree, 7, updated)).toBe(tree)
})
