import LoadingState from './LoadingState'
import { StockText } from './StockMentions'
import { useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronDown, MessageCircle, Plus, Radio, Search, Send, Settings2, Star, Wrench, X } from 'lucide-react'
import { api, conversationWorkflow, type ConversationScope, type WorkflowType } from '../api'
import { clientServiceMenus, workspaceMenus, type PageId, type ServiceView } from '../navigation'
import { trapDialogTab } from '../keyboard'
import ConversationHistoryItem, { type RecentConversation, type ConversationHistoryChange } from './ConversationHistoryItem'

const toolMenus = workspaceMenus.filter(item => ['qmt', 'patterns', 'etf', 'data-download'].includes(item.id))

export default function ResearchSidebar({ page, conversationId, revision, mobileOpen, historyOnly, onClose, onNavigate, onNewResearch, onNewScreening, onResearch, onSearch, onConversation, onSettings, workspace, onConversationChange, historyNavigation, serviceView = 'cards', onServiceView }: {
  serviceView?: ServiceView; onServiceView?: (view: ServiceView) => void
  workspace?: WorkflowType; onResearch?: () => void
  page: PageId; conversationId?: string; revision: number; mobileOpen: boolean; historyOnly?: boolean; onClose: () => void
  onNavigate: (page: PageId) => void; onNewResearch: () => void; onNewScreening: () => void; onSearch: () => void
  onConversation: (id: string, scope: ConversationScope, workflow?: WorkflowType) => void; onSettings: () => void
  onAssistant: (id: string, launchMode?: 'immediate' | 'draft', name?: string) => void; busy?: boolean
  onConversationChange?: (id: string, changes: ConversationHistoryChange) => void
  historyNavigation?: { id: string; phase: 'opening' | 'error' } | null
}) {
  const isService = page === 'client-service'
  const workflow = workspace ?? (page === 'conditions' ? 'screening' : 'research')
  const [items, setItems] = useState<RecentConversation[]>([])
  const [archived, setArchived] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [limit, setLimit] = useState(12)
  const [advancedOpen, setAdvancedOpen] = useState(toolMenus.some(item => item.id === page))
  useEffect(() => { if (toolMenus.some(item => item.id === page)) setAdvancedOpen(true) }, [page])
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
    api<{ items: RecentConversation[] }>(`/conversations?limit=50&state=${archived ? 'archived' : 'active'}&exclude_intelligence=true`, { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.items)) throw new Error('暂时无法读取对话。')
      if (!controller.signal.aborted) setItems(result.items)
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [conversationId, revision, retry, archived])
  useEffect(() => { setLimit(12) }, [archived])
  const visibleItems = items.filter(item => (item.state || 'active') === (archived ? 'archived' : 'active')).sort((left, right) => Number(!!right.pinned) - Number(!!left.pinned))
  function changeConversation(id: string, changes: ConversationHistoryChange) {
    setItems(current => changes.deleted ? current.filter(item => item.id !== id) : current.map(item => item.id === id ? { ...item, ...changes } : item))
    onConversationChange?.(id, changes)
  }

  if (historyOnly && !mobileOpen) return null
  return <StockText><>
    {mobileOpen && <div className="chat-sidebar-backdrop" onClick={onClose} aria-hidden="true" />}
    <aside id="workspace-navigation" className={`chat-sidebar${historyOnly ? ' mobile-history-sheet' : ''}`} role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? true : undefined} aria-label={historyOnly ? '对话记录' : '工作导航'} onKeyDown={event => {
      if (!mobileOpen) return
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      trapDialogTab(event)
    }}>
      {historyOnly ? <header className="mobile-sheet-header"><h2>对话记录</h2><button ref={close} type="button" className="icon-button mobile-icon-button workspace-button" aria-label="关闭对话记录" onClick={onClose}><X size={20} aria-hidden="true" /></button></header> : <>
      <div className="chat-brand"><img className="chat-brand-full" src="/brand/soochow-blue.png" alt="东吴证券 SOOCHOW SECURITIES" /><img className="chat-brand-symbol" src="/brand/soochow-symbol-blue.png" alt="东吴证券" /><button ref={close} className="icon-button chat-sidebar-close workspace-button" aria-label="关闭工作导航" onClick={onClose}><X size={19} /></button></div>
      <div className="chat-workspace-name">张家港营业部投研工作台</div>
      <div className="workspace-mode-switch" role="group" aria-label="研究与服务切换">
        <button type="button" aria-label="切换到研究" data-tooltip="研究" aria-pressed={!isService} onClick={() => { if (isService) { if (onResearch) onResearch(); else onNavigate('screening') } }} className="workspace-button"><MessageCircle size={16} /><span>研究</span></button>
        <button type="button" aria-label="切换到服务" data-tooltip="服务" aria-pressed={isService} onClick={() => { if (!isService) onNavigate('client-service') }} className="workspace-button"><Send size={16} /><span>服务</span></button>
      </div>
      <nav className="chat-navigation" aria-label="主菜单">
        {!isService && <>
        <button className="chat-nav-button chat-new workspace-button" aria-label="新建任务" data-tooltip={workflow === 'screening' ? '新建选股任务' : '新建研究任务'} onClick={workflow === 'screening' ? onNewScreening : onNewResearch}><Plus size={19} /><span>新建任务</span></button>
        <button className="chat-nav-button workspace-button" aria-label="搜索页面或对话" data-tooltip="搜索与跳转" onClick={onSearch}><Search size={18} /><span>搜索与跳转</span><kbd>Ctrl K</kbd></button>
        <button className="chat-nav-button workspace-button" aria-label="观察池" data-tooltip="观察池" aria-current={page === 'watchlist' ? 'page' : undefined} onClick={() => onNavigate('watchlist')}><Star size={18} /><span>观察池</span></button>
        <button className="chat-nav-button workspace-button" aria-label="资料库" aria-current={['library', 'news', 'reports'].includes(page) ? 'page' : undefined} onClick={() => onNavigate('library')}><BookOpen size={18} /><span>资料库</span></button>
        <button className="chat-nav-button workspace-button" aria-label="每日信号汇总" data-tooltip="每日信号汇总" aria-current={page === 'daily-signals' ? 'page' : undefined} onClick={() => onNavigate('daily-signals')}><Radio size={18} /><span>每日信号汇总</span></button>
        <button className="chat-nav-button chat-tools-toggle workspace-button" aria-label="研究工具" aria-expanded={advancedOpen} aria-controls="screening-advanced-links" onClick={() => setAdvancedOpen(value => !value)}><Wrench size={18} /><span>研究工具</span><ChevronDown size={14} /></button>
          <div id="screening-advanced-links" className="chat-tool-links" hidden={!advancedOpen}>
          {toolMenus.map(({ id, label, icon: Icon }) => <button className="chat-nav-button workspace-button" key={id} aria-label={label} aria-current={page === id ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon size={16} /><span>{label}</span></button>)}
          </div></>}
        {isService && clientServiceMenus.map(({ id, label, icon: Icon }) => <button key={id} className="chat-nav-button workspace-button" aria-label={label} aria-current={serviceView === id ? 'page' : undefined} onClick={() => onServiceView ? onServiceView(id) : onNavigate('client-service')}><Icon size={18} /><span>{label}</span></button>)}
      </nav></>}
      {(!isService || historyOnly) && <section className="chat-history" aria-label="最近任务"><div className="chat-history-heading"><h2>{archived ? '已归档任务' : '最近任务'}</h2><button type="button" className="chat-history-archive-toggle workspace-button" aria-pressed={archived} onClick={() => { setItems([]); setArchived(value => !value) }}>{archived ? '返回最近' : '已归档'}</button></div>
        {error && <div className="chat-history-error workspace-error" role="alert"><span>对话记录暂不可用</span><button className="text-button workspace-button" data-tooltip={error} onClick={() => setRetry(value => value + 1)}>重试</button></div>}
        {loading && !visibleItems.length ? <LoadingState compact label="正在读取…" /> : !error && !visibleItems.length ? <p>{archived ? '暂无已归档对话' : '新对话会保存在这里'}</p> : null}
        {visibleItems.slice(0, limit).map(item => <ConversationHistoryItem key={item.id} item={item} showWorkflow current={conversationId === item.id} openState={historyNavigation?.id === item.id ? historyNavigation.phase : undefined} onOpen={() => onConversation(item.id, item.entry_scope, conversationWorkflow(item))} onChange={changeConversation} />)}
        {limit < visibleItems.length && <button className="chat-history-more workspace-button" onClick={() => setLimit(value => value + 12)}>更多记录</button>}
      </section>}
      {!historyOnly && <button className="chat-settings chat-nav-button workspace-button" aria-label="数据与连接" data-tooltip="数据与连接" onClick={onSettings}><Settings2 size={18} /><span>数据与连接</span></button>}
    </aside>
  </></StockText>
}
