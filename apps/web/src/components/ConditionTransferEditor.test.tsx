import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { Asset, Node } from '../pages/StrategyPage'
import ConditionTransferEditor from './ConditionTransferEditor'

const assets: Asset[] = [
  ...[1, 2].map(version => ({ key: `filter:price@${version}`, label: `价格 v${version}`, filter: { id: 'price', version, name: '价格条件', library: 'technical' as const, expression: {}, description: '收盘价高于阈值', created_at: '' } })),
  { key: 'filter:volume@1', label: '成交量', filter: { id: 'volume', version: 1, name: '成交量条件', library: 'technical', expression: {}, description: '量能放大', created_at: '' } },
  { key: 'filter:report@1', label: '研报', filter: { id: 'report', version: 1, name: '研报增长条件', library: 'report', expression: {}, description: '业绩增长', created_at: '' } },
]
function Harness({ initial = { op: 'all', children: [] }, catalog = assets }: { initial?: Node; catalog?: Asset[] }) {
  const [tree, setTree] = useState(initial)
  return <><ConditionTransferEditor tree={tree} catalog={catalog} onChange={setTree} onCreateCondition={vi.fn()} /><output data-testid="tree">{JSON.stringify(tree)}</output></>
}
const currentTree = () => JSON.parse(screen.getByTestId('tree').textContent!) as Node

it('adds checked conditions in one batch and excludes chosen versions from the available list', async () => {
  const user = userEvent.setup(); render(<Harness />)
  expect(screen.queryByLabelText('选择待选条件 价格条件 第 1 版')).not.toBeInTheDocument()
  await user.click(screen.getByLabelText('选择待选条件 价格条件 第 2 版'))
  await user.click(screen.getByLabelText('选择待选条件 成交量条件 第 1 版'))
  await user.click(screen.getByRole('button', { name: '加入勾选条件' }))
  expect(currentTree().children?.map(node => node.filter_id)).toEqual(['price', 'volume'])
  expect(within(screen.getByRole('group', { name: '切换条件列表' })).getByRole('button', { name: '返回规则 · 2' })).toHaveAttribute('aria-pressed', 'false')
  expect(screen.queryByLabelText('选择待选条件 价格条件 第 2 版')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '加入勾选条件' })).toBeDisabled()
  expect(screen.queryByLabelText('历史版本')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('选择待选条件 价格条件 第 1 版')).not.toBeInTheDocument()
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

it('adds and removes a single condition directly while preserving an existing nested group', async () => {
  const group: Node = { op: 'any', children: [{ op: 'filter_ref', filter_id: 'report', version: 1, score_weight: 3, parameter_overrides: { n: 7 } }] }
  const initial: Node = { op: 'all', children: [group] }
  const user = userEvent.setup(); render(<Harness initial={initial} />)
  await user.click(screen.getByRole('button', { name: '添加条件' }))
  await user.click(screen.getByRole('button', { name: '加入 价格条件 第 2 版' }))
  expect(currentTree().children?.[0]).toEqual(group)
  expect(currentTree().children?.[1]).toMatchObject({ op: 'filter_ref', filter_id: 'price', version: 2 })
  await user.click(screen.getByRole('button', { name: '移除第 2 项' }))
  expect(currentTree()).toEqual(initial)
  expect(screen.getByRole('button', { name: '加入 价格条件 第 2 版' })).toBeEnabled()
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
  expect(screen.getByRole('combobox', { name: '组合关系' })).toBeDisabled()
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

it('edits business parameters inline while preserving weights, versions and other groups', async () => {
  const initial: Node = { op: 'all', children: [{ op: 'filter_ref', filter_id: 'price', version: 2, score_weight: 4, parameter_overrides: { value: 20 } }, { op: 'not', children: [{ op: 'filter_ref', filter_id: 'report', version: 1, parameter_overrides: { n: 7 } }] }] }
  const catalog: Asset[] = assets.map(asset => asset.filter?.id === 'price' && asset.filter.version === 2 ? { ...asset, filter: { ...asset.filter, expression: { op: 'metric_compare', metric: 'close', operator: 'gt', value: 10 }, parameters: { value: { label: '阈值', type: 'number', min: 0, max: 100 } } } } : asset)
  const user = userEvent.setup(); render(<Harness initial={initial} catalog={catalog} />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '编辑第 1 项参数' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByLabelText('选择已选条目 1 价格条件')).not.toBeChecked()
  expect(screen.queryByLabelText('评分权重')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('引用版本')).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('阈值'), { target: { value: '25' } })
  expect(currentTree().children?.[0].score_weight).toBe(4)
  expect(currentTree().children?.[0].version).toBe(2)
  expect(currentTree().children?.[0].parameter_overrides).toEqual({ value: 25 })
  expect(currentTree().children?.[1]).toEqual(initial.children![1])
  await user.click(screen.getByLabelText('阈值'))
  await user.keyboard('{Escape}')
  expect(screen.queryByText('修改仅对当前组合生效。')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '编辑第 1 项参数' })).toHaveFocus()
})

it('discards an individual logic change on Escape and preserves the original parameters', async () => {
  const initial: Node = { op: 'any', children: [{ op: 'filter_ref', filter_id: 'price', version: 1, score_weight: 3, parameter_overrides: { threshold: 5 } }] }
  const user = userEvent.setup(); render(<Harness initial={initial} />)
  await user.click(screen.getByLabelText('第 1 项更多操作'))
  await user.click(screen.getByRole('button', { name: '编辑第 1 项逻辑' }))
  await user.click(screen.getByRole('button', { name: '排除' }))
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(currentTree()).toEqual(initial)
  await user.click(screen.getByLabelText('第 1 项更多操作'))
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
  expect(screen.queryByLabelText('评分权重')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('引用版本')).not.toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('顶层逻辑'), 'any')
  await user.click(screen.getByRole('button', { name: '应用修改' }))
  expect(currentTree()).toEqual({ ...initial, op: 'any' })
  expect(screen.queryByLabelText('顶层逻辑')).not.toBeInTheDocument()
})

it('changes the visible relation and wraps exclusion without losing nested parameters', async () => {
  const initial: Node = { op: 'all', children: [{ op: 'filter_ref', filter_id: 'price', version: 2, score_weight: 3, parameter_overrides: { threshold: 5 } }, { op: 'any', children: [{ op: 'filter_ref', filter_id: 'report', version: 1 }] }] }
  const user = userEvent.setup(); render(<Harness initial={initial} />)
  await user.selectOptions(screen.getByRole('combobox', { name: '组合关系' }), 'any')
  expect(currentTree()).toEqual({ ...initial, op: 'any' })
  await user.selectOptions(screen.getByRole('combobox', { name: '组合关系' }), 'not')
  expect(currentTree()).toEqual({ op: 'not', children: [{ ...initial, op: 'any' }] })
  await user.selectOptions(screen.getByRole('combobox', { name: '组合关系' }), 'all')
  expect(currentTree()).toEqual(initial)
})


it('keeps an existing rule central and opens the library only on request without editing its AST', async () => {
  const user = userEvent.setup()
  const initial: Node = { op: 'all', children: [{ op: 'not', children: [{ op: 'filter_ref', filter_id: 'price', version: 1, parameter_overrides: { value: 22 } }] }] }
  render(<Harness initial={initial} />)
  expect(screen.queryByRole('region', { name: '待选条件' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '添加条件' })).toHaveAttribute('aria-expanded', 'false')
  await user.click(screen.getByRole('button', { name: '添加条件' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: '搜索待选条件' })).toHaveFocus())
  expect(currentTree()).toEqual(initial)
  await user.type(screen.getByRole('textbox', { name: '搜索待选条件' }), '量能')
  await user.click(screen.getByLabelText('选择待选条件 成交量条件 第 1 版'))
  await user.click(screen.getByRole('button', { name: '收起添加条件' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '添加条件' })).toHaveFocus())
  await user.click(screen.getByRole('button', { name: '添加条件' }))
  expect(screen.getByRole('textbox', { name: '搜索待选条件' })).toHaveValue('量能')
  expect(screen.getByLabelText('选择待选条件 成交量条件 第 1 版')).toBeChecked()
  expect(currentTree()).toEqual(initial)
})

it('keeps the picker open for repeated additions and offers an explicit mobile return to rules', async () => {
  const user = userEvent.setup(); render(<Harness />)
  const picker = screen.getByRole('region', { name: '待选条件' })
  const root = picker.closest('.condition-transfer')!
  expect(root).toHaveAttribute('data-library-open', 'true')
  await user.click(screen.getByRole('button', { name: '加入 价格条件 第 2 版' }))
  expect(root).toHaveAttribute('data-mobile-pane', 'available')
  await user.click(screen.getByRole('button', { name: '加入 成交量条件 第 1 版' }))
  await user.click(screen.getByRole('button', { name: '返回规则 · 2' }))
  expect(root).toHaveAttribute('data-mobile-pane', 'selected')
  expect(currentTree().children).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: /待选条件 ·/ }))
  expect(root).toHaveAttribute('data-mobile-pane', 'available')
  expect(currentTree().children).toHaveLength(2)
})

it('does not close the picker for IME Escape and restores focus for a normal Escape', async () => {
  const user = userEvent.setup(); render(<Harness />)
  const search = screen.getByRole('textbox', { name: '搜索待选条件' })
  await user.click(search)
  fireEvent.keyDown(search, { key: 'Escape', isComposing: true })
  expect(screen.getByRole('region', { name: '待选条件' })).toBeInTheDocument()
  fireEvent.keyDown(search, { key: 'Escape', keyCode: 229 })
  expect(screen.getByRole('region', { name: '待选条件' })).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('region', { name: '待选条件' })).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: '添加条件' })).toHaveFocus())
})

it('expands the entire readable rule using a keyboard-operable control without changing versions', async () => {
  const user = userEvent.setup(), change = vi.fn()
  const logic = '满足价格条件，且（满足成交量条件或研报增长条件），并排除停牌条件'
  render(<ConditionTransferEditor tree={{ op: 'all', children: [{ op: 'filter_ref', filter_id: 'price', version: 1 }] }} catalog={assets} logicSummary={logic} onChange={change} onCreateCondition={vi.fn()} />)
  expect(screen.getByText('固定 v1')).toBeInTheDocument()
  const toggle = screen.getByRole('button', { name: '展开完整逻辑' })
  toggle.focus(); await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: '收起完整逻辑' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText(logic)).toHaveAttribute('tabindex', '0')
  expect(change).not.toHaveBeenCalled()
})


it('opens the picker when a saved scheme is reset to an empty draft without retaining old rules', () => {
  const change = vi.fn(), create = vi.fn()
  const { rerender } = render(<ConditionTransferEditor tree={{ op: 'all', children: [{ op: 'filter_ref', filter_id: 'price', version: 1 }] }} catalog={assets} onChange={change} onCreateCondition={create} />)
  expect(screen.queryByRole('region', { name: '待选条件' })).not.toBeInTheDocument()
  rerender(<ConditionTransferEditor tree={{ op: 'all', children: [] }} catalog={assets} onChange={change} onCreateCondition={create} />)
  expect(screen.getByRole('region', { name: '待选条件' })).toBeInTheDocument()
  expect(screen.getByText('还没有方案规则')).toBeInTheDocument()
  expect(screen.queryByLabelText('选择已选条目 1 价格条件')).not.toBeInTheDocument()
  expect(change).not.toHaveBeenCalled()
})
