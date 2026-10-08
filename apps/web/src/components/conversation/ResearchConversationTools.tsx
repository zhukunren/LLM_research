import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Ellipsis, FileSearch } from 'lucide-react'
import ProjectMembership from './ProjectMembership'

type Props = {
  conversationId: string
  projectId?: string | null
  disabled: boolean
  hasResults: boolean
  resultsOpen: boolean
  resultsToggleRef: RefObject<HTMLButtonElement>
  onToggleResults: () => void
  onProjectChange: (id: string | null) => void
  onError: (message: string) => void
  onOpenProject?: (id: string) => void
  portalTargetId?: string
}

/** Keep optional conversation actions in the header, beside the model picker. */
export default function ResearchConversationTools({
  conversationId, projectId, disabled, hasResults, resultsOpen, resultsToggleRef,
  onToggleResults, onProjectChange, onError, onOpenProject, portalTargetId,
}: Props) {
  const [open, setOpen] = useState(false)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (!portalTargetId) { setPortalTarget(null); return }
    const findTarget = () => setPortalTarget(document.getElementById(portalTargetId))
    findTarget()
    const observer = new MutationObserver(findTarget)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [portalTargetId])

  useEffect(() => { close(false) }, [conversationId, close])

  useEffect(() => {
    if (!open) return
    const first = popup.current?.querySelector<HTMLElement>('select:not(:disabled), button:not(:disabled)')
    ;(first || popup.current)?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close()
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open, close, portalTarget])

  const content = <div ref={root} className="research-conversation-tools" onBlur={event => {
    if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(false)
  }}>
    {hasResults && <button ref={resultsToggleRef} type="button" className="icon-button research-conversation-results"
      aria-label="成果与文件" title="成果与文件" aria-expanded={resultsOpen} aria-controls="research-results-drawer"
      onClick={() => { close(false); onToggleResults() }}><FileSearch size={18} aria-hidden="true" /></button>}
    <button ref={trigger} type="button" className="icon-button research-conversation-options-trigger"
      aria-label="研究对话选项" title="研究对话选项" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) }
      }}><Ellipsis size={20} aria-hidden="true" /></button>
    {open && <div ref={popup} id={id} className="research-conversation-popover" role="dialog" aria-label="项目归属" tabIndex={-1}>
      <p className="research-conversation-popover-title">项目归属</p>
      <ProjectMembership key={conversationId} conversationId={conversationId} projectId={projectId} disabled={disabled}
        onChange={onProjectChange} onError={onError}
        onOpenProject={onOpenProject ? project => { close(false); onOpenProject(project) } : undefined} />
    </div>}
  </div>
  return portalTarget ? createPortal(content, portalTarget) : content
}
