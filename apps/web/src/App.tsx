import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react'
import { AlertCircle, BookOpen, ChevronRight, Database, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Search, Settings2 } from 'lucide-react'
import { api, conversationWorkflow, type Conversation, type ConversationScope, type ConversationSourceReference, type DataStatus, type WorkflowType } from './api'
const ObservationPage = lazy(() => import('./pages/ObservationPage'))
const ResearchWorkspace = lazy(() => import('./pages/ResearchWorkspace'))
const ScreeningWorkspace = lazy(() => import('./pages/ScreeningWorkspace'))
const PatternPage = lazy(() => import('./pages/PatternPage'))
const LibraryWorkspace = lazy(() => import('./pages/LibraryWorkspace'))
const ResearchProjectsPage = lazy(() => import('./pages/ResearchProjectsPage'))
const WorkspaceHome = lazy(() => import('./pages/WorkspaceHome'))
import SystemDrawer from './pages/DataServicesPanel'
import QuickNavigation, { ResourceNavigation } from './components/QuickNavigation'
import ActiveTasks from './components/ActiveTasks'
import type { Section } from './pages/WorkbenchPage'
import { useSessionState } from './useSessionState'
import { navigateTabs } from './keyboard'
import { workspaceMenus as menus, workspacePrimaryMenus, workspaceLibraryMenus, type PageId } from './navigation'
import { useWorkspaceRoute } from './useWorkspaceRoute'
import { storedConversationScope, storedScreeningView, type WorkspaceRoute } from './workspaceRoute'
export default function App() {
  const [isNavigating, startNavigation] = useTransition()
  const [data, setData] = useState<DataStatus | null>(null)
  const [systemOpen, setSystemOpen] = useState(false)
  const [quickNavigationOpen, setQuickNavigationOpen] = useState(false)
  const [resourceNavigationOpen, setResourceNavigationOpen] = useState(false)
  const [newResearchKey, setNewResearchKey] = useState(0)
  const [sidebarCollapsed, setSidebarCollapsed] = useSessionState('app.sidebarCollapsed', false, (value): value is boolean => typeof value === 'boolean')
  const [loadError, setLoadError] = useState('')
  const conversationNavigation = useRef(0)
  const [conversationPrompt, setConversationPrompt] = useState<string | undefined>()
  const [conversationSource, setConversationSource] = useState<{ reference: ConversationSourceReference; label: string } | null>(null)
  const { route, navigate } = useWorkspaceRoute(() => {
    ++conversationNavigation.current
    setConversationPrompt(undefined)
    setConversationSource(null)
    setNewResearchKey(0)
  })
  const page = route.page
  const previousPage = useRef(page)
  const [researchPage, setResearchPage] = useSessionState<'screening' | 'research'>('app.researchPage', page === 'research' ? 'research' : 'screening', (value): value is 'screening' | 'research' => value === 'screening' || value === 'research')
  const conversationScope = route.scope ?? 'screening'
  const conditionsSection = route.view ?? 'conversation'
  const [resolvedConversation, setResolvedConversation] = useState<{ id: string; scope: ConversationScope; workflow: WorkflowType } | null>(null)
  const [routeError, setRouteError] = useState('')
  const [routeRetry, setRouteRetry] = useState(0)
  const routeRef = useRef(route)
  routeRef.current = route
  const needsConversation = (page === 'screening' || page === 'conditions') && !!route.conversationId
  const conversationReady = !needsConversation || (resolvedConversation?.id === route.conversationId && resolvedConversation?.workflow === (page === 'conditions' ? 'screening' : 'research') && resolvedConversation?.scope === conversationScope)

  function navigateRoute(next: WorkspaceRoute, replace = false) {
    setResourceNavigationOpen(false)
    if (next.page === 'screening' || next.page === 'research') setResearchPage(next.page)
    startNavigation(() => navigate(next, { replace }))
  }

  function navigatePage(nextPage: PageId) {
    navigateRoute({ page: nextPage, ...((nextPage === 'screening' || nextPage === 'conditions') ? { scope: storedConversationScope() } : {}), ...(nextPage === 'conditions' ? { view: storedScreeningView() } : {}) })
  }

  function navigateFromMenu(nextPage: PageId) {
    ++conversationNavigation.current
    setConversationPrompt(undefined)
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
      navigateRoute({ page: workflow === 'screening' ? 'conditions' : 'screening', conversationId: id, scope: current.entry_scope, ...(workflow === 'screening' ? { view: 'conversation' as const } : {}) }, true)
    }).catch(reason => { if (!controller.signal.aborted && request === conversationNavigation.current) setRouteError((reason as Error).message) })
    return () => controller.abort()
  }, [needsConversation, route.conversationId, resolvedConversation?.id, routeRetry])

  useEffect(() => {
    if (!needsConversation || !resolvedConversation || resolvedConversation.id !== route.conversationId) return
    const targetPage = resolvedConversation.workflow === 'screening' ? 'conditions' : 'screening'
    if (page !== targetPage || conversationScope !== resolvedConversation.scope) navigateRoute({ page: targetPage, conversationId: resolvedConversation.id, scope: resolvedConversation.scope, ...(targetPage === 'conditions' ? { view: 'conversation' as const } : {}) }, true)
  }, [needsConversation, route.conversationId, page, conversationScope, resolvedConversation])

  useLayoutEffect(() => {
    if (previousPage.current === page) return
    previousPage.current = page
    // Reset before painting the new page, including when its data arrives later.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [page])

  function handleConversationScopeChange(scope: ConversationScope) {
    setConversationSource(null)
    navigateRoute({ page, scope, ...(page === 'conditions' ? { view: 'conversation' as const } : {}) })
  }

  function openConversation(scope: ConversationScope, source?: { reference: ConversationSourceReference; label: string }, prompt?: string, workflow: WorkflowType = 'research') {
    ++conversationNavigation.current
    setNewResearchKey(value => prompt ? 0 : value + 1)
    setConversationPrompt(prompt)
    setConversationSource(source ?? null)
    navigateRoute({ page: workflow === 'screening' ? 'conditions' : 'screening', scope, newDraft: true, ...(workflow === 'screening' ? { view: 'conversation' as const } : {}) })
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
    let type = workflow
    if (!prompt) {
      try { const current = await api<Conversation>(`/conversations/${id}`); type = conversationWorkflow(current, workflow); scope = current.entry_scope }
      catch (reason) { if (request === conversationNavigation.current) setLoadError((reason as Error).message); return }
    }
    if (request !== conversationNavigation.current) return
    setNewResearchKey(0)
    setConversationPrompt(prompt)
    setConversationSource(null)
    const actualWorkflow = type ?? 'research'
    startNavigation(() => {
      setResolvedConversation({ id, scope, workflow: actualWorkflow })
      navigateRoute({ page: actualWorkflow === 'screening' ? 'conditions' : 'screening', conversationId: id, scope, ...(actualWorkflow === 'screening' ? { view: 'conversation' as const } : {}) })
    })
  }

  function conversationLocation(id: string, scope: ConversationScope, workflow: WorkflowType) {
    const current = routeRef.current
    if (current.page !== 'screening' && current.page !== 'conditions') return
    const next: WorkspaceRoute = { page: workflow === 'screening' ? 'conditions' : 'screening', scope, ...(id ? { conversationId: id } : { newDraft: true }), ...(workflow === 'screening' ? { view: 'conversation' as const } : {}) }
    startNavigation(() => {
      if (id) setResolvedConversation({ id, scope, workflow })
      navigateRoute(next, !current.conversationId && !current.newDraft)
    })
  }

  function openProject(id: string) {
    navigateRoute({ page: 'research', ...(id ? { projectId: id } : {}) })
  }

  function openCandidate(id: string) {
    navigateRoute({ page: 'watchlist', observationTab: 'candidates', ...(id ? { candidateId: id } : {}) })
  }

  function startNewResearch() {
    openConversation('screening')
  }

  function openObservation(id: string) {
    navigateRoute({ page: 'watchlist', observationTab: 'batches', runId: id })
  }

  const refreshStatus = () => {
    api<DataStatus>('/data/status').then((result) => { setData(result); setLoadError('') }).catch((error) => setLoadError(error.message))
  }

  useEffect(() => {
    refreshStatus()
  }, [])

  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (document.querySelector('[role="dialog"][aria-modal="true"]:not([hidden])') && !document.querySelector('.quick-navigation')) return
        setResourceNavigationOpen(false)
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
    <div className={`app-shell redesigned-workspace ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <a className="skip-to-content" href="#workspace-main" onClick={event => { event.preventDefault(); document.getElementById('workspace-main')?.focus() }}>跳到页面内容</a>
      <aside className="sidebar">
        <div className="research-brand"><img src="/brand/soochow-white.png" alt="东吴证券 SOOCHOW SECURITIES" width="160" height="35" /><img className="sidebar-brand-symbol" src="/brand/soochow-symbol-white.png" alt="东吴证券" width="90" height="70" /></div>
        <div className="branch-name">投研工作台<span>张家港营业部</span></div>
        <button className="sidebar-new-research" onClick={startNewResearch} title="开始新研究" aria-label="开始新研究"><Plus size={18} /><span>开始新研究</span></button>
        <nav className="workspace-navigation" aria-label="主菜单">
          <div className="navigation-group">
            <div className="workspace-label">工作空间</div>
            {workspacePrimaryMenus.map(({ id, label, mobileLabel, icon: Icon }) => {
              const selected = id === 'screening' ? inResearch : page === id
              return <button className={'nav-item ' + (selected ? 'active' : '')} key={id} aria-label={label} title={label} aria-current={selected ? 'page' : undefined} onClick={() => navigateFromMenu(id === 'screening' ? researchPage : id)}><Icon size={19} strokeWidth={1.75} /><span className="nav-label">{label}</span><span className="nav-mobile-label" aria-hidden="true">{mobileLabel}</span></button>
            })}
          </div>
          <div className="navigation-group desktop-library-navigation">
            <div className="workspace-label">资料资源</div>
            {workspaceLibraryMenus.map(({ id, label, mobileLabel, icon: Icon }) => <button className={'nav-item ' + (page === id ? 'active' : '')} key={id} aria-label={label} title={label} aria-current={page === id ? 'page' : undefined} onClick={() => navigateFromMenu(id)}><Icon size={19} strokeWidth={1.75} /><span className="nav-label">{label}</span><span className="nav-mobile-label" aria-hidden="true">{mobileLabel}</span></button>)}
          </div>
          <button className={'nav-item mobile-library-launch ' + (workspaceLibraryMenus.some(item => item.id === page) ? 'active' : '')} aria-label="打开资料库" aria-expanded={resourceNavigationOpen} onClick={() => setResourceNavigationOpen(true)}><BookOpen size={20} /><span className="nav-mobile-label">资料</span></button>
        </nav>
        <div className="sidebar-bottom"><div className="research-data-status"><span className={'status-dot ' + (loadError ? 'warning' : data?.available ? 'good' : 'warning')} />{loadError ? '服务连接异常' : data ? data.available ? '行情可供查询' : '待添加行情数据' : '正在检查数据'}</div><button className="research-settings" onClick={() => setSystemOpen(true)} aria-label="数据与服务" title="数据与服务"><Settings2 size={17} /><span>数据与服务</span><ChevronRight size={14} className="settings-chevron" /></button></div>
      </aside>
      <main id="workspace-main" tabIndex={-1} className="main-shell" aria-busy={isNavigating}>
        {isNavigating && <div className="page-navigation-progress" role="status" aria-label="正在切换页面" />}
        <header className="research-header"><div className="workspace-header-leading"><button className="icon-button sidebar-toggle" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? '展开导航' : '收起导航'} title={sidebarCollapsed ? '展开导航' : '收起导航'}>{sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}</button><img className="mobile-header-brand" src="/brand/soochow-symbol-blue.png" alt="东吴证券" width="30" height="26" /><div className="research-breadcrumb"><span>研究空间</span><ChevronRight size={13} /><strong>{active.label}</strong></div></div><button className="workspace-command-launch" aria-label="搜索与快速导航" aria-keyshortcuts="Control+k Meta+k" onClick={() => setQuickNavigationOpen(true)}><Search size={16} /><span>查找项目、对话或页面</span><kbd>Ctrl K</kbd></button><div className="research-header-actions"><ActiveTasks onConversation={resumeResearch} onProject={openProject} onNavigate={navigateFromMenu} onSettings={() => setSystemOpen(true)} />{data?.last_date && <button className="header-data-status" onClick={() => setSystemOpen(true)} aria-label={`行情截至 ${data.last_date}，查看数据状态`} title="查看数据状态"><Database size={14} /><span><time>{data.last_date}</time></span></button>}<span className="mode-badge"><span className="status-dot warning" />探索模式</span><button className="research-settings mobile-settings" onClick={() => setSystemOpen(true)} aria-label="数据与服务" title="数据与服务"><Settings2 size={18} /></button></div></header>
        {loadError && <div className="global-alert" role="alert"><AlertCircle size={16} /><span>暂时无法连接服务，请检查本地服务是否已启动。</span><button onClick={refreshStatus}><RefreshCw size={14} />重试</button></div>}
        <section className="page-frame">
          <Suspense fallback={<div className="page-content page-loading" role="status">正在加载页面…<div className="page-loading-placeholder" aria-hidden="true" /></div>}>
          {page === 'home' && <WorkspaceHome onCandidate={openCandidate} data={data} onNavigate={navigateFromMenu} onNewResearch={startNewResearch} onResearch={prompt => openConversation('screening', undefined, prompt)} onProject={openProject} onConversation={resumeResearch} onObservation={openObservation} onSettings={() => setSystemOpen(true)} />}
          {inResearch && <div className="research-space">
            <div className="research-space-nav" role="tablist" aria-label="研究工作区" onKeyDown={event => navigateTabs(event, ['screening', 'research'] as const, page === 'research' ? 'research' : 'screening', navigateFromMenu)}>{([['screening', '研究对话'], ['research', '研究项目']] as const).map(([id, label]) => <button key={id} type="button" role="tab" id={`research-space-tab-${id}`} aria-controls={`research-space-panel-${id}`} aria-selected={page === id} tabIndex={page === id ? 0 : -1} onClick={() => navigateFromMenu(id)}>{label}</button>)}</div>
            <div role="tabpanel" id={`research-space-panel-${page}`} aria-labelledby={`research-space-tab-${page}`}>
              {page === 'research' && <ResearchProjectsPage initialProjectId={route.projectId} onLocationChange={id => navigateRoute({ page: 'research', projectId: id }, !route.projectId)} onOpenConversation={resumeResearch} />}
              {page === 'screening' && (conversationReady ? <ResearchWorkspace data={data} initialConversationId={route.conversationId} initialNewDraft={route.newDraft} onOpenProject={openProject} newResearchKey={newResearchKey} onNewResearchConsumed={() => setNewResearchKey(0)} initialPrompt={conversationPrompt} onPromptConsumed={() => setConversationPrompt(undefined)} initialScope={conversationScope} onScopeChange={handleConversationScopeChange} initialSource={conversationSource} onSourceChange={setConversationSource} onOpenConversation={resumeResearch} onLocationChange={conversationLocation} /> : <div className="page-content" role={routeError ? 'alert' : 'status'}>{routeError ? <><p>{routeError}</p><button className="secondary-button" onClick={() => setRouteRetry(value => value + 1)}>重新读取对话</button></> : '正在读取研究对话…'}</div>)}
            </div>
          </div>}
          {page === 'watchlist' && <ObservationPage initialRunId={route.runId} initialCandidateId={route.candidateId} initialTab={route.observationTab} onLocationChange={(tab, id) => navigateRoute({ page: 'watchlist', observationTab: tab, ...(id ? tab === 'batches' ? { runId: id } : { candidateId: id } : {}) }, !route.runId && !route.candidateId)} onStartResearch={startNewResearch} data={data} onNavigateScreening={() => openConversation('screening', undefined, undefined, 'screening')} onOpenResearch={id => void resumeResearch(id, 'screening', 'research')} />}
          {page === 'conditions' && (conversationReady ? <ScreeningWorkspace conversationId={route.conversationId} conversationNewDraft={route.newDraft} newResearchKey={newResearchKey} onNewResearchConsumed={() => setNewResearchKey(0)} conversationPrompt={conversationPrompt} onPromptConsumed={() => setConversationPrompt(undefined)} conversationScope={conversationScope} conversationSource={conversationSource} onConversationScopeChange={handleConversationScopeChange} onConversationSourceChange={setConversationSource} onLocationChange={conversationLocation} data={data} view={conditionsSection} onViewChange={(section: Section) => navigateRoute({ page: 'conditions', view: section, scope: conversationScope, ...(section === 'conversation' && route.conversationId ? { conversationId: route.conversationId } : {}) })} onReports={() => navigatePage('reports')} onCompose={openComposition} onCreateCondition={openConditionDescription} onResumeConversation={resumeResearch} onConversation={openConversation} /> : <div className="page-content" role={routeError ? 'alert' : 'status'}>{routeError ? <><p>{routeError}</p><button className="secondary-button" onClick={() => setRouteRetry(value => value + 1)}>重新读取对话</button></> : '正在读取选股方案…'}</div>)}
          {page === 'patterns' && <PatternPage onCompose={openComposition} onDiscuss={(id, version, name) => openConversation('pattern', { reference: { kind: 'pattern', source_id: id, version }, label: name })} />}
          {(page === 'technical' || page === 'news' || page === 'reports') && <LibraryWorkspace key={page} scope={page === 'reports' ? 'report' : page} data={data} onCompose={openComposition} onConversation={openConversation} onSettings={() => setSystemOpen(true)} />}
          </Suspense>
        </section>
      </main>
      {systemOpen && <SystemDrawer data={data} onClose={() => setSystemOpen(false)} onRefresh={refreshStatus} />}
      {quickNavigationOpen && <QuickNavigation onClose={() => setQuickNavigationOpen(false)} onNavigate={navigateFromMenu} onProject={openProject} onConversation={resumeResearch} onNewResearch={startNewResearch} onSettings={() => setSystemOpen(true)} />}
      {resourceNavigationOpen && <ResourceNavigation onClose={() => setResourceNavigationOpen(false)} onNavigate={navigateFromMenu} />}
    </div>
  )
}
