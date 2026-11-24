import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import TradeExplanation from './TradeExplanation'
vi.mock('../api', () => ({ api: vi.fn() }))
beforeEach(() => { sessionStorage.clear(); vi.mocked(api).mockReset() })
const result = { request_id: 'done', state: 'succeeded', message: '完成', client_copy: '根据公开信息和量价数据解释操作考虑。', sources: [{ title: '公司公告', url: 'https://www.cninfo.com.cn/example', published_at: '2026-11-01' }], limitations: [] }

it('requests independent public research for buy and sell and copies edited client text', async () => {
  vi.mocked(api).mockResolvedValue(result)
  const user = userEvent.setup(), copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  render(<TradeExplanation code="300001.SZ" date="2026-11-12" initialSide="sell" />)
  await user.click(screen.getByRole('button', { name: '深度' }))
  await user.click(screen.getByRole('button', { name: 'Codex 生成说明' }))
  const editor = await screen.findByRole('textbox', { name: '客户操作说明' })
  const payload = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))
  expect(payload).toEqual({ code: '300001.SZ', date: '2026-11-12', side: 'sell', model_mode: 'deep', request_id: expect.any(String) })
  fireEvent.change(editor, { target: { value: '核对后修改的客户操作说明。' } })
  await user.click(screen.getByRole('button', { name: '复制说明' }))
  expect(copy).toHaveBeenCalledWith('核对后修改的客户操作说明。')
  await user.click(screen.getByRole('button', { name: '买入' }))
  await user.click(screen.getByRole('button', { name: 'Codex 生成说明' }))
  await waitFor(() => expect(JSON.parse(String(vi.mocked(api).mock.lastCall?.[1]?.body)).side).toBe('buy'))
})

it('restores an existing research result without submitting another generation request', async () => {
  sessionStorage.setItem('trade-explanation:300001.SZ:2026-11-12:sell', 'saved-request')
  vi.mocked(api).mockResolvedValue(result)
  render(<TradeExplanation code="300001.SZ" date="2026-11-12" initialSide="sell" />)
  await screen.findByRole('textbox', { name: '客户操作说明' })
  expect(vi.mocked(api).mock.calls[0][0]).toBe('/daily-signals/reason/saved-request')
  expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method)).toBe(true)
})
