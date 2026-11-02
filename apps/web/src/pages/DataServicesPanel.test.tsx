import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import DataServicesPanel from './DataServicesPanel'
import type { UpdateJob } from './DataUpdateProgress'

vi.mock('../api', () => ({ api: vi.fn() }))
const refreshCatalog = vi.fn()
vi.mock('../components/StockSearch', () => ({ useSecurities: () => ({ refresh: refreshCatalog }) }))
let current: UpdateJob | null
let failStatus = false
const onRefresh = vi.fn()
function running(): UpdateJob {
  return { id: 'sync-1', state: 'running', message: '正在读取 2026-10-19 行情', progress: 0.45,
    created_at: '2026-10-20T01:00:00Z', updated_at: '2026-10-20T01:00:20Z',
    result: { names: { status: 'updated', count: 5000 }, market: { status: 'running', completed: 1, total: 2, unit: '交易日', current: '2026-10-19', rows_received: 2000, rows_written: 0 }, news: { status: 'pending' } } }
}
async function open() {
  await act(async () => { render(<DataServicesPanel data={null} onClose={vi.fn()} onRefresh={onRefresh} />) })
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T01:00:20Z'))
  vi.clearAllMocks(); current = running(); failStatus = false
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/settings/status') return { text_model: { configured: false, model: null }, tushare: { configured: true } } as never
    if (path === '/financial-data/status') return { configured: true, can_probe: true, capabilities: [], companies: [], latest: null } as never
    if (path === '/financial-data/series-status') return { can_sync: false, coverage: [], latest: null } as never
    if (path === '/maintenance/status') {
      if (failStatus) throw new Error('连接中断')
      return { job: current } as never
    }
    if (path === '/maintenance/refresh') return { job_id: 'sync-2' } as never
    throw new Error(`Unexpected API ${path}`)
  })
})
afterEach(() => { vi.useRealTimers() })

it('restores the active run and refreshes real counts and elapsed time every second', async () => {
  await open()
  const detail = within(screen.getByLabelText('数据更新详情'))
  expect(detail.getByText('45%')).toBeInTheDocument()
  expect(detail.getByText('已用时 20 秒')).toBeInTheDocument()
  expect(detail.getByText(/已处理 1 \/ 2 个交易日/)).toHaveTextContent('当前 2026-10-19')
  expect(screen.getByRole('button', { name: '正在更新…' })).toBeDisabled()
  current = { ...current!, progress: 0.8, message: '正在保存行情文件' }
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(detail.getByText('80%')).toBeInTheDocument()
  expect(detail.getByText('已用时 21 秒')).toBeInTheDocument()
  expect(detail.getByText('正在保存行情文件')).toBeInTheDocument()
})

it('retains the last progress on connection failure, then recovers and shows partial results', async () => {
  await open(); failStatus = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(screen.getByRole('alert')).toHaveTextContent('更新进度暂时无法刷新')
  expect(screen.getByText('45%')).toBeInTheDocument()
  failStatus = false
  current = { ...running(), state: 'partial', progress: 1, message: '部分资料尚未更新', result: {
    names: { status: 'updated', count: 5000 },
    market: { status: 'partial', rows_written: 1800, rows_received: 2000, deferred_days: ['2020-01-01'], missing_or_failed_days: [{ date: '2026-10-19', reason: '日线含无效记录，整日待重试' }] },
    news: { status: 'partial', import: { created: 12, duplicates: 3 }, coverage_note: '未返回完整的请求时间窗', failed_sources: [{ source: 'sina', reason: '暂无权限' }] },
    events: [{ at: '2026-10-20T01:00:20Z', stage: 'news', message: 'sina 资讯读取失败' }],
  } }
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText('100%')).toBeInTheDocument()
  expect(screen.getByText('新增 12 条资讯 · 重复 3 条')).toBeInTheDocument()
  fireEvent.click(screen.getByText('1 个资讯来源更新失败'))
  expect(screen.getByText('sina：暂无权限')).toBeVisible()
  fireEvent.click(screen.getByText('1 个交易日需重试'))
  expect(screen.getByText('2026-10-19：日线含无效记录，整日待重试')).toBeVisible()
  expect(onRefresh).toHaveBeenCalledTimes(1)
  expect(refreshCatalog).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(onRefresh).toHaveBeenCalledTimes(1)
})

it('replaces old results immediately when starting another update and prevents repeat submission', async () => {
  current = { ...running(), state: 'succeeded', progress: 1, message: '之前的更新已完成' }
  await open()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新股票名称、行情和资讯' })) })
  expect(screen.queryByText('之前的更新已完成')).not.toBeInTheDocument()
  expect(screen.getByText('0%')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '正在更新…' })).toBeDisabled()
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/maintenance/refresh')).toHaveLength(1)
})

it('shows compact service rows, keeps calculation requests out of maintenance, and opens company research after closing', async () => {
  current = null
  const close = vi.fn(), research = vi.fn()
  await act(async () => { render(<DataServicesPanel data={null} onClose={close} onRefresh={onRefresh} onOpenCompanyResearch={research} />) })
  for (const name of ['行情与资讯', '财务与披露接口', '财务数据采集', '智能助手连接', '原生网页搜索']) expect(screen.getByRole('region', { name })).toBeInTheDocument()
  expect(screen.queryByLabelText('财务指标')).not.toBeInTheDocument()
  expect(screen.queryByText('标准财务与指标计算')).not.toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('/financials') || path === '/financial-data/metrics')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '前往公司研究' }))
  expect(close).toHaveBeenCalledOnce()
  expect(research).toHaveBeenCalledOnce()
  expect(close.mock.invocationCallOrder[0]).toBeLessThan(research.mock.invocationCallOrder[0])
})

it('distinguishes configured search from a verified test, and refreshes all service statuses without starting work', async () => {
  current = null
  const configured = { text_model: { configured: true, model: '研究模型' }, tushare: { configured: true }, codex_runtime: { available: true, web_search: { enabled: true, mode: 'live', state: 'enabled' } } }
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === '/settings/status') return configured as never
    if (path === '/settings/model-test') return { connected: true } as never
    if (path === '/settings/web-search-test') return { message: '已验证搜索与访问', search_results: 2, latency_ms: 130, connected: true, verified: true, opened_page: true } as never
    return original(path, init)
  })
  await open()
  expect(screen.getByText('实时搜索已配置')).toBeInTheDocument()
  expect(screen.getByText('配置状态不代表实时搜索已成功。')).toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '检查助手连接' })) })
  expect(screen.getByText(/本次检查未发起实时检索/)).toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '测试原生网页搜索' })) })
  expect(screen.getByText('已验证搜索与访问 · 2 条搜索结果 · 130 ms')).toBeInTheDocument()
  const before = vi.mocked(api).mock.calls.filter(([path]) => path === '/financial-data/status').length
  const settingsBefore = vi.mocked(api).mock.calls.filter(([path]) => path === '/settings/status').length
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新检查状态' })) })
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/financial-data/status')).toHaveLength(before + 1)
  expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/settings/status')).toHaveLength(settingsBefore + 1)
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'POST').map(([path]) => path)).toEqual(['/settings/model-test', '/settings/web-search-test'])
})
