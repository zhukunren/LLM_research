import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export default function MobileSheet({ title, children, footer, onClose }: {
  title: string; children: ReactNode; footer?: ReactNode; onClose: () => void
}) {
  const headingId = useId()
  const sheet = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = sheet.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return <dialog ref={sheet} className="mobile-workspace-sheet" role="dialog" aria-modal="true" aria-labelledby={headingId}
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => event.stopPropagation()}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <header className="mobile-sheet-header">
      <h2 id={headingId}>{title}</h2>
      <button type="button" className="icon-button mobile-icon-button workspace-button" aria-label={`关闭${title}`} onClick={onClose}><X size={20} aria-hidden="true" /></button>
    </header>
    <div className="mobile-sheet-body">{children}</div>
    {footer && <footer className="mobile-sheet-footer">{footer}</footer>}
  </dialog>
}
