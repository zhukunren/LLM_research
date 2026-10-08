import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import SavedScreeningPlans from './SavedScreeningPlans'
import type { SavedScreeningTask } from '../api'

vi.mock('../components/conversation/SavedTaskLibrary', () => ({ default: ({ onReuse }: { onReuse: (task: SavedScreeningTask, latest?: boolean) => void }) => <button onClick={() => onReuse({ id: 'plan', name: '均线方案', version: 2 } as SavedScreeningTask, true)}>复用方案</button> }))

it('opens a reusable screening plan for review without starting model processing or execution', async () => {
  const calls: { path: string; body: Record<string, unknown> }[] = []
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url), body = JSON.parse(String(init?.body))
    calls.push({ path, body })
    return new Response(JSON.stringify(path === '/api/v1/conversations' ? { id: 'new-screening' } : path.endsWith('/messages') ? { message_id: 'reuse-message' } : { revision: 1 }))
  })
  vi.stubGlobal('fetch', fetcher)
  const open = vi.fn(), user = userEvent.setup()
  render(<SavedScreeningPlans data={{ available: true, last_date: '2026-10-08' }} onOpenConversation={open} />)
  await user.click(screen.getByRole('button', { name: '复用方案' }))
  await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('new-screening', 'screening', 'screening'))
  expect(calls.map(item => item.path)).toEqual(['/api/v1/conversations', '/api/v1/conversations/new-screening/messages', '/api/v1/conversations/new-screening/saved-screening-tasks/plan/reuse'])
  expect(calls[0].body).toMatchObject({ entry_scope: 'screening', workflow_type: 'screening', request_id: expect.any(String) })
  expect(calls[2].body).toMatchObject({ base_revision: 0, source_message_id: 'reuse-message', version: 2, as_of: '2026-10-08' })
})

it('retries a failed reuse with its accepted conversation and message instead of creating duplicates', async () => {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url); paths.push(path)
    if (path.endsWith('/reuse') && paths.filter(item => item.endsWith('/reuse')).length === 1) return new Response(JSON.stringify({ message: '临时失败' }), { status: 503 })
    return new Response(JSON.stringify(path === '/api/v1/conversations' ? { id: 'new-screening' } : path.endsWith('/messages') ? { message_id: 'reuse-message' } : { revision: 1 }))
  }))
  const open = vi.fn(), user = userEvent.setup()
  render(<SavedScreeningPlans onOpenConversation={open} />)
  await user.click(screen.getByRole('button', { name: '复用方案' }))
  await screen.findByRole('alert')
  await user.click(screen.getByRole('button', { name: '复用方案' }))
  await waitFor(() => expect(open).toHaveBeenCalledOnce())
  expect(paths.filter(path => path === '/api/v1/conversations')).toHaveLength(1)
  expect(paths.filter(path => path.endsWith('/messages'))).toHaveLength(1)
  expect(paths.filter(path => path.endsWith('/reuse'))).toHaveLength(2)
})
