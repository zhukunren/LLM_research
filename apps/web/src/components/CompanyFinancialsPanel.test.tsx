import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import CompanyFinancialsPanel from './CompanyFinancialsPanel'

vi.mock('../api', () => ({ api: vi.fn() }))
vi.mock('echarts-for-react', () => ({ default: () => <div data-testid="financial-chart" /> }))
let responseGate: Promise<unknown> | null
let currentStatus: { can_sync: boolean; can_save: boolean; companies: { code: string; name: string }[]; latest: unknown; coverage: unknown[] }

function data(path: string, value: string | null = '12340000000') {
  const url = new URL('http://local' + path)
  const metric = url.searchParams.get('metrics') || 'revenue'
  const cutoff = url.searchParams.get('as_of') || '2026-10-20'
  const state = value === null ? 'historical_evidence_missing' : 'ok'
  return {
    calculation_id: 'a'.repeat(64), formula_version: 'financial-series-v1',
    request: { stock_code: path.match(/companies\/([^/]+)/)?.[1] || '600519.SH', as_of: cutoff, start_year: Number(cutoff.slice(0, 4)) - 5,
      basis: url.searchParams.get('basis') || 'annual', mode: url.searchParams.get('mode') || 'as_of', metrics: [metric] },
    metrics: [{ code: metric, label: '营业收入', unit: '元' }],
    rows: [{ period: '2025-12-31', values: { [metric]: { metric, period: '2025-12-31', value, unit: '元', currency: 'CNY',
      status: state, reason: value === null ? '缺少当时可得的版本证据' : '可用', actual_basis: 'annual',
      input_fact_ids: value === null ? [] : ['fact-1'], source_record_ids: ['source-1'], formula: 'reported' } }, checks: [] }],
    coverage: { periods: 1, cells: 1, statuses: { [state]: 1 } }, notes: ['原始数值尚未核验。'],
  }
}
beforeEach(() => {
  vi.clearAllMocks(); responseGate = null
  currentStatus = { can_sync: false, can_save: true, companies: [{ code: '600519.SH', name: '贵州茅台' }], latest: null, coverage: [] }
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path.includes('/original-evidence') || path.startsWith('/disclosures?')) return { items: [] } as never
    if (path === '/financial-data/metrics') return { items: [{ code: 'revenue', label: '营业收入', unit: '元' }] } as never
    if (path === '/financial-data/series-status') return currentStatus as never
    if (path.startsWith('/companies/')) return (responseGate || data(path)) as never
    if (path.startsWith('/financial-data/calculations?')) return { ...data('/companies/600519.SH'), request: JSON.parse(String(options?.body)), saved: true } as never
    if (path.startsWith('/financial-facts/')) return {
      fact: { value: '12340000000', raw_value: '12340000000', unit: '元', raw_unit: '元', source_field: 'revenue', currency: 'CNY', status: 'reported' },
      record: { family: 'income', report_period: '2025-12-31', report_type: '1', scope: 'consolidated', public_date: '2026-03-31', first_observed_at: '2026-10-20T08:00:00Z' },
      observations: [], pilot_observations: [], note: '原始财报数值尚未核验。',
    } as never
    throw new Error('Unexpected financial API ' + path)
  })
})

it('shows scaled amounts, exposes exact source values and saves the expected calculation', async () => {
  render(<CompanyFinancialsPanel stockCode="600519.SH" asOf="2026-10-20" />)
  await screen.findByText('123.4')
  expect(screen.getByText('营业收入 · 亿元')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '查看计算依据' }))
  await screen.findByText(/源值 12340000000 元/)
  expect(screen.getByText('原始财报数值尚未核验。')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '保存本次计算' }))
  expect(await screen.findByRole('button', { name: '本次计算已保存' })).toBeDisabled()
  const save = vi.mocked(api).mock.calls.find(([path]) => path.startsWith('/financial-data/calculations?'))!
  expect(save[0]).toContain('expected_id=' + 'a'.repeat(64))
  expect(JSON.parse(String(save[1]?.body))).toMatchObject({ stock_code: '600519.SH', mode: 'as_of', metrics: ['revenue'] })
})

it('clears the old figure while changing basis and accepts only the matching response', async () => {
  render(<CompanyFinancialsPanel stockCode="600519.SH" asOf="2026-10-20" />)
  await screen.findByText('123.4')
  let resolve!: (value: unknown) => void
  responseGate = new Promise(done => { resolve = done })
  await userEvent.selectOptions(screen.getByLabelText('财务期间口径'), 'ttm')
  expect(screen.queryByText('123.4')).not.toBeInTheDocument()
  await act(async () => resolve(data('/companies/600519.SH/financials?as_of=2026-10-20&basis=ttm&mode=as_of&metrics=revenue', '20000000000')))
  await screen.findByText('200')
})

it('immediately hides the previous company when the parent switches its company', async () => {
  const view = render(<CompanyFinancialsPanel stockCode="600519.SH" asOf="2026-10-20" />)
  await screen.findByText('123.4')
  let resolve!: (value: unknown) => void
  responseGate = new Promise(done => { resolve = done })
  view.rerender(<CompanyFinancialsPanel stockCode="000333.SZ" asOf="2026-10-20" />)
  expect(screen.queryByText('123.4')).not.toBeInTheDocument()
  await act(async () => resolve(data('/companies/000333.SZ/financials?as_of=2026-10-20&basis=annual&mode=as_of&metrics=revenue', '30000000000')))
  await screen.findByText('300')
})

it('keeps historical evidence gaps empty instead of drawing or saving zero values', async () => {
  vi.mocked(api).mockImplementation(async path => {
    if (path.startsWith('/companies/')) return data(path, null) as never
    if (path === '/financial-data/metrics') return { items: [{ code: 'revenue', label: '营业收入', unit: '元' }] } as never
    return currentStatus as never
  })
  render(<CompanyFinancialsPanel stockCode="600519.SH" asOf="2024-10-20" />)
  await screen.findByText('缺少当时可得的版本证据')
  expect(screen.queryByTestId('financial-chart')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '保存本次计算' })).toBeDisabled()
  expect(screen.getByText('—')).toBeInTheDocument()
})

it('read-only views expose neither acquisition nor save actions', async () => {
  currentStatus.can_sync = true
  render(<CompanyFinancialsPanel stockCode="600519.SH" asOf="2026-10-20" writable={false} allowSync />)
  await screen.findByText('123.4')
  expect(screen.queryByRole('button', { name: '保存本次计算' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '更新十家公司财务' })).not.toBeInTheDocument()
})
