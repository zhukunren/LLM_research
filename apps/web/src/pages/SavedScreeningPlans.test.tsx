import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import SavedScreeningPlans from './SavedScreeningPlans'
import type { SavedScreeningTask } from '../api'
import { EmbeddedWorkspaceSession } from '../WorkspaceSession'

vi.mock('../components/conversation/SavedTaskLibrary', () => ({ default: ({ onReuse }: { onReuse: (task: SavedScreeningTask, latest?: boolean) => void }) => <><button onClick={() => onReuse({ id: 'plan', name: '均线方案', version: 2 } as SavedScreeningTask, true)}>复用方案</button><button onClick={() => onReuse({ id: 'plan', name: '均线方案', version: 2 } as SavedScreeningTask, false)}>复用原日期</button></> }))

it('runs an explicitly reused conversation plan through the existing reuse endpoint', async () => {
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
  render(<SavedScreeningPlans data={{ available: true, last_date: '2026-10-08' }} onOpenConversation={open} />)
  await user.click(screen.getByRole('button', { name: '复用方案' }))
  await screen.findByRole('alert')
  await user.click(screen.getByRole('button', { name: '复用方案' }))
  await waitFor(() => expect(open).toHaveBeenCalledOnce())
  expect(paths.filter(path => path === '/api/v1/conversations')).toHaveLength(1)
  expect(paths.filter(path => path.endsWith('/messages'))).toHaveLength(1)
  expect(paths.filter(path => path.endsWith('/reuse'))).toHaveLength(2)
})

it('keeps original-date reuse explicit and omits a replacement cutoff from its request', async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url), body = JSON.parse(String(init?.body)); requests.push({ path, body })
    return new Response(JSON.stringify(path === '/api/v1/conversations' ? { id: 'original-date' } : path.endsWith('/messages') ? { message_id: 'source-message' } : { revision: 1 }))
  }))
  const open = vi.fn(), user = userEvent.setup()
  render(<SavedScreeningPlans data={{ available: true, last_date: '2026-10-27' }} onOpenConversation={open} />)
  await user.click(screen.getByRole('button', { name: '复用原日期' }))
  await waitFor(() => expect(open).toHaveBeenCalledOnce())
  expect(requests.find(item => item.path.endsWith('/reuse'))!.body).toEqual({ base_revision: 0, source_message_id: 'source-message', version: 2 })
  expect(requests.find(item => item.path.endsWith('/messages'))!.body.content).toContain('保留原截止日')
})

it('does not silently reuse the original date when latest-date information is unavailable', async () => {
  const fetcher = vi.fn(), user = userEvent.setup()
  vi.stubGlobal('fetch', fetcher)
  render(<SavedScreeningPlans />)
  await user.click(screen.getByRole('button', { name: '复用方案' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('最新行情日期尚未就绪')
  expect(fetcher).not.toHaveBeenCalled()
})

it('discovers both types in one center and opens a composition for editing without running it', async () => {
  const onOpen = vi.fn(), fetcher = vi.fn(), user = userEvent.setup()
  vi.stubGlobal('fetch', fetcher)
  render(<SavedScreeningPlans strategies={[{ id: 'strategy', version: 3, name: '价值组合', tree: { op: 'all', children: [] }, top_n: 20, created_at: '2026-11-01T00:00:00Z' }]} onOpenComposition={onOpen} />)
  expect(screen.getByRole('heading', { name: '我的筛选方案' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: '条件组合' }))
  expect(screen.queryByRole('button', { name: '复用方案' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '打开编辑' }))
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('strategy@3')
  expect(fetcher).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '全部方案' }))
  expect(screen.getByRole('button', { name: '复用方案' })).toBeVisible()
})

it('continues the current draft without selecting or creating another composition', async () => {
  const open = vi.fn(), create = vi.fn(), resume = vi.fn(), user = userEvent.setup()
  render(<SavedScreeningPlans compositionDraft={{ name: '未完成组合', conditionCount: 3, saved: false }} onContinueComposition={resume} onOpenComposition={open} onNewComposition={create} />)
  expect(screen.getByText('3 个条件 · 当前草稿，尚未保存为方案版本')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '继续编辑草稿' }))
  expect(resume).toHaveBeenCalledOnce()
  expect(open).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})

it('keeps composition loading distinct from an empty conversation source and supports explicit refresh', async () => {
  const refresh = vi.fn(), user = userEvent.setup()
  const view = render(<SavedScreeningPlans loading onRefreshCompositions={refresh} />)
  expect(screen.queryByText('暂无已保存的条件组合')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '刷新方案来源' })).toBeDisabled()
  view.rerender(<SavedScreeningPlans compositionError="读取失败" onRefreshCompositions={refresh} />)
  await user.click(screen.getByRole('button', { name: '刷新方案来源' }))
  expect(refresh).toHaveBeenCalledOnce()
})

it('blocks mutations and submissions while the workbench is busy', async () => {
  const open = vi.fn(), create = vi.fn(), resume = vi.fn(), library = vi.fn(), fetcher = vi.fn(), user = userEvent.setup()
  vi.stubGlobal('fetch', fetcher)
  render(<SavedScreeningPlans externalBusy compositionDraft={{ name: '草稿', conditionCount: 1, saved: false }} onContinueComposition={resume} onOpenComposition={open} onNewComposition={create} onOpenConditionLibrary={library} />)
  expect(screen.getByRole('button', { name: '继续编辑草稿' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '管理条件库' })).toBeDisabled()
  expect(screen.getAllByRole('button', { name: '新建条件组合' }).every(button => button.hasAttribute('disabled'))).toBe(true)
  await user.click(screen.getByRole('button', { name: '复用方案' }))
  expect(fetcher).not.toHaveBeenCalled()
})

it('prevents repeated clicks from starting duplicate conversation runs', async () => {
  let resolve!: (response: Response) => void
  const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done })), user = userEvent.setup()
  vi.stubGlobal('fetch', fetcher)
  const view = render(<SavedScreeningPlans data={{ available: true, last_date: '2026-10-08' }} />)
  await user.dblClick(screen.getByRole('button', { name: '复用方案' }))
  expect(fetcher).toHaveBeenCalledOnce()
  view.unmount()
  resolve(new Response(JSON.stringify({ id: 'accepted' })))
})


it('does not navigate from an old reuse response after leaving and returning to the workspace', async () => {
  let finish!: (response: Response) => void
  const open = vi.fn(), user = userEvent.setup(), portal = document.createElement('div')
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url)
    if (path.endsWith('/reuse')) return new Promise<Response>(resolve => { finish = resolve })
    return new Response(JSON.stringify(path.endsWith('/messages') ? { message_id: 'accepted-message' } : { id: 'accepted-conversation' }))
  }))
  const content = (active: boolean) => <EmbeddedWorkspaceSession id="center" active={active} portalTarget={portal}><SavedScreeningPlans data={{ available: true, last_date: '2026-10-08' }} onOpenConversation={open} /></EmbeddedWorkspaceSession>
  const view = render(content(true))
  await user.click(screen.getByRole('button', { name: '复用方案' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  view.rerender(content(false))
  view.rerender(content(true))
  await act(async () => { finish(new Response(JSON.stringify({ revision: 1 }))) })
  expect(open).not.toHaveBeenCalled()
})
