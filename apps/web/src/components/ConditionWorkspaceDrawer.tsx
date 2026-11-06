import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { trapDialogTab } from '../keyboard'
import { useWorkspaceSession } from '../WorkspaceSession'
import './condition-workspace-drawer.css'

export default function ConditionWorkspaceDrawer({ title, description, closeLabel = '关闭条件详情', className = '', children, footer, onClose }: {
  title: string; description?: string; closeLabel?: string; className?: string; children: ReactNode; footer?: ReactNode; onClose: () => void
}) {
  const titleId = useId()
  const { active, portalTarget } = useWorkspaceSession()
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!active) return
    const origin = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    return () => {
      document.body.style.overflow = overflow
      if (origin?.isConnected) origin.focus({ preventScroll: true })
    }
  }, [active])
  return createPortal(<div className="condition-workspace-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className={`condition-workspace-drawer workspace-tool-dialog workspace-drawer ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
      if (event.target instanceof Element && event.target.closest('[role="dialog"]') !== event.currentTarget) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      else trapDialogTab(event)
    }}>
      <header><div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div><button ref={closeButton} type="button" className="icon-button workspace-button" aria-label={closeLabel} onClick={onClose}><X size={18} /></button></header>
      <div className="condition-workspace-drawer-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </section>
  </div>, portalTarget ?? document.body)
}
