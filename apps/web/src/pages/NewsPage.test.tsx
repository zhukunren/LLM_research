import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import NewsPage from './NewsPage'

vi.mock('../api', () => ({ api: vi.fn() }))
const mocked = vi.mocked(api)
const record = { id: 'news-1', root_id: 'news-1', version: 1, title: '新增订单', body: '公司已经取得新增订单。', source: '公司公告', stock_codes: ['600000.SH'], published_at: '2026-09-14T01:05:00+00:00', available_at: '2026-09-14T01:05:00+00:00', event_key: null }
beforeEach(() => {
  vi.clearAllMocks()
  mocked.mockImplementation(async path => path.startsWith('/securities/') ? { items: [] } : path === '/news/news-1' ? record : path === '/news/import-url' ? { created: 1, duplicates: 0 } : { items: [record], total: 1, next_offset: null })
})
it('switches news views while keeping the article and reading size', async () => {
  const user = userEvent.setup()
  render(<NewsPage />)
  await screen.findByText(record.body)
  const workspace = screen.getByRole('navigation', { name: '资讯列表与阅读切换' }).closest('.library-reading-workspace')!
  await user.click(screen.getByRole('button', { name: /新增订单/ }))
  expect(workspace).toHaveAttribute('data-mobile-view', 'reader')
  await user.click(screen.getByRole('button', { name: '放大资讯字体' }))
  const reads = mocked.mock.calls.filter(([path]) => path === '/news/news-1').length
  await user.click(screen.getByRole('button', { name: '资讯列表' }))
  expect(workspace).toHaveAttribute('data-mobile-view', 'catalog')
  await user.click(screen.getByRole('button', { name: '阅读资讯' }))
  expect(screen.getByLabelText('当前资讯字号')).toHaveTextContent('15')
  expect(screen.getByText(record.body)).toBeInTheDocument()
  expect(mocked.mock.calls.filter(([path]) => path === '/news/news-1')).toHaveLength(reads)
})
it('opens the first article for reading and changes its font size without showing import fields', async () => {
  const user = userEvent.setup()
  render(<NewsPage />)
  const body = await screen.findByText(record.body)
  expect(body.closest('article')).toHaveStyle({ fontSize: '14px' })
  expect(screen.getByLabelText('当前资讯字号')).toHaveTextContent('14')
  expect(screen.queryByLabelText('资讯网址')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '放大资讯字体' }))
  expect(body.closest('article')).toHaveStyle({ fontSize: '15px' })
  expect(screen.getByLabelText('当前资讯字号')).toHaveTextContent('15')
  await user.click(screen.getByRole('button', { name: '缩小资讯字体' }))
  expect(body.closest('article')).toHaveStyle({ fontSize: '14px' })
})
it('imports a URL with a stable retry request ID', async () => {
  const user = userEvent.setup(), close = vi.fn()
  render(<NewsPage importOpen onImportClose={close} />)
  await user.type(screen.getByLabelText('资讯网址'), 'https://example.com/news')
  await user.click(screen.getByRole('button', { name: '导入' }))
  await waitFor(() => expect(close).toHaveBeenCalled())
  const request = mocked.mock.calls.find(([path]) => path === '/news/import-url')!
  expect(JSON.parse(request[1]!.body as string)).toEqual({ url: 'https://example.com/news', request_id: expect.any(String) })
})
it('passes the date range to the backend before selecting an article', async () => {
  render(<NewsPage />)
  await screen.findByText(record.body)
  fireEvent.change(screen.getByLabelText('资讯开始日期'), { target: { value: '2026-09-01' } })
  fireEvent.change(screen.getByLabelText('资讯结束日期'), { target: { value: '2026-09-14' } })
  await waitFor(() => expect(mocked.mock.calls.some(([path]) => path.includes('start_date=2026-09-01') && path.includes('end_date=2026-09-14'))).toBe(true))
})

it('shows a retryable loading failure without reporting an empty library', async () => {
  let attempts = 0
  mocked.mockImplementation(async path => {
    if (path.startsWith('/news?') && attempts++ === 0) throw new Error('连接中断')
    return path.startsWith('/securities/') ? { items: [] } : path === '/news/news-1' ? record : { items: [record], total: 1, next_offset: null }
  })
  const user = userEvent.setup()
  render(<NewsPage />)
  expect(screen.getByRole('status')).toHaveTextContent('正在加载资讯')
  expect(await screen.findByRole('alert')).toHaveTextContent('连接中断')
  expect(screen.queryByText('暂无资讯，可从右上角导入。')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重新加载资讯' }))
  expect(await screen.findByText(record.body)).toBeInTheDocument()
})

it('keeps the latest selected article when an older request finishes late and restores it on remount', async () => {
  let first: (value: unknown) => void = () => {}
  const second = { ...record, id: 'news-2', title: '第二篇', body: '最新选择的正文' }
  mocked.mockImplementation(async path => path.startsWith('/securities/') ? { items: [] } : path.startsWith('/news?') ? { items: [record, second], total: 2, next_offset: null } : path === '/news/news-2' ? second : new Promise(resolve => { first = resolve }))
  const user = userEvent.setup()
  const view = render(<NewsPage />)
  await waitFor(() => expect(mocked.mock.calls.some(([path]) => path === '/news/news-1')).toBe(true))
  await user.click(screen.getByRole('button', { name: /第二篇/ }))
  expect(await screen.findByText(second.body)).toBeInTheDocument()
  await act(async () => first(record))
  expect(screen.queryByText(record.body)).not.toBeInTheDocument()
  view.unmount()
  render(<NewsPage />)
  expect(await screen.findByText(second.body)).toBeInTheDocument()
})

it('places the linked company chart below the article and uses the China publication date', async () => {
  const user = userEvent.setup()
  const dated = { ...record, published_at: '2026-09-13T17:05:00+00:00' }
  mocked.mockImplementation(async path => path.startsWith('/securities/') ? { items: [{ trade_date: '2026-09-14', open: 10, high: 12, low: 9, close: 11 }] } : path === '/news/news-1' ? dated : { items: [dated], total: 1, next_offset: null })
  render(<NewsPage />)
  const chart = await screen.findByRole('img', { name: 'K线主图叠加指标走势' })
  const article = screen.getByText(record.body).closest('article')!
  expect(article.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(mocked.mock.calls.some(([path]) => path === '/securities/600000.SH/bars?limit=120')).toBe(true)
  await user.click(screen.getByRole('button', { name: '资讯当日' }))
  await waitFor(() => expect(mocked.mock.calls.some(([path]) => path === '/securities/600000.SH/bars?limit=120&as_of=2026-09-14')).toBe(true))
  expect(await screen.findByText(/仅显示资讯当日及之前行情/)).toBeInTheDocument()
})

it('automatically displays every company in the article without company selection', async () => {
  const user = userEvent.setup()
  const linked = { ...record, stock_codes: [], chart_companies: [{ stock_code: '600000.SH', name: '浦发银行' }, { stock_code: '000002.SZ', name: '万科A' }] }
  mocked.mockImplementation(async path => path.startsWith('/securities/') ? { items: [{ trade_date: '2026-09-15', open: 20, high: 22, low: 19, close: 21 }] } : path === '/news/news-1' ? linked : { items: [linked], total: 1, next_offset: null })
  render(<NewsPage />)
  await waitFor(() => expect(screen.getAllByRole('img', { name: 'K线主图叠加指标走势' })).toHaveLength(2))
  expect(screen.getByRole('region', { name: '浦发银行K线' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: '万科AK线' })).toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '资讯当日' }))
  await waitFor(() => expect(mocked.mock.calls.filter(([path]) => path.startsWith('/securities/') && path.includes('as_of=2026-09-14'))).toHaveLength(2))
})

it('keeps the article readable when company data fails and retries the chart', async () => {
  const user = userEvent.setup()
  let attempts = 0
  mocked.mockImplementation(async path => {
    if (path.startsWith('/securities/')) { if (attempts++ === 0) throw new Error('公司行情读取失败'); return { items: [] } }
    return path === '/news/news-1' ? record : { items: [record], total: 1, next_offset: null }
  })
  render(<NewsPage />)
  expect(await screen.findByRole('alert')).toHaveTextContent('公司行情读取失败')
  expect(screen.getByText(record.body)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重试公司行情' }))
  expect(await screen.findByText('该公司暂无可用行情。')).toBeInTheDocument()
})

it('shows a clear empty state for news with no recognized company and no selection control', async () => {
  const unlinked = { ...record, stock_codes: [], chart_companies: [] }
  mocked.mockImplementation(async path => path === '/news/news-1' ? unlinked : { items: [unlinked], total: 1, next_offset: null })
  render(<NewsPage />)
  expect(await screen.findByText('此资讯未识别到可展示 K 线的上市企业。')).toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(mocked.mock.calls.some(([path]) => path.startsWith('/securities/'))).toBe(false)
})

it('does not show an old company chart after changing articles', async () => {
  const user = userEvent.setup()
  let old: (value: unknown) => void = () => {}
  const second = { ...record, id: 'news-2', title: '第二家公司的资讯', body: '第二家公司的正文', stock_codes: [], chart_companies: [{ stock_code: '000002.SZ', name: '万科A' }] }
  mocked.mockImplementation(async path => path.startsWith('/news?') ? { items: [record, second], total: 2, next_offset: null } : path === '/news/news-1' ? record : path === '/news/news-2' ? second : path.startsWith('/securities/600000.SH') ? new Promise(resolve => { old = resolve }) : { items: [{ trade_date: '2026-09-15', open: 20, high: 22, low: 19, close: 21 }] })
  render(<NewsPage />)
  await waitFor(() => expect(mocked.mock.calls.some(([path]) => path.startsWith('/securities/600000.SH'))).toBe(true))
  await user.click(screen.getByRole('button', { name: /第二家公司的资讯/ }))
  const next = await screen.findByRole('region', { name: '万科AK线' })
  await within(next).findByRole('img', { name: 'K线主图叠加指标走势' })
  await act(async () => old({ items: [{ trade_date: '2026-09-01', open: 10, high: 12, low: 9, close: 11 }] }))
  expect(screen.queryByText(/日线 · 2026-09-01/)).not.toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '600000.SHK线' })).not.toBeInTheDocument()
})

it('shows the displayed last close and its change from the preceding trading day', async () => {
  mocked.mockImplementation(async path => path.startsWith('/securities/') ? { items: [
    { trade_date: '2026-09-13', open: 11, high: 13, low: 10, close: 12 },
    { trade_date: '2026-09-14', open: 12, high: 14, low: 11, close: 13 },
  ] } : path === '/news/news-1' ? record : { items: [record], total: 1, next_offset: null })
  render(<NewsPage />)
  const quote = await screen.findByLabelText('行情摘要')
  expect(quote).toHaveTextContent('13.00')
  expect(quote).toHaveTextContent('+8.33%')
  expect(screen.getAllByText('资讯日')).toHaveLength(2)
})

it('does not publish a price or change for an invalid final market bar', async () => {
  mocked.mockImplementation(async path => path.startsWith('/securities/') ? { items: [
    { trade_date: '2026-09-13', open: 11, high: 13, low: 10, close: 12, quality_valid: true },
    { trade_date: '2026-09-14', open: 12, high: 14, low: 11, close: 1000, quality_valid: false },
  ] } : path === '/news/news-1' ? record : { items: [record], total: 1, next_offset: null })
  render(<NewsPage />)
  const quote = await screen.findByLabelText('行情摘要')
  expect(quote).toHaveTextContent('—')
  expect(quote).not.toHaveTextContent('1000')
  expect(quote).not.toHaveTextContent('%')
})

