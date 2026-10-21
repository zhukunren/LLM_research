import LoadingState from '../LoadingState'
import { useWorkspaceSession } from '../../WorkspaceSession'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, Bot, Check, ChevronDown, Paperclip, Plus, RefreshCw, X } from 'lucide-react'
import { api, type AssistantSelection, type ResearchAssistant } from '../../api'
import { ATTACHMENT_ACCEPT } from './useConversationAttachments'
import './composer-attachments.css'

export default function ResearchComposerMenu({ value, snapshot, disabled, showAssistants = true, onChange, onUpload }: {
  value: string; snapshot?: AssistantSelection; disabled: boolean; showAssistants?: boolean
  onChange: (id: string) => void; onUpload: (files: FileList | File[]) => void
}) {
  const workspaceSession = useWorkspaceSession()
  const portalTarget = workspaceSession.portalTarget ?? document.body
  const [items, setItems] = useState<ResearchAssistant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({ left: 12, bottom: 84 })
  const trigger = useRef<HTMLButtonElement>(null)
  const methodTrigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const uploadPicker = useRef<HTMLInputElement>(null)
  const menuId = useId()
  const close = useCallback((focus = true) => { setOpen(false); setSubmenu(false); if (focus) (submenu ? methodTrigger : trigger).current?.focus() }, [submenu])

  useEffect(() => { if (!workspaceSession.active) { setOpen(false); setSubmenu(false) } }, [workspaceSession.active])
  useEffect(() => {
    if (!showAssistants) return
    const controller = new AbortController()
    setLoading(true); setError(false)
    void api<{ items: ResearchAssistant[] }>('/research-assistants', { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.items)) throw new Error('研究方法暂不可用')
      if (!controller.signal.aborted) setItems(result.items.filter(item => item.enabled && item.builtin))
    }).catch(() => { if (!controller.signal.aborted) setError(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [attempt, showAssistants])

  useEffect(() => { if (disabled) close(false) }, [disabled, close])
  useLayoutEffect(() => {
    if (!open) return
    const reposition = () => {
      const rect = (submenu ? methodTrigger : trigger).current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(300, window.innerWidth - 24)
      const maxHeight = Math.max(180, window.innerHeight - 40)
      const height = Math.min(popup.current?.scrollHeight || (submenu ? 390 : 110), maxHeight)
      const top = Math.max(12, rect.top >= height + 20 ? rect.top - height - 8 : Math.min(rect.bottom + 8, window.innerHeight - height - 12))
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top, width, maxHeight })
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true) }
  }, [open, submenu, items, loading, error])

  useEffect(() => {
    if (!open) return
    popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !trigger.current?.contains(event.target) && !methodTrigger.current?.contains(event.target)) close(false)
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open, submenu, close])

  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') { close(false); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }

  const selected = snapshot?.id === value ? snapshot : items.find(item => item.id === value)
  const methods = items.filter(item => item.launch_mode !== 'immediate' && item.id !== 'qmt-script')
  const isTask = ['daily-hotspots', 'policy-tracker', 'industry-updates'].includes(value)
  const assistantItem = (item: ResearchAssistant) => {
    return <button type="button" role="menuitem" key={item.id} className="composer-menu-option workspace-button workspace-menu-option"
      disabled={disabled} aria-label={`使用${item.name}`} aria-current={value === item.id ? true : undefined}
      data-tooltip={item.launch_description || item.description} onClick={() => {
        onChange(item.id)
        close()
      }}><span><strong>{item.name}</strong><small>{item.description}</small></span>{value === item.id ? <Check size={15} aria-label="已选择" /> : null}</button>
  }
  return <div className="research-composer-addons">
    <button ref={trigger} type="button" className="composer-plus icon-button workspace-button" aria-label="添加文件" data-tooltip="添加文件"
      disabled={disabled} aria-haspopup="menu" aria-expanded={open && !submenu} aria-controls={open && !submenu ? menuId : undefined}
      onClick={() => { setSubmenu(false); setOpen(current => submenu ? true : !current) }} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setSubmenu(false); setOpen(true) }
      }}><Plus size={22} aria-hidden="true" /></button>
    <input ref={uploadPicker} type="file" hidden multiple accept={ATTACHMENT_ACCEPT} aria-label="上传研究文件" disabled={disabled}
      onChange={event => { if (event.target.files?.length) onUpload(Array.from(event.target.files)); event.currentTarget.value = '' }} />
    {showAssistants && value !== 'qmt-script' && <span className="composer-assistant-pill composer-method-control" aria-label={value === 'general' ? undefined : isTask ? '当前快捷任务' : '当前研究方法'}>
      <button ref={methodTrigger} type="button" className="composer-method-trigger workspace-button" aria-label="研究方法" data-tooltip={selected?.description || '选择研究方法'} disabled={disabled} aria-haspopup="menu" aria-expanded={open && submenu} aria-controls={open && submenu ? menuId : undefined}
        onClick={() => { setSubmenu(true); setOpen(current => submenu ? !current : true) }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setSubmenu(true); setOpen(true) } }}><BookOpen size={14} aria-hidden="true" /><span>{value === 'general' ? '研究方法' : selected?.name || '已选方法'}</span><ChevronDown size={12} aria-hidden="true" /></button>
      {value !== 'general' && <button type="button" className="icon-button workspace-button" disabled={disabled} aria-label="恢复通用投研" onClick={() => onChange('general')}><X size={13} /></button>}
    </span>}
    {showAssistants && value === 'qmt-script' && <span className="composer-assistant-pill" aria-label="当前工具"><Bot size={14} aria-hidden="true" /><span data-tooltip={selected?.description}>{selected?.name || 'QMT 脚本生成'}</span><button type="button" className="icon-button workspace-button" disabled={disabled} aria-label="退出专用工具，恢复通用投研" onClick={() => onChange('general')}><X size={13} /></button></span>}
    {open && createPortal(<div ref={popup} id={menuId} role="menu" aria-label={submenu ? '选择研究方法' : '添加到对话'} className="research-composer-popover workspace-tool-dialog workspace-popover workspace-menu" style={position} onKeyDown={menuKeys}>
      {!submenu ? <>
        <button type="button" role="menuitem" className="composer-menu-option workspace-button workspace-menu-option" onClick={() => { close(false); uploadPicker.current?.click() }}><Paperclip size={17} aria-hidden="true" /><span>上传文件</span></button>
      </> : <>
        {loading && <LoadingState compact label="正在读取研究方法…" />}
        {error && <p className="composer-menu-status workspace-error" role="alert">研究方法暂不可用<button type="button" className="text-button workspace-button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13} />重试</button></p>}
        {!!methods.length && <><p className="composer-menu-label">研究方法</p>{methods.map(assistantItem)}</>}
      </>}
    </div>, portalTarget)}
  </div>
}
