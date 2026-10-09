import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { Asset, Node } from '../pages/StrategyPage'
import ConditionTransferEditor from './ConditionTransferEditor'

const assets: Asset[] = [
  ...[1, 2].map(version => ({ key: `filter:price@${version}`, label: `价格 v${version}`, filter: { id: 'price', version, name: '价格条件', library: 'technical' as const, expression: {}, description: '收盘价高于阈值', created_at: '' } })),
  { key: 'filter:volume@1', label: '成交量', filter: { id: 'volume', version: 1, name: '成交量条件', library: 'technical', expression: {}, description: '量能放大', created_at: '' } },
  { key: 'filter:report@1', label: '研报', filter: { id: 'report', version: 1, name: '研报增长条件', library: 'report', expression: {}, description: '业绩增长', created_at: '' } },
]
function Harness({ initial = { op: 'all', children: [] } }: { initial?: Node }) {
  const [tree, setTree] = useState(initial)
  return <><ConditionTransferEditor tree={tree} catalog={assets} onChange={setTree} onCreateCondition={vi.fn()} /><output data-testid="tree">{JSON.stringify(tree)}</output></>
}
const currentTree = () => JSON.parse(screen.getByTestId('tree').textContent!) as Node

it('adds checked conditions in one batch and excludes chosen versions from the available list', async () => {
  const user = userEvent.setup(); render(<Harness />)
  expect(screen.queryByLabelText('选择待选条件 价格条件 第 1 版')).not.toBeInTheDocument()
  await user.click(screen.getByLabelText('选择待选条件 价格条件 第 2 版'))
  await user.click(screen.getByLabelText('选择待选条件 成交量条件 第 1 版'))
  await user.click(screen.getByRole('button', { name: '加入勾选条件' }))
  expect(currentTree().children?.map(node => node.filter_id)).toEqual(['price', 'volume'])
  expect(within(screen.getByRole('group', { name: '切换条件列表' })).getByRole('button', { name: '已选 2' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByLabelText('选择待选条件 价格条件 第 2 版')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '加入勾选条件' })).toBeDisabled()
  await user.click(screen.getByLabelText('历史版本'))
  expect(screen.getByLabelText('选择待选条件 价格条件 第 1 版')).toBeInTheDocument()
  await user.click(within(screen.getByRole('group', { name: '切换条件列表' })).getByRole('button', { name: /待选/ }))
  expect(currentTree().children).toHaveLength(2)
})

it('limits all-add to the visible category and search while keeping selected conditions', async () => {
  const user = userEvent.setup(); render(<Harness />)
  await user.click(screen.getByRole('button', { name: /行情条件/ }))
  await user.type(screen.getByRole('textbox', { name: '搜索待选条件' }), '量能')
  await user.click(screen.getByRole('button', { name: '加入全部待选条件' }))
  expect(currentTree().children?.map(node => node.filter_id)).toEqual(['volume'])
  await user.click(screen.getByRole('button', { name: /研报条件/ }))
  await user.clear(screen.getByRole('textbox', { name: '搜索待选条件' }))
  expect(screen.getByLabelText('选择已选条目 1 成交量条件')).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '待选条件' })).queryByText('价格条件')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '加入全部待选条件' }))
  expect(currentTree().children?.map(node => node.filter_id)).toEqual(['volume', 'report'])
})

it('keeps the selected row checked across repeated moves and removes the group whole', async () => {
  const group: Node = { op: 'not', children: [{ op: 'filter_ref', filter_id: 'price', version: 1, score_weight: 2, parameter_overrides: { value: 30 } }] }
  const initial: Node = { op: 'all', children: [{ op: 'filter_ref', filter_id: 'volume', version: 1 }, { op: 'filter_ref', filter_id: 'report', version: 1 }, group] }
  const user = userEvent.setup(); render(<Harness initial={initial} />)
  await user.click(screen.getByLabelText('选择已选条目 3 排除分组'))
  await user.click(screen.getByRole('button', { name: '上移' }))
  expect(screen.getByLabelText('选择已选条目 2 排除分组')).toBeChecked()
  await user.click(screen.getByRole('button', { name: '上移' }))
  expect(currentTree().children?.[0]).toEqual(group)
  await user.click(screen.getByRole('button', { name: '移除勾选条目' }))
  expect(currentTree().children).toHaveLength(2)
  expect(screen.getByLabelText('选择待选条件 价格条件 第 2 版')).toBeInTheDocument()
})

it('preserves unavailable fixed versions and disables all mutation controls during submission', () => {
  const missing: Node = { op: 'filter_ref', filter_id: 'missing', version: 7, parameter_overrides: { n: 4 } }
  const change = vi.fn()
  render(<ConditionTransferEditor tree={{ op: 'all', children: [missing] }} catalog={assets} disabled onChange={change} onCreateCondition={vi.fn()} />)
  expect(screen.getByText('未载入条件 · missing')).toBeInTheDocument()
  expect(screen.getByText(/v7 · 权重/)).toBeInTheDocument()
  expect(screen.getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true)
  expect(change).not.toHaveBeenCalled()
})

it('shows the effective parameter value in the selected list', () => {
  const asset: Asset = { key: 'filter:custom@3', label: '价格阈值', filter: { id: 'custom', name: '价格阈值', version: 3, library: 'technical', expression: { op: 'metric_compare', metric: 'close', operator: 'gt', value: 10 }, description: '收盘价大于 10 元', created_at: '' } }
  render(<ConditionTransferEditor tree={{ op: 'all', children: [{ op: 'filter_ref', filter_id: 'custom', version: 3, parameter_overrides: { value: 25 } }] }} catalog={[asset]} onChange={vi.fn()} onCreateCondition={vi.fn()} />)
  const selected = within(screen.getByRole('region', { name: '已选条件' }))
  expect(selected.getByText('收盘价大于 25 元')).toBeInTheDocument()
  expect(selected.queryByText('收盘价大于 10 元')).not.toBeInTheDocument()
})

it('describes an empty category honestly when other categories have conditions', async () => {
  const user = userEvent.setup(); render(<Harness />)
  await user.click(screen.getByRole('button', { name: /资讯条件/ }))
  expect(screen.getByText('当前分类暂无条件')).toBeInTheDocument()
  expect(screen.queryByText('当前分类已全部加入')).not.toBeInTheDocument()
})

it('edits parameters from the row without selecting it and applies one change', async () => {
  const initial: Node = { op: 'all', children: [{ op: 'filter_ref', filter_id: 'price', version: 2, score_weight: 1 }, { op: 'not', children: [{ op: 'filter_ref', filter_id: 'report', version: 1, parameter_overrides: { n: 7 } }] }] }
  const user = userEvent.setup(); render(<Harness initial={initial} />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '编辑第 1 项参数' }))
  expect(screen.getByRole('dialog', { name: '价格条件 · 条件参数' })).toBeInTheDocument()
  expect(screen.getByLabelText('选择已选条目 1 价格条件')).not.toBeChecked()
  fireEvent.change(screen.getByLabelText('评分权重'), { target: { value: '4' } })
  expect(currentTree()).toEqual(initial)
  await user.click(screen.getByRole('button', { name: '应用修改' }))
  expect(currentTree().children?.[0].score_weight).toBe(4)
  expect(currentTree().children?.[1]).toEqual(initial.children![1])
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '编辑第 1 项参数' })).toHaveFocus()
})

it('discards an individual logic change on Escape and preserves the original parameters', async () => {
  const initial: Node = { op: 'any', children: [{ op: 'filter_ref', filter_id: 'price', version: 1, score_weight: 3, parameter_overrides: { threshold: 5 } }] }
  const user = userEvent.setup(); render(<Harness initial={initial} />)
  await user.click(screen.getByRole('button', { name: '编辑第 1 项逻辑' }))
  await user.click(screen.getByRole('button', { name: '排除' }))
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(currentTree()).toEqual(initial)
  await user.click(screen.getByRole('button', { name: '编辑第 1 项逻辑' }))
  await user.click(screen.getByRole('button', { name: '排除' }))
  await user.click(screen.getByRole('button', { name: '应用修改' }))
  expect(currentTree()).toEqual({ op: 'any', children: [{ op: 'not', children: initial.children }] })
})

it('edits the overall relation from the selected header while preserving all entries', async () => {
  const initial: Node = { op: 'all', children: [{ op: 'filter_ref', filter_id: 'price', version: 2, score_weight: 2 }, { op: 'filter_ref', filter_id: 'volume', version: 1 }] }
  const user = userEvent.setup(); render(<Harness initial={initial} />)
  expect(screen.queryByLabelText('顶层逻辑')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '组合逻辑' }))
  await user.selectOptions(screen.getByLabelText('顶层逻辑'), 'any')
  await user.click(screen.getByRole('button', { name: '应用修改' }))
  expect(currentTree()).toEqual({ ...initial, op: 'any' })
  expect(screen.queryByLabelText('顶层逻辑')).not.toBeInTheDocument()
})
