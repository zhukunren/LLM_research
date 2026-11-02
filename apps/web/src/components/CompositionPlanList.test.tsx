import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import CompositionPlanList from './CompositionPlanList'
import type { Strategy } from '../api'

const original: Strategy = { id: 'stable', version: 1, name: '旧名称', top_n: 20, created_at: '2026-10-01T10:00:00Z', tree: { op: 'all', children: [{ op: 'filter_ref', filter_id: 'price', version: 2, parameter_overrides: { threshold: 12 } }, { op: 'not', children: [{ op: 'any', children: [{ op: 'filter_ref', filter_id: 'news', version: 1 }, { op: 'pattern_ref', pattern_id: 'shape', version: 3 }] }] }] } }
const current = { ...original, name: '稳健方案', version: 4, created_at: '2026-11-01T10:00:00Z' }

it('groups versions and opens an exact reference without mutating nested conditions', async () => {
  const onOpen = vi.fn(), user = userEvent.setup(), before = JSON.stringify(original)
  render(<CompositionPlanList strategies={[original, current]} query="" onOpen={onOpen} />)
  expect(screen.getByText('条件组合 · 3 个条件 · v4 · 保存于 2026-11-01')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '打开编辑 稳健方案 第 4 版' }))
  expect(onOpen).toHaveBeenLastCalledWith('stable@4')
  await user.click(screen.getByText('历史版本 · 1'))
  await user.click(screen.getByRole('button', { name: '打开编辑 旧名称 第 1 版' }))
  expect(onOpen).toHaveBeenLastCalledWith('stable@1')
  expect(JSON.stringify(original)).toBe(before)
})

it('matches historical names while retaining the version group', () => {
  render(<CompositionPlanList strategies={[original, current]} query="旧名称" onOpen={vi.fn()} />)
  expect(screen.getByText('稳健方案')).toBeInTheDocument()
  expect(screen.queryByText('没有匹配的条件组合')).not.toBeInTheDocument()
})

it('distinguishes loading, unavailable and truly empty sources', async () => {
  const refresh = vi.fn(), create = vi.fn(), user = userEvent.setup()
  const view = render(<CompositionPlanList strategies={[]} query="" loading onCreate={create} />)
  expect(screen.getByText('正在读取条件组合…')).toBeInTheDocument()
  expect(screen.queryByText('暂无已保存的条件组合')).not.toBeInTheDocument()
  view.rerender(<CompositionPlanList strategies={[]} query="" error="网络暂不可用" onRefresh={refresh} onCreate={create} />)
  expect(screen.queryByText('暂无已保存的条件组合')).not.toBeInTheDocument()
  await user.click(within(screen.getByRole('alert')).getByRole('button', { name: '重试读取组合' }))
  expect(refresh).toHaveBeenCalledOnce()
  view.rerender(<CompositionPlanList strategies={[]} query="" onCreate={create} />)
  await user.click(screen.getByRole('button', { name: '新建条件组合' }))
  expect(create).toHaveBeenCalledOnce()
})

it('does not open while a parent submission is busy', async () => {
  const onOpen = vi.fn(), user = userEvent.setup()
  render(<CompositionPlanList strategies={[current]} query="" disabled onOpen={onOpen} />)
  await user.click(screen.getByRole('button', { name: '打开编辑' }))
  expect(onOpen).not.toHaveBeenCalled()
})
