import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../api'
import CompanyReportsPanel from './CompanyReportsPanel'
import CompanyNewsPanel from './CompanyNewsPanel'
import CompanyMarketPanel from './CompanyMarketPanel'

vi.mock('../../api', () => ({ api: vi.fn() }))
vi.mock('../PdfReader', () => ({ default: ({ url, page, onPageChange }: { url: string; page: number; onPageChange: (page: number) => void }) =>
  <div aria-label="测试 PDF 原件">{url} · 第 {page} 页<button type="button" onClick={() => onPageChange(page + 1)}>翻页</button></div> }))
vi.mock('../MarketIndicatorChart', () => ({ ResponsiveMarketIndicatorChart: ({ chart }: { chart: { bars: { close: number }[] } }) =>
  <div role="img" aria-label="公司 K 线">{chart.bars.map(bar => bar.close).join(',')}</div> }))
beforeEach(() => vi.resetAllMocks())
const code = '600519.SH'
const report = (id: string, stock = code, status = 'confirmed') => ({ id, stock_code: stock, stock_code_status: status, title: '贵州茅台研报 ' + id, filename: id + '.pdf', pages: 4, publication_date: '2026-01-01' })
const news = (id: string, stock = code) => ({ id, title: '资讯 ' + id, stock_codes: [stock], source: '本地来源', body: '正文 ' + id, snippet: '摘录 ' + id, version: 2, published_at: '2026-10-01T08:00:00Z', available_at: '2026-10-01T08:01:00Z' })
const market = (date: string, close: number) => ({ stock_code: code, price_basis: 'unknown', volume_unit: 'unknown', amount_unit: 'unknown',
  items: [{ trade_date: date, open: close, high: close + 1, low: close - 1, close, quality_valid: true }] })

it('filters reports by exact registered company, flags pending binding, and resets the PDF page when switching reports', async () => {
  vi.mocked(api).mockResolvedValue({ items: [report('one'), report('pending', code, 'candidate'), report('other', '000333.SZ')] })
  render(<CompanyReportsPanel stockCode={code} />)
  const list = await screen.findByRole('region', { name: '公司研报列表' })
  expect(within(list).getAllByRole('button')).toHaveLength(2)
  expect(within(list).queryByText('贵州茅台研报 other')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '翻页' }))
  expect(screen.getByLabelText('测试 PDF 原件')).toHaveTextContent('第 2 页')
  await userEvent.click(within(list).getByRole('button', { name: /贵州茅台研报 pending/ }))
  expect(screen.getByLabelText('测试 PDF 原件')).toHaveTextContent('/documents/pending/pdf · 第 1 页')
  expect(screen.getByRole('article', { name: '公司研报原文' })).toHaveTextContent('公司归属待核对')
  expect(api).toHaveBeenCalledTimes(1)
  expect(api).toHaveBeenCalledWith('/documents', expect.objectContaining({ signal: expect.any(AbortSignal) }))
})

it('keeps report fetch failures distinct from an empty company catalog and supports retry', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('目录读取失败')).mockResolvedValue({ items: [report('other', '000333.SZ')] })
  render(<CompanyReportsPanel stockCode={code} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('目录读取失败')
  expect(screen.queryByText('暂无已登记归属这家公司的本地研报。')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '重试公司研报' }))
  await screen.findByText('暂无已登记归属这家公司的本地研报。')
  expect(screen.queryByLabelText('测试 PDF 原件')).not.toBeInTheDocument()
})

it('retains the exact company filter during news keyword searches and pagination and reads the selected version', async () => {
  vi.mocked(api).mockImplementation(async path => {
    const url = new URL('http://local' + path)
    if (url.pathname === '/news') return { items: [news(url.searchParams.get('offset') === '20' ? 'next' : 'first')], total: 21, next_offset: url.searchParams.get('offset') === '20' ? null : 20 } as never
    return news(url.pathname.endsWith('/next') ? 'next' : 'first') as never
  })
  render(<CompanyNewsPanel stockCode={code} />)
  await screen.findByText('正文 first')
  await userEvent.type(screen.getByLabelText('查找公司资讯'), '订单')
  await userEvent.click(screen.getByRole('button', { name: '查找资讯' }))
  await screen.findByText('正文 first')
  await userEvent.click(within(screen.getByRole('navigation', { name: '公司资讯分页' })).getByRole('button', { name: '下一页' }))
  await screen.findByText('正文 next')
  const listCalls = vi.mocked(api).mock.calls.filter(([path]) => path.startsWith('/news?')).map(([path]) => new URL('http://local' + path))
  expect(listCalls.every(url => url.searchParams.get('stock_code') === code)).toBe(true)
  expect(listCalls.at(-1)?.searchParams.get('query')).toBe('订单')
  expect(listCalls.at(-1)?.searchParams.get('offset')).toBe('20')
  expect(screen.getByRole('article', { name: '公司资讯正文' })).toHaveTextContent('第 2 版')
  expect(vi.mocked(api).mock.calls.every(([, options]) => !options?.method)).toBe(true)
})

it('does not expose the body of a news record whose company association differs from the selected company', async () => {
  vi.mocked(api).mockImplementation(async path => path.startsWith('/news?') ? { items: [news('first')], total: 1, next_offset: null } as never : { ...news('first', '000333.SZ'), body: '正文 foreign' } as never)
  render(<CompanyNewsPanel stockCode={code} />)
  await screen.findByText(/资讯的公司归属已变化/)
  expect(screen.queryByText('正文 foreign')).not.toBeInTheDocument()
})

it('clears old chart data while changing the historical cutoff and displays the actual data date and unknown units', async () => {
  let resolve!: (value: unknown) => void
  const gate = new Promise(done => { resolve = done })
  vi.mocked(api).mockImplementation(async path => path.includes('as_of=') ? gate as never : market('2026-10-19', 100) as never)
  render(<CompanyMarketPanel stockCode={code} />)
  expect(await screen.findByRole('img', { name: '公司 K 线' })).toHaveTextContent('100')
  expect(screen.getByText(/成交量单位 待核实/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('行情截止日'), { target: { value: '2025-12-31' } })
  expect(screen.queryByRole('img', { name: '公司 K 线' })).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('正在读取公司行情')
  await act(async () => resolve(market('2025-12-30', 42)))
  expect(await screen.findByRole('img', { name: '公司 K 线' })).toHaveTextContent('42')
  expect(screen.getByText(/实际截至 2025-12-30/)).toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.at(-1)?.[0]).toContain('as_of=2025-12-31')
})

it('reports a market API failure rather than rendering an empty chart and keeps retry available', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('行情读取失败')).mockResolvedValue({ ...market('2026-10-19', 100), items: [] })
  render(<CompanyMarketPanel stockCode={code} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('行情读取失败')
  await userEvent.click(screen.getByRole('button', { name: '重试公司行情' }))
  await screen.findByText('该截止日前没有可用的本地日线行情。')
  expect(screen.queryByRole('img', { name: '公司 K 线' })).not.toBeInTheDocument()
})
