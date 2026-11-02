import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { Asset, Node } from '../pages/StrategyPage'
import CompositionRankingSettings from './CompositionRankingSettings'
import ConditionReferenceDetails from './ConditionReferenceDetails'

const catalog: Asset[] = [1, 2].map(version => ({ key: `filter:price@${version}`, label: '价格条件', filter: {
  id: 'price', version, name: '价格条件', library: 'technical', expression: { op: 'metric_compare', metric: 'close', operator: 'gt', value: version * 10 },
  description: '收盘价阈值', parameters: { value: { label: '阈值', type: 'number', min: 0, max: 100 } }, created_at: '2026-10-27',
} }))
const reference: Node = { op: 'filter_ref', filter_id: 'price', version: 1, score_weight: 4, parameter_overrides: { value: 15 } }
const tree: Node = { op: 'any', children: [reference, { op: 'not', children: [{ ...reference, score_weight: 0, parameter_overrides: { value: 30 } }] }] }

it('changes a nested ranking weight without rewriting fixed versions or overrides', async () => {
  const apply = vi.fn(), user = userEvent.setup()
  render(<CompositionRankingSettings tree={tree} catalog={catalog} disabled={false} onApply={apply} onClose={vi.fn()} />)
  expect(screen.getByLabelText('第 1 项评分权重')).toHaveValue(4)
  expect(screen.getByLabelText('第 2 项评分权重')).toHaveValue(0)
  fireEvent.change(screen.getByLabelText('第 2 项评分权重'), { target: { value: '101' } })
  expect(screen.getByRole('button', { name: '应用排序设置' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('第 2 项评分权重'), { target: { value: '2.5' } })
  await user.click(screen.getByRole('button', { name: '应用排序设置' }))
  expect(apply).toHaveBeenCalledWith({ ...tree, children: [reference, { op: 'not', children: [{ ...reference, score_weight: 2.5, parameter_overrides: { value: 30 } }] }] })
  expect(tree.children![1].children![0].score_weight).toBe(0)
})

it('cancels ranking edits without changing the existing configuration', async () => {
  const apply = vi.fn(), close = vi.fn(), user = userEvent.setup()
  render(<CompositionRankingSettings tree={tree} catalog={catalog} disabled={false} onApply={apply} onClose={close} />)
  fireEvent.change(screen.getByLabelText('第 1 项评分权重'), { target: { value: '8' } })
  await user.click(screen.getByRole('button', { name: '取消' }))
  expect(close).toHaveBeenCalledOnce()
  expect(apply).not.toHaveBeenCalled()
  expect(reference.score_weight).toBe(4)
})

it('updates a reference only on request and keeps compatible custom settings', async () => {
  const update = vi.fn(), user = userEvent.setup()
  render(<ConditionReferenceDetails node={reference} catalog={catalog} disabled={false} onUpdate={update} onClose={vi.fn()} />)
  expect(screen.getByText('已固定 v1')).toBeInTheDocument()
  expect(screen.queryByRole('combobox', { name: '引用版本' })).not.toBeInTheDocument()
  expect(update).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '更新到 v2' }))
  expect(update).toHaveBeenCalledWith({ ...reference, version: 2 })
  expect(reference.version).toBe(1)
})

it('blocks an incompatible version update instead of discarding overrides', () => {
  const update = vi.fn()
  const incompatible: Asset[] = catalog.map(asset => asset.filter?.version === 2 ? { ...asset, filter: { ...asset.filter, parameters: { value: { label: '阈值', type: 'number', min: 0, max: 10 } } } } : asset)
  render(<ConditionReferenceDetails node={reference} catalog={incompatible} disabled={false} onUpdate={update} onClose={vi.fn()} />)
  expect(screen.getByRole('button', { name: '更新到 v2' })).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent('本组合配置与新版不兼容')
  expect(update).not.toHaveBeenCalled()
  expect(reference.parameter_overrides).toEqual({ value: 15 })
})

it('keeps inherited shape matching settings when updating a legacy reference', async () => {
  const shapes: Asset[] = [1, 2].map(version => ({ key: `pattern:shape@${version}`, label: '双底形态', pattern: {
    id: 'shape', version, name: '双底形态', input_type: 'drawing', representation: 'price_path', target_bars: 20, points: [], candlesticks: [], created_at: '2026-10-27',
    params: version === 1 ? { min_similarity: 77, match_mode: 'recent', recent_bars: 40 } : { min_similarity: 95, match_mode: 'current', recent_bars: 10 },
  } }))
  const node: Node = { op: 'pattern_ref', pattern_id: 'shape', version: 1, score_weight: 0 }
  const update = vi.fn(), user = userEvent.setup()
  render(<ConditionReferenceDetails node={node} catalog={shapes} disabled={false} onUpdate={update} onClose={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: '更新到 v2' }))
  expect(update).toHaveBeenCalledWith({ ...node, version: 2, min_similarity: 77, match_mode: 'recent', recent_bars: 40 })
  expect(node).toEqual({ op: 'pattern_ref', pattern_id: 'shape', version: 1, score_weight: 0 })
})
