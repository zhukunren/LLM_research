import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Bot, Check, ChevronRight, Paperclip, Plus, RefreshCw, X } from 'lucide-react'
import { api, type AssistantSelection, type ResearchAssistant } from '../../api'
import { ATTACHMENT_ACCEPT } from './useConversationAttachments'
import './composer-attachments.css'

export default function ResearchComposerMenu({ value, snapshot, disabled, launchDisabled = false, showAssistants = true, onChange, onUpload, onLaunchAssistant }: {
  value: string; snapshot?: AssistantSelection; disabled: boolean; launchDisabled?: boolean; showAssistants?: boolean
  onChange: (id: string) => void; onUpload: (files: FileList | File[]) => void
  onLaunchAssistant?: (id: string, name: string) => void
}) {
  const [items, setItems] = useState<ResearchAssistant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({ left: 12, bottom: 84 })
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const uploadPicker = useRef<HTMLInputElement>(null)
  const menuId = useId()
  const close = useCallback((focus = true) => { setOpen(false); setSubmenu(false); if (focus) trigger.current?.focus() }, [])

  useEffect(() => {
    if (!showAssistants) return
    const controller = new AbortController()
    setLoading(true); setError(false)
    void api<{ items: ResearchAssistant[] }>('/research-assistants', { signal: controller.signal }).then(result => {
      if (!Array.isArray(result.items)) throw new Error('助手目录暂不可用')
      if (!controller.signal.aborted) setItems(result.items.filter(item => item.enabled && item.builtin))
    }).catch(() => { if (!controller.signal.aborted) setError(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [attempt, showAssistants])

  useEffect(() => { if (disabled) close(false) }, [disabled, close])
  useLayoutEffect(() => {
    if (!open) return
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect()
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
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(false)
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
    if (event.key === 'ArrowLeft' && submenu) { event.preventDefault(); setSubmenu(false); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }

  const selected = snapshot?.id === value ? snapshot : items.find(item => item.id === value)
  const tasks = items.filter(item => item.launch_mode === 'immediate')
  const methods = items.filter(item => item.launch_mode !== 'immediate')
  const assistantItem = (item: ResearchAssistant) => {
    const immediate = item.launch_mode === 'immediate'
    return <button type="button" role="menuitem" key={item.id} className="composer-menu-option"
      disabled={disabled || (immediate && (launchDisabled || !onLaunchAssistant))} aria-label={`${immediate ? '启动' : '使用'}${item.name}`}
      title={item.launch_description || item.description} onClick={() => {
        if (immediate) onLaunchAssistant?.(item.id, item.name)
        else onChange(item.id)
        close()
      }}><span><strong>{item.name}</strong><small>{item.description}</small></span>{!immediate && value === item.id ? <Check size={15} aria-label="已选择" /> : null}</button>
  }
  return <div className="research-composer-addons">
    <button ref={trigger} type="button" className="composer-plus icon-button" aria-label="添加文件或研究助手" title="添加文件或研究助手"
      disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => { setSubmenu(false); setOpen(current => !current) }} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) }
      }}><Plus size={22} aria-hidden="true" /></button>
    <input ref={uploadPicker} type="file" hidden multiple accept={ATTACHMENT_ACCEPT} aria-label="上传研究文件" disabled={disabled}
      onChange={event => { if (event.target.files?.length) onUpload(Array.from(event.target.files)); event.currentTarget.value = '' }} />
    {showAssistants && value !== 'general' && <span className="composer-assistant-pill" aria-label="当前研究助手"><Bot size={14} aria-hidden="true" /><span title={selected?.description}>{selected?.name || '已选助手'}</span><button type="button" className="icon-button" disabled={disabled} aria-label="移除研究助手，恢复通用投研" onClick={() => onChange('general')}><X size={13} /></button></span>}
    {open && createPortal(<div ref={popup} id={menuId} role="menu" aria-label={submenu ? '选择研究助手' : '添加到对话'} className="research-composer-popover" style={position} onKeyDown={menuKeys}>
      {!submenu ? <>
        <button type="button" role="menuitem" className="composer-menu-option" onClick={() => { close(false); uploadPicker.current?.click() }}><Paperclip size={17} aria-hidden="true" /><span>上传文件</span></button>
        {showAssistants && <button type="button" role="menuitem" className="composer-menu-option" aria-haspopup="menu" onClick={() => setSubmenu(true)}><Bot size={17} aria-hidden="true" /><span>调用研究助手</span><ChevronRight size={15} aria-hidden="true" /></button>}
      </> : <>
        <button type="button" role="menuitem" className="composer-menu-back" onClick={() => setSubmenu(false)}><ArrowLeft size={15} aria-hidden="true" />研究助手</button>
        {loading && <p className="composer-menu-status" role="status">正在读取助手…</p>}
        {error && <p className="composer-menu-status" role="alert">助手列表暂不可用<button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13} />重试</button></p>}
        {!!tasks.length && <><p className="composer-menu-label">即用助手</p>{tasks.map(assistantItem)}</>}
        {!!methods.length && <><p className="composer-menu-label">研究方法</p>{methods.map(assistantItem)}</>}
      </>}
    </div>, document.body)}
  </div>
}
