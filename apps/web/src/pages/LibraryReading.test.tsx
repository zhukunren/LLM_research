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
it('keeps the report page across catalog and reader switches', async () => {
  mocked.mockImplementation(async path => path === '/documents' ? { items: [{ id: 'one', title: '第一份报告', filename: '1.pdf', pages: 5, metadata_status: 'ready' }] } : { queued: 0 })
  const user = userEvent.setup()
  render(<ReportPage />)
  await screen.findByRole('img', { name: 'PDF 1' })
  const workspace = screen.getByRole('navigation', { name: '研报列表与阅读切换' }).closest('.library-reading-workspace')!
  await user.click(screen.getByRole('button', { name: /第一份报告/ }))
  expect(workspace).toHaveAttribute('data-mobile-view', 'reader')
  fireEvent.change(screen.getByLabelText('研报页码'), { target: { value: '4' } })
  await user.click(screen.getByRole('navigation', { name: '研报列表与阅读切换' }).querySelector<HTMLButtonElement>('button')!)
  expect(workspace).toHaveAttribute('data-mobile-view', 'catalog')
  await user.click(screen.getByRole('button', { name: '阅读研报' }))
  expect(screen.getByRole('img', { name: 'PDF 4' })).toBeInTheDocument()
  expect(screen.getByLabelText('研报页码')).toHaveValue(4)
})

it('keeps drawing and uploads in description, and defaults saved patterns to real candles', async () => {
  const pattern = { id: 'pattern', version: 1, name: '目标走势', representation: 'price_path', input_type: 'drawing', points: Array.from({ length: 10 }, (_, i) => i), params: {}, target_bars: 10 }
  mocked.mockImplementation(async path => path === '/patterns' ? { items: [pattern] } : { bars: [{ trade_date: '2026-09-14', open: 10, close: 11, high: 12, low: 9 }], stock_code: '600000.SH', similarity: 95, start_date: '2026-09-01', end_date: '2026-09-14', scope: '本地行情' })
  const user = userEvent.setup()
  render(<PatternPage />)
  expect(await screen.findByRole('img', { name: 'K线主图叠加指标走势' })).toBeInTheDocument()
  expect(screen.queryByText('上传截图')).not.toBeInTheDocument()
  await user.click(screen.getByRole('tab', { name: '我的形态' }))
  expect(await screen.findByRole('img', { name: 'K线主图叠加指标走势' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '原始曲线' }))
  expect(screen.getByRole('img', { name: '目标走势原始曲线' })).toBeInTheDocument()
  await user.click(screen.getByRole('tab', { name: '描述需求' }))
  expect(screen.getByLabelText('形态需求描述')).toBeInTheDocument()
  expect(screen.getByText('上传截图')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '手绘输入' })).toBeInTheDocument()
  expect(screen.queryByText('行情对照')).not.toBeInTheDocument()
})

it('restores a generated pattern editor after navigating away without saving the template', async () => {
  const user = userEvent.setup()
  mocked.mockImplementation(async path => path === '/patterns' ? { items: [] } : { id: 'draft', prompt: '双底形态', status: 'ready', name: '双底草稿', points: Array.from({ length: 20 }, (_, index) => index / 19), target_bars: 20, min_similarity: 85, assumptions: [], issues: [], description: '测试草稿' })
  const view = render(<PatternPage />)
  await user.click(screen.getByRole('tab', { name: '描述需求' }))
  await user.type(screen.getByLabelText('形态需求描述'), '双底形态')
  await user.click(screen.getByRole('button', { name: '生成形态草稿' }))
  await screen.findByDisplayValue('双底草稿')
  await user.clear(screen.getByLabelText('模板名称'))
  await user.type(screen.getByLabelText('模板名称'), '尚未保存的形态编辑')
  view.unmount()
  render(<PatternPage />)
  expect(screen.getByLabelText('模板名称')).toHaveValue('尚未保存的形态编辑')
  expect(screen.getByRole('tab', { name: '描述需求' })).toHaveAttribute('aria-selected', 'true')
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

it('filters patterns without mixing a saved current window with an editor draft', async () => {
  const user = userEvent.setup()
  sessionStorage.setItem('pattern.editor', JSON.stringify({ activeId: '', version: 0, name: '未保存', mode: 'price_path', source: 'drawing', panel: 'browse', draft: null, sourceDraftId: '', minSimilarity: 80, matchMode: 'recent', recentBars: 20, dirty: true, targetBars: 40, rawPoints: [], candles: [], selectedCandle: 0, imageData: '', savedImageUrl: '', imageMime: 'image/png', imageName: '', crop: { x: 0, y: 0, width: 100, height: 100 }, quality: null }))
  const base = { version: 1, input_type: 'drawing', points: Array.from({ length: 10 }, (_, i) => i), params: { match_mode: 'current' }, target_bars: 10 }
  mocked.mockImplementation(async path => path === '/patterns' ? { items: [{ ...base, id: 'one', name: '双底走势', representation: 'price_path' }, { ...base, id: 'two', name: '锤头蜡烛', representation: 'ohlc_sequence' }] } : { bars: [], reason: '暂无匹配' })
  render(<PatternPage />)
  await screen.findByRole('button', { name: /双底走势/ })
  await user.type(screen.getByRole('searchbox', { name: '搜索形态' }), '双底')
  expect(screen.queryByRole('button', { name: /锤头蜡烛/ })).not.toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('形态类型筛选'), 'ohlc_sequence')
  expect(screen.getByRole('heading', { name: '没有找到匹配的形态' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '查看全部形态' }))
  await user.click(screen.getByRole('button', { name: '加入组合' }))
  expect(JSON.parse(localStorage.getItem('workbench.tree')!).children[0]).toMatchObject({ pattern_id: 'one', match_mode: 'current' })
})
