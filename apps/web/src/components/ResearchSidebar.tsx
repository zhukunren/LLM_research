import LoadingState from './LoadingState'
import { StockText } from './StockMentions'
import { useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronDown, Bookmark, History, FolderOpen, ListFilter, MessageCircle, Plus, Search, Settings2, Star, Wrench, X } from 'lucide-react'
import { api, conversationWorkflow, type ConversationScope, type WorkflowType } from '../api'
import { workspaceMenus, type PageId } from '../navigation'
import { trapDialogTab } from '../keyboard'
import ConversationHistoryItem, { type RecentConversation, type ConversationHistoryChange } from './ConversationHistoryItem'

const toolMenus = workspaceMenus.filter(item => ['patterns', 'qmt'].includes(item.id))

export default function ResearchSidebar({ page, conversationId, revision, mobileOpen, onClose, onNavigate, onNewResearch, onNewScreening, onSearch, onConversation, onSettings, workspace, screeningView, onWorkspaceChange, onScreeningView, onConversationChange }: {
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
  const [advancedOpen, setAdvancedOpen] = useState(toolMenus.some(item => item.id === page) || page === 'conditions' && ['library', 'create', 'compose'].includes(screeningView || ''))
  useEffect(() => { if (toolMenus.some(item => item.id === page) || page === 'conditions' && ['library', 'create', 'compose'].includes(screeningView || '')) setAdvancedOpen(true) }, [page, screeningView])
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!mobileOpen) return
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => close.current?.focus())
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus() }
  }, [mobileOpen])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    api<{ items: RecentConversation[] }>(`/conversations?limit=50&workflow_type=${area}&state=${archived ? 'archived' : 'active'}&exclude_intelligence=true`, { signal: controller.signal }).then(result => {
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

  return <StockText><>
    {mobileOpen && <div className="chat-sidebar-backdrop" onClick={onClose} aria-hidden="true" />}
    <aside id="workspace-navigation" className="chat-sidebar" role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? true : undefined} aria-label="工作导航" onKeyDown={event => {
      if (!mobileOpen) return
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      trapDialogTab(event)
    }}>
      <div className="chat-brand"><img className="chat-brand-full" src="/brand/soochow-blue.png" alt="东吴证券 SOOCHOW SECURITIES" /><img className="chat-brand-symbol" src="/brand/soochow-symbol-blue.png" alt="东吴证券" /><button ref={close} className="icon-button chat-sidebar-close workspace-button" aria-label="关闭工作导航" onClick={onClose}><X size={19} /></button></div>
      <div className="chat-workspace-name">投研工作台</div>
      <div className="workspace-mode-switch" role="group" aria-label="研究与选股切换">
        <button type="button" aria-label="切换到研究" data-tooltip="研究" aria-pressed={isResearch} onClick={() => changeArea('research')} className="workspace-button"><MessageCircle size={16} /><span>研究</span></button>
        <button type="button" aria-label="切换到选股" data-tooltip="选股" aria-pressed={!isResearch} onClick={() => changeArea('screening')} className="workspace-button"><ListFilter size={16} /><span>选股</span></button>
      </div>
      <nav className="chat-navigation" aria-label="主菜单">
        <button className="chat-nav-button chat-new workspace-button" aria-label={isResearch ? '开始新研究' : '开始选股'} data-tooltip={isResearch ? '开始新研究' : '开始选股'} aria-current={!isResearch && page === 'conditions' && (!screeningView || screeningView === 'conversation') ? 'page' : undefined} onClick={isResearch ? onNewResearch : onNewScreening}><Plus size={19} /><span>{isResearch ? '新研究' : '新选股'}</span></button>
        <button className="chat-nav-button workspace-button" aria-label="搜索与快速导航" data-tooltip="搜索与快速导航" onClick={onSearch}><Search size={18} /><span>搜索记录</span><kbd>Ctrl K</kbd></button>
        {isResearch && <>
        <button className="chat-nav-button workspace-button" aria-label="研究项目" data-tooltip="研究项目" aria-current={page === 'research' ? 'page' : undefined} onClick={() => onNavigate('research')}><FolderOpen size={18} /><span>研究项目</span></button>
        </>}
        {!isResearch && <>
          <button className="chat-nav-button workspace-button" aria-label="我的方案" aria-current={page === 'conditions' && screeningView === 'saved' ? 'page' : undefined} onClick={() => onScreeningView?.('saved')}><Bookmark size={18} /><span>我的方案</span></button>
        </>}
        {!isResearch && <><button className="chat-nav-button chat-tools-toggle workspace-button" aria-label="策略工具" aria-expanded={advancedOpen} aria-controls="screening-advanced-links" onClick={() => setAdvancedOpen(value => !value)}><Wrench size={18} /><span>策略工具</span><ChevronDown size={14} /></button>
          <div id="screening-advanced-links" className="chat-tool-links" hidden={!advancedOpen}>
          <button className="chat-nav-button workspace-button" aria-label="条件与组合" aria-current={page === 'conditions' && ['library', 'create', 'compose'].includes(screeningView || '') ? 'page' : undefined} onClick={() => onScreeningView?.('library')}><ListFilter size={18} /><span>条件与组合</span></button>
          {toolMenus.map(({ id, label, icon: Icon }) => <button className="chat-nav-button workspace-button" key={id} aria-label={label} aria-current={page === id ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon size={16} /><span>{label}</span></button>)}
          </div></>}
        <div className="workspace-shared-label">共享资料</div>
        <button className="chat-nav-button workspace-button" aria-label="观察池" data-tooltip="观察池" aria-current={page === 'watchlist' ? 'page' : undefined} onClick={() => onNavigate('watchlist')}><Star size={18} /><span>观察池</span></button>
        <button className="chat-nav-button workspace-button" aria-label="资料库" aria-current={['library', 'news', 'reports'].includes(page) ? 'page' : undefined} onClick={() => onNavigate('library')}><BookOpen size={18} /><span>资料库</span></button>
      </nav>
      <section className="chat-history" aria-label={isResearch ? "最近对话" : "最近选股"}><div className="chat-history-heading"><h2>{archived ? '已归档对话' : isResearch ? '最近研究' : '最近选股'}</h2><button type="button" className="chat-history-archive-toggle workspace-button" aria-pressed={archived} onClick={() => { setItems([]); setArchived(value => !value) }}>{archived ? '返回最近' : '已归档'}</button></div>
        {error && <div className="chat-history-error workspace-error" role="alert"><span>对话记录暂不可用</span><button className="text-button workspace-button" data-tooltip={error} onClick={() => setRetry(value => value + 1)}>重试</button></div>}
        {loading && !visibleItems.length ? <LoadingState compact label="正在读取…" /> : !error && !visibleItems.length ? <p>{archived ? '暂无已归档对话' : '新对话会保存在这里'}</p> : null}
        {visibleItems.slice(0, limit).map(item => <ConversationHistoryItem key={item.id} item={item} current={conversationId === item.id} onOpen={() => onConversation(item.id, item.entry_scope, conversationWorkflow(item))} onChange={changeConversation} />)}
        {limit < visibleItems.length && <button className="chat-history-more workspace-button" onClick={() => setLimit(value => value + 12)}>更多记录</button>}
        {!isResearch && <button className="chat-nav-button workspace-button" aria-label="全部筛选记录" data-tooltip="查看全部筛选运行记录" aria-current={page === 'conditions' && screeningView === 'history' ? 'page' : undefined} onClick={() => onScreeningView?.('history')}><History size={16} /><span>全部筛选记录</span></button>}
      </section>
      <button className="chat-settings chat-nav-button workspace-button" aria-label="数据与服务" data-tooltip="数据与服务" onClick={onSettings}><Settings2 size={18} /><span>数据与服务</span></button>
    </aside>
  </></StockText>
}
