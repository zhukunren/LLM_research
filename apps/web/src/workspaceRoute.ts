import type { ConversationScope } from './api'
import { isPageId, type PageId } from './navigation'

export type ScreeningView = 'conversation' | 'create' | 'library' | 'compose' | 'history'
export type WorkspaceRoute = {
  page: PageId
  conversationId?: string
  projectId?: string
  candidateId?: string
  runId?: string
  scope?: ConversationScope
  view?: ScreeningView
  newDraft?: boolean
  observationTab?: 'candidates' | 'batches'
}
const scopes: ConversationScope[] = ['screening', 'technical', 'news', 'report', 'pattern']
const views: ScreeningView[] = ['conversation', 'create', 'library', 'compose', 'history']
const objectId = /^[A-Za-z0-9_-]{1,100}$/
const simplePaths: Partial<Record<PageId, string>> = { home: 'home', news: 'library/news', technical: 'library/technical', patterns: 'library/patterns', reports: 'library/reports' }

/** Public paths use product names; legacy page IDs stay behind this mapping. */
export function parseWorkspaceRoute(hash: string): WorkspaceRoute | null {
  if (!hash.startsWith('#/')) return null
  const [path, query = ''] = hash.slice(2).split('?')
  let parts: string[]
  try { parts = path.replace(/\/$/, '').split('/').map(decodeURIComponent) } catch { return null }
  const params = new URLSearchParams(query)
  const scope = params.get('scope')
  if (scope && !scopes.includes(scope as ConversationScope)) return null
  if (parts.length === 1 && parts[0] === 'home') return { page: 'home' }
  if (parts[0] === 'library' && parts.length === 2 && ['news', 'technical', 'patterns', 'reports'].includes(parts[1])) return { page: parts[1] as PageId }
  if (parts[0] === 'research' || parts[0] === 'screening') {
    if (parts.length > 2 || (parts[1] && !objectId.test(parts[1]))) return null
    const view = params.get('view')
    if (view && !views.includes(view as ScreeningView)) return null
    const page = parts[0] === 'research' ? 'screening' : 'conditions'
    return { page, ...(parts[1] === 'new' ? { newDraft: true } : parts[1] ? { conversationId: parts[1] } : {}),
      ...(scope ? { scope: scope as ConversationScope } : {}), ...(page === 'conditions' ? { view: parts[1] ? 'conversation' : (view as ScreeningView || 'conversation') } : {}) }
  }
  if (parts[0] === 'projects' && parts.length <= 2 && (!parts[1] || objectId.test(parts[1]))) return { page: 'research', ...(parts[1] ? { projectId: parts[1] } : {}) }
  if (parts[0] === 'observation') {
    if (parts.length === 1) return { page: 'watchlist' }
    if (parts.length > 3 || !['candidates', 'batches'].includes(parts[1]) || (parts[2] && !objectId.test(parts[2]))) return null
    return { page: 'watchlist', observationTab: parts[1] as 'candidates' | 'batches', ...(parts[2] ? parts[1] === 'candidates' ? { candidateId: parts[2] } : { runId: parts[2] } : {}) }
  }
  return null
}

export function workspaceRouteHash(route: WorkspaceRoute): string {
  const params = new URLSearchParams()
  if ((route.page === 'screening' || route.page === 'conditions') && route.scope && route.scope !== 'screening') params.set('scope', route.scope)
  if (route.page === 'conditions' && !route.conversationId && !route.newDraft && route.view && route.view !== 'conversation') params.set('view', route.view)
  const id = route.conversationId ? encodeURIComponent(route.conversationId) : route.newDraft ? 'new' : ''
  const path = route.page === 'screening' ? `research${id ? '/' + id : ''}`
    : route.page === 'conditions' ? `screening${id ? '/' + id : ''}`
      : route.page === 'research' ? `projects${route.projectId ? '/' + encodeURIComponent(route.projectId) : ''}`
        : route.page === 'watchlist' ? `observation${route.runId ? '/batches/' + encodeURIComponent(route.runId) : route.candidateId ? '/candidates/' + encodeURIComponent(route.candidateId) : route.observationTab ? '/' + route.observationTab : ''}`
          : simplePaths[route.page] || 'home'
  return '#/' + path + (params.size ? '?' + params.toString() : '')
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
  if (!isPageId(page)) return { page: 'home' }
  const scope = storedConversationScope()
  if (page === 'conditions') {
    return { page, scope, view: storedScreeningView() }
  }
  if (page === 'screening') return { page, scope: scopes.includes(scope) ? scope : 'screening' }
  if (page === 'research') {
    const id = stored('research.selectedProject', '')
    return { page, ...(typeof id === 'string' && objectId.test(id) ? { projectId: id } : {}) }
  }
  if (page === 'watchlist') {
    const runId = stored('observation.run', ''), candidateId = stored('observation.candidate', '')
    return { page, ...(typeof runId === 'string' && objectId.test(runId) ? { runId, observationTab: 'batches' as const }
      : typeof candidateId === 'string' && objectId.test(candidateId) ? { candidateId, observationTab: 'candidates' as const } : {}) }
  }
  return { page }
}

/** Keep old reading/draft storage keys intact while URL wins for an explicit object. */
export function persistWorkspaceRoute(route: WorkspaceRoute) {
  try {
    sessionStorage.setItem('app.page', JSON.stringify(route.page))
    if (route.scope) sessionStorage.setItem('app.conversationScope', JSON.stringify(route.scope))
    if (route.page === 'conditions') sessionStorage.setItem('conditions.section', JSON.stringify(route.view ?? 'conversation'))
    if (route.projectId) sessionStorage.setItem('research.selectedProject', JSON.stringify(route.projectId))
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
