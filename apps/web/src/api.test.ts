import { expect, it, vi } from 'vitest'
import { api, ApiRequestError } from './api'

it('explains connection failures and malformed successful responses', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError()) })
  vi.stubGlobal('fetch', fetch)
  await expect(api('/news')).rejects.toThrow('暂时无法连接本地服务')
  await expect(api('/news')).rejects.toThrow('数据格式异常')
})

it('preserves cancellation instead of presenting it as a network error', async () => {
  const controller = new AbortController(); controller.abort()
  const error = new DOMException('cancelled', 'AbortError')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
  await expect(api('/news', { signal: controller.signal })).rejects.toBe(error)
})

it('preserves server status and structured details while remaining a normal Error', async () => {
  const body = { code: 'conversation_error', message: '模型不可用', details: { reason: 'free' } }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => body }))
  const error = await api('/research-assistants/daily-hotspots/launch').catch(reason => reason)
  expect(error).toBeInstanceOf(Error)
  expect(error).toBeInstanceOf(ApiRequestError)
  expect(error).toMatchObject({ status: 422, code: body.code, message: body.message, details: body.details })
})
