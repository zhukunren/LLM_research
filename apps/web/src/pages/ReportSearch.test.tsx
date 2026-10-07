import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import ReportPage from './ReportPage'

vi.mock('../api', () => ({ api: vi.fn() }))
vi.mock('../components/PdfReader', () => ({ default: ({ page, pageControls }: { page: number; pageControls?: ReactNode }) => <>{pageControls}<div role="img" aria-label={'PDF ' + page} /></> }))
const mocked = vi.mocked(api)
const documents = [
  { id: 'one', title: '第一份报告', filename: 'one.pdf', pages: 5, parse_status: 'indexed', metadata_status: 'ready' },
  { id: 'two', title: '第二份报告', filename: 'two.pdf', pages: 4, parse_status: 'indexed', metadata_status: 'ready' },
  { id: 'three', title: '光模块资料目录', filename: 'three.pdf', pages: 2, parse_status: 'indexed', metadata_status: 'ready' },
]
const hit = (id: string, page: number, snippet: string, terms = ['光模块']) => ({ document_id: id, title: documents.find(item => item.id === id)!.title, page_number: page, snippet, matched_terms: terms, match_type: 'expanded', retrieval_method: 'lexical', relevance_score: 1 })
const result = (items: ReturnType<typeof hit>[], total = items.length, next_offset: number | null = null) => ({ items, query_terms: ['光模块'], expanded_terms: ['光通信'], coverage_note: '相关词匹配需要核对原文，不代表判断已被证实。', total, next_offset })
const searchCalls = () => mocked.mock.calls.filter(([path]) => path === '/documents/search')
const catalog = () => screen.getByRole('complementary', { name: '研报列表' })

beforeEach(() => vi.clearAllMocks())

it('defaults to expanded search, follows relevance order, and opens the matching original page', async () => {
  mocked.mockImplementation(async path => path === '/documents' ? { items: documents } : path === '/documents/search' ? result([hit('two', 3, '光通信需求增长。', ['光通信']), hit('one', 2, '光模块订单增加。')]) : { queued: 0 })
  const user = userEvent.setup()
  render(<ReportPage />)
  await screen.findByRole('img', { name: 'PDF 1' })
  expect(screen.getByRole('button', { name: '扩展搜索' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.change(screen.getByLabelText('搜索研报'), { target: { value: '光模块' } })
  await within(catalog()).findByText('光通信需求增长。')
  expect(JSON.parse(searchCalls()[0][1]!.body as string)).toEqual({ query: '光模块', mode: 'smart', limit: 30, offset: 0 })
  const rows = within(catalog()).getAllByRole('button').filter(button => /第一份报告|第二份报告|光模块资料目录/.test(button.textContent ?? ''))
  expect(rows.map(button => button.querySelector('strong')!.textContent)).toEqual(['第二份报告', '第一份报告', '光模块资料目录'])
  expect(within(catalog()).getByText('命中词：光通信')).toBeInTheDocument()
  expect(screen.getByText(/相关词匹配需要核对原文/)).toBeInTheDocument()
  await user.click(rows[0])
  expect(screen.getByRole('img', { name: 'PDF 3' })).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '研报阅读' })).getByRole('button', { name: /第 3 页 光通信需求增长/ })).toBeInTheDocument()
  expect(screen.queryByText(/FTS|BM25/)).not.toBeInTheDocument()
})

it('switches search modes without allowing an older response to restore results or pagination', async () => {
  let resolveSmart: (value: unknown) => void = () => {}
  mocked.mockImplementation(async (path, init) => {
    if (path === '/documents') return { items: documents }
    if (path === '/documents/search') {
      if (JSON.parse(init!.body as string).mode === 'smart') return new Promise(resolve => { resolveSmart = resolve })
      return result([hit('one', 4, '精确匹配原文。')])
    }
    return { queued: 0 }
  })
  const user = userEvent.setup()
  render(<ReportPage />)
  await screen.findByRole('img', { name: 'PDF 1' })
  fireEvent.change(screen.getByLabelText('搜索研报'), { target: { value: '光模块' } })
  await waitFor(() => expect(searchCalls()).toHaveLength(1))
  await user.click(screen.getByRole('button', { name: '精确匹配' }))
  expect(searchCalls()[0][1]!.signal!.aborted).toBe(true)
  await within(catalog()).findByText('精确匹配原文。')
  expect(JSON.parse(searchCalls()[1][1]!.body as string)).toMatchObject({ mode: 'exact', offset: 0 })
  await act(async () => resolveSmart(result([hit('two', 2, '已经过期的扩展匹配。')], 80, 30)))
  expect(screen.queryByText('已经过期的扩展匹配。')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /第二份报告/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '加载更多命中' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '精确匹配' })).toHaveAttribute('aria-pressed', 'true')
})

it('keeps loaded hits when another page fails, retries the same offset, and merges pages without duplicates', async () => {
  let moreAttempts = 0
  mocked.mockImplementation(async (path, init) => {
    if (path === '/documents') return { items: documents }
    if (path === '/documents/search') {
      if (JSON.parse(init!.body as string).offset === 0) return result([hit('two', 3, '第一页原文命中。')], 3, 30)
      if (++moreAttempts === 1) throw new Error('暂时无法连接')
      return result([hit('two', 3, '重复的已有页。'), hit('one', 2, '新增报告原文。'), hit('two', 4, '新增的另一页。')], 3)
    }
    return { queued: 0 }
  })
  const user = userEvent.setup()
  render(<ReportPage />)
  await screen.findByRole('img', { name: 'PDF 1' })
  fireEvent.change(screen.getByLabelText('搜索研报'), { target: { value: '光模块' } })
  await within(catalog()).findByText('第一页原文命中。')
  await user.click(screen.getByRole('button', { name: '加载更多命中' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法连接')
  expect(within(catalog()).getByText('第一页原文命中。')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '重试加载更多' }))
  await within(catalog()).findByText('新增报告原文。')
  expect(searchCalls().map(([, init]) => JSON.parse(init!.body as string).offset)).toEqual([0, 30, 30])
  expect(within(catalog()).getByText('第一页原文命中。')).toBeInTheDocument()
  expect(screen.queryByText('重复的已有页。')).not.toBeInTheDocument()
  expect(screen.getByText('已显示 3 / 3 处原文命中')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '加载更多命中' })).not.toBeInTheDocument()
  await user.click(within(catalog()).getByRole('button', { name: /第二份报告/ }))
  expect(within(screen.getByRole('region', { name: '研报阅读' })).getByRole('button', { name: /第 4 页 新增的另一页/ })).toBeInTheDocument()
})

it('clears previous matches immediately on a new query and discards late pagination', async () => {
  let resolveMore: (value: unknown) => void = () => {}
  mocked.mockImplementation(async (path, init) => {
    if (path === '/documents') return { items: documents }
    if (path === '/documents/search') {
      const body = JSON.parse(init!.body as string)
      if (body.offset) return new Promise(resolve => { resolveMore = resolve })
      return body.query === '光模块' ? result([hit('two', 2, '旧查询已加载原文。')], 40, 30) : result([hit('one', 4, '新查询原文。', ['订单'])])
    }
    return { queued: 0 }
  })
  const user = userEvent.setup()
  render(<ReportPage />)
  await screen.findByRole('img', { name: 'PDF 1' })
  fireEvent.change(screen.getByLabelText('搜索研报'), { target: { value: '光模块' } })
  await within(catalog()).findByText('旧查询已加载原文。')
  await user.click(screen.getByRole('button', { name: '加载更多命中' }))
  fireEvent.change(screen.getByLabelText('搜索研报'), { target: { value: '订单' } })
  expect(screen.queryByText('旧查询已加载原文。')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /加载更多命中/ })).not.toBeInTheDocument()
  await within(catalog()).findByText('新查询原文。')
  await act(async () => resolveMore(result([hit('two', 3, '迟到的更多原文。')], 40, 60)))
  expect(screen.queryByText('迟到的更多原文。')).not.toBeInTheDocument()
  expect(within(catalog()).getByText('新查询原文。')).toBeInTheDocument()
  expect(screen.getByText('已显示 1 / 1 处原文命中')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /第二份报告/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '清除研报搜索' }))
  expect(within(catalog()).getByRole('button', { name: /第二份报告/ })).toBeInTheDocument()
  expect(screen.queryByText('新查询原文。')).not.toBeInTheDocument()
  expect(screen.queryByText(/处原文命中/)).not.toBeInTheDocument()
})
