import { StockText } from './StockMentions'
import EmptyState from './EmptyState'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, FolderOpen, ListFilter, MessageCircle, Plus, Search, Settings2, X } from 'lucide-react'
import { api, conversationWorkflow, type ConversationScope, type WorkflowType } from '../api'
import { workspaceMenus, workspaceLibraryMenus, type PageId } from '../navigation'
import type { ResearchProjectSummary } from '../research'
import { trapDialogTab } from '../keyboard'

type RecentConversation = { state?: 'active' | 'archived'; id: string; title: string | null; entry_scope: ConversationScope; workflow_type?: WorkflowType; research_mode?: string; task_revision?: number; updated_at: string }
type Command = { id: string; label: string; description: string; details?: string; keywords?: string; group: string; icon: typeof Search; select: () => void }

export default function QuickNavigation({ onClose, onNavigate, onProject, onConversation, onNewResearch, onSettings }: {
  onClose: () => void; onNavigate: (page: PageId) => void; onProject: (id: string) => void
  onConversation: (id: string, scope: ConversationScope) => void; onNewResearch: () => void; onSettings: () => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [projects, setProjects] = useState<ResearchProjectSummary[]>([])
  const searchQuery = query.trim()
  const [history, setHistory] = useState<{ query: string; items: RecentConversation[]; more: boolean; nextOffset: number }>({ query: '', items: [], more: false, nextOffset: 0 })
  const conversations = history.query === searchQuery ? history.items : []
  const [offset, setOffset] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [projectLoading, setProjectLoading] = useState(true)
  const [historyError, setHistoryError] = useState(false)
  const [projectError, setProjectError] = useState(false)
  const loading = historyLoading || projectLoading
  const error = historyError || projectError
  const pageLock = useRef(false)
  const [retry, setRetry] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    input.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setProjectLoading(true); setProjectError(false)
    void api<{ items: ResearchProjectSummary[] }>('/research-projects', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setProjects(result.items)
    }).catch(() => { if (!controller.signal.aborted) setProjectError(true) })
      .finally(() => { if (!controller.signal.aborted) setProjectLoading(false) })
    return () => controller.abort()
  }, [retry])
  useEffect(() => {
    const controller = new AbortController()
    setHistoryLoading(true); setHistoryError(false); pageLock.current = true
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: '31', offset: String(offset) })
      if (searchQuery) params.set('q', searchQuery)
      void api<{ items: RecentConversation[] }>('/conversations?' + params, { signal: controller.signal }).then(result => {
        if (controller.signal.aborted) return
        setHistory(previous => {
          const items = offset && previous.query === searchQuery ? [...previous.items, ...result.items.slice(0, 30)] : result.items.slice(0, 30)
          return { query: searchQuery, items: items.filter((item, index) => items.findIndex(other => other.id === item.id) === index), more: result.items.length > 30, nextOffset: offset + 30 }
        })
      }).catch(() => { if (!controller.signal.aborted) setHistoryError(true) })
        .finally(() => { if (!controller.signal.aborted) { setHistoryLoading(false); pageLock.current = false } })
    }, searchQuery ? 180 : 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [searchQuery, offset, retry])

  const commands = useMemo<Command[]>(() => [
    { id: 'new-research', label: '开始新研究', description: '打开一份新的研究草稿', group: '快捷操作', icon: Plus, select: onNewResearch },
    ...conversations.map(item => ({ id: 'conversation-' + item.id, label: item.title?.trim() || '未命名对话', description: (item.state === 'archived' ? '已归档 · ' : '') + (conversationWorkflow(item) === 'screening' ? '继续选股对话' : '继续研究对话'), group: searchQuery ? '历史对话' : '最近对话', icon: conversationWorkflow(item) === 'screening' ? ListFilter : MessageCircle, select: () => onConversation(item.id, item.entry_scope) })),
    ...projects.map(item => ({ id: 'project-' + item.id, label: item.name, description: (item.status === 'archived' ? '已归档 · ' : '') + (item.objective || '研究项目'), details: [item.status === 'archived' ? '已归档' : '', item.objective].filter(Boolean).join(' · '), group: '研究项目', icon: FolderOpen, select: () => onProject(item.id) })),
    ...workspaceMenus.filter(item => !['home', 'news', 'reports'].includes(item.id)).map(item => ({ ...item, id: 'page-' + item.id, keywords: item.id === 'library' ? '资讯库 研报库' : item.id === 'intelligence' ? '快捷任务 今日热点 产业动态 收评 诊股 个股分析 个股推荐理由' : '', group: '页面', select: () => onNavigate(item.id) })),
    { id: 'settings', label: '数据与服务', description: '查看数据覆盖和服务状态', group: '快捷操作', icon: Settings2, select: onSettings },
  ], [projects, conversations, searchQuery, onNavigate, onProject, onConversation, onNewResearch, onSettings])
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const results = words.length
    ? commands.filter(command => words.every(word => (command.label + ' ' + command.description + ' ' + command.group + ' ' + (command.keywords || '')).toLowerCase().includes(word)))
    : commands.filter(command => command.group !== '最近对话' && command.group !== '研究项目'
      || command.group === '最近对话' && conversations.slice(0, 5).some(item => command.id === 'conversation-' + item.id)
      || command.group === '研究项目' && projects.filter(item => item.status !== 'archived').slice(0, 3).some(item => command.id === 'project-' + item.id))
  const activeIndex = Math.min(selected, Math.max(0, results.length - 1))
  function choose(command?: Command) { if (command) { onClose(); command.select() } }
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [activeIndex, query])

  return <StockText><div className="workspace-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="quick-navigation workspace-tool-dialog workspace-dialog" role="dialog" aria-modal="true" aria-label="搜索与快速导航" onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { event.stopPropagation(); return }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      trapDialogTab(event)
      if (event.target !== input.current) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % (results.length || 1)) }
      if (event.key === 'Enter') { event.preventDefault(); choose(results[activeIndex]) }
    }}>
      <div className="quick-navigation-search workspace-field-shell workspace-search-unframed"><Search size={21} /><input ref={input} role="combobox" aria-label="搜索页面、项目或对话" aria-autocomplete="list" aria-expanded="true" aria-controls="quick-navigation-results" aria-activedescendant={results[activeIndex] ? 'quick-' + results[activeIndex].id : undefined} value={query} maxLength={200} onChange={event => { setQuery(event.target.value); setOffset(0); setSelected(0) }} placeholder="查找页面、研究项目或对话…" className="workspace-field" /><button className="icon-button workspace-button" aria-label="关闭快速导航" onClick={onClose}><X size={18} /></button></div>
      <div className="quick-navigation-results" id="quick-navigation-results" ref={list} role="listbox" aria-label="快速导航结果">
        {results.map((command, index) => <div key={command.id} id={'quick-' + command.id} role="option" aria-selected={activeIndex === index} onMouseEnter={() => setSelected(index)} onClick={() => choose(command)}><span className="quick-command-icon"><command.icon size={18} /></span><span><strong>{command.label}</strong><small>{command.details || command.description}</small></span><span className="quick-command-group">{command.group}</span><ArrowUpRight size={14} /></div>)}
        {!results.length && !historyLoading && <EmptyState title="没有找到匹配项" description="试试页面名称、公司或研究主题，也可以清除关键词重新查找。" actions={<><button className="secondary-button workspace-button" onClick={() => { setQuery(''); setOffset(0); input.current?.focus() }}>清除搜索</button><button className="text-button workspace-button" onClick={() => { onClose(); onNavigate('screening') }}>前往研究对话</button></>} />}
      </div>
      {searchQuery && history.query === searchQuery && history.more && <button className="text-button workspace-button" disabled={historyLoading || historyError} onClick={() => {
        if (pageLock.current) return
        pageLock.current = true; setHistoryLoading(true); setOffset(history.nextOffset)
      }}>加载更多历史匹配</button>}
      <p className="quick-navigation-scope">{searchQuery ? '搜索全部历史的对话标题与类型（含归档，不检索正文）；每次加载 30 条。' : '显示最近 5 条对话；输入关键词可检索全部历史标题。'}</p>
      {error && <p className="quick-navigation-error">项目或对话暂未加载。<button className="text-button workspace-button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
      <footer className="quick-navigation-footer"><span role="status">{loading ? '正在加载项目和对话…' : `找到 ${results.length} 个入口`}</span><span><kbd>↑</kbd><kbd>↓</kbd> 选择 <kbd>Enter</kbd> 打开 <kbd>Esc</kbd> 关闭</span></footer>
    </section>
  </div></StockText>
}

export function ResourceNavigation({ onClose, onNavigate }: { onClose: () => void; onNavigate: (page: PageId) => void }) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; close.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="workspace-modal-backdrop resource-navigation-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="resource-navigation workspace-tool-dialog workspace-dialog" role="dialog" aria-modal="true" aria-label="选择研究资料" onKeyDown={event => { if (event.key === 'Escape') onClose(); trapDialogTab(event) }}><div className="resource-navigation-heading"><h2>研究资料</h2><button ref={close} className="icon-button workspace-button" aria-label="关闭资料导航" onClick={onClose}><X size={20} /></button></div>{workspaceLibraryMenus.map(({ id, label, icon: Icon }) => <button className="resource-navigation-item workspace-button" key={id} onClick={() => { onClose(); onNavigate(id) }}><Icon size={22} /><span><strong>{label}</strong></span><ArrowUpRight size={17} /></button>)}</section></div>
}
