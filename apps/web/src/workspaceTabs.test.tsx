import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { useWorkspaceTabs } from './workspaceTabs'

beforeEach(() => window.history.replaceState(null, '', '#/research/new'))

it('migrates active and closed indicator-library tabs while preserving other tabs and drafts', () => {
  window.history.replaceState(null, '', '#/library/technical')
  const legacy = { id: 'old-indicators', title: '内置指标参考', route: { page: 'technical' } }
  sessionStorage.setItem('conversation.drafts', JSON.stringify({ 'research:screening:new': '保留研究草稿' }))
  sessionStorage.setItem('app.workspaceTabs.v1', JSON.stringify({ tabs: [legacy, { id: 'reports', title: '研报库', route: { page: 'reports' } }], activeId: legacy.id, closedTabs: [{ tab: { ...legacy, id: 'closed-indicators', route: { page: 'technical', workspace: 'screening' } }, index: 1, order: ['old-indicators', 'closed-indicators', 'reports'] }] }))
  const { result } = renderHook(useWorkspaceTabs)
  expect(result.current.activeId).toBe(legacy.id)
  expect(result.current.activeTab.route).toMatchObject({ page: 'screening', indicators: 'common' })
  expect(result.current.tabs.some(tab => tab.route.page === 'reports')).toBe(true)
  expect(window.location.hash).toBe('#/research/new?scope=technical&indicators=common')
  act(() => result.current.reopenClosed())
  expect(result.current.activeTab.id).toBe('closed-indicators')
  expect(result.current.activeTab.route).toMatchObject({ page: 'conditions', indicators: 'common' })
  expect(sessionStorage.getItem('conversation.drafts')).toContain('保留研究草稿')
})

it('reuses tools and conversations while keeping explicit new drafts separate', () => {
  const { result } = renderHook(useWorkspaceTabs)
  const first = result.current.activeId
  act(() => { result.current.open({ page: 'reports' }) })
  const reports = result.current.activeId
  act(() => { result.current.open({ page: 'reports' }) })
  expect(result.current.tabs).toHaveLength(2)
  expect(result.current.activeId).toBe(reports)
  act(() => { result.current.open({ page: 'screening', newDraft: true }, { forceNew: true, seed: { fresh: true } }) })
  expect(result.current.tabs).toHaveLength(3)
  expect(result.current.activeId).not.toBe(first)
  act(() => { result.current.open({ page: 'screening', conversationId: 'research-one' }) })
  const research = result.current.activeId
  act(() => { result.current.open({ page: 'screening', conversationId: 'research-one', scope: 'screening' }) })
  expect(result.current.activeId).toBe(research)
  expect(result.current.tabs).toHaveLength(4)
})

it('lets a background research publish its identity without replacing the active URL', () => {
  const { result } = renderHook(useWorkspaceTabs)
  const research = result.current.activeId
  act(() => { result.current.open({ page: 'reports' }) })
  const reports = result.current.activeId
  act(() => { result.current.update(research, { page: 'screening', conversationId: 'created-in-background' }) })
  expect(result.current.activeId).toBe(reports)
  expect(window.location.hash).toBe('#/library/reports')
  act(() => { result.current.activate(research) })
  expect(window.location.hash).toBe('#/research/created-in-background')
})

it('reuses a function after selecting its detail without crossing workspace context', () => {
  const { result } = renderHook(useWorkspaceTabs)
  act(() => { result.current.open({ page: 'watchlist', candidateId: 'one', workspace: 'research' }) })
  const observation = result.current.activeId
  act(() => { result.current.open({ page: 'watchlist', workspace: 'research' }, { reusePage: true }) })
  expect(result.current.activeId).toBe(observation)
  expect(result.current.activeTab.route.candidateId).toBe('one')
  act(() => { result.current.open({ page: 'watchlist', workspace: 'screening' }, { reusePage: true }) })
  expect(result.current.activeId).not.toBe(observation)
  expect(result.current.activeTab.route.workspace).toBe('screening')
})

it('restores tabs and the selected draft after reload, ignoring malformed saved entries', () => {
  const view = renderHook(useWorkspaceTabs)
  act(() => { view.result.current.open({ page: 'qmt' }) })
  act(() => { view.result.current.open({ page: 'screening', newDraft: true }, { forceNew: true }) })
  const activeId = view.result.current.activeId
  const saved = JSON.parse(sessionStorage.getItem('app.workspaceTabs.v1')!)
  saved.tabs.push({ id: 'bad', route: { page: 'unknown' }, title: 'invalid' })
  sessionStorage.setItem('app.workspaceTabs.v1', JSON.stringify(saved))
  view.unmount()
  const restored = renderHook(useWorkspaceTabs)
  expect(restored.result.current.tabs).toHaveLength(3)
  expect(restored.result.current.activeId).toBe(activeId)
})

it('selects an adjacent tab when closing, and keeps one usable draft when closing the last', () => {
  const { result } = renderHook(useWorkspaceTabs)
  const first = result.current.activeId
  act(() => { result.current.open({ page: 'reports' }) })
  const reports = result.current.activeId
  act(() => { result.current.open({ page: 'qmt' }) })
  act(() => { result.current.close(reports) })
  expect(result.current.activeTab.route.page).toBe('qmt')
  act(() => { result.current.close(result.current.activeId) })
  expect(result.current.activeId).toBe(first)
  act(() => { result.current.close(first) })
  expect(result.current.tabs).toHaveLength(1)
  expect(result.current.activeTab.route).toEqual({ page: 'screening', newDraft: true })
  expect(window.location.hash).toBe('#/research/new')
})

it.each([true, false])('closes other tabs and retains the chosen tab and its storage identity (active: %s)', active => {
  const { result } = renderHook(useWorkspaceTabs)
  const draft = result.current.activeTab
  act(() => { result.current.open({ page: 'reports' }) })
  const reports = result.current.activeTab
  act(() => { result.current.open({ page: 'qmt' }) })
  const keep = active ? result.current.activeTab : reports
  act(() => { result.current.closeOthers(keep.id) })
  expect(result.current.tabs).toEqual([keep])
  expect(result.current.activeId).toBe(keep.id)
  expect(result.current.tabs.some(tab => tab.id === draft.id)).toBe(false)
  expect(window.location.hash).toBe(active ? '#/tools/qmt' : '#/library/reports')
  const stored = JSON.parse(sessionStorage.getItem('app.workspaceTabs.v1')!)
  expect(stored.tabs.map((tab: { id: string }) => tab.id)).toEqual([keep.id])
  expect(stored.activeId).toBe(keep.id)
})

it('closes all tabs atomically and restores only the new blank draft on reload', () => {
  const view = renderHook(useWorkspaceTabs)
  act(() => { view.result.current.open({ page: 'reports' }) })
  act(() => { view.result.current.open({ page: 'qmt' }) })
  const previousIds = view.result.current.tabs.map(tab => tab.id)
  act(() => { view.result.current.closeAll() })
  const blank = view.result.current.activeTab
  expect(view.result.current.tabs).toHaveLength(1)
  expect(previousIds).not.toContain(blank.id)
  expect(blank.route).toEqual({ page: 'screening', newDraft: true })
  expect(blank.seed?.fresh).toBe(true)
  expect(window.location.hash).toBe('#/research/new')
  view.unmount()
  const restored = renderHook(useWorkspaceTabs)
  expect(restored.result.current.tabs).toHaveLength(1)
  expect(restored.result.current.activeId).toBe(blank.id)
  expect(restored.result.current.activeTab.route).toEqual(blank.route)
})

it('ignores a stale close-others target', () => {
  const { result } = renderHook(useWorkspaceTabs)
  const previous = result.current.tabs
  act(() => { result.current.closeOthers('already-closed') })
  expect(result.current.tabs).toBe(previous)
})

it('moves tabs in either direction without changing the active page or browser history', () => {
  const { result } = renderHook(useWorkspaceTabs)
  const first = result.current.activeTab
  act(() => { result.current.open({ page: 'reports' }) })
  const reports = result.current.activeTab
  act(() => { result.current.open({ page: 'qmt' }) })
  const qmt = result.current.activeTab, historyLength = window.history.length
  act(() => { result.current.move(qmt.id, first.id, 'before') })
  expect(result.current.tabs).toEqual([qmt, first, reports])
  expect(result.current.activeId).toBe(qmt.id)
  act(() => { result.current.move(first.id, reports.id, 'after') })
  expect(result.current.tabs).toEqual([qmt, reports, first])
  expect(result.current.activeId).toBe(qmt.id)
  expect(window.location.hash).toBe('#/tools/qmt')
  expect(window.history.length).toBe(historyLength)
})

it('persists reordered tabs and retains the active tab identity on reload', () => {
  const view = renderHook(useWorkspaceTabs)
  const first = view.result.current.activeId
  act(() => { view.result.current.open({ page: 'reports' }) })
  const reports = view.result.current.activeId
  act(() => { view.result.current.open({ page: 'qmt' }) })
  const activeId = view.result.current.activeId
  act(() => { view.result.current.move(first, activeId, 'after') })
  view.unmount()
  const restored = renderHook(useWorkspaceTabs)
  expect(restored.result.current.tabs.map(tab => tab.id)).toEqual([reports, activeId, first])
  expect(restored.result.current.activeId).toBe(activeId)
})

it('ignores cancelled, unchanged or stale moves and closes the new adjacent tab in order', () => {
  const { result } = renderHook(useWorkspaceTabs)
  const first = result.current.activeId
  act(() => { result.current.open({ page: 'reports' }) })
  const reports = result.current.activeId
  act(() => { result.current.open({ page: 'qmt' }) })
  const qmt = result.current.activeId, previous = result.current.tabs
  act(() => {
    result.current.move(first, first, 'after')
    result.current.move(first, reports, 'before')
    result.current.move('missing', first, 'before')
    result.current.move(first, 'missing', 'after')
  })
  expect(result.current.tabs).toBe(previous)
  act(() => { result.current.move(qmt, first, 'before') })
  act(() => { result.current.close(qmt) })
  expect(result.current.activeId).toBe(first)
})

it.each([
  ['left', 'first', 'reports'], ['left', 'qmt', 'qmt'],
  ['right', 'qmt', 'reports'], ['right', 'first', 'first'],
] as const)('closes %s of the target while handling an active %s tab', (side, active, expectedActive) => {
  const { result } = renderHook(useWorkspaceTabs)
  const first = result.current.activeTab
  act(() => { result.current.open({ page: 'reports' }) })
  const reports = result.current.activeTab
  act(() => { result.current.open({ page: 'qmt' }) })
  const qmt = result.current.activeTab, identities = { first, reports, qmt }
  act(() => { result.current.activate(identities[active].id) })
  act(() => { result.current.closeSide(reports.id, side) })
  expect(result.current.tabs).toEqual(side === 'left' ? [reports, qmt] : [first, reports])
  expect(result.current.activeId).toBe(identities[expectedActive].id)
  const saved = JSON.parse(sessionStorage.getItem('app.workspaceTabs.v1')!)
  expect(saved.tabs.map((tab: { id: string }) => tab.id)).toEqual(result.current.tabs.map(tab => tab.id))
  expect(saved.activeId).toBe(result.current.activeId)
})

it('closes sides using the latest drag order and preserves the surviving tabs on reload', () => {
  const view = renderHook(useWorkspaceTabs)
  const first = view.result.current.activeTab
  act(() => { view.result.current.open({ page: 'reports' }) })
  const reports = view.result.current.activeTab
  act(() => { view.result.current.open({ page: 'qmt' }) })
  const qmt = view.result.current.activeTab
  act(() => { view.result.current.move(qmt.id, first.id, 'before') })
  act(() => { view.result.current.closeSide(first.id, 'left') })
  expect(view.result.current.tabs).toEqual([first, reports])
  expect(view.result.current.activeId).toBe(first.id)
  view.unmount()
  const restored = renderHook(useWorkspaceTabs)
  expect(restored.result.current.tabs.map(tab => tab.id)).toEqual([first.id, reports.id])
  expect(restored.result.current.activeId).toBe(first.id)
})

it('ignores side closing at the first/last tab or with a stale target', () => {
  const { result } = renderHook(useWorkspaceTabs)
  const first = result.current.activeId
  act(() => { result.current.open({ page: 'reports' }) })
  const last = result.current.activeId, previous = result.current.tabs
  act(() => {
    result.current.closeSide(first, 'left')
    result.current.closeSide(last, 'right')
    result.current.closeSide('missing', 'left')
    result.current.closeSide('missing', 'right')
  })
  expect(result.current.tabs).toBe(previous)
  expect(result.current.activeId).toBe(last)
})

it('reopens the most recently closed tabs in order with their original identity and position', () => {
  const { result } = renderHook(useWorkspaceTabs)
  const first = result.current.activeTab
  act(() => { result.current.open({ page: 'reports' }) })
  const reports = result.current.activeTab
  act(() => { result.current.open({ page: 'qmt' }) })
  const qmt = result.current.activeTab
  act(() => { result.current.close(reports.id) })
  act(() => { result.current.close(qmt.id) })
  expect(result.current.canReopen).toBe(true)
  act(() => { result.current.reopenClosed() })
  expect(result.current.activeId).toBe(qmt.id)
  expect(result.current.tabs.map(tab => tab.id)).toEqual([first.id, qmt.id])
  act(() => { result.current.reopenClosed() })
  expect(result.current.activeId).toBe(reports.id)
  expect(result.current.tabs).toEqual([first, reports, qmt])
  expect(result.current.canReopen).toBe(false)
  expect(window.location.hash).toBe('#/library/reports')
})

it.each(['others', 'left', 'right', 'all'] as const)('recovers tabs from a bulk %s close without losing their relative order', action => {
  const { result } = renderHook(useWorkspaceTabs)
  act(() => { result.current.open({ page: 'reports' }) })
  act(() => { result.current.open({ page: 'qmt' }) })
  act(() => { result.current.open({ page: 'watchlist' }) })
  act(() => { result.current.open({ page: 'news' }) })
  const original = result.current.tabs, target = original[2]
  act(() => { result.current.activate(original[1].id) })
  act(() => {
    if (action === 'all') result.current.closeAll()
    else if (action === 'others') result.current.closeOthers(target.id)
    else result.current.closeSide(target.id, action)
  })
  const originallyActiveClosed = !result.current.tabs.some(tab => tab.id === original[1].id)
  if (originallyActiveClosed) {
    act(() => { result.current.reopenClosed() })
    expect(result.current.activeId).toBe(original[1].id)
  }
  for (let count = 0; count < original.length && result.current.canReopen; count++) act(() => { result.current.reopenClosed() })
  expect(result.current.canReopen).toBe(false)
  expect(result.current.tabs.filter(tab => original.some(item => item.id === tab.id))).toEqual(original)
})

it('restores recent-closed records after reload without replaying launch seeds', () => {
  const view = renderHook(useWorkspaceTabs)
  act(() => { view.result.current.open({ page: 'screening', newDraft: true }, { forceNew: true, seed: { fresh: true, prompt: 'original prompt', assistantId: 'financial' } }) })
  const draft = view.result.current.activeTab
  act(() => { view.result.current.close(draft.id) })
  view.unmount()
  const restored = renderHook(useWorkspaceTabs)
  expect(restored.result.current.canReopen).toBe(true)
  act(() => { restored.result.current.reopenClosed() })
  expect(restored.result.current.activeId).toBe(draft.id)
  expect(restored.result.current.activeTab.seed).toBeUndefined()
  expect(restored.result.current.canReopen).toBe(false)
})

it('does not duplicate a saved page that has already been reopened through navigation', () => {
  const { result } = renderHook(useWorkspaceTabs)
  act(() => { result.current.open({ page: 'reports' }) })
  act(() => { result.current.close(result.current.activeId) })
  act(() => { result.current.open({ page: 'reports' }) })
  const existing = result.current.activeId
  act(() => { result.current.reopenClosed() })
  expect(result.current.activeId).toBe(existing)
  expect(result.current.tabs.filter(tab => tab.route.page === 'reports')).toHaveLength(1)
  expect(result.current.canReopen).toBe(false)
})

it('does not remember automatic closures of removed conversations and discards deleted history', () => {
  const { result } = renderHook(useWorkspaceTabs)
  act(() => { result.current.open({ page: 'screening', conversationId: 'deleted' }) })
  act(() => { result.current.close(result.current.activeId, { remember: false }) })
  expect(result.current.canReopen).toBe(false)
  act(() => { result.current.open({ page: 'screening', conversationId: 'deleted' }) })
  act(() => { result.current.close(result.current.activeId) })
  expect(result.current.canReopen).toBe(true)
  act(() => { result.current.forgetClosedConversation('deleted') })
  expect(result.current.canReopen).toBe(false)
  const previous = result.current.tabs
  act(() => { result.current.reopenClosed() })
  expect(result.current.tabs).toBe(previous)
})
