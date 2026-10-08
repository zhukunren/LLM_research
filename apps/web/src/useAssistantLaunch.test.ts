import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, ApiRequestError } from './api'
import { readModelPreference } from './modelSelection'
import { useAssistantLaunch, type AssistantLaunchResult } from './useAssistantLaunch'

vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof import('./api')>(), api: vi.fn() }))
vi.mock('./modelSelection', () => ({ readModelPreference: vi.fn() }))

function resultFor(path: string, init?: RequestInit): AssistantLaunchResult {
  return {
    request_id: JSON.parse(init?.body as string).request_id,
    assistant_id: path.split('/')[2], conversation_id: 'conversation-1', turn_id: 'turn-1', job_id: 'job-1',
    state: 'awaiting_agent', job_state: 'queued', as_of_date: '2026-10-08', started_at: '2026-10-08T09:00:00+08:00',
    timezone: 'Asia/Shanghai', assistant_revision: 1, skill_hash: 'skill-hash', idempotent_replay: false,
  }
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(readModelPreference).mockReset().mockReturnValue({ model_id: 'gpt-6-luna', reasoning_effort: 'high' })
})

it('retries an uncertain request with the same ID and frozen model selection', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('网络中断')).mockImplementation(async (path, init) => resultFor(path, init) as never)
  const { result } = renderHook(() => useAssistantLaunch())
  await act(async () => { expect(await result.current.launch('daily-hotspots', '今日热点')).toBeNull() })
  expect(result.current.state).toMatchObject({ loading: false, recoverable: true, error: '网络中断', name: '今日热点' })
  const initial = JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string)
  expect(initial).toMatchObject({ model_id: 'gpt-6-luna', reasoning_effort: 'high' })
  vi.mocked(readModelPreference).mockReturnValue({ model_id: 'gpt-5.6-luna', reasoning_effort: 'low' })
  await act(async () => { expect((await result.current.retry())?.conversation_id).toBe('conversation-1') })
  expect(vi.mocked(api).mock.calls[1][1]!.body).toBe(JSON.stringify(initial))
  expect(result.current.state).toMatchObject({ loading: false, error: '', recoverable: false })
  expect(sessionStorage.length).toBe(0)
})

it('restores pending launch after refresh without automatically sending a request', async () => {
  vi.mocked(api).mockRejectedValue(new Error('响应丢失'))
  const first = renderHook(() => useAssistantLaunch())
  await act(async () => { await first.result.current.launch('daily-hotspots', '今日热点') })
  const body = vi.mocked(api).mock.calls[0][1]!.body
  first.unmount()
  const restored = renderHook(() => useAssistantLaunch())
  expect(vi.mocked(api)).toHaveBeenCalledTimes(1)
  expect(restored.result.current.state).toMatchObject({ loading: false, recoverable: true, name: '今日热点' })
  vi.mocked(api).mockImplementation(async (path, init) => resultFor(path, init) as never)
  await act(async () => { await restored.result.current.retry() })
  expect(vi.mocked(api).mock.calls[1][1]!.body).toBe(body)
  expect(sessionStorage.length).toBe(0)
})

it('coalesces double clicks into a single in-flight POST', async () => {
  let resolve: (value: unknown) => void = () => {}
  vi.mocked(api).mockImplementation(() => new Promise(done => { resolve = done }) as never)
  const { result } = renderHook(() => useAssistantLaunch())
  let first!: Promise<AssistantLaunchResult | null>
  let second!: Promise<AssistantLaunchResult | null>
  act(() => {
    first = result.current.launch('daily-hotspots', '今日热点')
    second = result.current.launch('daily-hotspots', '今日热点')
  })
  expect(first).toBe(second)
  expect(vi.mocked(api)).toHaveBeenCalledTimes(1)
  expect(result.current.state.loading).toBe(true)
  await act(async () => {
    resolve(resultFor(...vi.mocked(api).mock.calls[0]))
    await first
  })
  expect(result.current.state.loading).toBe(false)
})

it('dismisses only the prompt and preserves separate pending intents for each assistant', async () => {
  vi.mocked(api).mockRejectedValue(new Error('暂不可用'))
  const { result } = renderHook(() => useAssistantLaunch())
  await act(async () => { await result.current.launch('daily-hotspots', '今日热点') })
  const firstBody = vi.mocked(api).mock.calls[0][1]!.body
  act(() => result.current.dismiss())
  expect(result.current.state.error).toBe('')
  await act(async () => { await result.current.launch('policy-tracker', '政策追踪') })
  const policyBody = vi.mocked(api).mock.calls[1][1]!.body
  expect(policyBody).not.toBe(firstBody)
  vi.mocked(api).mockImplementation(async (path, init) => resultFor(path, init) as never)
  await act(async () => { await result.current.launch('daily-hotspots', '今日热点') })
  expect(vi.mocked(api).mock.calls[2][1]!.body).toBe(firstBody)
  await act(async () => { await result.current.launch('policy-tracker', '政策追踪') })
  expect(vi.mocked(api).mock.calls[3][1]!.body).toBe(policyBody)
  expect(sessionStorage.length).toBe(0)
})

it('does not let an earlier assistant failure replace the current launch state', async () => {
  let failEarlier: (reason: unknown) => void = () => {}
  vi.mocked(api).mockImplementationOnce(() => new Promise((_, reject) => { failEarlier = reject }) as never)
    .mockRejectedValueOnce(new Error('政策服务暂不可用'))
  const { result } = renderHook(() => useAssistantLaunch())
  let earlier!: Promise<AssistantLaunchResult | null>
  act(() => { earlier = result.current.launch('daily-hotspots', '今日热点') })
  await act(async () => { await result.current.launch('policy-tracker', '政策追踪') })
  await act(async () => { failEarlier(new Error('旧错误')); await earlier })
  expect(result.current.state).toMatchObject({ name: '政策追踪', error: '政策服务暂不可用', recoverable: true })
})

it('keeps an uncertain attempt if the response cannot identify its conversation', async () => {
  vi.mocked(api).mockResolvedValue({ conversation_id: 'wrong', turn_id: 'wrong', request_id: 'other-request' })
  const { result } = renderHook(() => useAssistantLaunch())
  await act(async () => { expect(await result.current.launch('daily-hotspots')).toBeNull() })
  expect(result.current.state.recoverable).toBe(true)
  const body = vi.mocked(api).mock.calls[0][1]!.body
  vi.mocked(api).mockImplementation(async (path, init) => resultFor(path, init) as never)
  await act(async () => { await result.current.retry() })
  expect(vi.mocked(api).mock.calls[1][1]!.body).toBe(body)
})

it('creates a fresh intent after a confirmed launch and reads the new model preference', async () => {
  vi.mocked(api).mockImplementation(async (path, init) => resultFor(path, init) as never)
  const { result } = renderHook(() => useAssistantLaunch())
  await act(async () => { await result.current.launch('daily-hotspots') })
  vi.mocked(readModelPreference).mockReturnValue({ model_id: 'gpt-5.6-luna', reasoning_effort: 'low' })
  await act(async () => { await result.current.launch('daily-hotspots') })
  const bodies = vi.mocked(api).mock.calls.map(call => JSON.parse(call[1]!.body as string))
  expect(bodies[0].request_id).not.toBe(bodies[1].request_id)
  expect(bodies[1]).toMatchObject({ model_id: 'gpt-5.6-luna', reasoning_effort: 'low' })
})

it('remains retryable in memory when session storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled') })
  vi.mocked(readModelPreference).mockReturnValue(null)
  vi.mocked(api).mockRejectedValueOnce(new Error('暂不可用')).mockImplementation(async (path, init) => resultFor(path, init) as never)
  const { result } = renderHook(() => useAssistantLaunch())
  await act(async () => { await result.current.launch('daily-hotspots') })
  await act(async () => { await result.current.retry() })
  expect(vi.mocked(api).mock.calls[0][1]!.body).toBe(vi.mocked(api).mock.calls[1][1]!.body)
  expect(Object.keys(JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string))).toEqual(['request_id'])
})

it('clears a confirmed validation rejection so a corrected model starts a new intent', async () => {
  vi.mocked(api).mockRejectedValueOnce(new ApiRequestError('此模型不可用', 422, 'conversation_error'))
    .mockImplementation(async (path, init) => resultFor(path, init) as never)
  const { result } = renderHook(() => useAssistantLaunch())
  await act(async () => { await result.current.launch('daily-hotspots', '今日热点') })
  const first = JSON.parse(vi.mocked(api).mock.calls[0][1]!.body as string)
  expect(result.current.state.recoverable).toBe(false)
  expect(result.current.state.error).toContain('调整选择后重新启动')
  expect(sessionStorage.length).toBe(0)
  await act(async () => { expect(await result.current.retry()).toBeNull() })
  expect(api).toHaveBeenCalledTimes(1)
  vi.mocked(readModelPreference).mockReturnValue({ model_id: 'gpt-5.6-luna', reasoning_effort: 'low' })
  await act(async () => { await result.current.launch('daily-hotspots', '今日热点') })
  const second = JSON.parse(vi.mocked(api).mock.calls[1][1]!.body as string)
  expect(second.request_id).not.toBe(first.request_id)
  expect(second).toMatchObject({ model_id: 'gpt-5.6-luna', reasoning_effort: 'low' })
})

it.each([
  new ApiRequestError('启动请求冲突', 409, 'research_assistant_launch_error'),
  new ApiRequestError('队列暂不可用', 503, 'research_assistant_launch_error', { recoverable: true, conversation_id: 'saved' }),
  new ApiRequestError('结果状态不明', 422, 'unknown_error'),
  new ApiRequestError('任务已创建', 422, 'conversation_error', { conversation_id: 'saved' }),
])('preserves a possibly existing task after %s', async error => {
  vi.mocked(api).mockRejectedValueOnce(error).mockImplementation(async (path, init) => resultFor(path, init) as never)
  const { result } = renderHook(() => useAssistantLaunch())
  await act(async () => { await result.current.launch('daily-hotspots') })
  expect(result.current.state.recoverable).toBe(true)
  const body = vi.mocked(api).mock.calls[0][1]!.body
  vi.mocked(readModelPreference).mockReturnValue({ model_id: 'gpt-5.6-luna', reasoning_effort: 'low' })
  await act(async () => { await result.current.retry() })
  expect(vi.mocked(api).mock.calls[1][1]!.body).toBe(body)
})
