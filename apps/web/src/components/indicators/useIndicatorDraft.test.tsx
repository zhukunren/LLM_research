import { act, renderHook } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { EmbeddedWorkspaceSession } from '../../WorkspaceSession'
import { setStorageIdentity, clearIdentityStorage } from '../../authStorage'
import { useIndicatorDraft, type IndicatorDraft } from './useIndicatorDraft'

const initial: IndicatorDraft = { selection: null, newIndicator: false, description: '', descriptionOpen: true, stock: '000001.SH', asOf: '', limit: 500, parameters: {}, saveName: '', saveTarget: '', output: '', operator: 'gt', threshold: '0', common: false, mobileDetail: false }
const key = (context: string, workspace = '') => `dynamicIndicators.draft.${JSON.stringify([workspace, context])}`
const stored = (draft: unknown, savedAt = Date.now(), version = 1) => JSON.stringify({ version, savedAt, draft })

it('restores only editable fields after immediate update and unmount', () => {
  const first = renderHook(() => useIndicatorDraft('research:A', initial), { wrapper: StrictMode })
  act(() => first.result.current[1]({ ...initial, selection: { kind: 'trial', id: 'trial-A' }, description: '未完成指标', saveName: '新名称', parameters: { period: 14, empty: NaN }, limit: NaN, validation: { saveable: true }, source_code: 'not saved' } as IndicatorDraft))
  first.unmount()
  const second = renderHook(() => useIndicatorDraft('research:A', initial))
  expect(second.result.current[0]).toMatchObject({ selection: { kind: 'trial', id: 'trial-A' }, description: '未完成指标', saveName: '新名称', parameters: { period: 14, empty: null }, limit: null })
  expect(sessionStorage.getItem(key('research:A'))).not.toContain('validation')
  expect(sessionStorage.getItem(key('research:A'))).not.toContain('source_code')
})

it('switches keys without copying the old draft and ignores a stale setter', () => {
  const view = renderHook(({ context }) => useIndicatorDraft(context, initial), { initialProps: { context: 'A' } })
  act(() => view.result.current[1](value => ({ ...value, description: 'A草稿' })))
  const stale = view.result.current[1]
  view.rerender({ context: 'B' })
  expect(view.result.current[0].description).toBe('')
  act(() => { stale(value => ({ ...value, description: '迟到的A' })); view.result.current[1](value => ({ ...value, description: 'B草稿' })) })
  view.rerender({ context: 'A' })
  expect(view.result.current[0].description).toBe('A草稿')
  view.rerender({ context: 'B' })
  expect(view.result.current[0].description).toBe('B草稿')
})

it('isolates workspace tabs and authenticated identities', () => {
  function tab(id: string) {
    return function Wrapper({ children }: { children: ReactNode }) { return <EmbeddedWorkspaceSession id={id} active portalTarget={document.body}>{children}</EmbeddedWorkspaceSession> }
  }
  setStorageIdentity('user-a', 'tenant')
  const a = renderHook(() => useIndicatorDraft('same-context', initial), { wrapper: tab('first') })
  act(() => a.result.current[1]({ ...initial, description: '私有草稿' }))
  a.unmount()
  const b = renderHook(() => useIndicatorDraft('same-context', initial), { wrapper: tab('second') })
  expect(b.result.current[0].description).toBe('')
  b.unmount()
  setStorageIdentity('user-b', 'tenant')
  const other = renderHook(() => useIndicatorDraft('same-context', initial), { wrapper: tab('first') })
  expect(other.result.current[0].description).toBe('')
  other.unmount()
  clearIdentityStorage()
})

it.each([
  '{broken',
  stored({ ...initial, selection: { kind: 'saved', id: 'bad', version: -1 } }),
  stored({ ...initial, parameters: { period: '14' } }),
  stored({ ...initial, operator: '__proto__' }),
  stored({ ...initial, description: 'x'.repeat(4001) }),
  stored({ ...initial, saveName: 'x'.repeat(101) }),
  stored(initial, Date.now() - 8 * 86400000),
  stored(initial, Date.now() + 86400000),
  stored(initial, Date.now(), 2),
  'x'.repeat(32769),
])('ignores malformed, oversized or expired storage (%#)', raw => {
  sessionStorage.setItem(key('A'), raw)
  const view = renderHook(() => useIndicatorDraft('A', initial))
  expect(view.result.current[0]).toEqual(initial)
})

it('keeps consecutive functional updates and reset usable when storage is denied', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  const view = renderHook(() => useIndicatorDraft('A', initial), { wrapper: StrictMode })
  act(() => {
    view.result.current[1](value => ({ ...value, description: value.description + '一' }))
    view.result.current[1](value => ({ ...value, description: value.description + '二' }))
  })
  expect(view.result.current[0].description).toBe('一二')
  act(() => view.result.current[1](initial))
  expect(view.result.current[0]).toEqual(initial)
})

it('does not persist payloads beyond the byte limit but keeps the live draft', () => {
  const view = renderHook(() => useIndicatorDraft('A', initial))
  const parameters = Object.fromEntries(Array.from({ length: 100 }, (_, index) => ['参'.repeat(95) + index, 123]))
  act(() => view.result.current[1]({ ...initial, description: '界'.repeat(4000), parameters }))
  expect(view.result.current[0].description).toHaveLength(4000)
  expect(sessionStorage.getItem(key('A'))).toBeNull()
})


it('restores an explicit new-indicator choice without selecting a previous trial', () => {
  const first = renderHook(() => useIndicatorDraft('A', initial))
  act(() => first.result.current[1]({ ...initial, selection: { kind: 'trial', id: 'previous' } }))
  act(() => first.result.current[1]({ ...initial, newIndicator: true }))
  first.unmount()
  const reopened = renderHook(() => useIndicatorDraft('A', initial))
  expect(reopened.result.current[0]).toMatchObject({ newIndicator: true, selection: null, description: '' })
})
