import { expect, it, vi } from 'vitest'
import { api } from './api'

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
