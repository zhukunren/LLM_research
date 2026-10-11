import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Archive, ArchiveRestore, ArrowLeft, Check, ChevronRight, Copy, Download, FolderOpen, ListFilter, MoreHorizontal, Pencil, Pin, PinOff, Share2, Trash2, X } from 'lucide-react'
import { api, conversationWorkflow, type Conversation, type ConversationScope, type WorkflowType } from '../api'
import { trapDialogTab } from '../keyboard'
import type { ResearchProjectSummary } from '../research'
import { workspaceRouteHash } from '../workspaceRoute'
import './conversation-history.css'

export type RecentConversation = {
  id: string; title: string | null; entry_scope: ConversationScope; workflow_type?: WorkflowType
  research_mode?: string; task_revision?: number; last_turn_state?: string; active_run_status?: string
  state?: 'active' | 'archived'; pinned?: boolean; project_id?: string | null
}
export type ConversationHistoryChange = Partial<Pick<RecentConversation, 'title' | 'pinned' | 'state' | 'project_id'>> & { deleted?: boolean }

export default function ConversationHistoryItem({ item, current, onOpen, onChange }: {
  item: RecentConversation; current: boolean; onOpen: () => void
  onChange: (id: string, changes: ConversationHistoryChange) => void
}) {
  const [menu, setMenu] = useState<'main' | 'projects' | null>(null)
  const [dialog, setDialog] = useState<'rename' | 'share' | 'delete' | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [shareAnswerId, setShareAnswerId] = useState('')
  const [publicShare, setPublicShare] = useState<{ id: string; url: string } | null>(null)
  const [shareLoading, setShareLoading] = useState(false)
  const shareRequest = useRef<string | null>(null)
  const [projects, setProjects] = useState<ResearchProjectSummary[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [projectAttempt, setProjectAttempt] = useState(0)
  const [position, setPosition] = useState<CSSProperties>({ top: 0, left: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const modal = useRef<HTMLElement>(null)
  const pending = useRef(false)
  const menuId = useId()
  const title = item.title?.trim() || '未命名对话'
  const screening = conversationWorkflow(item) === 'screening'
  const archived = item.state === 'archived'
  const active = ['running', 'awaiting_agent'].includes(item.last_turn_state || '') || ['queued', 'running'].includes(item.active_run_status || '')
  const shareUrl = new URL(window.location.href)
  shareUrl.hash = workspaceRouteHash({ page: screening ? 'conditions' : 'screening', conversationId: item.id, scope: item.entry_scope })
  const closeMenu = useCallback((focus = true) => { setMenu(null); if (focus) trigger.current?.focus() }, [])
  const closeDialog = () => { if (pending.current) return; setDialog(null); setError(''); trigger.current?.focus() }

  useLayoutEffect(() => {
    if (!menu) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(260, window.innerWidth - 24)
      const maxHeight = Math.max(80, window.innerHeight - 24)
      const height = Math.min(popup.current?.scrollHeight || 310, maxHeight)
      const left = rect.right + width + 8 <= window.innerWidth - 12 ? rect.right + 8 : Math.min(rect.right - width, window.innerWidth - width - 12)
      setPosition({ left: Math.max(12, left), top: Math.max(12, Math.min(rect.top, window.innerHeight - height - 12)), width, maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [menu, projects, loadingProjects, error])

  useEffect(() => {
    if (!menu) return
    popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const outside = (event: PointerEvent) => {
      if (pending.current) return
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) closeMenu(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menu, closeMenu])

  useEffect(() => {
    if (!dialog) return
    modal.current?.querySelector<HTMLElement>(dialog === 'rename' ? 'input' : 'button')?.focus()
    if (dialog === 'rename') modal.current?.querySelector<HTMLInputElement>('input')?.select()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = overflow }
  }, [dialog])

  useEffect(() => {
    if (dialog !== 'share' || screening) return
    const controller = new AbortController()
    setShareLoading(true); setShareAnswerId(''); setPublicShare(null)
    void (async () => {
      const conversation = await api<Conversation>(`/conversations/${item.id}`, { signal: controller.signal })
      const answer = conversation.messages.filter(message => message.role === 'assistant').at(-1)
      if (!answer) throw new Error('此对话还没有可分享的研究答复。')
      const result = await api<{ share: { id: string; url: string } | null }>(`/conversations/${item.id}/answers/${answer.id}/share`, { signal: controller.signal })
      if (!controller.signal.aborted) { setShareAnswerId(answer.id); setPublicShare(result.share || null) }
    })().catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setShareLoading(false) })
    return () => controller.abort()
  }, [dialog, screening, item.id])

  useEffect(() => {
    if (menu !== 'projects') return
    const controller = new AbortController()
    setLoadingProjects(true); setError('')
    api<{ items: ResearchProjectSummary[] }>('/research-projects', { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.items)) throw new Error('项目列表暂不可用。')
      if (!controller.signal.aborted) setProjects(result.items.filter(project => project.status === 'active'))
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoadingProjects(false) })
    return () => controller.abort()
  }, [menu, projectAttempt])

  async function save(changes: ConversationHistoryChange, project = false) {
    if (pending.current) return
    pending.current = true; setSaving(true); setError('')
    try {
      await api(`/conversations/${encodeURIComponent(item.id)}${project ? '/project' : ''}`, {
        method: changes.deleted ? 'DELETE' : 'PATCH', body: changes.deleted ? undefined : JSON.stringify(changes),
      })
      pending.current = false
      closeMenu(); setDialog(null)
      onChange(item.id, changes)
    } catch (reason) { setError((reason as Error).message) }
    finally { pending.current = false; setSaving(false) }
  }
  function openDialog(next: NonNullable<typeof dialog>) {
    closeMenu(false); setError(''); setCopied(false); setName(title); setDialog(next)
  }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); if (!pending.current) closeMenu(); return }
    if (event.key === 'Tab') { if (pending.current) event.preventDefault(); else closeMenu(); return }
    if (event.key === 'ArrowLeft' && menu === 'projects') { event.preventDefault(); setError(''); setMenu('main'); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }
  async function copyLink() {
    setError('')
    try { await navigator.clipboard.writeText(screening ? shareUrl.href : publicShare!.url); setCopied(true) }
    catch { setError('复制失败，请选中下方链接手动复制。') }
  }
  async function createPublicShare() {
    if (!shareAnswerId || pending.current) return
    pending.current = true; setSaving(true); setError('')
    shareRequest.current ||= crypto.randomUUID()
    try {
      const result = await api<{ id: string; url: string }>(`/conversations/${item.id}/answers/${shareAnswerId}/share`, { method: 'POST', body: JSON.stringify({ request_id: shareRequest.current }) })
      if (!result.url?.startsWith('https://')) throw new Error('分享链接未生成，请重试。')
      setPublicShare(result)
    } catch (reason) { setError((reason as Error).message) }
    finally { pending.current = false; setSaving(false) }
  }

  return <div className={`chat-history-row${menu ? ' menu-open' : ''}${current ? ' is-current' : ''}`}>
    <button type="button" className="chat-history-item" title={title} aria-label={`继续${screening ? '选股' : '研究'}：${title}`} aria-current={current ? 'page' : undefined} onClick={onOpen}>
      {screening && <ListFilter size={13} aria-hidden="true" />}<span>{title}</span>
      {['failed', 'awaiting_user', 'running', 'awaiting_agent'].includes(item.last_turn_state || '') && <i className={item.last_turn_state === 'failed' || item.last_turn_state === 'awaiting_user' ? 'needs-attention' : 'in-progress'} aria-label={item.last_turn_state === 'failed' ? '需重试' : item.last_turn_state === 'awaiting_user' ? '待补充' : '处理中'} />}
    </button>
    {!!item.pinned && <Pin className="chat-history-pin" size={13} aria-label="已置顶" />}
    <button ref={trigger} type="button" className="chat-history-actions" aria-label={`更多操作：${title}`} title="更多操作" aria-haspopup="menu" aria-expanded={!!menu} aria-controls={menu ? menuId : undefined}
      onClick={() => { if (pending.current) return; setError(''); if (menu) closeMenu(); else setMenu('main') }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setMenu('main') } }}><MoreHorizontal size={18} aria-hidden="true" /></button>
    {menu && createPortal(<div ref={popup} id={menuId} className="chat-history-menu" role="menu" aria-label={menu === 'projects' ? '移至项目' : '对话操作'} style={position} onKeyDown={menuKeys}>
      {menu === 'main' ? <>
        <button role="menuitem" disabled={saving} onClick={() => openDialog('rename')}><Pencil size={17} /><span>重命名</span></button>
        <button role="menuitem" disabled={saving} onClick={() => void save({ pinned: !item.pinned })}>{item.pinned ? <PinOff size={17} /> : <Pin size={17} />}<span>{item.pinned ? '取消置顶' : '置顶'}</span></button>
        <div role="separator" />
        <button role="menuitem" disabled={saving} onClick={() => openDialog('share')}><Share2 size={17} /><span>分享</span></button>
        <div role="separator" />
        <button role="menuitem" disabled={saving || active} title={active ? '请先等待或停止当前任务' : undefined} onClick={() => void save({ state: archived ? 'active' : 'archived' })}>{archived ? <ArchiveRestore size={17} /> : <Archive size={17} />}<span>{archived ? '恢复对话' : '归档'}</span></button>
        <button role="menuitem" className="danger" disabled={saving || active} title={active ? '请先等待或停止当前任务' : undefined} onClick={() => openDialog('delete')}><Trash2 size={17} /><span>删除</span></button>
        {!screening && <><div role="separator" /><button role="menuitem" disabled={saving || active} title={active ? '请先等待或停止当前任务' : undefined} aria-haspopup="menu" onClick={() => { setError(''); setMenu('projects') }}><FolderOpen size={17} /><span>移至项目</span><ChevronRight size={15} /></button></>}
      </> : <>
        <button role="menuitem" disabled={saving} onClick={() => { setError(''); setMenu('main') }}><ArrowLeft size={17} /><span>移至项目</span></button>
        <div role="separator" />
        {loadingProjects ? <p role="status">正在读取项目…</p> : <>
          <button role="menuitemradio" aria-checked={!item.project_id} disabled={saving} onClick={() => void save({ project_id: null }, true)}><FolderOpen size={17} /><span>未归入项目</span>{!item.project_id && <Check size={15} />}</button>
          {projects.map(project => <button key={project.id} role="menuitemradio" aria-checked={item.project_id === project.id} disabled={saving} onClick={() => void save({ project_id: project.id }, true)}><FolderOpen size={17} /><span>{project.name}</span>{item.project_id === project.id && <Check size={15} />}</button>)}
          {!projects.length && !error && <p>暂无可用项目，可在“研究项目”中创建。</p>}
        </>}
      </>}
      {saving && <p role="status">正在保存…</p>}
      {error && <p role="alert">{error}{menu === 'projects' && <button type="button" className="text-button" disabled={saving} onClick={() => setProjectAttempt(value => value + 1)}>重试项目列表</button>}</p>}
    </div>, document.body)}
    {dialog && createPortal(<div className="chat-history-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeDialog() }}>
      <section ref={modal} className="chat-history-dialog" role="dialog" aria-modal="true" aria-label={dialog === 'rename' ? '重命名对话' : dialog === 'delete' ? '删除对话' : '分享对话'} aria-busy={saving} onKeyDown={event => {
        event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); closeDialog() }; trapDialogTab(event)
      }}>
        <header><h2>{dialog === 'rename' ? '重命名对话' : dialog === 'delete' ? '删除对话' : '分享对话'}</h2><button type="button" className="icon-button" aria-label="关闭对话操作" disabled={saving} onClick={closeDialog}><X size={18} /></button></header>
        {dialog === 'rename' ? <form onSubmit={event => { event.preventDefault(); if (name.trim()) void save({ title: name.trim() }) }}>
          <label htmlFor={`${menuId}-name`}>对话名称</label><input id={`${menuId}-name`} value={name} maxLength={120} disabled={saving} onChange={event => setName(event.target.value)} />
          {error && <p role="alert">{error}</p>}
          <footer><button type="button" className="secondary-button" disabled={saving} onClick={closeDialog}>取消</button><button type="submit" className="primary-button" disabled={saving || !name.trim()}>{saving ? '正在保存…' : '保存'}</button></footer>
        </form> : dialog === 'delete' ? <>
          <p>确定删除“{title}”吗？删除后将无法从对话记录中恢复，已保存的研究笔记会保留。</p>
          {error && <p role="alert">{error}</p>}
          <footer><button type="button" className="secondary-button" disabled={saving} onClick={closeDialog}>取消</button><button type="button" className="chat-history-delete-button" disabled={saving} onClick={() => void save({ deleted: true })}>{saving ? '正在删除…' : '确认删除'}</button></footer>
        </> : <>
          <p className="chat-history-share-title">{title}</p><p>{screening ? '复制链接可在同一工作台打开，也可以下载对话文件分享给他人。' : '创建链接后，任何收到链接的人都能在其他设备查看截至最新答复的对话和来源。后续追问不会改变这份快照。'}</p>
          {(screening || publicShare) && <><label htmlFor={`${menuId}-link`}>对话链接</label><input id={`${menuId}-link`} value={screening ? shareUrl.href : publicShare!.url} readOnly onFocus={event => event.currentTarget.select()} /></>}
          {shareLoading && <p role="status">正在读取可分享的答复…</p>}
          {screening && <p className="chat-history-share-hint">本地工作台链接需要在可访问该工作台的设备上打开。</p>}
          {error && <p role="alert">{error}</p>}{copied && <p role="status">对话链接已复制</p>}
          <footer><a className="secondary-button" href={`/api/v1/conversations/${encodeURIComponent(item.id)}/export`} download><Download size={15} />下载对话</a>{screening || publicShare ? <button type="button" className="primary-button" onClick={() => void copyLink()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制链接'}</button> : <button type="button" className="primary-button" disabled={saving || shareLoading || !shareAnswerId} onClick={() => void createPublicShare()}><Share2 size={15} />{saving ? '正在创建…' : '创建分享链接'}</button>}</footer>
        </>}
      </section>
    </div>, document.body)}
  </div>
}
