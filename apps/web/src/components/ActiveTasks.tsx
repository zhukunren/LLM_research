import TimeLabel, { fullTimeDescription } from './TimeLabel'
import type { BriefKind } from '../intelligence'
import LoadingState from './LoadingState'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock3, RefreshCw, X } from 'lucide-react'
import { api, type ConversationScope } from '../api'
import { trapDialogTab } from '../keyboard'
import type { PageId } from '../navigation'
import type { TaskCatalog, UserTask } from '../features/tasks/taskTypes'
import EmptyState from './EmptyState'

export default function ActiveTasks({ onConversation, onNavigate, onSettings, onProject, onIntelligence }: {
  onConversation: (id: string, scope: ConversationScope) => void; onNavigate?: (page: PageId) => void; onSettings?: () => void; onProject?: (id: string) => void
  onIntelligence?: (id: string, kind: BriefKind) => void
}) {
  const [items, setItems] = useState<UserTask[]>([])
  const [activeCount, setActiveCount] = useState(0)
  const [recent, setRecent] = useState(false)
  const [open, setOpen] = useState(false), [error, setError] = useState(false), [loading, setLoading] = useState(true), [reload, setReload] = useState(0)
  const closeButton = useRef<HTMLButtonElement>(null), trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    async function load() {
      if (pending) return
      pending = true
      try { const result = await api<TaskCatalog>(`/tasks?active_only=${!recent}&limit=100`, { signal: controller.signal }); if (!controller.signal.aborted) { setItems(result.items); setActiveCount(result.active_count); setError(false) } }
      catch { if (!controller.signal.aborted) setError(true) }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false) }
    }
    setLoading(true); void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, 15000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [reload, open, recent])
  useEffect(() => {
    if (!open) return
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; closeButton.current?.focus()
    return () => { document.body.style.overflow = overflow; trigger.current?.focus() }
  }, [open])
  function canOpen(item: UserTask) {
    if (item.destination.kind === 'intelligence') return !!onIntelligence
    return item.destination.kind === 'conversation' || (item.destination.kind === 'settings' ? !!onSettings : item.destination.kind === 'project' ? !!onProject : !!onNavigate)
  }
  function openTask(item: UserTask) {
    const destination = item.destination
    setOpen(false)
    if (destination.kind === 'conversation') onConversation(destination.conversation_id, destination.scope)
    else if (destination.kind === 'intelligence') onIntelligence?.(destination.brief_id, destination.brief_kind)
    else if (destination.kind === 'settings') onSettings?.()
    else if (destination.kind === 'project') onProject?.(destination.project_id)
    else onNavigate?.(destination.page)
  }
  return <><button ref={trigger} className="active-tasks-launch workspace-button" aria-label="运行任务" aria-expanded={open} onClick={() => setOpen(value => !value)}><Clock3 size={17} /><span>运行任务</span>{!loading && !error && activeCount > 0 && <strong>{activeCount}</strong>}</button>{open && createPortal(
    <div className="workspace-modal-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setOpen(false) }}>
      <section className="active-tasks-dialog workspace-tool-dialog workspace-dialog" role="dialog" aria-modal="true" aria-label="运行任务列表" onKeyDown={event => { if (event.key === 'Escape') setOpen(false); trapDialogTab(event) }}>
        <header><h2>任务进展</h2><button ref={closeButton} className="icon-button workspace-button" aria-label="关闭运行任务" onClick={() => setOpen(false)}><X size={18} /></button></header>
        <div className="task-view-switch" role="group" aria-label="任务查看范围"><button type="button" className="secondary-button workspace-button" aria-pressed={!recent} onClick={() => setRecent(false)}>进行中</button><button type="button" className="secondary-button workspace-button" aria-pressed={recent} onClick={() => setRecent(true)}>最近任务</button></div>
        {loading ? <LoadingState compact label="正在读取任务…" /> : error ? <div role="alert" className="workspace-error"><p>暂时无法读取任务进展。</p><button className="secondary-button workspace-button" onClick={() => setReload(value => value + 1)}><RefreshCw size={15} />重新加载</button></div> : items.length ?
          <div className="active-tasks-list">{items.map(item => <button key={item.id} data-tooltip={item.updated_at ? fullTimeDescription(item.updated_at, 'Asia/Shanghai') : undefined} disabled={!canOpen(item)} onClick={() => openTask(item)} className="workspace-button"><span><strong data-tooltip={item.title}>{item.title}</strong><small>{item.kind_label} · {item.state_label}</small><small className="task-stage">{item.stage}</small>{item.updated_at && <small>更新于 <TimeLabel value={item.updated_at} timeZone="Asia/Shanghai" focusable={false} /></small>}</span><span>{item.action_label}</span></button>)}</div>
          : <EmptyState icon={Clock3} title={recent ? '暂无任务记录。' : '当前没有正在运行的任务。'} description={recent ? '研究、选股和资料处理的进展会保留在这里。' : '新提交的研究、选股和资料处理任务会显示在这里。'} />}
      </section>
    </div>, document.body)}</>
}
