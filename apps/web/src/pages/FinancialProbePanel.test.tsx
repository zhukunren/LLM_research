import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import FinancialProbePanel, { type FinancialStatus } from './FinancialProbePanel'

vi.mock('../api', () => ({ api: vi.fn() }))
let state: FinancialStatus
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  state = {
    configured: true, can_probe: true, contract_version: 'v1', companies: [{ code: '600519.SH', name: '贵州茅台', category: '一般工商业' }],
    capabilities: [{ endpoint: 'income', label: '利润表', status: 'available', checked_at: null }, { endpoint: 'anns_d', label: '公告索引', status: 'denied', checked_at: null }],
    latest: { id: 'run', job_id: 'job', state: 'succeeded', message: '接口检查完成', credential_matches: true,
      input: { parameters: { as_of: '2026-10-20', period: '2025-12-31' } }, note: '样本不代表完整覆盖。',
      summary: { planned: 74, checked: 74, attempted: 11, companies_with_rows: 0, source_versions: 0 },
      checks: [{ key: 'a', endpoint: 'anns_d', stock_code: '600519.SH', status: 'denied', message: '公告数据未开通', attempted: true }] },
  }
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/financial-data/status') return structuredClone(state) as never
    if (path === '/maintenance/financial-probe') {
      state.latest!.state = 'queued'; state.latest!.message = '等待检查'
      return { run_id: 'run' } as never
    }
    if (path === '/jobs/job/cancel') { state.latest!.state = 'cancelled'; return {} as never }
    throw new Error(path)
  })
})
afterEach(() => vi.useRealTimers())

it('distinguishes processed checks from real requests and exposes denied scope', async () => {
  await act(async () => { render(<FinancialProbePanel />) })
  expect(screen.getByText(/实际请求 11 次/)).toHaveTextContent('0/10 家取得样本')
  fireEvent.click(screen.getByText('各接口权限与检查时间'))
  expect(screen.getByText('权限受限')).toBeVisible()
  fireEvent.click(screen.getByText('试点公司与每项结果'))
  expect(screen.getByText('公告数据未开通')).toBeVisible()
})

it('starts one background check, polls, and can stop it', async () => {
  await act(async () => { render(<FinancialProbePanel />) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '检查接口与十家公司样本' })) })
  expect(screen.getByRole('button', { name: '正在检查财务接口…' })).toBeDisabled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/maintenance/financial-probe')).toHaveLength(1)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止财务检查' })) })
  expect(screen.getByRole('button', { name: '检查接口与十家公司样本' })).toBeEnabled()
})

it('marks old-credential evidence and prevents a read-only user from probing', async () => {
  state.can_probe = false; state.latest!.credential_matches = false
  state.capabilities.forEach(item => { item.status = 'unknown' })
  await act(async () => { render(<FinancialProbePanel />) })
  expect(screen.queryByRole('button', { name: '检查接口与十家公司样本' })).not.toBeInTheDocument()
  expect(screen.getByText(/凭据已变化/)).toBeInTheDocument()
  expect(screen.getByText('请由平台维护者运行接口检查。')).toBeInTheDocument()
})
