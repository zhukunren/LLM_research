import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import AuthBoundary from './AuthBoundary'
import { api, setCsrfToken } from './api'
import { clearIdentityStorage, localStorage as scopedStorage, setStorageIdentity } from './authStorage'

afterEach(() => {
  clearIdentityStorage(); setCsrfToken('')
  delete (window as Window & { __LLMR_AUTH_REQUIRED__?: boolean }).__LLMR_AUTH_REQUIRED__
})

it('retains local mode without login requests', () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  render(<AuthBoundary><div>local research</div></AuthBoundary>)
  expect(screen.getByText('local research')).toBeInTheDocument()
  expect(fetcher).not.toHaveBeenCalled()
})

it('gates private components until authenticated and sends CSRF on writes', async () => {
  ;(window as Window & { __LLMR_AUTH_REQUIRED__?: boolean }).__LLMR_AUTH_REQUIRED__ = true
  let finish!: (value: Response) => void
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve })).mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetcher)
  render(<AuthBoundary><div>private research</div></AuthBoundary>)
  expect(screen.queryByText('private research')).not.toBeInTheDocument()
  finish(new Response(JSON.stringify({ user_id: 'A', tenant_id: 'one', role: 'editor', csrf_token: 'csrf-A' })))
  await screen.findByText('private research')
  await api('/conversations', { method: 'POST', body: '{}' })
  expect(new Headers(fetcher.mock.calls[1][1].headers).get('X-CSRF-Token')).toBe('csrf-A')
})

it('unmounts private data and clears caches on session expiry', async () => {
  ;(window as Window & { __LLMR_AUTH_REQUIRED__?: boolean }).__LLMR_AUTH_REQUIRED__ = true
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ user_id: 'A', tenant_id: 'one', role: 'viewer', csrf_token: 'csrf-A' }))).mockResolvedValueOnce(new Response('{}', { status: 401 })))
  render(<AuthBoundary><div>private research</div></AuthBoundary>)
  await screen.findByText('private research')
  scopedStorage.setItem('draft', 'private')
  await expect(api('/conversations')).rejects.toThrow()
  await screen.findByRole('link', { name: '登录' })
  expect(screen.queryByText('private research')).not.toBeInTheDocument()
  expect(window.localStorage.length).toBe(0)
})

it('logout uses server CSRF and removes private components', async () => {
  ;(window as Window & { __LLMR_AUTH_REQUIRED__?: boolean }).__LLMR_AUTH_REQUIRED__ = true
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ user_id: 'A', tenant_id: 'one', role: 'editor', csrf_token: 'csrf-A' }))).mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetcher)
  render(<AuthBoundary><div>private research</div></AuthBoundary>)
  await screen.findByText('private research')
  fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
  await screen.findByRole('link', { name: '登录' })
  expect(fetcher.mock.calls[1][0]).toBe('/auth/logout')
  expect(fetcher.mock.calls[1][1].headers['X-CSRF-Token']).toBe('csrf-A')
})

it('scopes drafts by user and clears previous identities', () => {
  window.localStorage.setItem('draft', 'legacy')
  setStorageIdentity('A', 'one'); scopedStorage.setItem('draft', 'Alice')
  expect(window.localStorage.getItem('llmr:one:A:draft')).toBe('Alice')
  setStorageIdentity('B', 'one')
  expect(scopedStorage.getItem('draft')).toBeNull()
  expect(window.localStorage.getItem('llmr:one:A:draft')).toBeNull()
})

it('preserves shared drafts when a new tab initializes the same identity', () => {
  setStorageIdentity('A', 'one')
  scopedStorage.setItem('draft', 'Alice unsent research')
  window.sessionStorage.clear()
  setStorageIdentity('A', 'one')
  expect(scopedStorage.getItem('draft')).toBe('Alice unsent research')
  expect(window.sessionStorage.getItem('llmr.identity')).toBe('one:A')
})

it.each(['logout', 'expiry', 'switch', 'unmount'])('ignores a late focus response after %s', async reason => {
  ;(window as Window & { __LLMR_AUTH_REQUIRED__?: boolean }).__LLMR_AUTH_REQUIRED__ = true
  const me = { user_id: 'A', tenant_id: 'one', role: 'editor', csrf_token: 'csrf-A' }
  let resolveFocus!: (value: Response) => void
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(me)))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFocus = resolve }))
    .mockResolvedValueOnce(new Response('{}'))
  vi.stubGlobal('fetch', fetcher)
  const view = render(<AuthBoundary><div>private research</div></AuthBoundary>)
  await screen.findByText('private research')
  fireEvent(window, new Event('focus'))
  if (reason === 'logout') {
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await screen.findByRole('link', { name: '登录' })
  } else if (reason === 'expiry') fireEvent(window, new Event('llmr-auth-required'))
  else if (reason === 'switch') {
    window.localStorage.setItem('llmr.identity', 'one:B')
    fireEvent(window, new StorageEvent('storage', { key: 'llmr.identity', newValue: 'one:B' }))
  } else view.unmount()
  await act(async () => { resolveFocus(new Response(JSON.stringify(me))) })
  expect(screen.queryByText('private research')).not.toBeInTheDocument()
  if (reason === 'switch') expect(window.localStorage.getItem('llmr.identity')).toBe('one:B')
})

it('unmounts a stale tab when another tab changes identity', async () => {
  ;(window as Window & { __LLMR_AUTH_REQUIRED__?: boolean }).__LLMR_AUTH_REQUIRED__ = true
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ user_id: 'A', tenant_id: 'one', role: 'editor', csrf_token: 'csrf-A' }))))
  render(<AuthBoundary><div>private research</div></AuthBoundary>)
  await screen.findByText('private research')
  fireEvent(window, new StorageEvent('storage', { key: 'llmr.identity', newValue: 'one:B' }))
  await waitFor(() => expect(screen.queryByText('private research')).not.toBeInTheDocument())
})
