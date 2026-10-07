import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { NodeEditor, type Asset, type Node } from './StrategyPage'
import type { Filter } from '../api'

const filter = (version: number): Filter => ({ id: 'f1', version, name: '均线条件', library: 'technical', description: '高于均线', expression: { op: 'price_above_ma', window: 20 }, parameters: { window: { label: '观察周期', type: 'integer', min: 2, max: 250 } }, contract: { summary: '高于20日均线', availability: 'market', availability_label: '行情可计算', notes: [] }, created_at: '2026-10-04' })
const catalog: Asset[] = [1,2].map(version => ({ key: 'filter:f1@' + version, label: '均线条件 · v' + version, filter: filter(version) }))
const reference: Node = { op: 'filter_ref', filter_id: 'f1', version: 1, score_weight: 1 }
function Harness({ initial }: { initial: Node }) { const [tree,setTree] = useState(initial); return <><NodeEditor node={tree} catalog={catalog} onChange={setTree} depth={0} /><output data-testid="tree">{JSON.stringify(tree)}</output></> }
const current = () => JSON.parse(screen.getByTestId('tree').textContent!) as Node

it('offers latest references by default and keeps historical versions explicitly selectable', async () => {
  const user = userEvent.setup(); render(<Harness initial={{ op:'all',children:[] }} />)
  expect(screen.getByRole('button', { name:'添加 均线条件 第 2 版' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name:'添加 均线条件 第 1 版' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('checkbox', { name:'显示历史版本' }))
  await user.click(screen.getByRole('button', { name:'添加 均线条件 第 1 版' }))
  expect(current().children?.[0]).toMatchObject({ version:1,filter_id:'f1' })
})

it('excludes and restores the full original group instead of dropping sibling conditions', async () => {
  const original: Node = { op:'all',children:[reference,{...reference,parameter_overrides:{window:30}}] }
  const user = userEvent.setup(); render(<Harness initial={original} />)
  await user.selectOptions(screen.getByLabelText('顶层逻辑'), 'not')
  expect(current()).toEqual({ op:'not',children:[original] })
  await user.click(screen.getByRole('button', { name:'取消排除' }))
  expect(current()).toEqual(original)
})

it('can clear numeric overrides and type a new value without appending the restored default', async () => {
  const user = userEvent.setup(); render(<Harness initial={{ ...reference,parameter_overrides:{window:14} }} />)
  await user.click(screen.getByText('本次参数'))
  const period = screen.getByLabelText('观察周期')
  await user.clear(period); await user.type(period,'5')
  expect(current().parameter_overrides).toMatchObject({window:5})
  const weight = screen.getByLabelText('评分权重')
  await user.clear(weight); await user.tab()
  expect(current().score_weight).toBeUndefined()
  expect(weight).toHaveValue(1)
})

it('keeps duplicated references independently editable', async () => {
  const user = userEvent.setup(); render(<Harness initial={{op:'all',children:[reference,{...reference}]}} />)
  await user.click(screen.getAllByText('本次参数')[1])
  await user.clear(screen.getAllByLabelText('评分权重')[1]); await user.type(screen.getAllByLabelText('评分权重')[1],'2')
  expect(current().children?.map(node=>node.score_weight)).toEqual([1,2])
})
