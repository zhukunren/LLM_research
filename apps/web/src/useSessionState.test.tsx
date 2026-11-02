import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { StrictMode, useLayoutEffect, useState } from 'react'
import { useSessionState } from './useSessionState'

it('persists updates before the owner unmounts in the same batch', () => {
  function Editor({ close }: { close: () => void }) {
    const [draft, setDraft] = useSessionState('test.draft', 'saved draft', (value): value is string => typeof value === 'string')
    return <button onClick={() => { setDraft(''); close() }}>{draft}</button>
  }
  function Owner() {
    const [open, setOpen] = useState(true)
    return open ? <Editor close={() => setOpen(false)} /> : <span>closed</span>
  }
  const view = render(<StrictMode><Owner /></StrictMode>)
  act(() => screen.getByRole('button').click())
  expect(screen.getByText('closed')).toBeInTheDocument()
  expect(JSON.parse(sessionStorage.getItem('test.draft')!)).toBe('')
  view.unmount()
  function Reopened() {
    const [draft] = useSessionState('test.draft', 'stale fallback', (value): value is string => typeof value === 'string')
    return <input aria-label="restored draft" value={draft} readOnly />
  }
  render(<StrictMode><Reopened /></StrictMode>)
  expect(screen.getByLabelText('restored draft')).toHaveValue('')
})

it('does not let the mount effect overwrite a draft cleared from a layout effect', () => {
  function Editor({ close }: { close: () => void }) {
    const [, setDraft] = useSessionState('test.layoutDraft', 'old draft', (value): value is string => typeof value === 'string')
    useLayoutEffect(() => { setDraft(''); close() }, [])
    return null
  }
  function Owner() {
    const [open, setOpen] = useState(true)
    return open ? <Editor close={() => setOpen(false)} /> : <span>closed after layout</span>
  }
  render(<StrictMode><Owner /></StrictMode>)
  expect(screen.getByText('closed after layout')).toBeInTheDocument()
  expect(JSON.parse(sessionStorage.getItem('test.layoutDraft')!)).toBe('')
})

it('applies consecutive functional updates once in order and keeps editing available without storage', () => {
  function Counter() {
    const [count, setCount] = useSessionState('test.count', 0, (value): value is number => typeof value === 'number')
    return <button onClick={() => { setCount(value => value + 1); setCount(value => value + 1) }}>{count}</button>
  }
  render(<Counter />)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
  act(() => screen.getByRole('button').click())
  expect(screen.getByRole('button')).toHaveTextContent('2')
})

it('reports actual write success and reads a new key without writing the previous draft into it', () => {
  sessionStorage.setItem('draft.a', JSON.stringify('A'))
  sessionStorage.setItem('draft.b', JSON.stringify('B'))
  function Editor({ storageKey }: { storageKey: string }) {
    const [draft, setDraft, persistence] = useSessionState(storageKey, '', (value): value is string => typeof value === 'string')
    return <><input aria-label="draft" value={draft} onChange={event => setDraft(event.target.value)} /><output>{persistence?.persisted ? '暂存成功' : '暂存失败'}</output></>
  }
  const view = render(<Editor storageKey="draft.a" />)
  expect(screen.getByText('暂存成功')).toBeInTheDocument()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
  view.rerender(<Editor storageKey="draft.b" />)
  expect(screen.getByLabelText('draft')).toHaveValue('B')
  expect(screen.getByText('暂存失败')).toBeInTheDocument()
  expect(JSON.parse(sessionStorage.getItem('draft.b')!)).toBe('B')
})

it('does not let an old key setter change the newly selected draft', () => {
  let oldSet: (next: string) => void = () => {}
  function Editor({ storageKey }: { storageKey: string }) {
    const [value, setValue] = useSessionState(storageKey, storageKey, (item): item is string => typeof item === 'string')
    if (storageKey === 'owner-a') oldSet = setValue
    return <span>{value}</span>
  }
  const view = render(<Editor storageKey="owner-a" />)
  view.rerender(<Editor storageKey="owner-b" />)
  act(() => oldSet('late value from A'))
  expect(screen.getByText('owner-b')).toBeInTheDocument()
  expect(JSON.parse(sessionStorage.getItem('owner-b')!)).toBe('owner-b')
  expect(JSON.parse(sessionStorage.getItem('owner-a')!)).toBe('owner-a')
})
