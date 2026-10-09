import { StockText } from './StockMentions'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, FolderOpen, ListFilter, MessageCircle, Plus, Search, Settings2, X } from 'lucide-react'
import { api, conversationWorkflow, type ConversationScope, type WorkflowType } from '../api'
import { workspaceMenus, workspaceLibraryMenus, type PageId } from '../navigation'
import type { ResearchProjectSummary } from '../research'
import { trapDialogTab } from '../keyboard'

type RecentConversation = { id: string; title: string | null; entry_scope: ConversationScope; workflow_type?: WorkflowType; research_mode?: string; task_revision?: number; updated_at: string }
type Command = { id: string; label: string; description: string; details?: string; group: string; icon: typeof Search; select: () => void }

export default function QuickNavigation({ onClose, onNavigate, onProject, onConversation, onNewResearch, onSettings }: {
  onClose: () => void; onNavigate: (page: PageId) => void; onProject: (id: string) => void
  onConversation: (id: string, scope: ConversationScope) => void; onNewResearch: () => void; onSettings: () => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [projects, setProjects] = useState<ResearchProjectSummary[]>([])
  const [conversations, setConversations] = useState<RecentConversation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
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
    setLoading(true); setError(false)
    void Promise.allSettled([
      api<{ items: ResearchProjectSummary[] }>('/research-projects', { signal: controller.signal }),
      api<{ items: RecentConversation[] }>('/conversations?limit=30', { signal: controller.signal }),
    ]).then(([projectResult, conversationResult]) => {
      if (controller.signal.aborted) return
      if (projectResult.status === 'fulfilled') setProjects(projectResult.value.items)
      if (conversationResult.status === 'fulfilled') setConversations(conversationResult.value.items)
      setError(projectResult.status === 'rejected' || conversationResult.status === 'rejected')
      setLoading(false)
    })
    return () => controller.abort()
  }, [retry])

  const commands = useMemo<Command[]>(() => [
    { id: 'new-research', label: '开始新研究', description: '打开一份新的研究草稿', group: '快捷操作', icon: Plus, select: onNewResearch },
    ...conversations.map(item => ({ id: 'conversation-' + item.id, label: item.title?.trim() || '未命名对话', description: conversationWorkflow(item) === 'screening' ? '继续选股对话' : '继续研究对话', group: '最近对话', icon: conversationWorkflow(item) === 'screening' ? ListFilter : MessageCircle, select: () => onConversation(item.id, item.entry_scope) })),
    ...projects.map(item => ({ id: 'project-' + item.id, label: item.name, description: (item.status === 'archived' ? '已归档 · ' : '') + (item.objective || '研究项目'), details: [item.status === 'archived' ? '已归档' : '', item.objective].filter(Boolean).join(' · '), group: '研究项目', icon: FolderOpen, select: () => onProject(item.id) })),
    ...workspaceMenus.filter(item => item.id !== 'home').map(item => ({ ...item, id: 'page-' + item.id, group: '页面', select: () => onNavigate(item.id) })),
    { id: 'settings', label: '数据与服务', description: '查看数据覆盖和服务状态', group: '快捷操作', icon: Settings2, select: onSettings },
  ], [projects, conversations, onNavigate, onProject, onConversation, onNewResearch, onSettings])
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const results = words.length
    ? commands.filter(command => words.every(word => (command.label + ' ' + command.description + ' ' + command.group).toLowerCase().includes(word))).slice(0, 40)
    : commands.filter(command => command.group !== '最近对话' && command.group !== '研究项目'
      || command.group === '最近对话' && conversations.slice(0, 5).some(item => command.id === 'conversation-' + item.id)
      || command.group === '研究项目' && projects.filter(item => item.status !== 'archived').slice(0, 3).some(item => command.id === 'project-' + item.id))
  const activeIndex = Math.min(selected, Math.max(0, results.length - 1))
  function choose(command?: Command) { if (command) { onClose(); command.select() } }
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [activeIndex, query])

  return <StockText><div className="workspace-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="quick-navigation" role="dialog" aria-modal="true" aria-label="搜索与快速导航" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      trapDialogTab(event)
      if (event.target !== input.current) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % (results.length || 1)) }
      if (event.key === 'Enter') { event.preventDefault(); choose(results[activeIndex]) }
    }}>
      <div className="quick-navigation-search"><Search size={21} /><input ref={input} role="combobox" aria-label="搜索页面、项目或对话" aria-autocomplete="list" aria-expanded="true" aria-controls="quick-navigation-results" aria-activedescendant={results[activeIndex] ? 'quick-' + results[activeIndex].id : undefined} value={query} onChange={event => { setQuery(event.target.value); setSelected(0) }} placeholder="查找页面、研究项目或对话…" /><button className="icon-button" aria-label="关闭快速导航" onClick={onClose}><X size={18} /></button></div>
      <div className="quick-navigation-results" id="quick-navigation-results" ref={list} role="listbox" aria-label="快速导航结果">
        {results.map((command, index) => <div key={command.id} id={'quick-' + command.id} role="option" aria-selected={activeIndex === index} onMouseEnter={() => setSelected(index)} onClick={() => choose(command)}><span className="quick-command-icon"><command.icon size={18} /></span><span><strong>{command.label}</strong><small>{command.details || command.description}</small></span><span className="quick-command-group">{command.group}</span><ArrowUpRight size={14} /></div>)}
        {!results.length && <div className="quick-navigation-empty"><Search size={24} /><strong>没有找到匹配项</strong><button className="text-button" onClick={() => { setQuery(''); input.current?.focus() }}>清除搜索</button><button className="text-button" onClick={() => { onClose(); onNavigate('screening') }}>前往研究对话</button></div>}
      </div>
      {error && <p className="quick-navigation-error">项目或对话暂未加载。<button className="text-button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
      <footer className="quick-navigation-footer"><span role="status">{loading ? '正在加载项目和最近对话…' : `找到 ${results.length} 个入口`}</span><span><kbd>↑</kbd><kbd>↓</kbd> 选择 <kbd>Enter</kbd> 打开 <kbd>Esc</kbd> 关闭</span></footer>
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
  return <div className="workspace-modal-backdrop resource-navigation-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="resource-navigation" role="dialog" aria-modal="true" aria-label="选择研究资料" onKeyDown={event => { if (event.key === 'Escape') onClose(); trapDialogTab(event) }}><div className="resource-navigation-heading"><h2>研究资料</h2><button ref={close} className="icon-button" aria-label="关闭资料导航" onClick={onClose}><X size={20} /></button></div>{workspaceLibraryMenus.map(({ id, label, icon: Icon }) => <button className="resource-navigation-item" key={id} onClick={() => { onClose(); onNavigate(id) }}><Icon size={22} /><span><strong>{label}</strong></span><ArrowUpRight size={17} /></button>)}</section></div>
}
