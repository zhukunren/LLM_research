import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { legacyWorkspaceRoute, parseWorkspaceRoute, persistWorkspaceRoute, workspaceRouteHash, type WorkspaceRoute } from './workspaceRoute'
import { useWorkspaceRoute } from './useWorkspaceRoute'

beforeEach(() => window.history.replaceState(null, '', '/'))
afterEach(() => window.history.replaceState(null, '', '/'))

describe('stable workspace URLs', () => {
  it.each<WorkspaceRoute>([
    { page: 'screening', newDraft: true }, { page: 'screening', conversationId: 'one', scope: 'report' },
    { page: 'conditions', conversationId: 'task-1', scope: 'news', view: 'conversation' },
    { page: 'conditions', view: 'compose' }, { page: 'research', projectId: 'project-1' },
    { page: 'watchlist', candidateId: 'candidate-1', observationTab: 'candidates' },
    { page: 'watchlist', runId: 'batch-1', observationTab: 'batches' },
    { page: 'watchlist', observationTab: 'candidates' }, { page: 'technical' }, { page: 'reports' },
  ])('round-trips an explicit location %#', route => expect(parseWorkspaceRoute(workspaceRouteHash(route))).toEqual(route))

  it('keeps new drafts separate from saved objects and legacy page IDs', () => {
    expect(parseWorkspaceRoute('#/home')).toEqual({ page: 'screening', newDraft: true })
    expect(legacyWorkspaceRoute()).toEqual({ page: 'screening', newDraft: true })
    expect(parseWorkspaceRoute('#/research/new')).toEqual({ page: 'screening', newDraft: true })
    expect(parseWorkspaceRoute('#/screening/new')).toEqual({ page: 'conditions', newDraft: true, view: 'conversation' })
    expect(workspaceRouteHash({ page: 'screening' })).toBe('#/research')
    expect(workspaceRouteHash({ page: 'research' })).toBe('#/projects')
    expect(workspaceRouteHash({ page: 'conditions', view: 'library' })).toBe('#/screening?view=library')
  })

  it('replaces the old home bookmark without adding a Back step or clearing a draft', () => {
    window.history.replaceState(null, '', '#/home')
    sessionStorage.setItem('conversation.drafts', JSON.stringify({ 'research:screening:new': '未发送的研究问题' }))
    const historyLength = window.history.length
    renderHook(() => useWorkspaceRoute())
    expect(window.location.hash).toBe('#/research/new')
    expect(window.history.length).toBe(historyLength)
    expect(JSON.parse(sessionStorage.getItem('conversation.drafts')!)['research:screening:new']).toBe('未发送的研究问题')
  })

  it('normalizes a legacy home navigation into a new research route', () => {
    window.history.replaceState(null, '', '#/projects')
    const { result } = renderHook(() => useWorkspaceRoute())
    act(() => result.current.navigate({ page: 'home' }))
    expect(result.current.route).toEqual({ page: 'screening', newDraft: true })
    expect(window.location.hash).toBe('#/research/new')
  })

  it.each(['#workspace-main', '#/unknown', '#/research/a/b', '#/research/%2f', '#/research/%', '#/projects/..', '#/screening?view=unknown', '#/research?scope=invalid', '#/observation/batches/a/b'])('rejects malformed or unrelated locations %s', hash => {
    expect(parseWorkspaceRoute(hash)).toBeNull()
  })

  it('restores legacy positions without migrating or overwriting business records', () => {
    sessionStorage.setItem('app.page', '"watchlist"')
    sessionStorage.setItem('observation.run', '"old-run"')
    expect(legacyWorkspaceRoute()).toEqual({ page: 'watchlist', runId: 'old-run', observationTab: 'batches' })
    sessionStorage.setItem('app.page', '"research"')
    sessionStorage.setItem('research.selectedProject', '"old-project"')
    expect(legacyWorkspaceRoute()).toEqual({ page: 'research', projectId: 'old-project' })
    sessionStorage.setItem('app.page', '"conditions"')
    sessionStorage.setItem('conditions.section', '"history"')
    expect(legacyWorkspaceRoute()).toEqual({ page: 'conditions', scope: 'screening', view: 'history' })
  })

  it('gives an explicit URL priority over old selection storage', () => {
    sessionStorage.setItem('app.page', '"research"')
    localStorage.setItem('conversation.active.report.research', 'old')
    window.history.replaceState(null, '', '#/research/new?scope=report')
    const { result } = renderHook(() => useWorkspaceRoute())
    expect(result.current.route).toEqual({ page: 'screening', newDraft: true, scope: 'report' })
    expect(localStorage.getItem('conversation.active.report.research')).toBe('__new__')
    expect(sessionStorage.getItem('app.page')).toBe('"screening"')
  })

  it('does not depend on writable storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled') })
    expect(() => persistWorkspaceRoute({ page: 'research', projectId: 'one' })).not.toThrow()
    window.history.replaceState(null, '', '#/projects/one')
    const { result } = renderHook(() => useWorkspaceRoute())
    expect(result.current.route.projectId).toBe('one')
  })

  it('restores exact objects with browser Back and Forward without adding duplicate steps', async () => {
    window.history.replaceState(null, '', '#/projects/one')
    const onHistoryChange = vi.fn()
    const { result } = renderHook(() => useWorkspaceRoute(onHistoryChange))
    act(() => result.current.navigate({ page: 'screening', conversationId: 'two' }))
    expect(window.location.hash).toBe('#/research/two')
    const historyLength = window.history.length
    act(() => result.current.navigate({ page: 'screening', conversationId: 'two' }))
    expect(window.history.length).toBe(historyLength)
    act(() => window.history.back())
    await waitFor(() => expect(result.current.route).toEqual({ page: 'research', projectId: 'one' }))
    act(() => window.history.forward())
    await waitFor(() => expect(result.current.route).toEqual({ page: 'screening', conversationId: 'two' }))
    expect(onHistoryChange).toHaveBeenCalledTimes(2)
  })

  it('starts a fresh research conversation without a hash despite a stored page', () => {
    sessionStorage.setItem('app.page', '"news"')
    const historyLength = window.history.length
    const { result } = renderHook(() => useWorkspaceRoute())
    expect(window.location.hash).toBe('#/research/new')
    expect(result.current.route).toEqual({ page: 'screening', newDraft: true })
    expect(window.history.length).toBe(historyLength)
    act(() => result.current.navigate({ page: 'conditions', conversationId: 'one', view: 'conversation' }, { replace: true }))
    expect(window.location.hash).toBe('#/screening/one')
    expect(window.history.length).toBe(historyLength)
  })

  it('keeps screening drafts and saved records intact when the root URL opens research', () => {
    sessionStorage.setItem('app.page', '"conditions"')
    sessionStorage.setItem('conditions.section', '"history"')
    localStorage.setItem('conversation.active.screening.screening', 'saved-screening')
    sessionStorage.setItem('conversation.drafts', JSON.stringify({ 'screening:screening:new': '待完成条件' }))
    const { result } = renderHook(() => useWorkspaceRoute())
    expect(result.current.route).toEqual({ page: 'screening', newDraft: true })
    expect(window.location.hash).toBe('#/research/new')
    expect(localStorage.getItem('conversation.active.screening.screening')).toBe('saved-screening')
    expect(JSON.parse(sessionStorage.getItem('conversation.drafts')!)['screening:screening:new']).toBe('待完成条件')
  })

  it('preserves an explicit screening link even when the default entry is research', () => {
    window.history.replaceState(null, '', '#/screening/saved-screening?scope=technical')
    const { result } = renderHook(() => useWorkspaceRoute())
    expect(result.current.route).toEqual({ page: 'conditions', conversationId: 'saved-screening', scope: 'technical', view: 'conversation' })
    expect(window.location.hash).toBe('#/screening/saved-screening?scope=technical')
  })
})
