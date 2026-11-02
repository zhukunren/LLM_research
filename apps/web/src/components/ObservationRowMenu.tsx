import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Ellipsis } from 'lucide-react'
import { useWorkspaceSession } from '../WorkspaceSession'

export default function ObservationRowMenu({ label, disabled, children }: { label: string; disabled: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const session = useWorkspaceSession()
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  const positionMenu = useCallback(() => {
    if (!trigger.current || !menu.current) return
    const anchor = trigger.current.getBoundingClientRect(), box = menu.current.getBoundingClientRect()
    const clip = trigger.current.closest('.workspace-table-scroll')?.getBoundingClientRect()
    if (anchor.height > 0 && (anchor.bottom <= 0 || anchor.top >= window.innerHeight || clip && (anchor.bottom <= clip.top || anchor.top >= clip.bottom))) { setOpen(false); return }
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - box.width - 8, anchor.right - box.width)), top: Math.max(8, anchor.bottom + box.height + 6 <= window.innerHeight ? anchor.bottom + 4 : anchor.top - box.height - 4) })
  }, [])
  useLayoutEffect(() => {
    if (!open || !menu.current) return
    positionMenu()
    ;(menu.current.querySelector<HTMLElement>('button:not(:disabled)') || menu.current).focus({ preventScroll: true })
  }, [open, positionMenu])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false) }
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) positionMenu() }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', positionMenu)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', positionMenu) }
  }, [open, positionMenu])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return <>
    <button ref={trigger} type="button" className="icon-button workspace-button observation-row-action" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} data-tooltip="更多" onClick={() => setOpen(value => !value)} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true) } }}><Ellipsis size={16} /></button>
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label={label} tabIndex={-1} className="observation-row-menu workspace-menu" style={{ left: position.left, top: position.top }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
      if (event.key === 'Tab') { close(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }}>{children(close)}</div>, session.portalTarget ?? document.body)}
  </>
}
