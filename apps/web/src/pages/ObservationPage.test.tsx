import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ObservationPage from './ObservationPage'
import type { ObservationItem } from './ObservationPage'
import type { ScreeningTaskRevision } from '../api'

vi.mock('../components/ObservationChart', () => ({ default: ({ code, view }: { code: string; view: string }) => <div data-testid="chart">{code} · {view}</div> }))
const task: ScreeningTaskRevision = {
  task_id: 'source', revision: 1, original_user_messages: ['收盘价高于均线'],
  conditions: [{ condition_id: 'c', library: 'technical', description: '收盘价高于均线', source_quote: '收盘价高于均线', expression: {} }],
  references: [{ reference_id: 'r', condition_id: 'c', parameter_overrides: {} }], logic_tree: { op: 'condition', reference_id: 'r' },
  scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: '2026-09-01', report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: null, ranking: null }, unresolved: [],
}
const counts = { target_total: 1, true_count: 1, false_count: 0, unknown_count: 0 }
const run = (id = 'run-1') => ({ id, name: id === 'run-1' ? '趋势方案' : '新批次', version: 2, as_of: '2026-09-01', signal_date: '2026-09-01', created_at: '2026-09-01T09:00:00Z', status: 'succeeded', counts, conversation_id: 'cid', task, result: { coverage: counts }, job_id: 'job', job: { progress: 1, message: '完成' }, reference_prices: { '600000.SH': { trade_date: '2026-09-01', close: 10 } } })
const stat = { count: 1, average: 10, median: 10, positive_rate: 100 }
const performance = (code = '600000.SH') => ({ items: [{ stock_code: code, name: '', status: 'watching', note: '', updated_at: null, reference_close: 10, reference_date: '2026-09-01', calculation_base: 10, latest_close: 11, latest_date: '2026-09-03', days: 2, observed_days: 2, return_latest: 10, returns: { '5': null, '10': null, '20': null }, peak_return: 12, trough_return: -1, reason: '', invalid_bars: 0 }], latest_date: '2026-09-03', warning: '使用同一复权口径', summary: { selected: 1, latest: stat, '5': { count: 0, average: null, median: null, positive_rate: null }, '10': stat, '20': stat } })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function mockApi(intercept?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const custom = intercept?.(url, init)
    if (custom) return custom
    if (url.includes('/observation/research-candidates')) return json({ items: [], total: 0 })
    if (url.includes('/saved-screening-tasks')) return json({ items: [{ id: 'saved', name: '趋势方案', version: 2, task, created_at: '2026-09-01T09:00:00Z' }] })
    if (url.includes('/observation/runs?')) return json({ items: [run(), run('run-2')], total: 2 })
    if (url.includes('/decisions?')) return json({ items: [{ stock_code: '600000.SH', state: 'true', reason_code: 'condition_met', evaluation_status: 'completed', condition_decisions: [{ condition_id: 'c', reference_id: 'r', explanation: '收盘价符合条件', state: 'true', actual_values: {}, thresholds: {}, units: {} }] }], total: 1 })
    if (url.endsWith('/performance')) return json(performance(url.includes('run-2') ? '600001.SH' : '600000.SH'))
    if (url.endsWith('/run-1')) return json(run())
    if (url.endsWith('/run-2')) return json(run('run-2'))
    return json({ message: `未处理 ${url}` }, 404)
  })
  vi.stubGlobal('fetch', fetcher)
  let id = 0
  vi.stubGlobal('crypto', { randomUUID: () => `request-${++id}` })
  return fetcher
}
const data = { available: true, last_date: '2026-09-03' }

describe('观察池来源分类与跟踪', () => {
  it('restores the bookmarked batch before old session selection and reports only actual read objects', async () => {
    sessionStorage.setItem('observation.run', '"run-1"')
    const fetcher = mockApi(), location = vi.fn()
    const view = render(<ObservationPage data={data} initialRunId="run-2" initialTab="batches" onLocationChange={location} />)
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600001.SH'))
    expect(screen.getByLabelText('选择选股批次')).toHaveValue('run-2')
    expect(location).toHaveBeenCalledWith('batches', 'run-2', false)
    view.rerender(<ObservationPage data={data} initialRunId="run-1" initialTab="batches" onLocationChange={location} />)
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600000.SH'))
    expect(location).toHaveBeenLastCalledWith('batches', 'run-1', false)
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it('默认研究跟踪，通过条件选股导航开始新筛选', async () => {
    const fetcher = mockApi()
    const navigate = vi.fn()
    const user = userEvent.setup()
    render(<ObservationPage data={data} onNavigateScreening={navigate} />)
    await screen.findByText('还没有研究候选')
    expect(screen.getByRole('tab', { name: '研究候选' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: '执行选股' })).not.toBeInTheDocument()
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    await user.click(screen.getByRole('button', { name: '去条件选股' }))
    expect(navigate).toHaveBeenCalledOnce()
  })

  it('列表与K线联动，观察页显示后续走势，结束观察与备注显式保存', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let note: unknown
    mockApi((url, init) => {
      if (url.includes('/notes/')) { note = JSON.parse(String(init?.body)); return json({ ...note as object, updated_at: '2026-09-03T10:00:00Z' }) }
    })
    const user = userEvent.setup()
    render(<ObservationPage data={data} />)
    await user.click(screen.getByRole('tab', { name: '筛选批次' }))
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600000.SH · observation'))
    await user.selectOptions(screen.getByLabelText('统计周期'), '5')
    expect(screen.getAllByText('未满期').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: '观察备注' }))
    await user.selectOptions(screen.getByLabelText('个股观察状态'), 'ended')
    await user.type(screen.getByLabelText('观察备注'), '等待订单验证')
    await user.click(screen.getByRole('button', { name: '走势与依据' }))
    await user.click(screen.getByRole('button', { name: '观察备注' }))
    expect(screen.getByLabelText('观察备注')).toHaveValue('等待订单验证')
    expect(note).toBeUndefined()
    await user.click(screen.getByRole('button', { name: '保存观察记录' }))
    await screen.findByText('观察记录已保存')
    expect(note).toEqual({ status: 'ended', note: '等待订单验证' })
    expect(screen.getByRole('link', { name: '导出结果字典' })).toHaveAttribute('href', '/api/v1/observation/runs/run-1/snapshot')
    expect(errors).not.toHaveBeenCalled()
  })

  it('切换批次后迟到的旧统计不能覆盖新批次股票', async () => {
    let resolveOld!: (value: Response) => void
    let requested = false
    mockApi(url => {
      if (url.endsWith('/run-1/performance')) { requested = true; return new Promise<Response>(resolve => { resolveOld = resolve }) }
    })
    const user = userEvent.setup()
    render(<ObservationPage data={data} />)
    await user.click(screen.getByRole('tab', { name: '筛选批次' }))
    await waitFor(() => expect(requested).toBe(true))
    await user.selectOptions(screen.getByLabelText('选择选股批次'), 'run-2')
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600001.SH'))
    resolveOld(json(performance('600000.SH')))
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600001.SH'))
    expect(screen.queryByRole('button', { name: '600000.SH' })).not.toBeInTheDocument()
  })

  it('涨跌幅升序将缺失值放在最后，搜索无结果可一键恢复完整列表', async () => {
    mockApi(url => {
      if (url.endsWith('/performance')) {
        const value = performance()
        const items: ObservationItem[] = [
          { ...value.items[0], stock_code: '600000.SH', return_latest: 12 },
          { ...value.items[0], stock_code: '600001.SH', return_latest: -4 },
          { ...value.items[0], stock_code: '600002.SH', return_latest: null },
        ]
        return json({ ...value, items, summary: { ...value.summary, selected: 3 } })
      }
    })
    const user = userEvent.setup()
    render(<ObservationPage data={data} />)
    await user.click(screen.getByRole('tab', { name: '筛选批次' }))
    await screen.findByRole('cell', { name: '-4.00%' })
    await user.selectOptions(screen.getByLabelText('观察排序'), 'return-asc')
    const list = screen.getByRole('region', { name: '股票结果列表' })
    const rows = within(list).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('600001.SH')
    expect(rows[2]).toHaveTextContent('600000.SH')
    expect(rows[3]).toHaveTextContent('600002.SH')
    await user.type(screen.getByLabelText('搜索结果股票'), '不存在的股票')
    expect(screen.getByText('没有匹配的股票')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '显示全部股票' }))
    expect(screen.getByLabelText('搜索结果股票')).toHaveValue('')
    expect(within(list).getAllByRole('row')).toHaveLength(4)
  })
})

it('uses neutral styling for unchanged prices and missing horizon returns', async () => {
  mockApi(url => {
    if (url.endsWith('/performance')) {
      const value = performance()
      value.items[0].return_latest = 0
      return json(value)
    }
  })
  const user = userEvent.setup()
  render(<ObservationPage data={data} />)
  await user.click(screen.getByRole('tab', { name: '筛选批次' }))
  const unchanged = await screen.findByRole('cell', { name: '0.00%' })
  expect(unchanged).toHaveClass('observation-neutral')
  await user.selectOptions(screen.getByLabelText('统计周期'), '5')
  expect(screen.getByRole('cell', { name: /未满期/ })).toHaveClass('observation-neutral')
})
