import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import NewsPage from './NewsPage'

vi.mock('../api', () => ({ api: vi.fn() }))
const mocked = vi.mocked(api)
const record = { id: 'news-1', root_id: 'news-1', version: 1, title: '新增订单', body: '公司已经取得新增订单。', source: '公司公告', stock_codes: ['600000.SH'], published_at: '2026-09-14T01:05:00+00:00', available_at: '2026-09-14T01:05:00+00:00', event_key: null }
beforeEach(() => {
  vi.clearAllMocks()
  mocked.mockImplementation(async path => path === '/news/news-1' ? record : path === '/news/import-url' ? { created: 1, duplicates: 0 } : { items: [record], total: 1, next_offset: null })
})
it('opens the first article for reading and changes its font size without showing import fields', async () => {
  const user = userEvent.setup()
  render(<NewsPage />)
  const body = await screen.findByText(record.body)
  expect(body.closest('article')).toHaveStyle({ fontSize: '14px' })
  expect(screen.queryByLabelText('资讯网址')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '放大资讯字体' }))
  expect(body.closest('article')).toHaveStyle({ fontSize: '15px' })
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
    return path === '/news/news-1' ? record : { items: [record], total: 1, next_offset: null }
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
  mocked.mockImplementation(async path => path.startsWith('/news?') ? { items: [record, second], total: 2, next_offset: null } : path === '/news/news-2' ? second : new Promise(resolve => { first = resolve }))
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

