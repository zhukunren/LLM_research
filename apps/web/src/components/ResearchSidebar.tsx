import { useEffect, useRef, useState } from 'react'
import { Bot, BookOpen, ChartNoAxesCombined, ChevronDown, FolderOpen, ListFilter, MessageCircle, Network, Plus, Search, Settings2, ShieldCheck, Star, Wrench, X } from 'lucide-react'
import { api, conversationWorkflow, type ConversationScope, type ResearchAssistant, type WorkflowType } from '../api'
import { workspaceMenus, type PageId } from '../navigation'
import { trapDialogTab } from '../keyboard'

type Recent = { id: string; title: string | null; entry_scope: ConversationScope; workflow_type?: WorkflowType; research_mode?: string; task_revision?: number; last_turn_state?: string }
const toolMenus = workspaceMenus.filter(item => ['conditions', 'reports', 'news', 'technical', 'patterns'].includes(item.id))
const assistantIcons = { general: MessageCircle, financial: ChartNoAxesCombined, reports: BookOpen, 'supply-chain': Network, risk: ShieldCheck }

export default function ResearchSidebar({ page, conversationId, revision, mobileOpen, onClose, onNavigate, onNewResearch, onSearch, onConversation, onSettings, onAssistant }: {
  page: PageId; conversationId?: string; revision: number; mobileOpen: boolean; onClose: () => void
  onNavigate: (page: PageId) => void; onNewResearch: () => void; onSearch: () => void
  onConversation: (id: string, scope: ConversationScope, workflow?: WorkflowType) => void; onSettings: () => void
  onAssistant: (id: string) => void
}) {
  const [items, setItems] = useState<Recent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [limit, setLimit] = useState(12)
  const [toolsOpen, setToolsOpen] = useState(toolMenus.some(item => item.id === page))
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
    api<{ items: Recent[] }>('/conversations?limit=30', { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.items)) throw new Error('暂时无法读取对话。')
      if (!controller.signal.aborted) setItems(result.items)
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [conversationId, revision, retry])

  return <>
    {mobileOpen && <div className="chat-sidebar-backdrop" onClick={onClose} aria-hidden="true" />}
    <aside className="chat-sidebar" role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? true : undefined} aria-label="工作导航" onKeyDown={event => {
      if (!mobileOpen) return
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      trapDialogTab(event)
    }}>
      <div className="chat-brand"><img className="chat-brand-full" src="/brand/soochow-blue.png" alt="东吴证券 SOOCHOW SECURITIES" /><img className="chat-brand-symbol" src="/brand/soochow-symbol-blue.png" alt="东吴证券" /><button ref={close} className="icon-button chat-sidebar-close" aria-label="关闭工作导航" onClick={onClose}><X size={19} /></button></div>
      <div className="chat-workspace-name">投研工作台<span>张家港营业部</span></div>
      <nav className="chat-navigation" aria-label="主菜单">
        <button className="chat-nav-button chat-new" aria-label="开始新研究" title="开始新研究" onClick={onNewResearch}><Plus size={19} /><span>新研究</span></button>
        <button className="chat-nav-button" aria-label="搜索与快速导航" title="搜索与快速导航" onClick={onSearch}><Search size={18} /><span>搜索记录</span><kbd>Ctrl K</kbd></button>
        <button className="chat-nav-button" aria-label="研究对话" title="研究对话" aria-current={page === 'screening' ? 'page' : undefined} onClick={() => onNavigate('screening')}><MessageCircle size={18} /><span>研究对话</span></button>
        <button className="chat-nav-button" aria-label="研究项目" title="研究项目" aria-current={page === 'research' ? 'page' : undefined} onClick={() => onNavigate('research')}><FolderOpen size={18} /><span>研究项目</span></button>
        <button className="chat-nav-button" aria-label="观察池" title="观察池" aria-current={page === 'watchlist' ? 'page' : undefined} onClick={() => onNavigate('watchlist')}><Star size={18} /><span>观察池</span></button>
        <button className="chat-nav-button chat-tools-toggle" aria-label="研究助手" title="研究助手" aria-current={page === 'assistants' ? 'page' : undefined} aria-expanded={assistantsOpen} aria-controls="chat-assistant-links" onClick={() => { if (mobileOpen || page === 'assistants') setAssistantsOpen(value => !value); else { setAssistantsOpen(true); onNavigate('assistants') } }}><Bot size={18} /><span>研究助手</span><ChevronDown size={14} /></button>
        <div id="chat-assistant-links" className="chat-assistant-links" role="group" aria-label="研究助手子入口" hidden={!assistantsOpen}>
          {assistantsLoading && !assistants.length && <p role="status">正在读取助手…</p>}
          {assistants.map(item => { const Icon = assistantIcons[item.id as keyof typeof assistantIcons] || Bot; return <button className="chat-nav-button" key={item.id} aria-label={`使用${item.name}`} title={item.description} onClick={() => onAssistant(item.id)}><Icon size={16} /><span>{item.name}</span></button> })}
          {assistantsError && <button className="chat-nav-button" onClick={() => setAssistantsRetry(value => value + 1)}>重试助手列表</button>}
        </div>
        <button className="chat-nav-button chat-tools-toggle" title="资料与工具" aria-label="资料与工具" aria-expanded={toolsOpen} aria-controls="chat-tool-links" onClick={() => setToolsOpen(value => !value)}><Wrench size={18} /><span>资料与工具</span><ChevronDown size={14} /></button>
        <div id="chat-tool-links" className="chat-tool-links" hidden={!toolsOpen}>{toolMenus.map(({ id, label, icon: Icon }) => <button className="chat-nav-button" key={id} aria-label={label} title={label} aria-current={page === id ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon size={16} /><span>{label}</span></button>)}</div>
      </nav>
      <section className="chat-history" aria-label="最近对话"><h2>最近对话</h2>
        {error && <div className="chat-history-error" role="alert"><span>对话记录暂不可用</span><button className="text-button" title={error} onClick={() => setRetry(value => value + 1)}>重试</button></div>}
        {loading && !items.length ? <p role="status">正在读取…</p> : !error && !items.length ? <p>新对话会保存在这里</p> : null}
        {items.slice(0, limit).map(item => {
          const screening = conversationWorkflow(item) === 'screening'
          return <button key={item.id} className="chat-history-item" title={item.title || '未命名对话'} aria-label={`继续${screening ? '选股' : '研究'}：${item.title || '未命名对话'}`} aria-current={conversationId === item.id ? 'page' : undefined} onClick={() => onConversation(item.id, item.entry_scope, conversationWorkflow(item))}>{screening && <ListFilter size={13} />}<span>{item.title?.trim() || '未命名对话'}</span>{['failed', 'awaiting_user', 'running', 'awaiting_agent'].includes(item.last_turn_state || '') && <i className={item.last_turn_state === 'failed' || item.last_turn_state === 'awaiting_user' ? 'needs-attention' : 'in-progress'} aria-label={item.last_turn_state === 'failed' ? '需重试' : item.last_turn_state === 'awaiting_user' ? '待补充' : '处理中'} />}</button>
        })}
        {limit < items.length && <button className="chat-history-more" onClick={() => setLimit(value => value + 12)}>更多记录</button>}
      </section>
      <button className="chat-settings chat-nav-button" aria-label="数据与服务" title="数据与服务" onClick={onSettings}><Settings2 size={18} /><span>数据与服务</span></button>
    </aside>
  </>
}
