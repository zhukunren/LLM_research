import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import PatternPage from './PatternPage'
import ReportPage from './ReportPage'
import WorkbenchPage from './WorkbenchPage'
import type { ReactNode } from 'react'

vi.mock('../api', () => ({ api: vi.fn() }))
vi.mock('../components/PdfReader', () => ({ default: ({ url, page, pageControls }: { url: string; page: number; pageControls?: ReactNode }) => <>{pageControls}<div role="img" aria-label={'PDF ' + page} data-url={url} /></> }))
const mocked = vi.mocked(api)
beforeEach(() => vi.clearAllMocks())

it('keeps drawing and uploads in description, and defaults saved patterns to real candles', async () => {
  const pattern = { id: 'pattern', version: 1, name: '目标走势', representation: 'price_path', input_type: 'drawing', points: Array.from({ length: 10 }, (_, i) => i), params: {}, target_bars: 10 }
  mocked.mockImplementation(async path => path === '/patterns' ? { items: [pattern] } : { bars: [{ trade_date: '2026-09-14', open: 10, close: 11, high: 12, low: 9 }], stock_code: '600000.SH', similarity: 95, start_date: '2026-09-01', end_date: '2026-09-14', scope: '本地行情' })
  const user = userEvent.setup()
  render(<PatternPage />)
  expect(await screen.findByRole('img', { name: 'K线主图叠加指标走势' })).toBeInTheDocument()
  expect(screen.queryByText('上传截图')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '我的形态' }))
  expect(await screen.findByRole('img', { name: 'K线主图叠加指标走势' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '原始曲线' }))
  expect(screen.getByRole('img', { name: '目标走势原始曲线' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '描述需求' }))
  expect(screen.getByLabelText('形态需求描述')).toBeInTheDocument()
  expect(screen.getByText('上传截图')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '手绘输入' })).toBeInTheDocument()
  expect(screen.queryByText('行情对照')).not.toBeInTheDocument()
})

it('automatically catalogs reports and opens the PDF source without manual candidate forms', async () => {
  mocked.mockImplementation(async path => path === '/documents' ? { items: [{ id: 'report', title: '公司研究', filename: 'source.pdf', pages: 3, parse_status: 'indexed', metadata_status: 'ready', stock_code: '600000.SH', publication_date: '2026-09-14', metadata: { fields: { analysts: { value: '张三' }, stock_name: { value: '浦发银行' } } } }] } : { queued: 0 })
  const user = userEvent.setup()
  render(<ReportPage />)
  const pdf = await screen.findByRole('img', { name: 'PDF 1' })
  expect(pdf).toHaveAttribute('data-url', '/api/v1/documents/report/pdf')
  expect(screen.getByRole('link', { name: '在浏览器中打开' })).toHaveAttribute('href', '/api/v1/documents/report/pdf#page=1')
  expect(screen.queryByText('确认归属')).not.toBeInTheDocument()
  expect(mocked.mock.calls.some(([path]) => path === '/documents/catalog')).toBe(true)
  const page = screen.getByRole('spinbutton', { name: '研报页码' })
  await user.clear(page); await user.type(page, '2')
  expect(screen.getByRole('img', { name: 'PDF 2' })).toBeInTheDocument()
  expect(mocked.mock.calls.some(([path]) => path.includes('/pages/'))).toBe(false)
})

it('fills a recent description and sends the news date range with the requirement', async () => {
  const match = { candidate_count: 0, matched_count: 0, items: [], start_date: '2026-09-01', end_date: '2026-09-14' }
  const draft = { id: 'draft', prompt: '已签署订单', conditions: [], assumptions: [], issues: [], status: 'matched', tree: null, news_matches: match }
  mocked.mockImplementation(async path => path === '/condition-drafts/draft' || path === '/condition-drafts' ? draft : path.startsWith('/condition-drafts?') ? { items: [{ id: 'draft', prompt: draft.prompt, saved: false }] } : { items: [] })
  const user = userEvent.setup()
  render(<WorkbenchPage scope="news" view="create" data={null} onReports={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: draft.prompt }))
  expect(screen.getByLabelText('选股条件描述')).toHaveValue(draft.prompt)
  expect(screen.getByLabelText('匹配资讯开始日期')).toHaveValue('2026-09-01')
  expect(screen.queryByText('从一个想法开始')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '匹配资讯' }))
  await waitFor(() => expect(mocked.mock.calls.some(([path, init]) => path === '/condition-drafts' && init?.method === 'POST')).toBe(true))
  const call = mocked.mock.calls.find(([path, init]) => path === '/condition-drafts' && init?.method === 'POST')!
  expect(JSON.parse(call[1]!.body as string)).toMatchObject({ prompt: draft.prompt, start_date: '2026-09-01', end_date: '2026-09-14' })
})

it('ignores stale report search results and preserves matches from report metadata', async () => {
  const documents = [
    { id: 'one', title: '第一份报告', filename: '1.pdf', pages: 4, metadata_status: 'ready', metadata: { fields: { analysts: { value: '张三' } } } },
    { id: 'two', title: '第二份报告', filename: '2.pdf', pages: 2, metadata_status: 'ready' },
  ]
  let oldSearch: (value: unknown) => void = () => {}
  mocked.mockImplementation(async (path, init) => {
    if (path === '/documents') return { items: documents }
    if (path === '/documents/search') {
      const query = JSON.parse(init!.body as string).query
      if (query === '旧查询') return new Promise(resolve => { oldSearch = resolve })
      return { items: [] }
    }
    return { queued: 0 }
  })
  render(<ReportPage />)
  await screen.findByRole('img', { name: 'PDF 1' })
  fireEvent.change(screen.getByLabelText('搜索研报'), { target: { value: '旧查询' } })
  await waitFor(() => expect(mocked.mock.calls.some(([path]) => path === '/documents/search')).toBe(true))
  fireEvent.change(screen.getByLabelText('搜索研报'), { target: { value: '张三' } })
  await waitFor(() => expect(screen.queryByText('正在检索正文…')).not.toBeInTheDocument())
  await act(async () => oldSearch({ items: [{ document_id: 'two', page_number: 2, snippet: '过期命中' }] }))
  expect(screen.getByRole('button', { name: /第一份报告/ })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /第二份报告/ })).not.toBeInTheDocument()
})

it('restores the last page of each report after changing reports and remounting', async () => {
  mocked.mockImplementation(async path => path === '/documents' ? { items: [
    { id: 'one', title: '第一份报告', filename: '1.pdf', pages: 5, metadata_status: 'ready' },
    { id: 'two', title: '第二份报告', filename: '2.pdf', pages: 3, metadata_status: 'ready' },
  ] } : { queued: 0 })
  const user = userEvent.setup()
  const view = render(<ReportPage />)
  await screen.findByRole('img', { name: 'PDF 1' })
  fireEvent.change(screen.getByLabelText('研报页码'), { target: { value: '4' } })
  await user.click(screen.getByRole('button', { name: /第二份报告/ }))
  expect(screen.getByRole('img', { name: 'PDF 1' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /第一份报告/ }))
  expect(screen.getByRole('img', { name: 'PDF 4' })).toBeInTheDocument()
  view.unmount()
  render(<ReportPage />)
  expect(await screen.findByRole('img', { name: 'PDF 4' })).toBeInTheDocument()
})
