import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import FinancialSyncStatusRow from './FinancialSyncStatusRow'

vi.mock('../api', () => ({ api: vi.fn() }))
const initial = { id: 'sync1', job_id: 'job1', state: 'partial', message: '部分分片尚未完成', credential_matches: true, summary: { planned: 20, finished: 12, source_versions: 30 } }
let status = { can_sync: true, latest: { ...initial }, coverage: [{ stock_code: '600519.SH', periods: 5, source_versions: 8, facts: 90 }] }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T01:00:00Z')); vi.clearAllMocks()
  status = { can_sync: true, latest: { ...initial }, coverage: [{ stock_code: '600519.SH', periods: 5, source_versions: 8, facts: 90 }] }
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/financial-data/series-status') return structuredClone(status) as never
    if (path === '/maintenance/financial-sync' || path.endsWith('/retry')) { status.latest.state = 'queued'; status.latest.message = '等待采集'; return {} as never }
    if (path === '/jobs/job1/cancel') { status.latest.state = 'cancelled'; return {} as never }
    throw new Error(`${path} ${init?.method}`)
  })
})
afterEach(() => vi.useRealTimers())

it('keeps malformed status responses behind an error and recovers through an explicit retry', async () => {
  vi.mocked(api).mockResolvedValue({ items: [] } as never)
  await act(async () => { render(<FinancialSyncStatusRow />) })
  expect(screen.getByRole('alert')).toHaveTextContent('无法识别财务采集状态')
  expect(screen.queryByRole('button', { name: '更新十家公司财务' })).not.toBeInTheDocument()
  vi.mocked(api).mockResolvedValue(status as never)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试读取采集状态' })) })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '更新十家公司财务' })).toBeEnabled()
})

it('retains scoped retries, polling and cancellation without loading metric calculations', async () => {
  await act(async () => { render(<FinancialSyncStatusRow />) })
  expect(screen.getByRole('status')).toHaveTextContent('12/20 个分片')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续未完成分片' })) })
  expect(vi.mocked(api).mock.calls.some(([path, init]) => path === '/maintenance/financial-sync/sync1/retry' && init?.method === 'POST')).toBe(true)
  expect(screen.getByRole('button', { name: '更新十家公司财务' })).toBeDisabled()
  status.latest = { ...status.latest, state: 'running', summary: { ...initial.summary, finished: 14 } }
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByRole('status')).toHaveTextContent('14/20 个分片')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止财务采集' })) })
  expect(screen.getByRole('button', { name: '更新十家公司财务' })).toBeEnabled()
  expect(vi.mocked(api).mock.calls.some(([path]) => path === '/jobs/job1/cancel')).toBe(true)
  expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('/financials') || path.endsWith('/metrics'))).toBe(false)
})

it('starts a new acquisition with a Shanghai date and preserves maintenance permissions and credential warnings', async () => {
  const view = await act(async () => render(<FinancialSyncStatusRow />))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新十家公司财务' })) })
  const request = vi.mocked(api).mock.calls.find(([path]) => path === '/maintenance/financial-sync')
  expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ as_of: '2026-10-20', request_id: expect.any(String) })
  status.can_sync = false; status.latest.credential_matches = false
  await act(async () => { view.rerender(<FinancialSyncStatusRow refreshKey={1} />) })
  expect(screen.queryByRole('button', { name: '更新十家公司财务' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '停止财务采集' })).not.toBeInTheDocument()
  expect(screen.getByText('凭据已变化，历史采集不证明当前权限。')).toBeInTheDocument()
})
