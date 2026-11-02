import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type ScreeningTaskRevision, type ScreeningTaskRunSummary } from '../../api'
import ScreeningDeliveryCard, { type DeliveryRun } from './ScreeningDeliveryCard'

vi.mock('../../api', () => ({ api: vi.fn() }))
beforeEach(() => { vi.mocked(api).mockReset() })
const task: ScreeningTaskRevision = {
  task_id: 'task', revision: 1, original_user_messages: ['趋势选股'],
  conditions: [{ condition_id: 'one', library: 'technical', description: '收盘价高于20日均线', source_quote: '趋势选股', expression: {} }],
  references: [{ reference_id: 'one', condition_id: 'one', parameter_overrides: {} }], logic_tree: { op: 'condition', reference_id: 'one' },
  scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: '2026-10-20', report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: null, ranking: null }, unresolved: [],
}
const summary = { id: 'current', task_revision: 1, as_of: '2026-10-20', status: 'running', job_id: 'job', created_at: '', finished_at: null } satisfies ScreeningTaskRunSummary
const running: DeliveryRun = { ...summary, result: {}, job: { state: 'running', progress: 0.4, message: '已核对40只股票' } }
const completed: DeliveryRun = { ...running, status: 'partial', result: { coverage: { target_total: 100, true_count: 3, false_count: 95, unknown_count: 2 } } }
const callbacks = () => ({ onPlan: vi.fn(), onResults: vi.fn(), onEdit: vi.fn(), onStart: vi.fn(), onReload: vi.fn(), onClarify: vi.fn(), onRunStatus: vi.fn(), onContentChange: vi.fn() })
const state = { conversationId: 'one', task, viewedRunId: 'current', readError: '', refreshKey: 0, active: true, processing: false, failed: false, pending: false, paused: false, canStart: false, disabled: false, stopping: false }

it('updates one card from plan preparation to real progress and counts without changing focus', async () => {
  const actions = callbacks()
  const view = render(<><input aria-label="保留焦点" /><ScreeningDeliveryCard {...state} {...actions} task={null} processing viewedRun={null} /></>)
  const card = screen.getByRole('region', { name: '本次选股进展' }), input = screen.getByLabelText('保留焦点')
  input.focus()
  expect(screen.getByRole('status')).toHaveTextContent('正在整理筛选方案')
  view.rerender(<><input aria-label="保留焦点" /><ScreeningDeliveryCard {...state} {...actions} currentRun={summary} viewedRun={running} /></>)
  expect(screen.getByRole('progressbar', { name: '筛选进度' })).toHaveAttribute('value', '0.4')
  view.rerender(<><input aria-label="保留焦点" /><ScreeningDeliveryCard {...state} {...actions} currentRun={{ ...summary, status: 'partial' }} viewedRun={completed} /></>)
  expect(screen.getByRole('region', { name: '本次选股进展' })).toBe(card)
  expect(input).toHaveFocus()
  expect(within(card).getByText('3')).toBeVisible()
  expect(within(card).getByText('2')).toBeVisible()
  expect(actions.onPlan).not.toHaveBeenCalled(); expect(actions.onResults).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '查看名单' }))
  expect(actions.onResults).toHaveBeenCalledOnce()
  expect(vi.mocked(api)).not.toHaveBeenCalled()
})

it('never substitutes historical counts for the current run and reads only the current result', async () => {
  vi.mocked(api).mockResolvedValue(completed as never)
  const old = { ...completed, id: 'history', result: { coverage: { target_total: 99, true_count: 99, false_count: 0, unknown_count: 0 } } }
  render(<ScreeningDeliveryCard {...state} {...callbacks()} currentRun={summary} viewedRunId="history" viewedRun={old} />)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('筛选完成'))
  expect(screen.getByText('3')).toBeVisible()
  expect(screen.queryByText('99')).not.toBeInTheDocument()
  expect(vi.mocked(api)).toHaveBeenCalledWith('/conversations/one/screening-runs/current', expect.objectContaining({ signal: expect.any(AbortSignal) }))
})

it('explains a result read failure without presenting zero matches or completed counts', () => {
  render(<ScreeningDeliveryCard {...state} {...callbacks()} currentRun={{ ...summary, status: 'succeeded' }} viewedRun={null} readError="读取失败" />)
  expect(screen.getByRole('status')).toHaveTextContent('筛选状态暂时无法读取')
  expect(screen.getByText(/暂不能据此判断是否有匹配结果/)).toBeVisible()
  expect(screen.queryByText('0')).not.toBeInTheDocument()
})

it('keeps completed counts identifiable when a later request fails instead of claiming that request completed', () => {
  render(<ScreeningDeliveryCard {...state} {...callbacks()} currentRun={{ ...summary, status: 'partial' }} viewedRun={completed} failed />)
  expect(screen.getByRole('status')).toHaveTextContent('本轮处理未完成')
  expect(screen.getByText('已取得的筛选结果')).toBeVisible()
  expect(screen.getByText('3')).toBeVisible()
})
