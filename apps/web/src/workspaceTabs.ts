import { briefKinds } from './intelligence'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ConversationSourceReference } from './api'
import { sessionStorage } from './authStorage'
import { isPageId, workspaceMenus } from './navigation'
import { normalizeWorkspaceRoute, parseWorkspaceRoute, persistWorkspaceRoute, workspaceRouteHash, type WorkspaceRoute } from './workspaceRoute'

export type WorkspaceSeed = { prompt?: string; assistantId?: string; source?: { reference: ConversationSourceReference; label: string }; fresh?: boolean }
export type WorkspaceTab = { id: string; route: WorkspaceRoute; title: string; seed?: WorkspaceSeed; legacy?: boolean }
type ClosedTab = { tab: WorkspaceTab; index: number; order: string[] }
type TabState = { tabs: WorkspaceTab[]; activeId: string; closedTabs: ClosedTab[] }
const STORAGE_KEY = 'app.workspaceTabs.v1'
const CLOSED_TAB_LIMIT = 20
const freshRoute: WorkspaceRoute = { page: 'screening', newDraft: true }
const newId = () => crypto.randomUUID()

export function workspaceTabTitle(route: WorkspaceRoute) {
  route = normalizeWorkspaceRoute(route)
  if (route.page === 'intelligence') return briefKinds.find(item => item.id === (route.briefKind || 'market'))?.name || '情报台'
  if (route.page === 'screening') return route.conversationId ? '研究对话' : '新研究'
  if (route.page === 'conditions') return ({ saved: '我的方案', history: '选股记录', library: '我的条件', compose: '高级组合', create: '描述条件', conversation: route.conversationId ? '选股对话' : '新选股' })[route.view || 'conversation']
  if (route.page === 'library') return route.libraryTab === 'reports' ? '研报与公告' : '资讯'
  return workspaceMenus.find(item => item.id === route.page)?.label || '研究'
}

function makeTab(route: WorkspaceRoute, seed?: WorkspaceSeed): WorkspaceTab {
  route = normalizeWorkspaceRoute(route)
  return { id: newId(), route, title: workspaceTabTitle(route), ...(seed ? { seed } : {}) }
}

function migrateSavedTab(tab: WorkspaceTab): WorkspaceTab {
  if (!tab?.route) return tab
  if ((tab?.route?.page as string) === 'technical') {
    const route = parseWorkspaceRoute('#/library/technical' + (tab.route.workspace === 'screening' ? '?workspace=screening' : ''))!
    return { ...tab, route, title: workspaceTabTitle(route) }
  }
  const route = normalizeWorkspaceRoute(tab.route)
  if (route === tab.route) return tab
  return { ...tab, route, title: workspaceTabTitle(route) }
}

function validTab(tab: WorkspaceTab | null | undefined): tab is WorkspaceTab {
  return !!tab && typeof tab.id === 'string' && /^[\w-]+$/.test(tab.id) && typeof tab.title === 'string' && !!tab.route && isPageId(tab.route.page) && !!parseWorkspaceRoute(workspaceRouteHash(tab.route))
}

function savedTab({ seed, ...tab }: WorkspaceTab): WorkspaceTab {
  // Launch seeds are one-shot instructions. Reopening restores stored editing
  // state without resetting a fresh draft or replaying an already used prompt.
  return tab
}

function initialState(): TabState {
  const route = parseWorkspaceRoute(window.location.hash) ?? freshRoute
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') as TabState | null
    if (saved && Array.isArray(saved.tabs)) {
      const tabs = saved.tabs.map(migrateSavedTab).filter(validTab)
        .filter((tab, index, all) => all.findIndex(item => item.id === tab.id) === index)
      const closedTabs = (Array.isArray(saved.closedTabs) ? saved.closedTabs : []).map(item => item && ({ ...item, tab: migrateSavedTab(item.tab) })).filter(item => item && validTab(item.tab)
        && Number.isInteger(item.index) && item.index >= 0 && Array.isArray(item.order) && item.order.every(id => typeof id === 'string')
        && !tabs.some(tab => tab.id === item.tab.id))
        .filter((item, index, all) => !all.slice(index + 1).some(record => record.tab.id === item.tab.id))
        .slice(-CLOSED_TAB_LIMIT).map(item => ({ ...item, tab: savedTab(item.tab) }))
      if (tabs.length) {
        const selected = tabs.find(tab => tab.id === saved.activeId && workspaceRouteHash(tab.route) === workspaceRouteHash(route))
          ?? tabs.find(tab => workspaceRouteHash(tab.route) === workspaceRouteHash(route))
        if (selected) return { tabs, activeId: selected.id, closedTabs }
        const added = makeTab(route)
        return { tabs: [...tabs, added], activeId: added.id, closedTabs }
      }
    }
  } catch { /* Invalid or unavailable storage must not prevent navigation. */ }
  const tab = { ...makeTab(route), legacy: true }
  return { tabs: [tab], activeId: tab.id, closedTabs: [] }
}

/** The URL follows the active tab; background location updates never take focus. */
export function useWorkspaceTabs() {
  const [state, setState] = useState<TabState>(initialState)
  const current = useRef(state)
  current.current = state

  function publish(next: TabState, replace = false, history = true) {
    current.current = next
    const active = next.tabs.find(tab => tab.id === next.activeId)!
    if (history) {
      const hash = workspaceRouteHash(active.route)
      if (window.location.hash !== hash || window.history.state?.workspaceTabId !== active.id) {
        window.history[replace ? 'replaceState' : 'pushState']({ workspaceTabId: active.id }, '', hash)
      }
      persistWorkspaceRoute(active.route)
    }
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, tabs: next.tabs.map(savedTab) })) } catch { /* Tabs still work in memory. */ }
    setState(next)
  }

  function activate(id: string) {
    if (current.current.tabs.some(tab => tab.id === id)) publish({ ...current.current, activeId: id })
  }

  function open(route: WorkspaceRoute, options: { seed?: WorkspaceSeed; forceNew?: boolean; reusePage?: boolean } = {}) {
    route = normalizeWorkspaceRoute(route)
    const previous = current.current
    const existing = !options.forceNew && [...previous.tabs].reverse().find(tab => options.reusePage
      ? tab.route.page === route.page && (tab.route.workspace ?? 'research') === (route.workspace ?? 'research') && (route.page !== 'conditions' || (tab.route.view || 'conversation') === (route.view || 'conversation'))
      : workspaceRouteHash(tab.route) === workspaceRouteHash(route))
    if (existing) { activate(existing.id); return existing.id }
    const tab = makeTab(route, options.seed)
    publish({ ...previous, tabs: [...previous.tabs, tab], activeId: tab.id })
    return tab.id
  }

  function update(id: string, route: WorkspaceRoute, replace = true) {
    route = normalizeWorkspaceRoute(route)
    const previous = current.current, tab = previous.tabs.find(item => item.id === id)
    if (!tab || workspaceRouteHash(tab.route) === workspaceRouteHash(route)) return
    const title = tab.route.page === route.page && (route.page !== 'library' || tab.route.libraryTab === route.libraryTab)
      ? tab.title : workspaceTabTitle(route)
    publish({ ...previous, tabs: previous.tabs.map(item => item.id === id ? { ...item, route, title } : item) }, replace, previous.activeId === id)
  }

  function rename(id: string, title: string) {
    const previous = current.current, value = title.trim().slice(0, 120)
    if (!value || previous.tabs.find(tab => tab.id === id)?.title === value) return
    publish({ ...previous, tabs: previous.tabs.map(tab => tab.id === id ? { ...tab, title: value } : tab) }, true, false)
  }

  function publishClosed(tabs: WorkspaceTab[], activeId: string, remember = true) {
    const previous = current.current, remaining = new Set(tabs.map(tab => tab.id)), order = previous.tabs.map(tab => tab.id)
    const removed = previous.tabs.flatMap((tab, index) => remaining.has(tab.id) ? [] : [{ tab: savedTab(tab), index, order }])
    // A bulk close restores the previously active page first, then the other
    // closed tabs one at a time. Saved neighbors retain their relative order.
    const records = [...removed.filter(item => item.tab.id !== previous.activeId), ...removed.filter(item => item.tab.id === previous.activeId)]
    const closedTabs = remember ? [...previous.closedTabs, ...records].slice(-CLOSED_TAB_LIMIT) : previous.closedTabs
    publish({ ...previous, tabs, activeId, closedTabs }, true)
  }

  function close(id: string, options: { remember?: boolean } = {}) {
    const previous = current.current, index = previous.tabs.findIndex(tab => tab.id === id)
    if (index < 0) return
    let tabs = previous.tabs.filter(tab => tab.id !== id)
    if (!tabs.length) tabs = [makeTab(freshRoute, { fresh: true })]
    const activeId = previous.activeId === id ? tabs[Math.min(index, tabs.length - 1)].id : previous.activeId
    publishClosed(tabs, activeId, options.remember !== false)
  }

  function closeOthers(id: string) {
    const tab = current.current.tabs.find(item => item.id === id)
    if (tab) publishClosed([tab], tab.id)
  }

  function closeSide(id: string, side: 'left' | 'right') {
    const previous = current.current, index = previous.tabs.findIndex(tab => tab.id === id)
    if (index < 0 || (side === 'left' ? index === 0 : index === previous.tabs.length - 1)) return
    const tabs = side === 'left' ? previous.tabs.slice(index) : previous.tabs.slice(0, index + 1)
    const activeId = tabs.some(tab => tab.id === previous.activeId) ? previous.activeId : id
    publishClosed(tabs, activeId)
  }

  function closeAll() {
    const tab = makeTab(freshRoute, { fresh: true })
    publishClosed([tab], tab.id)
  }

  function reopenClosed() {
    const previous = current.current, record = previous.closedTabs.at(-1)
    if (!record) return
    const closedTabs = previous.closedTabs.slice(0, -1), tab = savedTab(record.tab)
    const existing = previous.tabs.find(item => item.id === tab.id || (!tab.route.newDraft && workspaceRouteHash(item.route) === workspaceRouteHash(tab.route)))
    if (existing) { publish({ ...previous, activeId: existing.id, closedTabs }); return }
    const tabs = [...previous.tabs], available = new Set(tabs.map(item => item.id))
    const right = record.order.slice(record.index + 1).find(id => available.has(id))
    const left = record.order.slice(0, record.index).reverse().find(id => available.has(id))
    const index = right ? tabs.findIndex(item => item.id === right) : left ? tabs.findIndex(item => item.id === left) + 1 : Math.min(record.index, tabs.length)
    tabs.splice(index, 0, tab)
    publish({ ...previous, tabs, activeId: tab.id, closedTabs })
  }

  function forgetClosedConversation(id: string) {
    const previous = current.current, closedTabs = previous.closedTabs.filter(record => record.tab.route.conversationId !== id)
    if (closedTabs.length !== previous.closedTabs.length) publish({ ...previous, closedTabs }, true, false)
  }

  function move(id: string, targetId: string, placement: 'before' | 'after') {
    const previous = current.current, tab = previous.tabs.find(item => item.id === id)
    if (!tab || id === targetId || !previous.tabs.some(item => item.id === targetId)) return
    const tabs = previous.tabs.filter(item => item.id !== id)
    const index = tabs.findIndex(item => item.id === targetId) + (placement === 'after' ? 1 : 0)
    tabs.splice(index, 0, tab)
    if (tabs.every((item, offset) => item.id === previous.tabs[offset].id)) return
    // Reordering keeps every pane and its active URL; only the saved order changes.
    publish({ ...previous, tabs }, true, false)
  }

  useLayoutEffect(() => {
    publish(current.current, true)
    const restore = () => {
      const route = parseWorkspaceRoute(window.location.hash)
      if (!route && window.location.hash && !window.location.hash.startsWith('#/')) return
      const target = route ?? freshRoute, previous = current.current
      const selected = previous.tabs.find(tab => tab.id === window.history.state?.workspaceTabId && workspaceRouteHash(tab.route) === workspaceRouteHash(target))
        ?? previous.tabs.find(tab => workspaceRouteHash(tab.route) === workspaceRouteHash(target))
      if (selected) { if (selected.id !== previous.activeId) publish({ ...previous, activeId: selected.id }, true); return }
      const historicalTab = previous.tabs.find(tab => tab.id === window.history.state?.workspaceTabId && tab.route.page === target.page)
      if (historicalTab) {
        publish({ ...previous, tabs: previous.tabs.map(tab => tab.id === historicalTab.id ? { ...tab, route: target } : tab), activeId: historicalTab.id }, true)
        return
      }
      const tab = makeTab(target)
      publish({ ...previous, tabs: [...previous.tabs, tab], activeId: tab.id }, true)
    }
    window.addEventListener('popstate', restore)
    window.addEventListener('hashchange', restore)
    return () => { window.removeEventListener('popstate', restore); window.removeEventListener('hashchange', restore) }
  }, [])

  return { tabs: state.tabs, activeId: state.activeId, activeTab: state.tabs.find(tab => tab.id === state.activeId)!, canReopen: state.closedTabs.length > 0, open, activate, update, rename, close, closeOthers, closeSide, closeAll, move, reopenClosed, forgetClosedConversation }
}
