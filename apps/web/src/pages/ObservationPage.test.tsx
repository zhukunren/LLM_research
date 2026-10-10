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
  updated_at: '2026-10-04T00:00:00Z', owner_type: 'research', owner_key: 'project:project', owner_label: '盈利研究',
}
const screeningEntry = (id = 'run-1', code = '600000.SH') => ({
  kind: 'screening', entry_id: id + ':' + code, candidate_id: null, run_id: id,
  stock_code: code, name: code === '600000.SH' ? '浦发银行' : '招商银行', status: 'watching',
  note: '', verification: '', updated_at: '2026-09-02T00:00:00Z',
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
      return json({ items: filtered, total: filtered.length })
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
  it('同一列表显示研究与筛选记录的所属，并可按具体所属筛选', async () => {
    const fetcher = mockApi()
    const user = userEvent.setup()
    render(<ObservationPage data={null} />)
    const list = await screen.findByRole('region', { name: '观察记录列表' })
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(4))
    expect(within(list).getByRole('columnheader', { name: '所属' })).toBeInTheDocument()
    expect(within(list).getByText('盈利研究')).toBeInTheDocument()
    expect(within(list).getByText('趋势方案 · 2026-09-01')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '研究候选' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '筛选批次' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('按所属筛选'), 'run:run-2')
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(2))
    expect(within(list).getByText('招商银行')).toBeInTheDocument()
    expect(fetcher.mock.calls.some(([input]) => String(input).includes('owner=run%3Arun-2'))).toBe(true)
    await user.click(screen.getByRole('button', { name: '清除筛选' }))
    await waitFor(() => expect(within(list).getAllByRole('row')).toHaveLength(4))
  })

  it('点击筛选记录可看原批次走势并保存观察状态', async () => {
    let saved: unknown
    mockApi((url, init) => {
      if (url.pathname.includes('/notes/') && init?.method === 'PUT') {
        saved = JSON.parse(String(init.body))
        return json({ ...(saved as object), updated_at: '2026-10-05T00:00:00Z' })
      }
    })
    const user = userEvent.setup()
    render(<ObservationPage data={null} />)
    const list = await screen.findByRole('region', { name: '观察记录列表' })
    await user.click(await within(list).findByRole('button', { name: /浦发银行/ }))
    expect(await screen.findByTestId('chart')).toHaveTextContent('600000.SH · observation')
    expect(screen.getByText('趋势方案')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '观察备注' }))
    await user.selectOptions(screen.getByLabelText('个股观察状态'), 'ended')
    await user.type(screen.getByLabelText('观察备注'), '等待订单验证')
    await user.click(screen.getByRole('button', { name: '保存观察记录' }))
    await screen.findByText('观察记录已保存')
    expect(saved).toEqual({ status: 'ended', note: '等待订单验证' })
    expect(screen.getByRole('link', { name: '导出结果字典' })).toHaveAttribute('href', '/api/v1/observation/runs/run-1/snapshot')
  })

  it('同一批次切换股票时复用已读取的观察统计', async () => {
    const fetcher = mockApi(url => {
      if (url.pathname.endsWith('/entries')) return json({ items: [screeningEntry(), screeningEntry('run-1', '600001.SH')], total: 2 })
      if (url.pathname.endsWith('/run-1/performance')) return json({ ...performance(), items: [performance().items[0], performance('600001.SH').items[0]] })
    })
    const user = userEvent.setup()
    render(<ObservationPage data={null} />)
    const list = await screen.findByRole('region', { name: '观察记录列表' })
    await user.click(await within(list).findByRole('button', { name: /浦发银行/ }))
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600000.SH'))
    await user.click(within(list).getByRole('button', { name: /招商银行/ }))
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
    const view = render(<ObservationPage data={null} initialRunId="run-2" initialTab="batches" />)
    expect(await screen.findByTestId('chart')).toHaveTextContent('600001.SH')
    view.rerender(<ObservationPage data={null} initialRunId="run-1" initialTab="batches" />)
    await waitFor(() => expect(requested).toBe(true))
    const list = screen.getByRole('region', { name: '观察记录列表' })
    await user.selectOptions(screen.getByLabelText('按所属筛选'), 'run:run-2')
    await user.click(await within(list).findByRole('button', { name: /招商银行/ }))
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600001.SH'))
    resolveOld(json(performance()))
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600001.SH'))
  })
})
