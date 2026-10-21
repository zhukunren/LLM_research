import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { defaultBriefScope } from './intelligence'

vi.mock('./pages/ResearchWorkspace', () => ({ default: () => <h1>新研究草稿</h1> }))
vi.mock('./pages/ResearchProjectsPage', () => ({ default: () => <h1>研究项目目录</h1> }))
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState({}, '', '#/research/new') })

it('navigates to intelligence desk by URL without posting an assistant prompt', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.includes('/intelligence?')) return json({ items: [], total: 0, next_offset: null, latest_result_id: null, default_scope: defaultBriefScope, legacy: [] })
    if (path.includes('/data/status')) return json({ available: true, last_date: '2026-10-20' })
    return json({ items: [], active_count: 0 })
  })
  vi.stubGlobal('fetch', fetcher)
  window.history.replaceState({}, '', '#/intelligence/market')
  render(<App />)
  expect(await screen.findByRole('heading', { name: '市场简报' })).toBeInTheDocument()
  await waitFor(() => expect(window.location.hash).toBe('#/intelligence/market'))
  expect(fetcher.mock.calls.some(([path]) => String(path).includes('/launch'))).toBe(false)
  expect(screen.queryByRole('button', { name: '启动今日热点' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '政策追踪' }))
  expect(await screen.findByRole('heading', { name: '政策追踪' })).toBeInTheDocument()
  expect(window.location.hash).toBe('#/intelligence/policy')
})

it('restores an exact intelligence version from its URL', async () => {
  window.history.replaceState({}, '', '#/intelligence/market/saved-run')
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.endsWith('/intelligence/runs/saved-run')) return json({ id: 'saved-run', kind: 'market', version: 3, scope: defaultBriefScope,
      state: 'cancelled', cutoff_at: '2026-10-19T10:00:00+08:00', created_at: '2026-10-19T02:00:00Z',
      result: null, sources: [], activity: [], source_count: 0, search_count: 0 })
    if (path.includes('/intelligence?')) return json({ items: [], total: 0, default_scope: defaultBriefScope, latest_result_id: null, legacy: [] })
    return json({ items: [], active_count: 0 })
  })
  vi.stubGlobal('fetch', fetcher)
  render(<App />)
  expect(await screen.findByRole('button', { name: '按原范围重试' })).toBeInTheDocument()
  expect(window.location.hash).toBe('#/intelligence/market/saved-run')
  expect(screen.getByText('V3')).toBeInTheDocument()
})
