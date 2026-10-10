import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react'
import { AlertCircle, Database, Menu, PanelLeftClose, PanelLeftOpen, RefreshCw } from 'lucide-react'
import { api, conversationWorkflow, type Conversation, type ConversationScope, type ConversationSourceReference, type DataStatus, type WorkflowType } from './api'
const ObservationPage = lazy(() => import('./pages/ObservationPage'))
const ResearchWorkspace = lazy(() => import('./pages/ResearchWorkspace'))
const ScreeningWorkspace = lazy(() => import('./pages/ScreeningWorkspace'))
const PatternPage = lazy(() => import('./pages/PatternPage'))
const LibraryWorkspace = lazy(() => import('./pages/LibraryWorkspace'))
const ResearchProjectsPage = lazy(() => import('./pages/ResearchProjectsPage'))
const ResearchAssistantsPage = lazy(() => import('./pages/ResearchAssistantsPage'))
import ResearchSidebar from './components/ResearchSidebar'
import SystemDrawer from './pages/DataServicesPanel'
import QuickNavigation from './components/QuickNavigation'
import ActiveTasks from './components/ActiveTasks'
import type { Section } from './pages/WorkbenchPage'
import { isText, useSessionState } from './useSessionState'

import { workspaceMenus as menus, type PageId } from './navigation'
import { useWorkspaceRoute } from './useWorkspaceRoute'
import { parseWorkspaceRoute, workspaceRouteHash, storedConversationScope, storedScreeningView, type WorkspaceRoute } from './workspaceRoute'
import { useAssistantLaunch } from './useAssistantLaunch'
import './workspace-switch.css'
export default function App() {
  const [isNavigating, startNavigation] = useTransition()
  const [data, setData] = useState<DataStatus | null>(null)
  const [systemOpen, setSystemOpen] = useState(false)
  const [quickNavigationOpen, setQuickNavigationOpen] = useState(false)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const [sidebarRevision, setSidebarRevision] = useState(0)
  const [homeDraft, setHomeDraft] = useSessionState('home.researchDraft', '', isText)
  const [newResearchKey, setNewResearchKey] = useState(0)
  const [sidebarCollapsed, setSidebarCollapsed] = useSessionState('app.sidebarCollapsed', false, (value): value is boolean => typeof value === 'boolean')
  const [loadError, setLoadError] = useState('')
  const conversationNavigation = useRef(0)
  const assistantLaunch = useAssistantLaunch()
  const [conversationPrompt, setConversationPrompt] = useState<string | undefined>()
  const [conversationAssistant, setConversationAssistant] = useState<string | undefined>()
  const [conversationSource, setConversationSource] = useState<{ reference: ConversationSourceReference; label: string } | null>(null)
  const { route, navigate } = useWorkspaceRoute(() => {
    ++conversationNavigation.current
    setConversationPrompt(undefined)
    setConversationAssistant(undefined)
    setConversationSource(null)
    setNewResearchKey(0)
  })
  const page = route.page
  const [workspacePreference, setWorkspacePreference] = useSessionState<WorkflowType>('app.workspace', 'research', (value): value is WorkflowType => value === 'research' || value === 'screening')
  const workspaceArea: WorkflowType = page === 'conditions' ? 'screening' : ['home', 'screening', 'research', 'assistants'].includes(page) ? 'research' : route.workspace ?? workspacePreference
  const [researchLocation, setResearchLocation] = useSessionState('app.researchLocation', '#/research/new', isText)
  const [screeningLocation, setScreeningLocation] = useSessionState('app.screeningLocation', '#/screening/new', isText)
  useEffect(() => { setWorkspacePreference(workspaceArea) }, [workspaceArea])
  useEffect(() => {
    if (page === 'screening') setResearchLocation(workspaceRouteHash(route))
    if (page === 'conditions') setScreeningLocation(workspaceRouteHash(route))
  }, [route])
  const previousPage = useRef(page)
  const conversationScope = route.scope ?? 'screening'
  const conditionsSection = route.view ?? 'conversation'
  const [resolvedConversation, setResolvedConversation] = useState<{ id: string; scope: ConversationScope; workflow: WorkflowType } | null>(null)
  const [routeError, setRouteError] = useState('')
  const [routeRetry, setRouteRetry] = useState(0)
  const routeRef = useRef(route)
  routeRef.current = route
  const needsConversation = (page === 'screening' || page === 'conditions') && !!route.conversationId
  const conversationReady = !needsConversation || (resolvedConversation?.id === route.conversationId && resolvedConversation?.workflow === (page === 'conditions' ? 'screening' : 'research') && resolvedConversation?.scope === conversationScope)

  function navigateRoute(next: WorkspaceRoute, replace = false, userNavigation = true) {
    // Explicit navigation supersedes any pending conversation lookup. Route
    // canonicalization only publishes resolved identity and must not cancel it.
    if (userNavigation) {
      ++conversationNavigation.current
      setMobileNavigationOpen(false)
    }
    startNavigation(() => navigate(next, { replace }))
  }

  function navigatePage(nextPage: PageId) {
    navigateRoute({ page: nextPage, ...(['news', 'technical', 'patterns', 'reports', 'watchlist'].includes(nextPage) ? { workspace: workspaceArea } : {}), ...((nextPage === 'screening' || nextPage === 'conditions') ? { scope: storedConversationScope() } : {}), ...(nextPage === 'conditions' ? { view: storedScreeningView() } : {}) })
  }

  function switchWorkspace(next: WorkflowType) {
    if (next === workspaceArea) return
    setWorkspacePreference(next)
    setConversationPrompt(undefined); setConversationAssistant(undefined); setConversationSource(null); setNewResearchKey(0)
    const saved = parseWorkspaceRoute(next === 'research' ? researchLocation : screeningLocation)
    navigateRoute(saved?.page === (next === 'research' ? 'screening' : 'conditions') ? saved : { page: next === 'research' ? 'screening' : 'conditions', newDraft: true })
  }

  function openScreeningView(view: 'saved' | 'history' | 'library' | 'compose') {
    setConversationPrompt(undefined); setConversationAssistant(undefined); setConversationSource(null); setNewResearchKey(0)
    navigateRoute({ page: 'conditions', view })
  }

  function navigateFromMenu(nextPage: PageId) {
    ++conversationNavigation.current
    setConversationPrompt(undefined)
    setConversationAssistant(undefined)
    setConversationSource(null)
    navigatePage(nextPage)
  }

  useEffect(() => {
    if (!needsConversation || !route.conversationId || resolvedConversation?.id === route.conversationId) return
    const id = route.conversationId, controller = new AbortController()
    const request = ++conversationNavigation.current
    setRouteError('')
    api<Conversation>(`/conversations/${encodeURIComponent(id)}`, { signal: controller.signal }).then(current => {
      if (controller.signal.aborted || request !== conversationNavigation.current) return
      const workflow = conversationWorkflow(current)
      setResolvedConversation({ id, scope: current.entry_scope, workflow })
      navigateRoute({ page: workflow === 'screening' ? 'conditions' : 'screening', conversationId: id, scope: current.entry_scope, ...(workflow === 'screening' ? { view: 'conversation' as const } : {}) }, true, false)
    }).catch(reason => { if (!controller.signal.aborted && request === conversationNavigation.current) setRouteError((reason as Error).message) })
    return () => controller.abort()
  }, [needsConversation, route.conversationId, resolvedConversation?.id, routeRetry])

  useEffect(() => {
    if (!needsConversation || !resolvedConversation || resolvedConversation.id !== route.conversationId) return
    const targetPage = resolvedConversation.workflow === 'screening' ? 'conditions' : 'screening'
    if (page !== targetPage || conversationScope !== resolvedConversation.scope) navigateRoute({ page: targetPage, conversationId: resolvedConversation.id, scope: resolvedConversation.scope, ...(targetPage === 'conditions' ? { view: 'conversation' as const } : {}) }, true, false)
  }, [needsConversation, route.conversationId, page, conversationScope, resolvedConversation])

  useLayoutEffect(() => {
    if (previousPage.current === page) return
    previousPage.current = page
    // Reset before painting the new page, including when its data arrives later.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    document.querySelector('.page-frame')?.scrollTo?.({ top: 0, left: 0, behavior: 'instant' })
  }, [page])

  function handleConversationScopeChange(scope: ConversationScope) {
    setConversationSource(null)
    navigateRoute({ page, scope, ...(page === 'conditions' ? { view: 'conversation' as const } : {}) })
  }

  function openConversation(scope: ConversationScope, source?: { reference: ConversationSourceReference; label: string }, prompt?: string, workflow: WorkflowType = 'research', assistantId?: string) {
    ++conversationNavigation.current
    // Keep the reset signal with its destination. Publishing it before the
    // route transition lets the previous workflow consume it and reclaim the URL.
    startNavigation(() => {
      setNewResearchKey(value => prompt ? 0 : value + 1)
      setConversationPrompt(prompt)
      setConversationAssistant(assistantId)
      setConversationSource(source ?? null)
      navigateRoute({ page: workflow === 'screening' ? 'conditions' : 'screening', scope, newDraft: true, ...(workflow === 'screening' ? { view: 'conversation' as const } : {}) })
    })
  }

  function openComposition() {
    ++conversationNavigation.current
    setConversationSource(null)
    navigateRoute({ page: 'conditions', view: 'compose' })
  }

  function openConditionDescription() {
    navigateRoute({ page: 'conditions', view: 'create' })
  }

  async function resumeResearch(id: string, scope: ConversationScope, workflow?: WorkflowType, prompt?: string) {
    const request = ++conversationNavigation.current
    setMobileNavigationOpen(false)
    let type = workflow
    if (!prompt) {
      try { const current = await api<Conversation>(`/conversations/${id}`); type = conversationWorkflow(current, workflow); scope = current.entry_scope }
      catch (reason) { if (request === conversationNavigation.current) setLoadError((reason as Error).message); return }
    }
    if (request !== conversationNavigation.current) return
    setNewResearchKey(0)
    setConversationPrompt(prompt)
    setConversationAssistant(undefined)
    setConversationSource(null)
    const actualWorkflow = type ?? 'research'
    startNavigation(() => {
      setResolvedConversation({ id, scope, workflow: actualWorkflow })
      navigateRoute({ page: actualWorkflow === 'screening' ? 'conditions' : 'screening', conversationId: id, scope, ...(actualWorkflow === 'screening' ? { view: 'conversation' as const } : {}) }, false, false)
    })
  }

  function conversationLocation(id: string, scope: ConversationScope, workflow: WorkflowType) {
    const current = routeRef.current
    if (current.page !== 'screening' && current.page !== 'conditions') return
    const next: WorkspaceRoute = { page: workflow === 'screening' ? 'conditions' : 'screening', scope, ...(id ? { conversationId: id } : { newDraft: true }), ...(workflow === 'screening' ? { view: 'conversation' as const } : {}) }
    startNavigation(() => {
      if (id) setResolvedConversation({ id, scope, workflow })
      navigateRoute(next, !current.conversationId && !current.newDraft, false)
    })
  }

  function openProject(id: string) {
    navigateRoute({ page: 'research', ...(id ? { projectId: id } : {}) })
  }

  function startNewResearch() {
    openConversation('screening')
  }

  async function launchAssistant(id: string, mode: 'immediate' | 'draft' = 'draft', name?: string) {
    if (mode !== 'immediate') {
      openConversation('screening', undefined, undefined, 'research', id)
      return
    }
    const request = ++conversationNavigation.current
    setMobileNavigationOpen(false)
    const result = await assistantLaunch.launch(id, name)
    setSidebarRevision(value => value + 1)
    if (result && request === conversationNavigation.current) await resumeResearch(result.conversation_id, 'screening', 'research')
  }

  async function retryAssistantLaunch() {
    const request = ++conversationNavigation.current
    const result = await assistantLaunch.retry()
    setSidebarRevision(value => value + 1)
    if (result && request === conversationNavigation.current) await resumeResearch(result.conversation_id, 'screening', 'research')
  }

  const refreshStatus = () => {
    api<DataStatus>('/data/status').then((result) => { setData(result); setLoadError('') }).catch((error) => setLoadError(error.message))
  }

  useEffect(() => {
    refreshStatus()
  }, [])

  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 900px)')
    if (!media) return
    const closeOnDesktop = () => { if (!media.matches) setMobileNavigationOpen(false) }
    media.addEventListener('change', closeOnDesktop)
    return () => media.removeEventListener('change', closeOnDesktop)
  }, [])

  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (document.querySelector('[role="dialog"][aria-modal="true"]:not([hidden])') && !document.querySelector('.quick-navigation')) return
        setMobileNavigationOpen(false)
        setSystemOpen(false)
        setQuickNavigationOpen(value => !value)
      }
    }
    window.addEventListener('keydown', open)
    return () => window.removeEventListener('keydown', open)
  }, [])

  const active = menus.find((item) => item.id === page)!
  const inResearch = page === 'screening' || page === 'research'
  return (
    <div className={`app-shell redesigned-workspace chat-layout viewport-workspace ${page === 'screening' ? 'chat-page' : 'tool-page'} ${mobileNavigationOpen ? 'mobile-navigation-open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <a className="skip-to-content" href="#workspace-main" onClick={event => { event.preventDefault(); document.getElementById('workspace-main')?.focus() }}>跳到页面内容</a>
      <ResearchSidebar workspace={workspaceArea} screeningView={conditionsSection} onWorkspaceChange={switchWorkspace} onScreeningView={openScreeningView} busy={assistantLaunch.state.loading} onAssistant={launchAssistant} page={page} conversationId={route.conversationId} revision={sidebarRevision} mobileOpen={mobileNavigationOpen} onClose={() => setMobileNavigationOpen(false)} onNavigate={navigateFromMenu} onNewResearch={startNewResearch} onNewScreening={() => openConversation('screening', undefined, undefined, 'screening')} onConversation={resumeResearch} onSearch={() => { setMobileNavigationOpen(false); setQuickNavigationOpen(true) }} onSettings={() => { setMobileNavigationOpen(false); setSystemOpen(true) }} />
      <main id="workspace-main" tabIndex={-1} className="main-shell" aria-busy={isNavigating}>
        {isNavigating && <div className="page-navigation-progress" role="status" aria-label="正在切换页面" />}
        <header className="research-header"><div className="workspace-header-leading"><button className="icon-button chat-menu-toggle" aria-controls="workspace-navigation" onClick={() => { if (window.matchMedia?.('(max-width: 900px)').matches) setMobileNavigationOpen(value => !value); else setSidebarCollapsed(value => !value) }} aria-label="切换工作导航" title="切换工作导航"><Menu className="mobile-menu-icon" size={20} />{sidebarCollapsed ? <PanelLeftOpen className="desktop-menu-icon" size={19} /> : <PanelLeftClose className="desktop-menu-icon" size={19} />}</button><span className="chat-header-title">{page === 'screening' ? '东吴投研' : active.label}</span></div><div className="research-header-actions">{page === 'screening' && <div id="research-tools-slot" className="research-tools-slot" />}<ActiveTasks onConversation={resumeResearch} onProject={openProject} onNavigate={navigateFromMenu} onSettings={() => setSystemOpen(true)} />{page !== 'screening' && data?.last_date && <button className="header-data-status" onClick={() => setSystemOpen(true)} aria-label={`行情截至 ${data.last_date}，查看数据状态`} title="查看数据状态"><Database size={14} /><time>{data.last_date}</time></button>}</div></header>
        {loadError && <div className="global-alert" role="alert"><AlertCircle size={16} /><span>暂时无法连接服务，请检查本地服务是否已启动。</span><button onClick={refreshStatus}><RefreshCw size={14} />重试</button></div>}
        {(assistantLaunch.state.loading || assistantLaunch.state.error) && <div className="assistant-launch-status" role={assistantLaunch.state.error ? 'alert' : 'status'}>
          {assistantLaunch.state.loading ? <><RefreshCw size={15} className="spin" /><span>正在启动{assistantLaunch.state.name}…</span></> : <><AlertCircle size={15} /><span>{assistantLaunch.state.name}：{assistantLaunch.state.error}</span>{assistantLaunch.state.recoverable && <button onClick={() => void retryAssistantLaunch()}>继续启动</button>}<button aria-label="关闭助手启动提示" onClick={assistantLaunch.dismiss}>关闭</button></>}
        </div>}
        <section className="page-frame" data-page={page} data-view={page === 'conditions' ? conditionsSection : undefined}>
          <Suspense fallback={<div className="page-content page-loading" role="status">正在加载页面…<div className="page-loading-placeholder" aria-hidden="true" /></div>}>
          {page === 'assistants' && <ResearchAssistantsPage busy={assistantLaunch.state.loading} onUse={launchAssistant} />}
          {inResearch && <div className="research-space">
            <div className={'research-space-panel research-space-panel-' + page}>
              {page === 'research' && <ResearchProjectsPage initialProjectId={route.projectId} onLocationChange={(id, userNavigation = true) => navigateRoute({ page: 'research', projectId: id }, !route.projectId, userNavigation)} onOpenConversation={resumeResearch} />}
              {page === 'screening' && homeDraft.trim() && <div className="legacy-draft-notice"><span>还有一个之前保存的问题</span><button className="text-button" onClick={() => { openConversation('screening', undefined, homeDraft.trim()); setHomeDraft('') }}>继续未发送的问题</button></div>}
              {page === 'screening' && (conversationReady ? <ResearchWorkspace onLaunchAssistant={(id, name) => void launchAssistant(id, 'immediate', name)} initialAssistantId={conversationAssistant} shellNavigation onHistoryChange={() => setSidebarRevision(value => value + 1)} data={data} initialConversationId={route.conversationId} initialNewDraft={route.newDraft} onOpenProject={openProject} newResearchKey={newResearchKey} onNewResearchConsumed={() => { setNewResearchKey(0); setConversationAssistant(undefined) }} initialPrompt={conversationPrompt} onPromptConsumed={() => setConversationPrompt(undefined)} initialScope={conversationScope} onScopeChange={handleConversationScopeChange} initialSource={conversationSource} onSourceChange={setConversationSource} onOpenConversation={resumeResearch} onLocationChange={conversationLocation} /> : <div className="page-content" role={routeError ? 'alert' : 'status'}>{routeError ? <><p>{routeError}</p><button className="secondary-button" onClick={() => setRouteRetry(value => value + 1)}>重新读取对话</button></> : '正在读取研究对话…'}</div>)}
            </div>
          </div>}
          {page === 'watchlist' && <ObservationPage initialRunId={route.runId} initialCode={route.observationCode} initialCandidateId={route.candidateId} initialTab={route.observationTab} onLocationChange={(tab, id, userNavigation = true, code) => navigateRoute({ page: 'watchlist', workspace: workspaceArea, ...(tab ? { observationTab: tab } : {}), ...(id ? tab === 'batches' ? { runId: id, ...(code ? { observationCode: code } : {}) } : { candidateId: id } : {}) }, !route.runId && !route.candidateId, userNavigation)} onStartResearch={startNewResearch} data={data} onNavigateScreening={() => openConversation('screening', undefined, undefined, 'screening')} onOpenResearch={id => void resumeResearch(id, 'screening', 'research')} />}
          {page === 'conditions' && (conversationReady ? <ScreeningWorkspace onHistoryChange={() => setSidebarRevision(value => value + 1)} shellNavigation onOpenDataServices={() => setSystemOpen(true)} conversationId={route.conversationId} conversationNewDraft={route.newDraft} newResearchKey={newResearchKey} onNewResearchConsumed={() => setNewResearchKey(0)} conversationPrompt={conversationPrompt} onPromptConsumed={() => setConversationPrompt(undefined)} conversationScope={conversationScope} conversationSource={conversationSource} onConversationScopeChange={handleConversationScopeChange} onConversationSourceChange={setConversationSource} onLocationChange={conversationLocation} data={data} view={conditionsSection} onViewChange={(section: Section) => navigateRoute({ page: 'conditions', view: section, scope: conversationScope, ...(section === 'conversation' && route.conversationId ? { conversationId: route.conversationId } : {}) })} onReports={() => navigatePage('reports')} onCompose={openComposition} onCreateCondition={openConditionDescription} onResumeConversation={resumeResearch} onConversation={openConversation} /> : <div className="page-content" role={routeError ? 'alert' : 'status'}>{routeError ? <><p>{routeError}</p><button className="secondary-button" onClick={() => setRouteRetry(value => value + 1)}>重新读取对话</button></> : '正在读取选股方案…'}</div>)}
          {page === 'patterns' && <PatternPage onCompose={openComposition} onDiscuss={(id, version, name) => openConversation('pattern', { reference: { kind: 'pattern', source_id: id, version }, label: name })} />}
          {(page === 'technical' || page === 'news' || page === 'reports') && <LibraryWorkspace key={page} scope={page === 'reports' ? 'report' : page} data={data} onCompose={openComposition} onConversation={openConversation} onSettings={() => setSystemOpen(true)} />}
          </Suspense>
        </section>
      </main>
      {systemOpen && <SystemDrawer data={data} onClose={() => setSystemOpen(false)} onRefresh={refreshStatus} />}
      {quickNavigationOpen && <QuickNavigation onClose={() => setQuickNavigationOpen(false)} onNavigate={navigateFromMenu} onProject={openProject} onConversation={resumeResearch} onNewResearch={startNewResearch} onSettings={() => setSystemOpen(true)} />}
    </div>
  )
}
