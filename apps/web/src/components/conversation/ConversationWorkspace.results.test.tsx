import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Conversation, ScreeningTaskRevision } from '../../api'
import ConversationWorkspace from './ConversationWorkspace'

const timestamp = '2026-11-16T08:00:00Z'
const plan = (revision: number): ScreeningTaskRevision => ({
  task_id: 'one', revision, original_user_messages: ['放量突破'],
  conditions: [{ condition_id: 'trend', library: 'technical', description: `技术条件 v${revision}`, source_quote: '趋势条件', expression: {} }],
  references: [{ reference_id: 'ref', condition_id: 'trend', parameter_overrides: {} }], logic_tree: { op: 'condition', reference_id: 'ref' },
  scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: revision === 1 ? '2026-11-13' : '2026-11-16', report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: null, ranking: null }, unresolved: [],
})
const stored: Conversation = { id: 'one', task_id: 'one', entry_scope: 'screening', workflow_type: 'screening', task_revision: 2, active_run_id: 'latest', pending_execution: false, state: 'active', messages: [{ id: 'question', role: 'user', content: '放量突破', source_refs: [], created_at: timestamp }], turns: [], created_at: timestamp, updated_at: timestamp }
const json = (value: unknown) => new Response(JSON.stringify(value))
const writes: { path: string; body: Record<string, unknown> }[] = []
beforeEach(() => {
  writes.length = 0
  vi.stubGlobal('innerWidth', 1440)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost'), path = url.pathname
    if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); writes.push({ path, body }); return json({ name: body.name }) }
    if (path === '/api/v1/conversations') return json({ items: [stored] })
    if (path === '/api/v1/conversations/one') return json(stored)
    if (path.endsWith('/revisions/2')) return json(plan(2))
    if (path.endsWith('/screening-runs')) return json({ items: ['latest', 'old'].map((id, index) => ({ id, task_revision: 2 - index, as_of: plan(2 - index).scope.as_of, status: 'succeeded', created_at: timestamp })) })
    const id = path.includes('/old') ? 'old' : 'latest', revision = id === 'old' ? 1 : 2
    if (path.endsWith('/decisions')) return json({ total: 1, items: [{ stock_code: id === 'old' ? '000001.SZ' : '600000.SH', state: 'true', condition_decisions: [{ reference_id: 'ref', condition_id: 'trend', state: 'true', explanation: `批次 ${id} 的原始依据` }] }] })
    if (path.endsWith('/screening-runs/latest') || path.endsWith('/screening-runs/old')) return json({ id, task_revision: revision, as_of: plan(revision).scope.as_of, status: 'succeeded', task: plan(revision), result: { coverage: { target_total: 1, true_count: 1, false_count: 0, unknown_count: 0 } } })
    return json({ items: [] })
  }))
})

it('opens desktop results without taking focus and keeps the viewed batch for saving, asking and research', async () => {
  const user = userEvent.setup(), research = vi.fn()
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="one" onResearchResult={research} data={{ available: true, last_date: '2026-11-16' }} />)
  const panel = await screen.findByRole('region', { name: '筛选方案与结果' })
  const divider = screen.getByRole('separator', { name: '调整对话与结果宽度' })
  expect(divider).toHaveAttribute('aria-valuenow', '38')
  divider.focus(); await user.keyboard('{ArrowRight}')
  expect(divider).toHaveAttribute('aria-valuenow', '40')
  expect(panel).not.toHaveAttribute('aria-modal')
  const input = screen.getByLabelText('选股要求')
  await waitFor(() => expect(input).toBeEnabled())
  fireEvent.change(input, { target: { value: '保留未发送的条件' } })
  input.focus()
  await within(panel).findByRole('table', { name: '筛选结果股票列表' })
  expect(input).toHaveFocus()
  const batch = screen.getByRole('combobox', { name: '查看筛选运行' })
  await user.selectOptions(batch, 'old')
  const evidence = () => within(screen.getByRole('region', { name: '个股条件与依据' }))
  await screen.findByText('批次 old 的原始依据')
  await user.click(within(panel).getByRole('tab', { name: '筛选方案' }))
  expect(batch).toBeVisible()
  const planTab = within(panel).getByRole('tabpanel', { name: '筛选方案' })
  expect(planTab).toHaveTextContent('技术条件 v1')
  expect(planTab).toHaveTextContent('批次规则快照 · 只读')
  expect(within(planTab).queryByText('修改范围与日期')).not.toBeInTheDocument()
  await user.click(within(planTab).getByRole('button', { name: '编辑当前方案 v2' }))
  expect(planTab).toHaveTextContent('技术条件 v2')
  await user.click(within(planTab).getByRole('button', { name: '返回批次方案' }))
  expect(planTab).toHaveTextContent('技术条件 v1')
  await user.click(within(panel).getByRole('tab', { name: '筛选结果' }))
  const row = await within(panel).findByRole('button', { name: '查看 000001.SZ 条件与依据' })
  await user.click(row)
  await waitFor(() => expect(within(panel).getByRole('region', { name: '个股条件与依据' })).toHaveFocus())
  await user.click(evidence().getByRole('button', { name: '返回名单' }))
  expect(row).toHaveFocus()
  expect(input).toHaveValue('保留未发送的条件')
  await user.click(within(panel).getByRole('button', { name: '保存为方案' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0].body).toMatchObject({ revision: 1, name: '技术条件 v1' })
  await user.click(evidence().getByRole('button', { name: '继续研究' }))
  expect(research).toHaveBeenCalledWith(
    { reference: { kind: 'screening_run', source_id: 'old', stock_code: '000001.SZ' }, label: '筛选批次 · 2026-11-13 · v1' },
    expect.stringContaining('000001.SZ'),
    { conversationId: 'one', runId: 'old', stockCode: '000001.SZ', query: '', state: 'true', offset: 0 },
  )
  expect(research.mock.calls[0][1]).toContain('2026-11-13')
  expect(batch).toHaveValue('old')
  await user.click(evidence().getByRole('button', { name: '追问这只股票' }))
  await waitFor(() => expect(input).toHaveFocus())
  expect(screen.getByRole('region', { name: '筛选方案与结果' })).toBeVisible()
  expect(input).toHaveValue('为什么这次选中了000001.SZ？')
  await user.click(screen.getByRole('button', { name: '返回原选股草稿' }))
  expect(input).toHaveValue('保留未发送的条件')
  expect(writes).toHaveLength(1)
})

it('opens results explicitly on mobile and restores the draft after closing', async () => {
  vi.stubGlobal('innerWidth', 390)
  const user = userEvent.setup()
  const workspace = <ConversationWorkspace initialWorkflowType="screening" initialConversationId="one" data={{ available: true, last_date: '2026-11-16' }} />
  const view = render(workspace)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  fireEvent.change(screen.getByLabelText('选股要求'), { target: { value: '手机草稿' } })
  expect(screen.queryByRole('dialog', { name: '筛选方案与结果' })).not.toBeInTheDocument()
  await user.click(await screen.findByRole('button', { name: '查看名单' }))
  const dialog = await screen.findByRole('dialog', { name: '筛选方案与结果' })
  expect(dialog).toHaveAttribute('aria-modal', 'true')
  await within(dialog).findByRole('region', { name: '个股条件与依据' })
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: '筛选方案与结果' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('选股要求')).toHaveValue('手机草稿')
  await user.click(screen.getByRole('button', { name: '查看名单' }))
  await user.click(await screen.findByRole('button', { name: '追问这只股票' }))
  expect(screen.getByLabelText('选股要求')).toHaveValue('为什么这次选中了600000.SH？')
  view.unmount()
  render(workspace)
  await waitFor(() => expect(screen.getByLabelText('选股要求')).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '返回原选股草稿' }))
  expect(screen.getByLabelText('选股要求')).toHaveValue('手机草稿')
  expect(writes).toHaveLength(0)
})

it('restores a historical batch and the same stock in the compact result drawer after remounting', async () => {
  vi.stubGlobal('innerWidth', 390)
  const fallback = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/old/decisions') && url.searchParams.get('offset') === '20') {
      return Promise.resolve(json({ total: 60, items: [
        { stock_code: '000002.SZ', state: 'true', condition_decisions: [] },
        { stock_code: '000003.SZ', state: 'true', condition_decisions: [{ condition_id: 'trend', state: 'true', explanation: '本页第二只的历史依据' }] },
      ] }))
    }
    return fallback(input, init)
  })
  const handoff = {
    screeningResult: { conversationId: 'one', runId: 'old', stockCode: '000003.SZ', query: '', state: 'true', offset: 20 },
    pickReport: vi.fn(), onTransferApplied: vi.fn(), onReleaseScreeningResult: vi.fn(),
  }
  render(<ConversationWorkspace initialWorkflowType="screening" initialConversationId="one" handoff={handoff} />)
  const dialog = await screen.findByRole('dialog', { name: '筛选方案与结果' })
  expect(within(dialog).getByRole('combobox', { name: '查看筛选运行' })).toHaveValue('old')
  const evidence = await within(dialog).findByRole('region', { name: '个股条件与依据' })
  expect(within(evidence).getByText('本页第二只的历史依据')).toBeVisible()
  const user = userEvent.setup()
  await user.click(within(evidence).getByRole('button', { name: '返回名单' }))
  expect(within(dialog).getByRole('button', { name: '查看 000003.SZ 条件与依据' })).toHaveFocus()
  expect(writes).toHaveLength(0)
})
