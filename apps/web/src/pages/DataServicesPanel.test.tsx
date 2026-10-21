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
