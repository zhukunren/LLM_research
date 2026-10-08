import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type DataStatus, type ScreeningTaskRevision } from '../../api'
import ScreeningReadiness, { screeningSourceReadiness, type ScreeningCapabilities } from './ScreeningReadiness'

vi.mock('../../api', async importOriginal => ({ ...await importOriginal<typeof import('../../api')>(), api: vi.fn() }))
beforeEach(() => { vi.mocked(api).mockReset() })
const data: DataStatus = { available: true, rows: 100, securities: 2, first_date: '2024-01-01', last_date: '2025-01-02', formal_execution_ready: false, formal_blockers: ['/private/raw-error'] }
const manifest: ScreeningCapabilities = { capabilities: [
  { id: 'market.daily_bars', title: '行情', availability: 'available' },
  { id: 'report.page_search', title: '研报', availability: 'unavailable' },
  { id: 'fundamentals.market_cap', title: '市值', availability: 'unavailable' },
  { id: 'market.minute_bars', title: '分钟', availability: 'unavailable' },
] }
const task = (libraries: string[], asOf = '2025-01-02'): ScreeningTaskRevision => ({
  task_id: 'task', revision: 1, original_user_messages: [],
  conditions: libraries.map(library => ({ condition_id: library, library, description: '保留条件', source_quote: '原始要求', expression: {} })),
  references: [], logic_tree: null, unresolved: [],
  scope: { universe: { kind: 'all_a_shares', stock_codes: [] }, as_of: asOf, report_lookback_calendar_days: null, news_lookback_calendar_days: null, price_basis: null, ranking: null },
})
it('does not claim zero-row or zero-security market data is usable', () => {
  expect(screeningSourceReadiness({ ...data, rows: 0 }, manifest, 'technical').state).toBe('unavailable')
  expect(screeningSourceReadiness({ ...data, securities: 0 }, manifest, 'technical').state).toBe('unavailable')
  expect(screeningSourceReadiness({ available: false }, manifest, 'technical').issues.join('')).toContain('接入日线行情')
})
it('distinguishes missing sources and unknown availability without gating exploratory data', () => {
  expect(screeningSourceReadiness(data, manifest, 'technical').state).toBe('available')
  expect(screeningSourceReadiness(data, manifest, 'report').state).toBe('unavailable')
  expect(screeningSourceReadiness(data, manifest, 'screening', task(['technical', 'report'])).state).toBe('partial')
  expect(screeningSourceReadiness(data, null, 'technical').state).toBe('partial')
  expect(screeningSourceReadiness(data, manifest, 'technical', task(['technical', 'unrecognized'])).state).toBe('partial')
})
it('flags cutoff outside actual coverage and never substitutes a date', () => {
  const newer = task(['technical'], '2025-02-01')
  expect(screeningSourceReadiness(data, manifest, 'technical', newer).issues.join('')).toContain('晚于最新行情')
  expect(newer.scope.as_of).toBe('2025-02-01')
  expect(screeningSourceReadiness(data, manifest, 'report', task(['report'], '2025-02-01')).issues.join('')).not.toContain('晚于最新行情')
  expect(screeningSourceReadiness(data, manifest, 'technical', task(['technical'], '2023-01-01')).issues.join('')).toContain('早于行情起始日')
})
it('shows real defaults and honest unsupported/unknown coverage without raw diagnostics', async () => {
  vi.mocked(api).mockResolvedValue(manifest)
  render(<ScreeningReadiness data={data} scope="technical" />)
  await screen.findByText('数据来源已接入')
  expect(screen.getByText(/全部 A 股（默认范围）/)).toHaveTextContent('2025-01-02（默认最新行情日）')
  await userEvent.setup().click(screen.getByText('查看数据范围与限制'))
  expect(screen.getByText(/暂不支持：历史财务与估值、分钟行情/)).toBeVisible()
  expect(screen.getByText(/不保证每项条件都能完成/)).toBeVisible()
  expect(screen.queryByText(/private\/raw-error/)).not.toBeInTheDocument()
})
it('keeps conditions intact and recovers from a capability read failure', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('/private/provider traceback')).mockResolvedValueOnce(manifest)
  const value = task(['technical'])
  const before = JSON.stringify(value)
  render(<ScreeningReadiness data={data} task={value} />)
  await screen.findByText('数据状态待确认')
  expect(screen.queryByText(/traceback/)).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole('button', { name: '重新检查' }))
  await screen.findByText('数据来源已接入')
  expect(JSON.stringify(value)).toBe(before)
})

it('shows selected scope and date instead of suggesting unselected defaults', async () => {
  vi.mocked(api).mockResolvedValue(manifest)
  render(<ScreeningReadiness data={data} scope="technical" selectedUniverseLabel="我的观察池" asOf="2025-03-01" />)
  await screen.findByText('数据部分可用 / 待确认')
  expect(screen.getByText(/我的观察池/)).toHaveTextContent('截止日：2025-03-01')
  expect(screen.queryByText(/默认范围/)).not.toBeInTheDocument()
})

it('refreshes unavailable source status after an import without remounting', async () => {
  vi.mocked(api).mockResolvedValueOnce(manifest).mockResolvedValueOnce({ capabilities: [{ id: 'report.page_search', title: '研报', availability: 'available' }] })
  render(<ScreeningReadiness data={data} scope="report" />)
  await screen.findByText('所需数据暂不可用')
  await userEvent.setup().click(screen.getByRole('button', { name: '重新检查' }))
  await screen.findByText('数据来源已接入')
  expect(screen.queryByRole('button', { name: '重新检查' })).not.toBeInTheDocument()
})
it('refreshes when meaningful market status changes', async () => {
  vi.mocked(api).mockResolvedValue(manifest)
  const view = render(<ScreeningReadiness data={{ available: false }} scope="technical" />)
  await screen.findByText('所需数据暂不可用')
  const calls = vi.mocked(api).mock.calls.length
  view.rerender(<ScreeningReadiness data={data} scope="technical" />)
  await screen.findByText('数据来源已接入')
  expect(vi.mocked(api).mock.calls.length).toBe(calls + 1)
})

it('collapses a healthy state to one row without duplicating the composer scope and date', async () => {
  vi.mocked(api).mockResolvedValue(manifest)
  render(<ScreeningReadiness data={data} scope="technical" showScope={false} onOpenData={vi.fn()} />)
  await screen.findByText('数据来源已接入')
  expect(screen.queryByText(/全部 A 股/)).not.toBeInTheDocument()
  expect(screen.getByText(/本地行情截至/)).not.toBeVisible()
  expect(screen.getByRole('button', { name: '查看数据范围与限制' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('button', { name: '检查数据与服务' })).not.toBeInTheDocument()
})
