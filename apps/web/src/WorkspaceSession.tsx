import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceTab } from './workspaceTabs'

type Session = { id: string; active: boolean; legacy?: boolean; portalTarget?: HTMLElement; actionsTarget?: HTMLElement | null; setTitle?: (title: string) => void }
const WorkspaceSession = createContext<Session>({ id: '', active: true })
export const useWorkspaceSession = () => useContext(WorkspaceSession)

/** A local surface owns its drafts and popovers without changing its parent tab. */
export function EmbeddedWorkspaceSession({ id, active, portalTarget, children }: { id: string; active: boolean; portalTarget: HTMLElement; children: ReactNode }) {
  return <WorkspaceSession.Provider value={{ id, active, portalTarget }}>{children}</WorkspaceSession.Provider>
}

/** Detach inactive DOM, preserving editors, scroll positions and running work.
 * Only the active document contributes IDs, labels and focusable controls. */
export function WorkspaceSessionPane({ tab, active, onTitle, actionsTarget, children }: { tab: WorkspaceTab; active: boolean; onTitle: (title: string) => void; actionsTarget?: HTMLElement | null; children: ReactNode }) {
  const mount = useRef<HTMLDivElement>(null)
  const [host] = useState(() => document.createElement('section'))
  const isActive = useRef(active)
  isActive.current = active
  const scrollPositions = useRef(new Map<HTMLElement, { top: number; left: number }>())
  useLayoutEffect(() => {
    const remember = (event: Event) => {
      const target = event.target
      if (isActive.current && target instanceof HTMLElement && target.isConnected) scrollPositions.current.set(target, { top: target.scrollTop, left: target.scrollLeft })
    }
    host.addEventListener('scroll', remember, true)
    return () => host.removeEventListener('scroll', remember, true)
  }, [host])
  useLayoutEffect(() => {
    host.className = 'page-frame'
    host.id = `workspace-panel-${tab.id}`
    host.setAttribute('role', 'tabpanel')
    host.setAttribute('aria-labelledby', `workspace-tab-${tab.id}`)
    host.dataset.page = tab.route.page
    if (tab.route.view) host.dataset.view = tab.route.view
    else delete host.dataset.view
  }, [host, tab.id, tab.route.page, tab.route.view])
  useLayoutEffect(() => {
    const restoreScroll = () => {
      for (const [element, position] of scrollPositions.current) {
        if (!host.contains(element)) { scrollPositions.current.delete(element); continue }
        element.scrollTop = position.top
        element.scrollLeft = position.left
      }
    }
    if (active) { mount.current?.append(host); restoreScroll() }
    else host.remove()
    // Charts and growing composers need the visible pane's actual dimensions.
    const frame = active ? requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'))
      restoreScroll()
    }) : 0
    return () => { cancelAnimationFrame(frame); host.remove() }
  }, [active, host])
  return <div ref={mount} className="workspace-panel-mount" hidden={!active}>
    {createPortal(<WorkspaceSession.Provider value={{ id: tab.id, active, legacy: tab.legacy || !!tab.route.conversationId, portalTarget: host, actionsTarget, setTitle: onTitle }}>{children}</WorkspaceSession.Provider>, host)}
  </div>
}
