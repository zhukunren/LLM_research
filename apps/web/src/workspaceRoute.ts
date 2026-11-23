import { briefKinds, type BriefKind } from './intelligence'
import type { ConversationScope, WorkflowType } from './api'
import { localStorage, sessionStorage } from './authStorage'
import { clientServiceMenus, isPageId, type PageId, type ServiceView } from './navigation'
import { isScreeningMethod, type ScreeningMethod } from './screeningMethods'

export type ScreeningView = 'conversation' | 'create' | 'library' | 'compose' | 'history' | 'saved'
export type { ServiceView } from './navigation'
export type ObservationTab = 'candidates' | 'batches'
export type WorkspaceRoute = {
  page: PageId
  conversationId?: string
  candidateId?: string
  runId?: string
  observationCode?: string
  scope?: ConversationScope
  view?: ScreeningView
  newDraft?: boolean
  observationTab?: ObservationTab
  workspace?: WorkflowType
  indicators?: 'common'
  briefKind?: BriefKind
  briefId?: string
  libraryTab?: 'news' | 'reports'
  screeningMethod?: ScreeningMethod
  serviceView?: ServiceView
}
const scopes: ConversationScope[] = ['screening', 'technical', 'news', 'report', 'pattern']
const views: ScreeningView[] = ['conversation', 'create', 'library', 'compose', 'history', 'saved']
const retiredObservationTabs = ['all', 'updates', 'expectations', 'portfolio']
const objectId = /^[A-Za-z0-9_-]{1,100}$/
const stockCode = /^\d{6}\.(SH|SZ|BJ)$/
const simplePaths: Partial<Record<PageId, string>> = { qmt: 'tools/qmt', 'daily-signals': 'tools/daily-signals', etf: 'tools/etf', 'data-download': 'tools/data-download', 'client-service': 'tools/client-service', patterns: 'library/patterns' }

/** Canonical runtime routes for legacy navigation IDs. */
export function normalizeWorkspaceRoute(route: WorkspaceRoute): WorkspaceRoute {
  if (route.page === 'client-service' && String(route.serviceView) === 'diagnosis') return { ...route, serviceView: 'suggestions' }
  if (route.page === 'home') return { page: 'screening', newDraft: true }
  if (route.page === 'news' || route.page === 'reports') return {
    page: 'library', libraryTab: route.page === 'reports' ? 'reports' : 'news',
    ...(route.workspace === 'screening' ? { workspace: 'screening' as const } : {}),
  }
  if (route.page === 'watchlist' && route.observationTab && retiredObservationTabs.includes(route.observationTab)) return { ...route, observationTab: undefined }
  return route
}

/** Public paths use product names; legacy page IDs stay behind this mapping. */
export function parseWorkspaceRoute(hash: string): WorkspaceRoute | null {
  if (!hash.startsWith('#/')) return null
  const [path, query = ''] = hash.slice(2).split('?')
  let parts: string[]
  try { parts = path.replace(/\/$/, '').split('/').map(decodeURIComponent) } catch { return null }
  const params = new URLSearchParams(query)
  const workspace = params.get('workspace')
  if (workspace && !['research', 'screening'].includes(workspace)) return null
  const sharedWorkspace = workspace === 'screening' ? { workspace: 'screening' as const } : {}
  const scope = params.get('scope')
  if (scope && !scopes.includes(scope as ConversationScope)) return null
  const method = params.get('method')
  if (method && !isScreeningMethod(method)) return null
  if (parts[0] === 'screening' && parts[1] === 'method' && parts.length === 3) {
    return isScreeningMethod(parts[2]) ? screeningMethodRoute(parts[2]) : null
  }
  if (parts[0] === 'intelligence' && parts.length <= 3) {
    if (parts[1] && !briefKinds.some(item => item.id === parts[1]) || parts[2] && !objectId.test(parts[2])) return null
    return { page: 'intelligence', briefKind: (parts[1] || 'market') as WorkspaceRoute['briefKind'], ...(parts[2] ? { briefId: parts[2] } : {}) }
  }
  if (parts[0] === 'library' && parts.length === 1) {
    const type = params.get('type')
    if (type && !['news', 'reports'].includes(type)) return null
    return { page: 'library', libraryTab: type === 'reports' ? 'reports' : 'news', ...sharedWorkspace }
  }
  if (parts.length === 1 && parts[0] === 'home') return { page: 'screening', newDraft: true }
  if (parts.length === 1 && parts[0] === 'assistants') return { page: 'screening', newDraft: true }
  if (parts.length === 2 && parts[0] === 'tools' && parts[1] === 'qmt') return { page: 'qmt', ...sharedWorkspace }
  if (parts.length === 2 && parts[0] === 'tools' && parts[1] === 'daily-signals') return { page: 'daily-signals', ...sharedWorkspace }
  if (parts.length === 2 && parts[0] === 'tools' && parts[1] === 'etf') return { page: 'etf', ...sharedWorkspace }
  if (parts.length === 2 && parts[0] === 'tools' && parts[1] === 'data-download') return { page: 'data-download', ...sharedWorkspace }
  if (parts.length === 2 && parts[0] === 'tools' && parts[1] === 'client-service') {
    const requestedView = params.get('view')
    const view = requestedView === 'diagnosis' ? 'suggestions' : requestedView
    if (view && !clientServiceMenus.some(item => item.id === view)) return null
    return { page: 'client-service', ...sharedWorkspace, ...(view && view !== 'cards' ? { serviceView: view as ServiceView } : {}) }
  }
  if (parts.length === 2 && parts[0] === 'library' && parts[1] === 'technical') return { page: workspace === 'screening' ? 'conditions' : 'screening', newDraft: true, scope: 'technical', indicators: 'common', ...(workspace === 'screening' ? { view: 'conversation' } : {}) }
  if (parts[0] === 'library' && parts.length === 2 && ['news', 'patterns', 'reports'].includes(parts[1])) {
    if (parts[1] === 'patterns') return { page: 'patterns', ...sharedWorkspace }
    return { page: 'library', libraryTab: parts[1] === 'reports' ? 'reports' : 'news', ...sharedWorkspace }
  }
  if (parts[0] === 'research' || parts[0] === 'screening') {
    if (parts.length > 2 || (parts[1] && !objectId.test(parts[1]))) return null
    const view = params.get('view')
    if (view && !views.includes(view as ScreeningView)) return null
    const page = parts[0] === 'research' ? 'screening' : 'conditions'
    return { page, ...(parts[1] === 'new' ? { newDraft: true } : parts[1] ? { conversationId: parts[1] } : {}),
      ...(scope ? { scope: scope as ConversationScope } : {}), ...(params.get('indicators') === 'common' ? { indicators: 'common' as const } : {}), ...(page === 'conditions' ? { view: parts[1] ? 'conversation' : (view as ScreeningView || 'conversation'), ...(method && method !== 'pattern' ? { screeningMethod: method as ScreeningMethod } : {}) } : {}) }
  }
  if (parts[0] === 'projects' && parts.length <= 2 && (!parts[1] || objectId.test(parts[1]))) return { page: 'screening', newDraft: true }
  if (parts[0] === 'observation') {
    const [, section, id, code] = parts
    if (parts.length === 1 || (parts.length === 2 && retiredObservationTabs.includes(section))) return { page: 'watchlist', ...sharedWorkspace }
    if ((section !== 'candidates' && section !== 'batches') || parts.length > 4 || (id && !objectId.test(id))
        || (section === 'candidates' && parts.length > 3) || (code && (!id || !stockCode.test(code)))) return null
    return { page: 'watchlist', ...sharedWorkspace, observationTab: section,
      ...(id ? section === 'candidates' ? { candidateId: id } : { runId: id, ...(code ? { observationCode: code } : {}) } : {}) }
  }
  return null
}

export function workspaceRouteHash(input: WorkspaceRoute): string {
  const route = normalizeWorkspaceRoute(input)
  if (route.screeningMethod && !route.conversationId && (route.page === 'patterns' && route.screeningMethod === 'pattern' || route.page === 'conditions' && (route.view ?? 'conversation') === 'conversation')) return `#/screening/method/${route.screeningMethod}`
  if (route.page === 'intelligence') return `#/intelligence/${route.briefKind || 'market'}${route.briefId ? '/' + encodeURIComponent(route.briefId) : ''}`
  if (route.page === 'library') return `#/library?type=${route.libraryTab || 'news'}${route.workspace === 'screening' ? '&workspace=screening' : ''}`
  const params = new URLSearchParams()
  if (route.page === 'client-service' && route.serviceView && route.serviceView !== 'cards') params.set('view', route.serviceView)
  if (route.workspace === 'screening' && ['news', 'patterns', 'reports', 'watchlist', 'qmt', 'daily-signals', 'etf', 'data-download', 'client-service'].includes(route.page)) params.set('workspace', 'screening')
  if ((route.page === 'screening' || route.page === 'conditions') && route.scope && route.scope !== 'screening') params.set('scope', route.scope)
  if ((route.page === 'screening' || route.page === 'conditions') && route.indicators === 'common') params.set('indicators', 'common')
  if (route.page === 'conditions' && route.conversationId && route.screeningMethod && route.screeningMethod !== 'pattern') params.set('method', route.screeningMethod)
  if (route.page === 'conditions' && !route.conversationId && !route.newDraft && route.view && route.view !== 'conversation') params.set('view', route.view)
  const id = route.conversationId ? encodeURIComponent(route.conversationId) : route.newDraft ? 'new' : ''
  const path = route.page === 'screening' ? `research${id ? '/' + id : ''}`
    : route.page === 'conditions' ? `screening${id ? '/' + id : ''}`
      : route.page === 'watchlist' ? `observation${route.runId ? '/batches/' + encodeURIComponent(route.runId) + (route.observationCode ? '/' + encodeURIComponent(route.observationCode) : '') : route.candidateId ? '/candidates/' + encodeURIComponent(route.candidateId) : route.observationTab ? '/' + route.observationTab : ''}`
        : simplePaths[route.page] || 'home'
  return '#/' + path + (params.size ? '?' + params.toString() : '')
}

export function screeningMethodRoute(method: ScreeningMethod): WorkspaceRoute {
  return method === 'pattern' ? { page: 'patterns', workspace: 'screening', screeningMethod: method }
    : { page: 'conditions', view: 'conversation', scope: method, newDraft: true, screeningMethod: method }
}

function stored<T>(key: string, fallback: T): T {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? fallback } catch { return fallback }
}
export function storedConversationScope(): ConversationScope {
  const scope = stored<ConversationScope>('app.conversationScope', 'screening')
  return scopes.includes(scope) ? scope : 'screening'
}
export function storedScreeningView(): ScreeningView {
  const view = stored<ScreeningView>('conditions.section', 'conversation')
  return views.includes(view) ? view : 'conversation'
}
export function legacyWorkspaceRoute(): WorkspaceRoute {
  const page = stored<string>('app.page', 'home')
  if (page === 'technical') return parseWorkspaceRoute('#/library/technical')!
  if (page === 'news' || page === 'reports') return normalizeWorkspaceRoute({ page })
  if (!isPageId(page) || page === 'home') return { page: 'screening', newDraft: true }
  const scope = storedConversationScope()
  if (page === 'conditions') {
    return { page, scope, view: storedScreeningView() }
  }
  if (page === 'screening') return { page, scope: scopes.includes(scope) ? scope : 'screening' }
  if (page === 'watchlist') {
    const runId = stored('observation.run', ''), candidateId = stored('observation.candidate', '')
    return { page, ...(typeof runId === 'string' && objectId.test(runId) ? { runId, observationTab: 'batches' as const }
      : typeof candidateId === 'string' && objectId.test(candidateId) ? { candidateId, observationTab: 'candidates' as const } : {}) }
  }
  return { page }
}

/** Keep old reading/draft storage keys intact while URL wins for an explicit object. */
export function persistWorkspaceRoute(input: WorkspaceRoute) {
  const route = normalizeWorkspaceRoute(input)
  try {
    sessionStorage.setItem('app.page', JSON.stringify(route.page))
    if (route.scope) sessionStorage.setItem('app.conversationScope', JSON.stringify(route.scope))
    if (route.page === 'conditions') sessionStorage.setItem('conditions.section', JSON.stringify(route.view ?? 'conversation'))
    if (route.page === 'watchlist' && (route.runId || route.candidateId || route.observationTab)) {
      sessionStorage.setItem('observation.run', JSON.stringify(route.runId || ''))
      if (route.candidateId) sessionStorage.setItem('observation.candidate', JSON.stringify(route.candidateId))
    }
    if ((route.page === 'screening' || route.page === 'conditions') && (route.conversationId || route.newDraft)) {
      const key = `conversation.active.${route.scope || 'screening'}`
      localStorage.setItem(`${key}.${route.page === 'screening' ? 'research' : 'screening'}`, route.conversationId || '__new__')
    }
  } catch { /* Direct URLs still work with browser storage disabled. */ }
}
