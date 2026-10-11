import { StockText } from './StockMentions'
import { useEffect, useRef, useState } from 'react'
import { Bot, BookOpen, ChartNoAxesCombined, ChevronDown, Factory, Bookmark, History, FolderOpen, Landmark, ListFilter, MessageCircle, Network, Newspaper, Plus, Search, Settings2, ShieldCheck, Star, Wrench, X } from 'lucide-react'
import { api, conversationWorkflow, type ConversationScope, type ResearchAssistant, type WorkflowType } from '../api'
import { workspaceMenus, type PageId } from '../navigation'
import { trapDialogTab } from '../keyboard'
import ConversationHistoryItem, { type RecentConversation, type ConversationHistoryChange } from './ConversationHistoryItem'

const toolMenus = workspaceMenus.filter(item => ['reports', 'news', 'technical', 'patterns'].includes(item.id))
const assistantIcons = { general: MessageCircle, financial: ChartNoAxesCombined, reports: BookOpen, 'supply-chain': Network, risk: ShieldCheck, 'daily-hotspots': Newspaper, 'policy-tracker': Landmark, 'industry-updates': Factory }

export default function ResearchSidebar({ page, conversationId, revision, mobileOpen, onClose, onNavigate, onNewResearch, onNewScreening, onSearch, onConversation, onSettings, onAssistant, workspace, screeningView, onWorkspaceChange, onScreeningView, onConversationChange, busy = false }: {
  workspace?: WorkflowType; screeningView?: string; onWorkspaceChange?: (area: WorkflowType) => void; onScreeningView?: (view: 'saved' | 'history' | 'library' | 'compose') => void
  page: PageId; conversationId?: string; revision: number; mobileOpen: boolean; onClose: () => void
  onNavigate: (page: PageId) => void; onNewResearch: () => void; onNewScreening: () => void; onSearch: () => void
  onConversation: (id: string, scope: ConversationScope, workflow?: WorkflowType) => void; onSettings: () => void
  onAssistant: (id: string, launchMode?: 'immediate' | 'draft', name?: string) => void; busy?: boolean
  onConversationChange?: (id: string, changes: ConversationHistoryChange) => void
}) {
  const area = workspace ?? (page === 'conditions' ? 'screening' : 'research')
  const isResearch = area === 'research'
  const [items, setItems] = useState<RecentConversation[]>([])
  const [archived, setArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [limit, setLimit] = useState(12)
  const [toolsOpen, setToolsOpen] = useState(toolMenus.some(item => item.id === page))
  const [advancedOpen, setAdvancedOpen] = useState(page === 'conditions' && ['library', 'create', 'compose'].includes(screeningView || ''))
  useEffect(() => { if (page === 'conditions' && ['library', 'create', 'compose'].includes(screeningView || '')) setAdvancedOpen(true) }, [page, screeningView])
  const [assistantsOpen, setAssistantsOpen] = useState(page === 'assistants')
  const [assistants, setAssistants] = useState<ResearchAssistant[]>([])
  const [assistantsLoading, setAssistantsLoading] = useState(false)
  const [assistantsError, setAssistantsError] = useState(false)
  const [assistantsRetry, setAssistantsRetry] = useState(0)
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (toolMenus.some(item => item.id === page)) setToolsOpen(true)
    if (page === 'assistants') setAssistantsOpen(true)
  }, [page])
  useEffect(() => {
    if (!assistantsOpen) return
    const controller = new AbortController()
    setAssistantsLoading(true); setAssistantsError(false)
    api<{ items: ResearchAssistant[] }>('/research-assistants', { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.items)) throw new Error('助手暂不可用')
      if (!controller.signal.aborted) setAssistants(result.items.filter(item => item.builtin && item.enabled))
    }).catch(() => { if (!controller.signal.aborted) setAssistantsError(true) })
      .finally(() => { if (!controller.signal.aborted) setAssistantsLoading(false) })
    return () => controller.abort()
  }, [assistantsOpen, assistantsRetry])
  useEffect(() => {
    if (!mobileOpen) return
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => close.current?.focus())
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus() }
  }, [mobileOpen])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    api<{ items: RecentConversation[] }>(`/conversations?limit=50&workflow_type=${area}&state=${archived ? 'archived' : 'active'}`, { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.items)) throw new Error('暂时无法读取对话。')
      if (!controller.signal.aborted) setItems(result.items.filter(item => conversationWorkflow(item) === area))
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [conversationId, revision, retry, area, archived])
  useEffect(() => { setLimit(12) }, [area, archived])
  const changeArea = (next: WorkflowType) => {
    if (next === area) return
    if (onWorkspaceChange) onWorkspaceChange(next)
    else onNavigate(next === 'research' ? 'screening' : 'conditions')
  }
  const visibleItems = items.filter(item => conversationWorkflow(item) === area && (item.state || 'active') === (archived ? 'archived' : 'active')).sort((left, right) => Number(!!right.pinned) - Number(!!left.pinned))
  function changeConversation(id: string, changes: ConversationHistoryChange) {
    setItems(current => changes.deleted ? current.filter(item => item.id !== id) : current.map(item => item.id === id ? { ...item, ...changes } : item))
    onConversationChange?.(id, changes)
  }
  const tasks = assistants.filter(item => item.launch_mode === 'immediate')
  const methods = assistants.filter(item => item.launch_mode !== 'immediate')
  const assistantButton = (item: ResearchAssistant) => {
    const Icon = assistantIcons[item.id as keyof typeof assistantIcons] || Bot
    const immediate = item.launch_mode === 'immediate'
    return <button className="chat-nav-button" key={item.id} aria-label={`使用${item.name}`} title={item.launch_description || item.description} disabled={immediate && busy} onClick={() => immediate ? onAssistant(item.id, 'immediate', item.name) : onAssistant(item.id)}><Icon size={16} /><span>{item.name}</span></button>
  }

  return <StockText><>
    {mobileOpen && <div className="chat-sidebar-backdrop" onClick={onClose} aria-hidden="true" />}
    <aside id="workspace-navigation" className="chat-sidebar" role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? true : undefined} aria-label="工作导航" onKeyDown={event => {
      if (!mobileOpen) return
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      trapDialogTab(event)
    }}>
      <div className="chat-brand"><img className="chat-brand-full" src="/brand/soochow-blue.png" alt="东吴证券 SOOCHOW SECURITIES" /><img className="chat-brand-symbol" src="/brand/soochow-symbol-blue.png" alt="东吴证券" /><button ref={close} className="icon-button chat-sidebar-close" aria-label="关闭工作导航" onClick={onClose}><X size={19} /></button></div>
      <div className="chat-workspace-name">投研工作台</div>
      <div className="workspace-mode-switch" role="group" aria-label="研究与选股切换">
        <button type="button" aria-label="切换到研究" title="研究" aria-pressed={isResearch} onClick={() => changeArea('research')}><MessageCircle size={16} /><span>研究</span></button>
        <button type="button" aria-label="切换到选股" title="选股" aria-pressed={!isResearch} onClick={() => changeArea('screening')}><ListFilter size={16} /><span>选股</span></button>
      </div>
      <nav className="chat-navigation" aria-label="主菜单">
        <button className="chat-nav-button chat-new" aria-label={isResearch ? '开始新研究' : '开始选股'} title={isResearch ? '开始新研究' : '开始选股'} aria-current={!isResearch && page === 'conditions' && (!screeningView || screeningView === 'conversation') ? 'page' : undefined} onClick={isResearch ? onNewResearch : onNewScreening}><Plus size={19} /><span>{isResearch ? '新研究' : '新选股'}</span></button>
        <button className="chat-nav-button" aria-label="搜索与快速导航" title="搜索与快速导航" onClick={onSearch}><Search size={18} /><span>搜索记录</span><kbd>Ctrl K</kbd></button>
        {isResearch && <><button className="chat-nav-button" aria-label="研究对话" title="研究对话" aria-current={page === 'screening' ? 'page' : undefined} onClick={() => onNavigate('screening')}><MessageCircle size={18} /><span>研究对话</span></button>
        <button className="chat-nav-button" aria-label="研究项目" title="研究项目" aria-current={page === 'research' ? 'page' : undefined} onClick={() => onNavigate('research')}><FolderOpen size={18} /><span>研究项目</span></button>
        <button className="chat-nav-button chat-tools-toggle" aria-label="研究助手" title="研究助手" aria-current={page === 'assistants' ? 'page' : undefined} aria-expanded={assistantsOpen} aria-controls="chat-assistant-links" onClick={() => { if (mobileOpen || page === 'assistants') setAssistantsOpen(value => !value); else { setAssistantsOpen(true); onNavigate('assistants') } }}><Bot size={18} /><span>研究助手</span><ChevronDown size={14} /></button>
        <div id="chat-assistant-links" className="chat-assistant-links" role="group" aria-label="研究助手子入口" hidden={!assistantsOpen}>
          {assistantsLoading && !assistants.length && <p role="status">正在读取助手…</p>}
          {tasks.map(assistantButton)}
          {!!tasks.length && !!methods.length && <p>研究方法</p>}
          {methods.map(assistantButton)}
          {assistantsError && <button className="chat-nav-button" onClick={() => setAssistantsRetry(value => value + 1)}>重试助手列表</button>}
        </div>
        </>}
        {!isResearch && <>
          <button className="chat-nav-button" aria-label="我的方案" aria-current={page === 'conditions' && screeningView === 'saved' ? 'page' : undefined} onClick={() => onScreeningView?.('saved')}><Bookmark size={18} /><span>我的方案</span></button>
          <button className="chat-nav-button chat-tools-toggle" aria-label="高级工具" aria-expanded={advancedOpen} aria-controls="screening-advanced-links" onClick={() => setAdvancedOpen(value => !value)}><Wrench size={18} /><span>高级工具</span><ChevronDown size={14} /></button>
          <div id="screening-advanced-links" className="chat-tool-links" hidden={!advancedOpen}>
          <button className="chat-nav-button" aria-label="我的条件" aria-current={page === 'conditions' && ['library', 'create'].includes(screeningView || '') ? 'page' : undefined} onClick={() => onScreeningView?.('library')}><ListFilter size={18} /><span>我的条件</span></button>
          <button className="chat-nav-button" aria-label="高级组合" aria-current={page === 'conditions' && screeningView === 'compose' ? 'page' : undefined} onClick={() => onScreeningView?.('compose')}><ChartNoAxesCombined size={18} /><span>高级组合</span></button>
          </div>
        </>}
        <div className="workspace-shared-label">共享资料</div>
        <button className="chat-nav-button" aria-label="观察池" title="观察池" aria-current={page === 'watchlist' ? 'page' : undefined} onClick={() => onNavigate('watchlist')}><Star size={18} /><span>观察池</span></button>
        <button className="chat-nav-button chat-tools-toggle" title="资料与工具" aria-label="资料与工具" aria-expanded={toolsOpen} aria-controls="chat-tool-links" onClick={() => setToolsOpen(value => !value)}><Wrench size={18} /><span>资料与工具</span><ChevronDown size={14} /></button>
        <div id="chat-tool-links" className="chat-tool-links" hidden={!toolsOpen}>{toolMenus.map(({ id, label, icon: Icon }) => <button className="chat-nav-button" key={id} aria-label={label} title={label} aria-current={page === id ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon size={16} /><span>{label}</span></button>)}</div>
      </nav>
      <section className="chat-history" aria-label={isResearch ? "最近对话" : "最近选股"}><div className="chat-history-heading"><h2>{archived ? '已归档对话' : isResearch ? '最近研究' : '最近选股'}</h2><button type="button" className="chat-history-archive-toggle" aria-pressed={archived} onClick={() => { setItems([]); setArchived(value => !value) }}>{archived ? '返回最近' : '已归档'}</button></div>
        {error && <div className="chat-history-error" role="alert"><span>对话记录暂不可用</span><button className="text-button" title={error} onClick={() => setRetry(value => value + 1)}>重试</button></div>}
        {loading && !visibleItems.length ? <p role="status">正在读取…</p> : !error && !visibleItems.length ? <p>{archived ? '暂无已归档对话' : '新对话会保存在这里'}</p> : null}
        {visibleItems.slice(0, limit).map(item => <ConversationHistoryItem key={item.id} item={item} current={conversationId === item.id} onOpen={() => onConversation(item.id, item.entry_scope, conversationWorkflow(item))} onChange={changeConversation} />)}
        {limit < visibleItems.length && <button className="chat-history-more" onClick={() => setLimit(value => value + 12)}>更多记录</button>}
        {!isResearch && <button className="chat-nav-button" aria-label="全部筛选记录" title="查看全部筛选运行记录" aria-current={page === 'conditions' && screeningView === 'history' ? 'page' : undefined} onClick={() => onScreeningView?.('history')}><History size={16} /><span>全部筛选记录</span></button>}
      </section>
      <button className="chat-settings chat-nav-button" aria-label="数据与服务" title="数据与服务" onClick={onSettings}><Settings2 size={18} /><span>数据与服务</span></button>
    </aside>
  </></StockText>
}
