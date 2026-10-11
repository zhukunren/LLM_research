import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ObservationPage from './ObservationPage'
import type { ResearchCandidate } from './ResearchCandidatePanel'
import type { ScreeningTaskRevision } from '../api'

vi.mock('../components/ObservationChart', () => ({ default: ({ code, view }: { code: string; view: string }) => <div data-testid="chart">{code} · {view}</div> }))
const task: ScreeningTaskRevision = {
  task_id: 'source', revision: 1, original_user_messages: ['收盘价高于均线'],
  conditions: [{ condition_id: 'c', library: 'technical', description: '收盘价高于均线', source_quote: '收盘价高于均线', expression: {} }],
  references: [{ reference_id: 'r', condition_id: 'c', parameter_overrides: {} }], logic_tree: { op: 'condition', reference_id: 'r' },
  scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: '2026-09-01', report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: null, ranking: null }, unresolved: [],
}
const candidate: ResearchCandidate = {
  id: 'candidate', revision: 1, source_kind: 'research_candidate', stock_code: '600519.SH', name: '贵州茅台',
  status: 'watching', note: '核对现金流', verification: '下一期公告', invalidation: '现金流恶化',
  conversation_id: 'research', source_message_id: 'answer', source_text: '原研究答复', project_id: 'project',
  scope: { as_of: '2026-09-30' }, as_of: '2026-09-30', source_scope_status: 'frozen', source_scope_revision: 2,
  created_at: '2026-10-04T00:00:00Z', updated_at: '2026-10-04T00:00:00Z',
}
const researchEntry = {
  kind: 'candidate', entry_id: 'candidate', candidate_id: 'candidate', run_id: null,
  stock_code: '600519.SH', name: '贵州茅台', status: 'watching', note: '核对现金流', verification: '下一期公告',
  updated_at: '2026-10-04T00:00:00Z', joined_at: '2026-10-04T00:00:00Z', basis_date: '2026-10-04',
  owner_type: 'research', owner_key: 'project:project', owner_label: '盈利研究',
}
const screeningEntry = (id = 'run-1', code = '600000.SH') => ({
  kind: 'screening', entry_id: id + ':' + code, candidate_id: null, run_id: id,
  stock_code: code, name: code === '600000.SH' ? '浦发银行' : '招商银行', status: 'watching',
  note: '', verification: '', updated_at: '2026-09-02T00:00:00Z', joined_at: '2026-09-01T09:00:00Z', basis_date: '2026-09-01',
  owner_type: 'screening', owner_key: 'run:' + id, owner_label: (id === 'run-1' ? '趋势方案' : '质量方案') + ' · 2026-09-01',
})
const counts = { target_total: 2, true_count: 1, false_count: 1, unknown_count: 0 }
const run = (id = 'run-1') => ({ id, name: id === 'run-1' ? '趋势方案' : '质量方案', version: 2, signal_date: '2026-09-01', created_at: '2026-09-01T09:00:00Z', status: 'succeeded', conversation_id: 'cid', task, result: { coverage: counts }, job_id: 'job' })
const performance = (code = '600000.SH') => ({
  items: [{ stock_code: code, name: code === '600000.SH' ? '浦发银行' : '招商银行', status: 'watching', note: '', updated_at: null,
    reference_close: 10, reference_date: '2026-09-01', calculation_base: 10, latest_close: 11, latest_date: '2026-09-03',
    days: 2, observed_days: 2, return_latest: 10, returns: { '5': null, '10': null, '20': null }, peak_return: 12, trough_return: -1, reason: '', invalid_bars: 0 }],
  latest_date: '2026-09-03', warning: '',
})
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function mockApi(intercept?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const entries = [researchEntry, screeningEntry(), screeningEntry('run-2', '600001.SH')]
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const custom = intercept?.(url, init)
    if (custom) return custom
    if (url.pathname.endsWith('/owners')) return json({ items: [
      { value: 'project:project', label: '盈利研究', group: 'research', count: 1 },
      { value: 'run:run-1', label: '趋势方案 · 2026-09-01', group: 'screening', count: 1 },
      { value: 'run:run-2', label: '质量方案 · 2026-09-01', group: 'screening', count: 1 },
    ] })
    if (url.pathname.endsWith('/entries')) {
      const owner = url.searchParams.get('owner')
      const status = url.searchParams.get('status')
      const query = url.searchParams.get('query') || ''
      const filtered = entries.filter(item => (!owner || owner === item.owner_type || owner === item.owner_key)
        && (!status || item.status === status)
        && (!query || (item.name + item.stock_code + item.note + item.owner_label).includes(query)))
      if (url.searchParams.get('include_metrics') === 'false') return json({ items: filtered, total: filtered.length })
      return json({ items: filtered.map(item => ({ ...item, return_latest: item.kind === 'candidate' ? 6 : 10,
        max_drawdown: item.kind === 'candidate' ? -12 : -25, base_date: item.basis_date, price_date: '2026-10-05', metric_reason: '' })),
        total: filtered.length, summary: { total: filtered.length,
          research_count: filtered.filter(item => item.kind === 'candidate').length,
          screening_count: filtered.filter(item => item.kind === 'screening').length,
          priced_count: filtered.length, average_return: filtered.length ? 8 : null,
          worst_drawdown: filtered.length ? -25 : null, positive_rate: filtered.length ? 100 : null },
        metric_note: '按收盘价计算', latest_date: '2026-10-05' })
    }
    if (url.pathname.endsWith('/research-candidates/candidate')) return json(candidate)
    if (url.pathname.endsWith('/run-1/performance')) return json(performance())
    if (url.pathname.endsWith('/run-2/performance')) return json(performance('600001.SH'))
    if (url.pathname.endsWith('/run-1')) return json(run())
    if (url.pathname.endsWith('/run-2')) return json(run('run-2'))
    return json({ message: '未处理 ' + url.pathname }, 404)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('统一观察池', () => {
  it('在列表修改状态时只保存状态，并可快速编辑备注', async () => {
    const writes: Record<string, unknown>[] = []
    mockApi((url, init) => {
      if (url.pathname.endsWith('/research-candidates/candidate') && init?.method === 'PATCH') { const body = JSON.parse(String(init.body)); writes.push(body); return json({ ...candidate, ...body }) }
    })
    const user = userEvent.setup()
    render(<ObservationPage data={null} />)
    await user.selectOptions(await screen.findByLabelText('修改贵州茅台观察状态'), 'priority')
    await screen.findByText('贵州茅台已设为重点关注。')
    expect(writes[0]).toEqual({ revision: 1, status: 'priority' })
    await user.click(await screen.findByRole('button', { name: '编辑贵州茅台关注备注' }))
    const dialog = screen.getByRole('dialog', { name: '快速编辑观察备注' })
    const input = within(dialog).getByLabelText('关注备注')
    await waitFor(() => expect(input).toBeEnabled())
    await user.clear(input); await user.type(input, '核对新增订单')
    await user.click(within(dialog).getByRole('button', { name: '保存备注' }))
    await screen.findByText('关注备注已保存。')
    expect(writes[1]).toEqual({ revision: 1, note: '核对新增订单' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('本页批量处理混合来源，失败项仍保留勾选', async () => {
    const writes: string[] = []
    mockApi((url, init) => {
      if (init?.method === 'PATCH') { writes.push(url.pathname); return url.pathname.includes('run-2') ? json({ detail: '稍后重试' }, 503) : json({}) }
    })
    const user = userEvent.setup()
    render(<ObservationPage data={null} />)
    await user.click(await screen.findByRole('checkbox', { name: '勾选本页全部观察记录' }))
    await user.click(screen.getByRole('button', { name: '设为重点关注' }))
    await screen.findByText(/已将 2 条记录设为重点关注/)
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '勾选观察记录 600001.SH 质量方案 · 2026-09-01' })).toBeChecked())
    expect(screen.getByRole('checkbox', { name: '勾选观察记录 600000.SH 趋势方案 · 2026-09-01' })).not.toBeChecked()
    expect(writes).toHaveLength(3)
  })

  it('保存筛选视图后可重新载入同一查询', async () => {
    mockApi()
    const user = userEvent.setup()
    const view = render(<ObservationPage data={null} />)
    await user.type(screen.getByLabelText('搜索观察记录'), '贵州茅台')
    await user.click(screen.getByRole('button', { name: '保存当前筛选' }))
    await user.clear(screen.getByLabelText('视图名称')); await user.type(screen.getByLabelText('视图名称'), '现金流跟踪')
    await user.click(screen.getByRole('button', { name: '保存视图' }))
    const saved = JSON.parse(localStorage.getItem('observation.savedViews')!)[0]
    expect(saved).toMatchObject({ name: '现金流跟踪', query: '贵州茅台' })
    view.unmount(); render(<ObservationPage data={null} />)
    await user.selectOptions(screen.getByLabelText('已保存观察视图'), saved.id)
    expect(screen.getByLabelText('搜索观察记录')).toHaveValue('贵州茅台')
  })
  it('先显示可操作的列表，再补齐行情统计与汇总', async () => {
    let finishMetrics!: (response: Response) => void
    mockApi(url => url.pathname.endsWith('/entries') && url.searchParams.get('include_metrics') !== 'false'
      ? new Promise<Response>(resolve => { finishMetrics = resolve }) : undefined)
    render(<ObservationPage data={null} />)
    const list = await screen.findByRole('region', { name: '观察记录列表' })
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(4))
    expect(within(list).getAllByText('计算中…').length).toBeGreaterThan(0)
    finishMetrics(json({ items: [
      { ...researchEntry, return_latest: 6, max_drawdown: -12, base_date: '2026-10-04', price_date: '2026-10-05' },
      { ...screeningEntry(), return_latest: 10, max_drawdown: -25, base_date: '2026-09-01', price_date: '2026-10-05' },
      { ...screeningEntry('run-2', '600001.SH'), return_latest: 10, max_drawdown: -25, base_date: '2026-09-01', price_date: '2026-10-05' },
    ], summary: { total: 3, research_count: 1, screening_count: 2, priced_count: 3, average_return: 8, worst_drawdown: -25, positive_rate: 100 }, metric_note: '按收盘价计算' }))
    await waitFor(() => expect(within(list).getAllByText('+10.00%')).toHaveLength(2))
    expect(screen.getByRole('region', { name: '当前筛选范围汇总' })).toHaveTextContent('-25.00%')
  })

  it('同一列表显示研究与筛选记录的所属，并可按具体所属筛选', async () => {
    const fetcher = mockApi()
    const user = userEvent.setup()
    render(<ObservationPage data={null} />)
    const list = await screen.findByRole('region', { name: '观察记录列表' })
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(4))
    expect(within(list).getByRole('columnheader', { name: '所属' })).toBeInTheDocument()
    expect(within(list).getByRole('columnheader', { name: '加入时间' })).toBeInTheDocument()
    expect(within(list).getByRole('columnheader', { name: '至今涨跌幅' })).toBeInTheDocument()
    expect(within(list).getByRole('columnheader', { name: '最大回撤' })).toBeInTheDocument()
    expect(within(list).getByText('盈利研究')).toBeInTheDocument()
    expect(within(list).getByText('趋势方案 · 2026-09-01')).toBeInTheDocument()
    await waitFor(() => expect(within(list).getAllByText('+10.00%')).toHaveLength(2))
    expect(within(list).getAllByText('-25.00%')).toHaveLength(2)
    expect(screen.getByRole('region', { name: '当前筛选范围汇总' })).toHaveTextContent('8.00%')
    expect(screen.queryByRole('tab', { name: '研究候选' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '筛选批次' })).not.toBeInTheDocument()
    await user.click(within(list).getByRole('button', { name: /查看贵州茅台观察详情/ }))
    expect(await screen.findByRole('dialog', { name: '观察详情' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '观察详情' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('按所属筛选'), 'run:run-2')
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(2))
    expect(within(list).getByText('招商银行')).toBeInTheDocument()
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('owner=run%3Arun-2'))).toBe(true)
    await user.click(screen.getByRole('button', { name: '清除筛选' }))
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(4))
  })

  it('点击筛选记录可看原批次走势并保存观察状态', async () => {
    let saved: unknown
    const location = vi.fn()
    mockApi((url, init) => {
      if (url.pathname.includes('/notes/') && init?.method === 'PUT') {
        saved = JSON.parse(String(init.body))
        return json({ ...(saved as object), updated_at: '2026-10-05T00:00:00Z' })
      }
    })
    const user = userEvent.setup()
    render(<ObservationPage data={null} onLocationChange={location} />)
    const list = await screen.findByRole('region', { name: '观察记录列表' })
    await user.click(await within(list).findByRole('button', { name: '查看浦发银行观察详情' }))
    expect(await screen.findByTestId('chart')).toHaveTextContent('600000.SH · observation')
    expect(location).toHaveBeenCalledWith('batches', 'run-1', true, '600000.SH')
    expect(screen.getByText('趋势方案')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '观察备注' }))
    await user.selectOptions(screen.getByLabelText('个股观察状态'), 'ended')
    await user.type(screen.getByLabelText('观察备注'), '等待订单验证')
    await user.click(screen.getByRole('button', { name: '保存观察记录' }))
    await screen.findByText('观察记录已保存')
    expect(saved).toEqual({ status: 'ended', note: '等待订单验证' })
    expect(await screen.findByRole('link', { name: '导出结果字典' })).toHaveAttribute('href', '/api/v1/observation/runs/run-1/snapshot')
  })

  it('同一批次切换股票时复用已读取的观察统计', async () => {
    const fetcher = mockApi(url => {
      if (url.pathname.endsWith('/entries')) return json({ items: [screeningEntry(), screeningEntry('run-1', '600001.SH')], total: 2 })
      if (url.pathname.endsWith('/run-1/performance')) return json({ ...performance(), items: [performance().items[0], performance('600001.SH').items[0]] })
    })
    const user = userEvent.setup()
    render(<ObservationPage data={null} />)
    const list = await screen.findByRole('region', { name: '观察记录列表' })
    await user.click(await within(list).findByRole('button', { name: '查看浦发银行观察详情' }))
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600000.SH'))
    await user.click(screen.getByRole('button', { name: '关闭观察详情' }))
    await user.click(within(list).getByRole('button', { name: '查看招商银行观察详情' }))
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600001.SH'))
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/run-1/performance'))).toHaveLength(1)
  })

  it('批次书签优先于列表中的其他记录，旧请求不能覆盖新选择', async () => {
    let resolveOld!: (value: Response) => void
    let requested = false
    mockApi(url => {
      if (url.pathname.endsWith('/run-1/performance')) { requested = true; return new Promise<Response>(resolve => { resolveOld = resolve }) }
    })
    const user = userEvent.setup()
    const view = render(<ObservationPage data={null} initialRunId="run-2" initialCode="600001.SH" initialTab="batches" />)
    expect(await screen.findByTestId('chart')).toHaveTextContent('600001.SH')
    view.rerender(<ObservationPage data={null} initialRunId="run-1" initialCode="600000.SH" initialTab="batches" />)
    await waitFor(() => expect(requested).toBe(true))
    const list = screen.getByRole('region', { name: '观察记录列表' })
    await user.click(screen.getByRole('button', { name: '关闭观察详情' }))
    await user.selectOptions(screen.getByLabelText('按所属筛选'), 'run:run-2')
    await user.click(await within(list).findByRole('button', { name: '查看招商银行观察详情' }))
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600001.SH'))
    resolveOld(json(performance()))
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600001.SH'))
  })

  it('股票不在当前列表页时仍能从批次书签打开正确详情', async () => {
    mockApi(url => {
      if (url.pathname.endsWith('/entries')) return json({ items: [screeningEntry()], total: 40 })
      if (url.pathname.endsWith('/run-1/performance')) return json({ ...performance(), items: [performance().items[0], performance('600001.SH').items[0]] })
    })
    render(<ObservationPage data={null} initialRunId="run-1" initialCode="600001.SH" initialTab="batches" />)
    expect(await screen.findByTestId('chart')).toHaveTextContent('600001.SH · observation')
    expect(screen.getByRole('dialog', { name: '观察详情' })).toBeInTheDocument()
  })
})
