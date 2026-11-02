import { useEffect, useRef, useState, useTransition } from 'react'
import { AlertCircle, Database, Menu, PanelLeftClose, PanelLeftOpen, RefreshCw, X } from 'lucide-react'
import { api, conversationWorkflow, type Conversation, type ConversationScope, type DataStatus, type WorkflowType } from './api'
import ResearchSidebar from './components/ResearchSidebar'
import type { ConversationHistoryChange } from './components/ConversationHistoryItem'
import SystemDrawer from './pages/DataServicesPanel'
import QuickNavigation from './components/QuickNavigation'
import ActiveTasks from './components/ActiveTasks'
import WorkspaceTabs from './components/WorkspaceTabs'
import WorkspacePage from './WorkspacePage'
import { WorkspaceSessionPane } from './WorkspaceSession'
import { useWorkspaceTabs, type WorkspaceSeed } from './workspaceTabs'
import { isText, useSessionState } from './useSessionState'
import type { PageId } from './navigation'
import { parseWorkspaceRoute, workspaceRouteHash, storedConversationScope, storedScreeningView, type WorkspaceRoute } from './workspaceRoute'
import { useAssistantLaunch } from './useAssistantLaunch'
import './workspace-switch.css'

export default function App() {
  const [isNavigating, startNavigation] = useTransition()
  const workspaces = useWorkspaceTabs()
  const { route } = workspaces.activeTab, { page } = route
  const [data, setData] = useState<DataStatus | null>(null)
  const [systemOpen, setSystemOpen] = useState(false)
  const [pageActionsTarget, setPageActionsTarget] = useState<HTMLDivElement | null>(null)
  const [quickNavigationOpen, setQuickNavigationOpen] = useState(false)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia?.('(max-width: 900px)').matches ?? false)
  const [sidebarRevision, setSidebarRevision] = useState(0)
  const [conversationUpdate, setConversationUpdate] = useState<({ id: string } & ConversationHistoryChange)>()
  const [homeDraft, setHomeDraft] = useSessionState('home.researchDraft', '', isText)
  const [sidebarCollapsed, setSidebarCollapsed] = useSessionState('app.sidebarCollapsed', false, (value): value is boolean => typeof value === 'boolean')
  const [loadError, setLoadError] = useState('')
  const conversationNavigation = useRef(0)
  const assistantLaunch = useAssistantLaunch()
  const [workspacePreference, setWorkspacePreference] = useSessionState<WorkflowType>('app.workspace', 'research', (value): value is WorkflowType => value === 'research' || value === 'screening')
  const workspaceArea: WorkflowType = ['conditions', 'patterns', 'qmt'].includes(page) ? 'screening' : ['home', 'screening', 'research', 'intelligence'].includes(page) ? 'research' : route.workspace ?? workspacePreference
  const navigationLabel = compactNavigation
    ? mobileNavigationOpen ? '关闭工作导航' : '打开工作导航'
    : sidebarCollapsed ? '展开工作导航' : '收起工作导航'
  const [researchLocation, setResearchLocation] = useSessionState('app.researchLocation', '#/research/new', isText)
  const [screeningLocation, setScreeningLocation] = useSessionState('app.screeningLocation', '#/screening/new', isText)
  useEffect(() => { setWorkspacePreference(workspaceArea) }, [workspaceArea])
  useEffect(() => {
    if (page === 'screening') setResearchLocation(workspaceRouteHash(route))
    if (page === 'conditions') setScreeningLocation(workspaceRouteHash(route))
  }, [route])
  useEffect(() => { ++conversationNavigation.current }, [workspaces.activeId])

  function openRoute(next: WorkspaceRoute, seed?: WorkspaceSeed, reusePage = false) {
    ++conversationNavigation.current
    setMobileNavigationOpen(false)
    startNavigation(() => { workspaces.open(next, { seed, forceNew: !!seed, reusePage }) })
  }
  function navigateFromMenu(nextPage: PageId) {
    openRoute({ page: nextPage, ...(['library', 'news', 'patterns', 'reports', 'watchlist', 'qmt'].includes(nextPage) ? { workspace: workspaceArea } : {}), ...((nextPage === 'screening' || nextPage === 'conditions') ? { scope: storedConversationScope() } : {}), ...(nextPage === 'conditions' ? { view: storedScreeningView() } : {}) }, undefined, ['screening', 'conditions', 'research', 'watchlist', 'intelligence', 'library'].includes(nextPage))
  }
  function switchWorkspace(next: WorkflowType) {
    if (next === workspaceArea) return
    setWorkspacePreference(next)
    const saved = parseWorkspaceRoute(next === 'research' ? researchLocation : screeningLocation)
    openRoute(saved?.page === (next === 'research' ? 'screening' : 'conditions') ? saved : { page: next === 'research' ? 'screening' : 'conditions', newDraft: true })
  }
  function newResearch(workflow: WorkflowType = 'research') {
    openRoute({ page: workflow === 'research' ? 'screening' : 'conditions', scope: 'screening', newDraft: true, ...(workflow === 'screening' ? { view: 'conversation' } : {}) }, { fresh: true })
  }
  async function resumeResearch(id: string, scope: ConversationScope, workflow?: WorkflowType, prompt?: string) {
    const existing = workspaces.tabs.find(tab => tab.route.conversationId === id)
    if (existing && !prompt) { ++conversationNavigation.current; setMobileNavigationOpen(false); workspaces.activate(existing.id); return }
    const request = ++conversationNavigation.current
    setMobileNavigationOpen(false)
    let type = workflow
    if (!prompt) {
      try { const current = await api<Conversation>(`/conversations/${encodeURIComponent(id)}`); type = conversationWorkflow(current, workflow); scope = current.entry_scope }
      catch (reason) { if (request === conversationNavigation.current) setLoadError((reason as Error).message); return }
    }
    if (request !== conversationNavigation.current) return
    openRoute({ page: type === 'screening' ? 'conditions' : 'screening', conversationId: id, scope, ...(type === 'screening' ? { view: 'conversation' } : {}) }, prompt ? { prompt } : undefined)
  }
  const openProject = (id: string) => openRoute({ page: 'research', ...(id ? { projectId: id } : {}) })
  async function launchAssistant(id: string, mode: 'immediate' | 'draft' = 'draft', name?: string) {
    if (mode !== 'immediate') { openRoute({ page: 'screening', scope: 'screening', newDraft: true }, { fresh: true, assistantId: id }); return }
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
    api<DataStatus>('/data/status').then(result => { setData(result); setLoadError('') }).catch(error => setLoadError(error.message))
  }
  useEffect(() => { refreshStatus() }, [])
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 900px)')
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

  return <div className={`app-shell redesigned-workspace chat-layout viewport-workspace ${page === 'screening' || page === 'conditions' && (route.view ?? 'conversation') === 'conversation' ? 'chat-page' : 'tool-page'} ${mobileNavigationOpen ? 'mobile-navigation-open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <a className="skip-to-content" href="#workspace-main" onClick={event => { event.preventDefault(); document.getElementById('workspace-main')?.focus() }}>跳到页面内容</a>
    <ResearchSidebar onConversationChange={(id, changes) => {
      setSidebarRevision(value => value + 1)
      setConversationUpdate({ id, ...changes })
      if (changes.title) workspaces.tabs.filter(tab => tab.route.conversationId === id).forEach(tab => workspaces.rename(tab.id, changes.title!))
      if (changes.deleted || changes.state === 'archived') { workspaces.forgetClosedConversation(id); workspaces.tabs.filter(tab => tab.route.conversationId === id).forEach(tab => workspaces.close(tab.id, { remember: false })) }
    }} workspace={workspaceArea} screeningView={route.view ?? 'conversation'} onWorkspaceChange={switchWorkspace} onScreeningView={view => openRoute({ page: 'conditions', view })} busy={assistantLaunch.state.loading} onAssistant={launchAssistant} page={page} conversationId={route.conversationId} revision={sidebarRevision} mobileOpen={mobileNavigationOpen} onClose={() => setMobileNavigationOpen(false)} onNavigate={navigateFromMenu} onNewResearch={() => newResearch()} onNewScreening={() => newResearch('screening')} onConversation={resumeResearch} onSearch={() => { setMobileNavigationOpen(false); setQuickNavigationOpen(true) }} onSettings={() => { setMobileNavigationOpen(false); setSystemOpen(true) }} />
    <main id="workspace-main" tabIndex={-1} className="main-shell" aria-busy={isNavigating}>
      {isNavigating && <div className="page-navigation-progress" role="status" aria-label="正在切换页面" />}
      <header className="research-header workspace-tab-header" aria-label="工作区导航与全局操作">
        <div className="workspace-header-leading"><button className="icon-button chat-menu-toggle workspace-button" aria-controls="workspace-navigation" aria-expanded={compactNavigation ? mobileNavigationOpen : !sidebarCollapsed} onClick={() => { if (compactNavigation) setMobileNavigationOpen(value => !value); else setSidebarCollapsed(value => !value) }} aria-label={navigationLabel} data-tooltip={navigationLabel}>{compactNavigation && mobileNavigationOpen ? <X className="mobile-menu-icon" size={19} /> : <Menu className="mobile-menu-icon" size={20} />}{sidebarCollapsed ? <PanelLeftOpen className="desktop-menu-icon" size={19} /> : <PanelLeftClose className="desktop-menu-icon" size={19} />}</button></div>
      <WorkspaceTabs tabs={workspaces.tabs} activeId={workspaces.activeId} onActivate={id => { ++conversationNavigation.current; setMobileNavigationOpen(false); workspaces.activate(id) }} onClose={workspaces.close} canReopen={workspaces.canReopen} onReopen={() => { ++conversationNavigation.current; setMobileNavigationOpen(false); workspaces.reopenClosed() }} onMove={workspaces.move} onCloseOthers={id => { ++conversationNavigation.current; workspaces.closeOthers(id) }} onCloseSide={(id, side) => { ++conversationNavigation.current; workspaces.closeSide(id, side) }} onCloseAll={() => { ++conversationNavigation.current; workspaces.closeAll() }} newWorkflow={workspaceArea} onNew={() => newResearch(workspaceArea)} />
        <div className="research-header-actions">{page === 'screening' && <div id="research-tools-slot" className="research-tools-slot" />}<ActiveTasks onIntelligence={(briefId, briefKind) => openRoute({ page: 'intelligence', briefId, briefKind })} onConversation={resumeResearch} onProject={openProject} onNavigate={navigateFromMenu} onSettings={() => setSystemOpen(true)} />{page !== 'screening' && page !== 'intelligence' && data?.last_date && <button className="header-data-status workspace-button" onClick={() => setSystemOpen(true)} aria-label={`行情截至 ${data.last_date}，查看数据状态`} data-tooltip="查看数据状态"><Database size={14} /><time>{data.last_date}</time></button>}</div>
        <div ref={setPageActionsTarget} className="workspace-page-actions-slot" role="toolbar" aria-label="当前页面操作" />
      </header>
      {loadError && <div className="global-alert workspace-error" role="alert"><AlertCircle size={16} /><span>暂时无法连接服务，请检查本地服务是否已启动。</span><button onClick={refreshStatus} className="workspace-button"><RefreshCw size={14} />重试</button></div>}
      {(assistantLaunch.state.loading || assistantLaunch.state.error) && <div className={'assistant-launch-status' + (assistantLaunch.state.error ? ' workspace-error' : '')} role={assistantLaunch.state.error ? 'alert' : 'status'}>{assistantLaunch.state.loading ? <><RefreshCw size={15} className="spin" /><span>正在启动{assistantLaunch.state.name}…</span></> : <><AlertCircle size={15} /><span>{assistantLaunch.state.name}：{assistantLaunch.state.error}</span>{assistantLaunch.state.recoverable && <button onClick={() => void retryAssistantLaunch()} className="workspace-button">继续启动</button>}<button aria-label="关闭助手启动提示" onClick={assistantLaunch.dismiss} className="workspace-button">关闭</button></>}</div>}
      {workspaces.tabs.map(tab => <WorkspaceSessionPane key={tab.id} tab={tab} active={tab.id === workspaces.activeId} actionsTarget={pageActionsTarget} onTitle={title => workspaces.rename(tab.id, title)}>
        <WorkspacePage tab={tab} data={data} workspace={tab.route.page === 'conditions' ? 'screening' : tab.route.workspace ?? 'research'} conversationUpdate={conversationUpdate} homeDraft={tab.legacy ? homeDraft : ''} onLegacyDraft={() => { openRoute({ page: 'screening', scope: 'screening', newDraft: true }, { prompt: homeDraft.trim(), fresh: true }); setHomeDraft('') }} onUpdate={(next, userNavigation = false) => { if (userNavigation && tab.id === workspaces.activeId) ++conversationNavigation.current; workspaces.update(tab.id, next, !userNavigation) }} onOpen={openRoute} onConversation={resumeResearch} onNewResearch={() => newResearch()} onSettings={() => setSystemOpen(true)} onHistoryChange={() => setSidebarRevision(value => value + 1)} />
      </WorkspaceSessionPane>)}
    </main>
    {systemOpen && <SystemDrawer data={data} onClose={() => setSystemOpen(false)} onRefresh={refreshStatus} onOpenCompanyResearch={() => openProject('')} />}
    {quickNavigationOpen && <QuickNavigation onClose={() => setQuickNavigationOpen(false)} onNavigate={navigateFromMenu} onProject={openProject} onConversation={resumeResearch} onNewResearch={() => newResearch()} onSettings={() => setSystemOpen(true)} />}
  </div>
}
