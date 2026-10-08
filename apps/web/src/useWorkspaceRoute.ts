import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { parseWorkspaceRoute, persistWorkspaceRoute, workspaceRouteHash, type WorkspaceRoute } from './workspaceRoute'

export function useWorkspaceRoute(onHistoryChange?: () => void) {
  const historyCallback = useRef(onHistoryChange)
  historyCallback.current = onHistoryChange
  const [route, setRoute] = useState<WorkspaceRoute>(() => {
    const initial = parseWorkspaceRoute(window.location.hash) ?? { page: 'screening' as const, newDraft: true }
    persistWorkspaceRoute(initial)
    return initial
  })
  const current = useRef(route)
  const navigate = useCallback((next: WorkspaceRoute, options: { replace?: boolean } = {}) => {
    if (next.page === 'home') next = { page: 'screening', newDraft: true }
    const hash = workspaceRouteHash(next)
    if (window.location.hash !== hash) window.history[options.replace ? 'replaceState' : 'pushState'](null, '', hash)
    persistWorkspaceRoute(next)
    if (workspaceRouteHash(current.current) === hash) return
    current.current = next
    setRoute(next)
  }, [])
  useLayoutEffect(() => {
    // Canonicalize a legacy launch once, without adding a fake Back step.
    const initialHash = workspaceRouteHash(current.current)
    if (window.location.hash !== initialHash) window.history.replaceState(null, '', initialHash)
    const restore = () => {
      const next = parseWorkspaceRoute(window.location.hash)
      if (!next && window.location.hash && !window.location.hash.startsWith('#/')) return
      const target = next ?? { page: 'screening' as const, newDraft: true }
      if (workspaceRouteHash(target) === workspaceRouteHash(current.current)) return
      persistWorkspaceRoute(target)
      current.current = target
      historyCallback.current?.()
      setRoute(target)
    }
    window.addEventListener('popstate', restore)
    window.addEventListener('hashchange', restore)
    return () => { window.removeEventListener('popstate', restore); window.removeEventListener('hashchange', restore) }
  }, [])
  return { route, navigate }
}
