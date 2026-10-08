import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../api'
import { useConversationAttachments, type ConversationAttachment } from './useConversationAttachments'

vi.mock('../../api', async importOriginal => ({ ...await importOriginal<typeof import('../../api')>(), api: vi.fn() }))
const key = 'research:screening:one'
const file = () => new File(['private document text'], 'report.txt', { type: 'text/plain', lastModified: 100 })
const metadata = (requestId: string, id = 'file-one'): ConversationAttachment => ({
  id, request_id: requestId, conversation_id: 'one', filename: 'report.txt', media_type: 'text/plain', bytes: file().size,
  sha256: 'hash', created_at: '2026-10-08T12:00:00Z', url: `/api/v1/conversations/one/attachments/${id}/download`,
})
const target = () => Promise.resolve({ conversationId: 'one', draftKey: key })
const uploadResult = (_: string, init?: RequestInit) => metadata(String((init!.body as FormData).get('request_id')))

beforeEach(() => { vi.mocked(api).mockReset() })

it('uploads originals as multipart and persists only metadata and stable request identity', async () => {
  vi.mocked(api).mockImplementation(async (path, init) => uploadResult(path, init) as never)
  const ensure = vi.fn(target)
  const { result } = renderHook(() => useConversationAttachments(key, 'one', ensure))
  await act(async () => { await result.current.upload([file()]) })
  expect(ensure).toHaveBeenCalledOnce()
  expect(api).toHaveBeenCalledOnce()
  const [path, init] = vi.mocked(api).mock.calls[0]
  expect(path).toBe('/conversations/one/attachments')
  expect(init?.method).toBe('POST')
  expect((init?.body as FormData).get('file')).toBeInstanceOf(File)
  expect((init?.body as FormData).get('request_id')).toBe(result.current.items[0].requestId)
  expect(result.current.ready.map(item => item.id)).toEqual(['file-one'])
  expect(sessionStorage.getItem('conversation.attachmentDrafts')).not.toContain('private document text')
})

it('retries a failed or lost upload response with the original file and request ID', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('网络中断')).mockImplementation(async (path, init) => uploadResult(path, init) as never)
  const { result } = renderHook(() => useConversationAttachments(key, 'one', target))
  await act(async () => { await result.current.upload([file()]) })
  expect(result.current.items[0]).toMatchObject({ status: 'error', canRetry: true, error: '网络中断' })
  const first = vi.mocked(api).mock.calls[0][1]?.body as FormData
  await act(async () => { await result.current.retry(result.current.items[0].requestId) })
  const second = vi.mocked(api).mock.calls[1][1]?.body as FormData
  expect(second.get('request_id')).toBe(first.get('request_id'))
  expect(second.get('file')).toBe(first.get('file'))
  expect(result.current.ready).toHaveLength(1)
})

it('cancels an in-flight upload and ignores a late transport success', async () => {
  let complete!: (value: unknown) => void
  vi.mocked(api).mockImplementation(() => new Promise(resolve => { complete = resolve }) as never)
  const { result } = renderHook(() => useConversationAttachments(key, 'one', target))
  let pending!: Promise<void>
  act(() => { pending = result.current.upload([file()]) })
  await waitFor(() => expect(api).toHaveBeenCalledOnce())
  const requestId = result.current.items[0].requestId
  act(() => result.current.cancel(requestId))
  expect(vi.mocked(api).mock.calls[0][1]?.signal?.aborted).toBe(true)
  await act(async () => { complete(metadata(requestId)); await pending })
  expect(result.current.items[0].status).toBe('cancelled')
  expect(result.current.ready).toHaveLength(0)
  act(() => result.current.remove(requestId))
  expect(result.current.items).toHaveLength(0)
})

it('does not begin uploading a file cancelled while its conversation was being created', async () => {
  let created!: (value: { conversationId: string; draftKey: string }) => void
  const ensure = () => new Promise<{ conversationId: string; draftKey: string }>(resolve => { created = resolve })
  const { result } = renderHook(() => useConversationAttachments(key, 'one', ensure))
  let pending!: Promise<void>
  act(() => { pending = result.current.upload([file()]) })
  act(() => result.current.cancel(result.current.items[0].requestId))
  await act(async () => { created({ conversationId: 'one', draftKey: key }); await pending })
  expect(api).not.toHaveBeenCalled()
  expect(result.current.items[0].status).toBe('cancelled')
})

it('restores unsent uploaded files after refresh without uploading them again', async () => {
  vi.mocked(api).mockImplementation(async (path, init) => uploadResult(path, init) as never)
  const first = renderHook(() => useConversationAttachments(key, 'one', target))
  await act(async () => { await first.result.current.upload([file()]) })
  first.unmount()
  const restored = renderHook(() => useConversationAttachments(key, 'one', target))
  expect(restored.result.current.ready.map(item => item.id)).toEqual(['file-one'])
  expect(api).toHaveBeenCalledOnce()
  act(() => restored.result.current.remove(restored.result.current.items[0].requestId))
  expect(api).toHaveBeenCalledOnce() // removing an unsent chip does not delete the original
})

it('recovers a committed upload after a lost response using its request ID on refresh', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('响应丢失'))
  const first = renderHook(() => useConversationAttachments(key, 'one', target))
  await act(async () => { await first.result.current.upload([file()]) })
  const requestId = first.result.current.items[0].requestId
  first.unmount()
  vi.mocked(api).mockResolvedValue({ items: [metadata(requestId)] } as never)
  const ensure = vi.fn(target)
  const restored = renderHook(() => useConversationAttachments(key, 'one', ensure))
  await waitFor(() => expect(restored.result.current.ready).toHaveLength(1))
  expect(ensure).not.toHaveBeenCalled()
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})

it('requires reselecting an unconfirmed file after refresh and retains its upload ID', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('未保存'))
  const first = renderHook(() => useConversationAttachments(key, 'one', target))
  await act(async () => { await first.result.current.upload([file()]) })
  const requestId = first.result.current.items[0].requestId
  first.unmount()
  vi.mocked(api).mockResolvedValueOnce({ items: [] } as never).mockImplementation(async (path, init) => uploadResult(path, init) as never)
  const restored = renderHook(() => useConversationAttachments(key, 'one', target))
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
  expect(restored.result.current.items[0]).toMatchObject({ requestId, status: 'missing', canRetry: false })
  await act(async () => { await restored.result.current.retry(requestId, file()) })
  const form = vi.mocked(api).mock.calls[2][1]?.body as FormData
  expect(form.get('request_id')).toBe(requestId)
  expect(restored.result.current.ready).toHaveLength(1)
})

it('keeps late upload completion in its original conversation after navigation', async () => {
  let complete!: (value: unknown) => void
  vi.mocked(api).mockImplementation(() => new Promise(resolve => { complete = resolve }) as never)
  const view = renderHook(({ owner, cid }) => useConversationAttachments(owner, cid, target), { initialProps: { owner: key, cid: 'one' } })
  let pending!: Promise<void>
  act(() => { pending = view.result.current.upload([file()]) })
  await waitFor(() => expect(api).toHaveBeenCalledOnce())
  const requestId = view.result.current.items[0].requestId
  view.rerender({ owner: 'research:screening:two', cid: 'two' })
  await act(async () => { complete(metadata(requestId)); await pending })
  expect(view.result.current.items).toHaveLength(0)
  view.rerender({ owner: key, cid: 'one' })
  expect(view.result.current.ready.map(item => item.id)).toEqual(['file-one'])
})

it('does not upload after leaving during metadata creation or overwrite a newer instance draft', async () => {
  let created!: (value: { conversationId: string; draftKey: string }) => void
  const old = renderHook(() => useConversationAttachments('research:screening:new', undefined,
    () => new Promise(resolve => { created = resolve })))
  let preparing!: Promise<void>
  act(() => { preparing = old.result.current.upload([file()]) })
  old.unmount()
  vi.mocked(api).mockImplementation(async (_, init) => ({ ...metadata(String((init?.body as FormData).get('request_id')), 'new-file'), conversation_id: 'two' }) as never)
  const nextKey = 'research:screening:two'
  const next = renderHook(() => useConversationAttachments(nextKey, 'two', () => Promise.resolve({ conversationId: 'two', draftKey: nextKey })))
  await act(async () => { await next.result.current.upload([file()]) })
  await act(async () => { created({ conversationId: 'one', draftKey: key }); await preparing })
  expect(api).toHaveBeenCalledOnce()
  expect(vi.mocked(api).mock.calls[0][0]).toBe('/conversations/two/attachments')
  const stored = JSON.parse(sessionStorage.getItem('conversation.attachmentDrafts')!)
  expect(stored[nextKey][0].attachment.id).toBe('new-file')
  expect(stored[key]).toBeUndefined()
})

it('merges draft-key updates into the latest session map across mounted instances', async () => {
  vi.mocked(api).mockImplementation(async (path, init) => ({ ...uploadResult(path, init), conversation_id: path.includes('/two/') ? 'two' : 'one' }) as never)
  const first = renderHook(() => useConversationAttachments(key, 'one', target))
  const secondKey = 'research:screening:two'
  const second = renderHook(() => useConversationAttachments(secondKey, 'two', () => Promise.resolve({ conversationId: 'two', draftKey: secondKey })))
  await act(async () => { await first.result.current.upload([file()]) })
  await act(async () => { await second.result.current.upload([file()]) })
  act(() => first.result.current.remove(first.result.current.items[0].requestId))
  const stored = JSON.parse(sessionStorage.getItem('conversation.attachmentDrafts')!)
  expect(stored[key]).toHaveLength(0)
  expect(stored[secondKey]).toHaveLength(1)
  expect(stored[secondKey][0].status).toBe('ready')
})
