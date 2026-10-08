import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import './screening-result-menu.css'

export default function ScreeningResultMenu({ children, context }: { children: (close: () => void) => ReactNode; context: string }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = () => { setOpen(false); trigger.current?.focus() }
  useEffect(() => { setOpen(false) }, [context])
  useEffect(() => {
    if (!open) return
    const first = menu.current?.querySelector<HTMLElement>('button:not(:disabled), a[href]')
    ;(first || menu.current)?.focus()
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div ref={root} className="screening-result-menu">
    <button ref={trigger} type="button" className="secondary-button compact" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}>复制与导出<ChevronDown size={13} aria-hidden="true" /></button>
    {open && <div ref={menu} id={id} role="menu" aria-label="复制与导出" tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
      if (event.key === 'Tab') { close(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') || [])
      const current = items.indexOf(document.activeElement as HTMLElement)
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }}>{children(close)}</div>}
  </div>
}
