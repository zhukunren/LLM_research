import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import ObservationPage from './ObservationPage'
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

describe('观察池第一版', () => {
  it('加载方案不执行，显式执行使用所选版本与最新日期，失败重试复用请求标识', async () => {
    const requests: Record<string, unknown>[] = []
    const fetcher = mockApi((url, init) => {
      if (url.endsWith('/execute')) {
        requests.push(JSON.parse(String(init?.body)))
        return requests.length === 1 ? json({ message: '响应丢失，请重试' }, 503) : json({ run_id: 'run-1' })
      }
    })
    const user = userEvent.setup()
    render(<ObservationPage data={data} />)
    await waitFor(() => expect(screen.getByRole('button', { name: '执行选股' })).toBeEnabled())
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    await user.click(screen.getByRole('button', { name: '执行选股' }))
    await screen.findByText('响应丢失，请重试')
    await user.click(screen.getByRole('button', { name: '执行选股' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]).toMatchObject({ version: 2, as_of: '2026-09-03' })
    await screen.findByText(/选股已提交/)
    fireEvent.input(screen.getByLabelText('选股行情截止日'), { target: { value: '2026-09-01' } })
    await user.click(screen.getByRole('button', { name: '执行选股' }))
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2]).toMatchObject({ version: 2, as_of: '2026-09-01' })
    expect(requests[2].request_id).not.toEqual(requests[0].request_id)
  })

  it('列表与K线联动，观察页显示后续走势，结束观察与备注显式保存', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let note: unknown
    mockApi((url, init) => {
      if (url.includes('/notes/')) { note = JSON.parse(String(init?.body)); return json({ ...note as object, updated_at: '2026-09-03T10:00:00Z' }) }
    })
    const user = userEvent.setup()
    render(<ObservationPage data={data} />)
    expect(await screen.findByTestId('chart')).toHaveTextContent('600000.SH · selection')
    await user.click(screen.getByRole('button', { name: '查看本批次观察' }))
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600000.SH · observation'))
    await user.selectOptions(screen.getByLabelText('统计周期'), '5')
    expect(screen.getAllByText('未满期').length).toBeGreaterThan(0)
    await user.selectOptions(screen.getByLabelText('个股观察状态'), 'ended')
    await user.type(screen.getByLabelText('观察备注'), '等待订单验证')
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
    await screen.findByTestId('chart')
    await user.click(screen.getByRole('tab', { name: '观察池' }))
    await waitFor(() => expect(requested).toBe(true))
    await user.selectOptions(screen.getByLabelText('选择选股批次'), 'run-2')
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600001.SH'))
    resolveOld(json(performance('600000.SH')))
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveTextContent('600001.SH'))
    expect(screen.queryByRole('button', { name: '600000.SH' })).not.toBeInTheDocument()
  })
})
