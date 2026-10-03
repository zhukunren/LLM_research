import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { useRemoteResource } from './useRemoteResource'
vi.mock('./api', () => ({ api: vi.fn() }))

function View({ path }: { path: string }) {
  const state = useRemoteResource<{ name: string }>(path)
  return <div>{state.loading ? '正在读取' : state.error || state.data?.name}<button onClick={state.retry}>重试</button></div>
}
describe('useRemoteResource', () => {
  it('ignores a late result for the old security even when the transport ignores cancellation', async () => {
    let old: (value: unknown) => void = () => {}
    vi.mocked(api).mockImplementation(path => path === '/old' ? new Promise(resolve => { old = resolve }) : Promise.resolve({ name: '新股票' }) as never)
    const view = render(<View path="/old" />)
    expect(screen.getByText('正在读取')).toBeVisible()
    view.rerender(<View path="/new" />)
    await screen.findByText('新股票')
    await act(async () => old({ name: '旧股票' }))
    expect(screen.queryByText('旧股票')).not.toBeInTheDocument()
    expect(screen.getByText('新股票')).toBeVisible()
  })
})
