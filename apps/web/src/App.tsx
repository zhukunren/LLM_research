import { useEffect, useRef, useState, useTransition } from 'react'
import { AlertCircle, ChevronDown, Database, Menu, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, X } from 'lucide-react'
import { api, conversationWorkflow, type Conversation, type ConversationScope, type DataStatus, type WorkflowType } from './api'
import ResearchSidebar from './components/ResearchSidebar'
import ResearchWorkspaceNavigation from './components/ResearchWorkspaceNavigation'
import type { ConversationHistoryChange } from './components/ConversationHistoryItem'
import SystemDrawer from './pages/DataServicesPanel'
import QuickNavigation from './components/QuickNavigation'
import ActiveTasks from './components/ActiveTasks'
import MobileWorkspaceNavigation, { MobileMoreSheet, MobileServiceNavigation, MobileTabsSheet } from './components/MobileWorkspaceNavigation'
import WorkspaceTabs from './components/WorkspaceTabs'
import WorkspacePage from './WorkspacePage'
import { WorkspaceSessionPane } from './WorkspaceSession'
import { useWorkspaceTabs, type WorkspaceSeed } from './workspaceTabs'
import type { TabLocation, WorkspaceHandoff } from './workspaceHandoff'
import { isText, useSessionState } from './useSessionState'
import type { PageId, ServiceView } from './navigation'
import { parseWorkspaceRoute, workspaceRouteHash, screeningMethodRoute, storedConversationScope, storedScreeningView, type WorkspaceRoute } from './workspaceRoute'
import { useAssistantLaunch } from './useAssistantLaunch'
import { mobileWorkspaceQuery } from './useMobileWorkspace'
import './workspace-switch.css'
import { isScreeningPatternSelection, type ScreeningDestination, type ScreeningMethod, type ScreeningPatternSelection } from './screeningMethods'

type ScreeningToolView = 'saved' | 'history' | 'compose' | 'library'
type ResearchNavigationTabs = Partial<Record<'research' | 'screeningDraft' | 'area' | 'conversation' | ScreeningMethod | ScreeningToolView | `page:${PageId}`, string>>
const isResearchNavigationTabs = (value: unknown): value is ResearchNavigationTabs => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(id => typeof id === 'string')
const isScreeningConversation = (route: WorkspaceRoute) => route.page === 'conditions' && !route.screeningMethod && (route.view ?? 'conversation') === 'conversation'
const isNewTask = (route: WorkspaceRoute) => route.newDraft === true && !route.conversationId && (route.page === 'screening' || isScreeningConversation(route))
type PendingPatterns = Record<string, ScreeningPatternSelection[]>
const isPendingPatterns = (value: unknown): value is PendingPatterns => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every(items => Array.isArray(items) && items.every(isScreeningPatternSelection))
const compactNavigationQuery = '(max-width: 900px)'

export default function App() {
  const [isNavigating, startNavigation] = useTransition()
  const workspaces = useWorkspaceTabs()
  const { route } = workspaces.activeTab, { page } = route
  const [data, setData] = useState<DataStatus | null>(null)
  const [systemOpen, setSystemOpen] = useState(false)
  const [pageActionsTarget, setPageActionsTarget] = useState<HTMLDivElement | null>(null)
  const [quickNavigationOpen, setQuickNavigationOpen] = useState(false)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia?.(compactNavigationQuery).matches ?? false)
  const [mobileApp, setMobileApp] = useState(() => window.matchMedia?.(mobileWorkspaceQuery).matches ?? false)
  const [mobileSheet, setMobileSheet] = useState<'more' | 'pages' | null>(null)
  const [sidebarRevision, setSidebarRevision] = useState(0)
  const [conversationUpdate, setConversationUpdate] = useState<({ id: string } & ConversationHistoryChange)>()
  const [homeDraft, setHomeDraft] = useSessionState('home.researchDraft', '', isText)
  const [sidebarCollapsed, setSidebarCollapsed] = useSessionState('app.sidebarCollapsed', false, (value): value is boolean => typeof value === 'boolean')
  const [loadError, setLoadError] = useState('')
  const [historyNavigation, setHistoryNavigation] = useState<{ id: string; phase: 'opening' | 'error' } | null>(null)
  const conversationNavigation = useRef(0)
  const assistantLaunch = useAssistantLaunch()
  const [workspacePreference, setWorkspacePreference] = useSessionState<WorkflowType>('app.workspace', 'research', (value): value is WorkflowType => value === 'research' || value === 'screening')
  const workspaceArea: WorkflowType = page === 'conditions' || route.screeningMethod === 'pattern' ? 'screening' : ['home', 'screening', 'intelligence'].includes(page) ? 'research' : route.workspace ?? workspacePreference
  const isService = page === 'client-service'
  const showTaskTypes = isNewTask(route)
  const navigationLabel = compactNavigation
    ? mobileNavigationOpen ? '关闭工作导航' : '打开工作导航'
    : sidebarCollapsed ? '展开工作导航' : '收起工作导航'
  const [researchAreaLocation, setResearchAreaLocation] = useSessionState('app.researchAreaLocation', '#/research/new', isText)
  const [screeningConversationLocation, setScreeningConversationLocation] = useSessionState('app.screeningConversationLocation', '#/screening/new', isText)
  const [navigationTabs, setNavigationTabs] = useSessionState<ResearchNavigationTabs>('app.researchNavigationTabs', {}, isResearchNavigationTabs)
  const [patternOrigin, setPatternOrigin] = useSessionState('app.screeningPatternOrigin', '', isText)
  const [pendingPatterns, setPendingPatterns] = useSessionState<PendingPatterns>('app.screeningPatternHandoffs', {}, isPendingPatterns)
  const [fixedRulesTab, setFixedRulesTab] = useState('')
  useEffect(() => { setWorkspacePreference(workspaceArea) }, [workspaceArea])
  useEffect(() => {
    const remembered: ResearchNavigationTabs = { [`page:${page}`]: workspaces.activeId }
    if (!isService) { setResearchAreaLocation(workspaceRouteHash(route)); remembered.area = workspaces.activeId }
    if (isScreeningConversation(route)) { setScreeningConversationLocation(workspaceRouteHash(route)); remembered.conversation = workspaces.activeId }
    if (showTaskTypes) remembered[page === 'screening' ? 'research' : 'screeningDraft'] = workspaces.activeId
    if (route.screeningMethod && (page === 'patterns' || page === 'conditions' && (route.view ?? 'conversation') === 'conversation')) remembered[route.screeningMethod] = workspaces.activeId
    if (page === 'conditions' && route.view && ['saved', 'history', 'compose', 'library'].includes(route.view)) remembered[route.view as ScreeningToolView] = workspaces.activeId
    setNavigationTabs(current => Object.entries(remembered).every(([key, id]) => current[key as keyof ResearchNavigationTabs] === id) ? current : { ...current, ...remembered })
  }, [route, workspaces.activeId])
  useEffect(() => { beginConversationNavigation() }, [workspaces.activeId])

  function beginConversationNavigation() {
    setHistoryNavigation(null)
    return ++conversationNavigation.current
  }

  function openRoute(next: WorkspaceRoute, seed?: WorkspaceSeed, reusePage = false, handoff?: WorkspaceHandoff) {
    beginConversationNavigation()
    setMobileNavigationOpen(false)
    setMobileSheet(null)
    let id = ''
    startNavigation(() => { id = workspaces.open(next, { seed, handoff, forceNew: !!seed || !!handoff, reusePage }) })
    return id
  }
  function restoreHandoff(target: TabLocation, change?: (current: WorkspaceHandoff) => WorkspaceHandoff) {
    beginConversationNavigation()
    setMobileNavigationOpen(false)
    let restored = false
    startNavigation(() => { restored = workspaces.restore(target, change) })
    return restored
  }
  function openPatternSamples() {
    if (page !== 'patterns' || route.screeningMethod !== 'pattern') setPatternOrigin(workspaces.activeId)
    if (!activateRemembered(navigationTabs.pattern, saved => saved.page === 'patterns' && saved.screeningMethod === 'pattern')) openRoute(screeningMethodRoute('pattern'), undefined, true)
  }
  function screeningDestination(view: ScreeningDestination, preferred = workspaces.activeId) {
    const accepts = view === 'conversation' ? isScreeningConversation : (saved: WorkspaceRoute) => saved.page === 'conditions' && saved.view === 'compose'
    if (activateRemembered(preferred, accepts)) return preferred
    const remembered = navigationTabs[view]
    if (remembered && activateRemembered(remembered, accepts)) return remembered
    const saved = view === 'conversation' ? parseWorkspaceRoute(screeningConversationLocation) : null
    return openRoute(saved && accepts(saved) ? saved : view === 'compose' ? { page: 'conditions', view } : { page: 'conditions', newDraft: true })
  }
  function openFixedRules() {
    setFixedRulesTab(screeningDestination('conversation'))
  }
  function returnPattern(view: ScreeningDestination, pattern: ScreeningPatternSelection) {
    const id = screeningDestination(view, patternOrigin)
    setPendingPatterns(current => {
      const existing = current[id] ?? []
      if (existing.some(item => item.id === pattern.id && item.version === pattern.version)) return current
      return { ...current, [id]: [...existing, pattern] }
    })
  }
  function consumePattern(id: string, pattern: ScreeningPatternSelection | undefined) {
    setPendingPatterns(current => {
      const first = current[id]?.[0]
      if (!first || first !== pattern) return current
      const next = { ...current }
      const remaining = next[id]?.slice(1) ?? []
      if (remaining.length) next[id] = remaining
      else delete next[id]
      return next
    })
  }
  function openScreeningView(view: ScreeningToolView) {
    if (!activateRemembered(navigationTabs[view], saved => saved.page === 'conditions' && saved.view === view)) openRoute({ page: 'conditions', view }, undefined, true)
  }
  function navigateFromMenu(nextPage: PageId) {
    openRoute({ page: nextPage, ...(['library', 'news', 'patterns', 'reports', 'watchlist', 'qmt', 'daily-signals', 'data-download', 'client-service'].includes(nextPage) ? { workspace: workspaceArea } : {}), ...((nextPage === 'screening' || nextPage === 'conditions') ? { scope: storedConversationScope() } : {}), ...(nextPage === 'conditions' ? { view: storedScreeningView() } : {}) }, undefined, ['screening', 'conditions', 'watchlist', 'intelligence', 'library', 'daily-signals', 'data-download', 'client-service'].includes(nextPage))
  }
  function navigateFromMobile(nextPage: PageId) {
    setMobileSheet(null)
    const accepts = (saved: WorkspaceRoute) => saved.page === nextPage && (nextPage !== 'patterns' || !saved.screeningMethod)
    if (accepts(route)) return
    if (activateRemembered(navigationTabs[`page:${nextPage}`], accepts)) return
    const existing = [...workspaces.tabs].reverse().find(tab => accepts(tab.route))
    if (existing) { activateWorkspace(existing.id); return }
    if (nextPage === 'screening' || nextPage === 'conditions') switchTaskType(nextPage === 'screening' ? 'research' : 'screening')
    else navigateFromMenu(nextPage)
  }
  function openServiceView(serviceView: ServiceView) {
    const target = isService ? workspaces.activeTab : [...workspaces.tabs].reverse().find(tab =>
      tab.route.page === 'client-service' && (tab.route.workspace ?? 'research') === workspaceArea)
    if (!target) {
      openRoute({ page: 'client-service', workspace: workspaceArea, serviceView })
      return
    }
    beginConversationNavigation()
    setMobileNavigationOpen(false)
    workspaces.update(target.id, { ...target.route, serviceView }, !mobileApp || target.id !== workspaces.activeId)
    if (target.id !== workspaces.activeId) workspaces.activate(target.id)
  }
  function switchTaskType(next: WorkflowType) {
    const nextPage = next === 'research' ? 'screening' : 'conditions'
    const accepts = (saved: WorkspaceRoute) => isNewTask(saved) && saved.page === nextPage
    if (accepts(route) || activateRemembered(navigationTabs[next === 'research' ? 'research' : 'screeningDraft'], accepts)) return
    openRoute({ page: nextPage, newDraft: true })
  }
  function activateRemembered(id: string | undefined, accepts: (saved: WorkspaceRoute) => boolean) {
    const tab = workspaces.tabs.find(item => item.id === id)
    if (!tab || !accepts(tab.route)) return false
    activateWorkspace(tab.id)
    return true
  }
  function activateWorkspace(id: string) {
    beginConversationNavigation()
    setMobileNavigationOpen(false)
    setMobileSheet(null)
    workspaces.activate(id)
  }
  function reopenWorkspace() {
    beginConversationNavigation()
    setMobileNavigationOpen(false)
    setMobileSheet(null)
    workspaces.reopenClosed()
  }
  function openQuickNavigation() {
    beginConversationNavigation()
    setMobileNavigationOpen(false)
    setMobileSheet(null)
    setQuickNavigationOpen(true)
  }
  function returnToResearch() {
    if (activateRemembered(navigationTabs.area, saved => saved.page !== 'client-service')) return
    const saved = parseWorkspaceRoute(researchAreaLocation)
    openRoute(saved && saved.page !== 'client-service' ? saved : { page: workspaceArea === 'screening' ? 'conditions' : 'screening', newDraft: true })
  }
  function newResearch(workflow: WorkflowType = 'research') {
    openRoute({ page: workflow === 'research' ? 'screening' : 'conditions', scope: 'screening', newDraft: true, ...(workflow === 'screening' ? { view: 'conversation' } : {}) }, { fresh: true })
  }
  async function resumeResearch(id: string, scope: ConversationScope, workflow?: WorkflowType, prompt?: string, fromHistory = false) {
    if (fromHistory && historyNavigation?.id === id && historyNavigation.phase === 'opening') return
    const existing = workspaces.tabs.find(tab => tab.route.conversationId === id)
    if (existing && !prompt) { beginConversationNavigation(); setMobileNavigationOpen(false); workspaces.activate(existing.id); return }
    const request = beginConversationNavigation()
    if (fromHistory) setHistoryNavigation({ id, phase: 'opening' })
    else setMobileNavigationOpen(false)
    let type = workflow
    if (!prompt) {
      try { const current = await api<Conversation>(`/conversations/${encodeURIComponent(id)}`); type = conversationWorkflow(current, workflow); scope = current.entry_scope }
      catch (reason) {
        if (request === conversationNavigation.current) {
          if (fromHistory) setHistoryNavigation({ id, phase: 'error' })
          else setLoadError((reason as Error).message)
        }
        return
      }
    }
    if (request !== conversationNavigation.current) return
    openRoute({ page: type === 'screening' ? 'conditions' : 'screening', conversationId: id, scope, ...(type === 'screening' ? { view: 'conversation' } : {}) }, prompt ? { prompt } : undefined)
  }
  async function launchAssistant(id: string, mode: 'immediate' | 'draft' = 'draft', name?: string) {
    if (mode !== 'immediate') { openRoute({ page: 'screening', scope: 'screening', newDraft: true }, { fresh: true, assistantId: id }); return }
    const request = beginConversationNavigation()
    setMobileNavigationOpen(false)
    const result = await assistantLaunch.launch(id, name)
    setSidebarRevision(value => value + 1)
    if (result && request === conversationNavigation.current) await resumeResearch(result.conversation_id, 'screening', 'research')
  }
  async function retryAssistantLaunch() {
    const request = beginConversationNavigation()
    const result = await assistantLaunch.retry()
    setSidebarRevision(value => value + 1)
    if (result && request === conversationNavigation.current) await resumeResearch(result.conversation_id, 'screening', 'research')
  }
  const refreshStatus = () => {
    api<DataStatus>('/data/status').then(result => { setData(result); setLoadError('') }).catch(error => setLoadError(error.message))
  }
  useEffect(() => { refreshStatus() }, [])
  useEffect(() => {
    const media = window.matchMedia?.(compactNavigationQuery)
    if (!media) return
    const syncNavigationViewport = () => {
      setCompactNavigation(media.matches)
      if (!media.matches) setMobileNavigationOpen(false)
    }
    syncNavigationViewport()
    media.addEventListener('change', syncNavigationViewport)
    return () => media.removeEventListener('change', syncNavigationViewport)
  }, [])
  useEffect(() => {
    const media = window.matchMedia?.(mobileWorkspaceQuery)
    if (!media) return
    const onChange = () => { setMobileApp(media.matches); setMobileSheet(null); setMobileNavigationOpen(false) }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  useEffect(() => {
    const viewport = window.visualViewport
    if (!mobileApp) return
    const root = document.documentElement
    let availableWidth = window.innerWidth
    let availableHeight = window.innerHeight
    let frame = 0
    const fitViewport = () => {
      const width = window.innerWidth, height = window.innerHeight
      const editing = document.activeElement?.matches('textarea:not([readonly]), input:not([readonly],[type=checkbox],[type=radio],[type=button],[type=file],[type=range]), [contenteditable=true]')
      if (!editing || width !== availableWidth || height > availableHeight) availableHeight = height
      availableWidth = width
      const visibleHeight = viewport?.scale === 1 ? viewport.height : height
      const keyboardOverlaysPage = !!editing && height - visibleHeight > 120
      if (keyboardOverlaysPage) root.style.setProperty('--mobile-viewport-height', `${Math.round(visibleHeight)}px`)
      else root.style.removeProperty('--mobile-viewport-height')
      root.toggleAttribute('data-mobile-keyboard', !!editing && (keyboardOverlaysPage || availableHeight - height > 120))
    }
    const scheduleFit = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fitViewport)
    }
    fitViewport()
    viewport?.addEventListener('resize', scheduleFit)
    window.addEventListener('resize', scheduleFit)
    document.addEventListener('focusin', scheduleFit)
    document.addEventListener('focusout', scheduleFit)
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener('resize', scheduleFit)
      window.removeEventListener('resize', scheduleFit)
      document.removeEventListener('focusin', scheduleFit)
      document.removeEventListener('focusout', scheduleFit)
      root.style.removeProperty('--mobile-viewport-height')
      root.removeAttribute('data-mobile-keyboard')
    }
  }, [mobileApp])
  useEffect(() => {
    const handleKeyboardShortcuts = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        const activeModal = document.querySelector('[role="dialog"][aria-modal="true"]:not([hidden])')
        if (activeModal?.classList.contains('chat-sidebar')) setMobileNavigationOpen(false)
        else if (!activeModal && mobileNavigationOpen) setMobileNavigationOpen(false)
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (document.querySelector('[role="dialog"][aria-modal="true"]:not([hidden])') && !document.querySelector('.quick-navigation')) return
        setMobileNavigationOpen(false); setSystemOpen(false); setQuickNavigationOpen(value => !value)
      }
    }
    window.addEventListener('keydown', handleKeyboardShortcuts)
    return () => window.removeEventListener('keydown', handleKeyboardShortcuts)
  }, [mobileNavigationOpen])

  const mobileTitle = showTaskTypes && !route.screeningMethod ? (page === 'screening' ? '研究对话' : '选股对话') : workspaces.activeTab.title
  const showResearchNavigation = mobileApp ? page === 'conditions' || route.screeningMethod === 'pattern' : !isService && (workspaceArea === 'screening' || showTaskTypes)
  const researchNavigation = showResearchNavigation && <ResearchWorkspaceNavigation compact={mobileApp} showTaskTypes={showTaskTypes && !mobileApp} screeningMethod={route.screeningMethod} workspace={workspaceArea} page={page} view={route.view} onTaskTypeChange={switchTaskType} onScreeningView={openScreeningView} onFixedRules={openFixedRules} onPatternSamples={openPatternSamples} />

  return <div className={`app-shell redesigned-workspace chat-layout viewport-workspace ${page === 'screening' || page === 'conditions' && (route.view ?? 'conversation') === 'conversation' ? 'chat-page' : 'tool-page'} ${mobileApp ? 'mobile-app-shell' : ''} ${mobileNavigationOpen ? 'mobile-navigation-open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <a className="skip-to-content" href="#workspace-main" onClick={event => { event.preventDefault(); document.getElementById('workspace-main')?.focus() }}>跳到页面内容</a>
    <ResearchSidebar serviceView={route.serviceView} historyOnly={mobileApp} historyNavigation={historyNavigation} onServiceView={openServiceView} onConversationChange={(id, changes) => {
      setSidebarRevision(value => value + 1)
      setConversationUpdate({ id, ...changes })
      if (changes.title) workspaces.tabs.filter(tab => tab.route.conversationId === id).forEach(tab => workspaces.rename(tab.id, changes.title!))
      if (changes.deleted || changes.state === 'archived') { workspaces.forgetClosedConversation(id); workspaces.tabs.filter(tab => tab.route.conversationId === id).forEach(tab => workspaces.close(tab.id, { remember: false })) }
    }} workspace={workspaceArea} onResearch={returnToResearch} busy={assistantLaunch.state.loading} onAssistant={launchAssistant} page={page} conversationId={route.conversationId} revision={sidebarRevision} mobileOpen={mobileNavigationOpen} onClose={() => setMobileNavigationOpen(false)} onNavigate={navigateFromMenu} onNewResearch={() => newResearch()} onNewScreening={() => newResearch('screening')} onConversation={(id, scope, workflow) => void resumeResearch(id, scope, workflow, undefined, true)} onSearch={openQuickNavigation} onSettings={() => { setMobileNavigationOpen(false); setSystemOpen(true) }} />
    <main id="workspace-main" tabIndex={-1} className="main-shell" aria-busy={isNavigating}>
      {isNavigating && <div className="page-navigation-progress" role="status" aria-label="正在切换页面" />}
      <header className="research-header workspace-tab-header" aria-label="工作区导航与全局操作" data-page={mobileApp ? page : undefined}>
        {mobileApp ? <button type="button" className="mobile-workspace-title workspace-button" aria-label={`切换页面，当前${mobileTitle}`} aria-haspopup="dialog" aria-expanded={mobileSheet === 'pages'} onClick={() => setMobileSheet('pages')}>
          <span className="mobile-brand-mark"><img src="/brand/soochow-symbol-blue.png" alt="东吴证券" /></span>
          <span id="mobile-workspace-title">{mobileTitle}</span><ChevronDown size={14} aria-hidden="true" />
        </button> : <>
          <div className="workspace-header-leading"><button className="icon-button chat-menu-toggle workspace-button" aria-controls="workspace-navigation" aria-expanded={compactNavigation ? mobileNavigationOpen : !sidebarCollapsed} onClick={() => { if (compactNavigation) setMobileNavigationOpen(value => !value); else setSidebarCollapsed(value => !value) }} aria-label={navigationLabel} data-tooltip={navigationLabel}>{compactNavigation && mobileNavigationOpen ? <X className="mobile-menu-icon" size={19} /> : <Menu className="mobile-menu-icon" size={20} />}{sidebarCollapsed ? <PanelLeftOpen className="desktop-menu-icon" size={19} /> : <PanelLeftClose className="desktop-menu-icon" size={19} />}</button></div>
          <WorkspaceTabs tabs={workspaces.tabs} activeId={workspaces.activeId} onActivate={activateWorkspace} onClose={workspaces.close} canReopen={workspaces.canReopen} onReopen={reopenWorkspace} onMove={workspaces.move} onCloseOthers={id => { beginConversationNavigation(); workspaces.closeOthers(id) }} onCloseSide={(id, side) => { beginConversationNavigation(); workspaces.closeSide(id, side) }} onCloseAll={() => { beginConversationNavigation(); workspaces.closeAll() }} newWorkflow={workspaceArea} onNew={() => newResearch(workspaceArea)} />
        </>}
        <div className="research-header-actions">
          {mobileApp && researchNavigation}
          {page === 'screening' && <div id="research-tools-slot" className="research-tools-slot" />}
          {mobileApp && <button type="button" className="icon-button mobile-icon-button workspace-button" aria-label="搜索页面或对话" aria-haspopup="dialog" onClick={openQuickNavigation}><Search size={20} aria-hidden="true" /></button>}
          <ActiveTasks onIntelligence={(briefId, briefKind) => openRoute({ page: 'intelligence', briefId, briefKind })} onConversation={resumeResearch} onNavigate={navigateFromMenu} onSettings={() => setSystemOpen(true)} />
          {!mobileApp && page !== 'screening' && page !== 'intelligence' && page !== 'daily-signals' && page !== 'client-service' && data?.last_date && <button className="header-data-status workspace-button" onClick={() => setSystemOpen(true)} aria-label={`行情截至 ${data.last_date}，查看数据状态`} data-tooltip="查看数据状态"><Database size={14} /><time>{data.last_date}</time></button>}
        </div>
        {mobileApp && isService && <MobileServiceNavigation view={route.serviceView} onSelect={openServiceView} />}
        <div ref={setPageActionsTarget} className="workspace-page-actions-slot" role="toolbar" aria-label="当前页面操作" />
      </header>
      {!mobileApp && researchNavigation}
      {loadError && <div className="global-alert workspace-error" role="alert"><AlertCircle size={16} /><span>暂时无法连接服务，请检查本地服务是否已启动。</span><button onClick={refreshStatus} className="workspace-button"><RefreshCw size={14} />重试</button></div>}
      {(assistantLaunch.state.loading || assistantLaunch.state.error) && <div className={'assistant-launch-status' + (assistantLaunch.state.error ? ' workspace-error' : '')} role={assistantLaunch.state.error ? 'alert' : 'status'}>{assistantLaunch.state.loading ? <><RefreshCw size={15} className="spin" /><span>正在启动{assistantLaunch.state.name}…</span></> : <><AlertCircle size={15} /><span>{assistantLaunch.state.name}：{assistantLaunch.state.error}</span>{assistantLaunch.state.recoverable && <button onClick={() => void retryAssistantLaunch()} className="workspace-button">继续启动</button>}<button aria-label="关闭助手启动提示" onClick={assistantLaunch.dismiss} className="workspace-button">关闭</button></>}</div>}
      {workspaces.tabs.map(tab => <WorkspaceSessionPane key={tab.id} tab={tab} active={tab.id === workspaces.activeId} actionsTarget={pageActionsTarget} mobileTitleId={mobileApp ? 'mobile-workspace-title' : undefined} onTitle={title => workspaces.rename(tab.id, title)}>
        <WorkspacePage tab={tab} data={data} fixedRulesOpen={fixedRulesTab === tab.id} onCloseFixedRules={() => setFixedRulesTab(current => current === tab.id ? '' : current)} onOpenPatternSamples={openPatternSamples} onUsePattern={returnPattern} incomingPattern={pendingPatterns[tab.id]?.[0]} onPatternApplied={() => consumePattern(tab.id, pendingPatterns[tab.id]?.[0])} workspace={tab.route.page === 'conditions' ? 'screening' : tab.route.workspace ?? 'research'} conversationUpdate={conversationUpdate} homeDraft={tab.legacy ? homeDraft : ''} onLegacyDraft={() => { openRoute({ page: 'screening', scope: 'screening', newDraft: true }, { prompt: homeDraft.trim(), fresh: true }); setHomeDraft('') }} onUpdate={(next, userNavigation = false) => { if (userNavigation && tab.id === workspaces.activeId) beginConversationNavigation(); workspaces.update(tab.id, next, !userNavigation) }} onOpen={openRoute} onConversation={resumeResearch} onNewResearch={() => newResearch()} onSettings={() => setSystemOpen(true)} onHistoryChange={() => setSidebarRevision(value => value + 1)}
          onOpenLinked={(next, handoff) => openRoute(next, undefined, false, handoff)} onRestore={restoreHandoff} onChangeHandoff={change => workspaces.updateHandoff(tab.id, change)} />
      </WorkspaceSessionPane>)}
    </main>
    {mobileApp && <MobileWorkspaceNavigation route={route} moreOpen={mobileSheet === 'more'} onNavigate={navigateFromMobile} onMore={() => setMobileSheet('more')} />}
    {mobileApp && mobileSheet === 'more' && <MobileMoreSheet page={page} onNavigate={navigateFromMobile} onHistory={() => { setMobileSheet(null); setMobileNavigationOpen(true) }} onSettings={() => { setMobileSheet(null); setSystemOpen(true) }} onClose={() => setMobileSheet(null)} />}
    {mobileApp && mobileSheet === 'pages' && <MobileTabsSheet tabs={workspaces.tabs} activeId={workspaces.activeId} canReopen={workspaces.canReopen} onActivate={activateWorkspace} onCloseTab={workspaces.close} onReopen={reopenWorkspace} onNew={newResearch} onClose={() => setMobileSheet(null)} />}
    {systemOpen && <SystemDrawer data={data} onClose={() => setSystemOpen(false)} onRefresh={refreshStatus} />}
    {quickNavigationOpen && <QuickNavigation onFixedRules={openFixedRules} onPatternSamples={openPatternSamples} onScreeningCompose={() => openScreeningView('compose')} onNewScreening={() => newResearch('screening')} onClose={() => setQuickNavigationOpen(false)} onNavigate={navigateFromMenu} onServiceView={openServiceView} onConversation={resumeResearch} onNewResearch={() => newResearch()} onSettings={() => setSystemOpen(true)} />}
  </div>
}
