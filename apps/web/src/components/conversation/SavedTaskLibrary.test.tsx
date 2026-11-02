import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type SavedScreeningTask, type ScreeningTaskRevision } from '../../api'
import SavedTaskLibrary from './SavedTaskLibrary'

vi.mock('../../api', () => ({ api: vi.fn() }))
const task: ScreeningTaskRevision = {
  task_id: 'original', revision: 3, original_user_messages: ['价格高于阈值，排除下跌'],
  conditions: [{ condition_id: 'price', library: 'technical', description: '收盘价高于10元', source_quote: '价格高于阈值', expression: {} }, { condition_id: 'falling', library: 'technical', description: '近5日下跌', source_quote: '排除下跌', expression: {} }],
  references: [{ reference_id: 'price-ref', condition_id: 'price', parameter_overrides: { threshold: 15 } }, { reference_id: 'falling-ref', condition_id: 'falling', parameter_overrides: {} }],
  logic_tree: { op: 'all', children: [{ op: 'condition', reference_id: 'price-ref' }, { op: 'not', children: [{ op: 'condition', reference_id: 'falling-ref' }] }] },
  scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: '2026-09-14', report_lookback_calendar_days: 90, news_lookback_calendar_days: 30, price_basis: 'unadjusted', ranking: null }, unresolved: [],
}
const saved: SavedScreeningTask = { id: 'plan', version: 2, name: '趋势跟踪', task, created_at: '2026-09-28T08:00:00Z' }
const other: SavedScreeningTask = { ...saved, id: 'other', name: 'ROE 观察', task: { ...task, conditions: task.conditions.map(condition => ({ ...condition, description: condition.description + '，核对 ROE' })) } }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api).mockResolvedValue({ items: [saved, other] }) })

it('reuses a plan with the latest market date directly from its row', async () => {
  const reuse = vi.fn(), user = userEvent.setup()
  render(<SavedTaskLibrary scope="screening" busy={false} latestDate="2026-10-27" onReuse={reuse} />)
  const row = (await screen.findByRole('button', { name: '查看方案 趋势跟踪 详情' })).closest('article')!
  expect(screen.queryByText('2026-09-14')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '按原日期运行' })).not.toBeInTheDocument()
  await user.click(within(row).getByRole('button', { name: '按最新行情运行' }))
  expect(reuse).toHaveBeenCalledExactlyOnceWith(saved, true)
  expect(saved.task.scope.as_of).toBe('2026-09-14')
  expect(saved.task.references[0].parameter_overrides).toEqual({ threshold: 15 })
})

it('shows the fixed version, original date, nested logic and overrides in details', async () => {
  const reuse = vi.fn(), user = userEvent.setup()
  render(<SavedTaskLibrary scope="screening" busy={false} latestDate="2026-10-27" onReuse={reuse} />)
  await user.click(await screen.findByRole('button', { name: '查看 趋势跟踪 详情' }))
  const drawer = screen.getByRole('dialog', { name: '方案详情' })
  expect(within(drawer).getByText('v2', { exact: true })).toBeVisible()
  expect(within(drawer).getByText('2026-09-14')).toBeVisible()
  expect(within(drawer).getByText('同时满足')).toBeVisible()
  expect(within(drawer).getByText('排除以下情况')).toBeVisible()
  expect(within(drawer).getByText('本次采用的参数：阈值 15')).toBeVisible()
  await user.click(within(drawer).getByRole('button', { name: '关闭方案详情' }))
  expect(screen.getByRole('button', { name: '查看 趋势跟踪 详情' })).toHaveFocus()
  await user.click(screen.getByRole('button', { name: '查看 趋势跟踪 详情' }))
  await user.click(within(screen.getByRole('dialog', { name: '方案详情' })).getByRole('button', { name: '按原日期运行' }))
  expect(reuse).toHaveBeenCalledExactlyOnceWith(saved, false)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('keeps latest-date reuse disabled without a market date and allows explicit original-date reuse', async () => {
  const reuse = vi.fn(), user = userEvent.setup()
  render(<SavedTaskLibrary scope="screening" busy={false} onReuse={reuse} />)
  await screen.findByRole('button', { name: '查看 趋势跟踪 详情' })
  expect(screen.getAllByRole('button', { name: '按最新行情运行' }).every(button => button.hasAttribute('disabled'))).toBe(true)
  await user.click(screen.getByRole('button', { name: '查看 趋势跟踪 详情' }))
  const drawer = screen.getByRole('dialog', { name: '方案详情' })
  expect(within(drawer).getByRole('button', { name: '按最新行情运行' })).toBeDisabled()
  await user.click(within(drawer).getByRole('button', { name: '按原日期运行' }))
  expect(reuse).toHaveBeenCalledExactlyOnceWith(saved, false)
})

it('uses inline details in the conversation drawer and restores its search without another modal', async () => {
  const user = userEvent.setup()
  render(<SavedTaskLibrary embedded scope="screening" busy={false} latestDate="2026-10-27" onReuse={vi.fn()} />)
  await screen.findByText('ROE 观察')
  await user.type(screen.getByLabelText('搜索已保存方案'), 'roe')
  expect(screen.queryByText('趋势跟踪')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '查看方案 ROE 观察 详情' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: '方案详情' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '返回方案列表' })).toHaveFocus()
  await user.click(screen.getByRole('button', { name: '返回方案列表' }))
  expect(screen.getByLabelText('搜索已保存方案')).toHaveValue('roe')
  await waitFor(() => expect(screen.getByLabelText('搜索已保存方案')).toHaveFocus())
})

it('supports the centers shared search and clearing without a second search toolbar', async () => {
  const clear = vi.fn(), user = userEvent.setup()
  const view = render(<SavedTaskLibrary hideToolbar searchQuery="ROE" onSearchQueryChange={clear} scope="screening" busy={false} onReuse={vi.fn()} />)
  await screen.findByText('ROE 观察')
  expect(screen.queryByText('趋势跟踪')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('搜索已保存方案')).not.toBeInTheDocument()
  view.rerender(<SavedTaskLibrary hideToolbar searchQuery="找不到" onSearchQueryChange={clear} scope="screening" busy={false} onReuse={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: '清除搜索' }))
  expect(clear).toHaveBeenCalledExactlyOnceWith('')
})
