import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../api'
import ProjectMembership from './ProjectMembership'

vi.mock('../../api', () => ({ api: vi.fn() }))

describe('ProjectMembership', () => {
  it('only confirms a new association after the server accepts it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn(), onError = vi.fn()
    let reject = true
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === '/research-projects') return { items: [{ id: 'p1', name: '白酒研究', status: 'active' }] } as never
      expect(path).toBe('/conversations/c1/project')
      expect(JSON.parse(String(init?.body))).toEqual({ project_id: 'p1' })
      if (reject) throw new Error('当前研究尚未结束')
      return {} as never
    })
    render(<ProjectMembership conversationId="c1" disabled={false} onChange={onChange} onError={onError} />)
    await screen.findByRole('option', { name: '白酒研究' })
    await user.selectOptions(screen.getByRole('combobox', { name: '所属研究项目' }), 'p1')
    await waitFor(() => expect(onError).toHaveBeenCalledWith('当前研究尚未结束'))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: '所属研究项目' })).toHaveValue('')
    reject = false
    await user.selectOptions(screen.getByRole('combobox', { name: '所属研究项目' }), 'p1')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('p1'))
  })
})


function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

it.each(['success', 'failure'] as const)('ignores an old conversation save %s without unlocking the new save', async outcome => {
  const oldSave = deferred<unknown>(), newSave = deferred<unknown>()
  const onChange = vi.fn(), onError = vi.fn()
  let oldSignal: AbortSignal | undefined
  vi.mocked(api).mockImplementation((path, init) => {
    if (path === '/research-projects') return Promise.resolve({ items: [{ id: 'p1', name: '白酒研究', status: 'active' }] }) as never
    if (path === '/conversations/c1/project') { oldSignal = init?.signal as AbortSignal; return oldSave.promise as never }
    if (path === '/conversations/c2/project') return newSave.promise as never
    throw new Error(`Unexpected request: ${path}`)
  })
  const view = render(<ProjectMembership conversationId="c1" disabled={false} onChange={onChange} onError={onError} />)
  await screen.findByRole('option', { name: '白酒研究' })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p1' } })
  view.rerender(<ProjectMembership conversationId="c2" disabled={false} onChange={onChange} onError={onError} />)
  expect(oldSignal?.aborted).toBe(true)
  expect(screen.getByRole('combobox')).toBeEnabled()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p1' } })
  await act(async () => {
    if (outcome === 'success') oldSave.resolve({})
    else oldSave.reject(new Error('旧对话保存失败'))
  })
  expect(onChange).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
  expect(screen.getByRole('combobox')).toBeDisabled()
  await act(async () => { newSave.resolve({}) })
  expect(onChange).toHaveBeenCalledExactlyOnceWith('p1')
  expect(screen.getByRole('combobox')).toBeEnabled()
})

it('locks repeated saves synchronously and ignores completion after unmount', async () => {
  const save = deferred<unknown>(), onChange = vi.fn(), onError = vi.fn()
  vi.mocked(api).mockImplementation(path => path === '/research-projects'
    ? Promise.resolve({ items: [{ id: 'p1', name: '白酒研究', status: 'active' }] }) as never
    : save.promise as never)
  const view = render(<ProjectMembership conversationId="c1" disabled={false} onChange={onChange} onError={onError} />)
  await screen.findByRole('option', { name: '白酒研究' })
  const select = screen.getByRole('combobox')
  act(() => {
    fireEvent.change(select, { target: { value: 'p1' } })
    fireEvent.change(select, { target: { value: '' } })
  })
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
  view.unmount()
  await act(async () => { save.reject(new Error('已离开的对话保存失败')) })
  expect(onChange).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
})

it('does not install an aborted project list over the current conversation list', async () => {
  const oldList = deferred<unknown>()
  vi.mocked(api).mockReturnValueOnce(oldList.promise as never).mockResolvedValue({ items: [{ id: 'p2', name: '新项目', status: 'active' }] } as never)
  const props = { disabled: false, onChange: vi.fn(), onError: vi.fn() }
  const view = render(<ProjectMembership conversationId="c1" {...props} />)
  view.rerender(<ProjectMembership conversationId="c2" {...props} />)
  await screen.findByRole('option', { name: '新项目' })
  await act(async () => { oldList.resolve({ items: [{ id: 'p1', name: '旧项目', status: 'active' }] }) })
  expect(screen.getByRole('option', { name: '新项目' })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: '旧项目' })).not.toBeInTheDocument()
})
