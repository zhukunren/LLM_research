import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Settings2 } from 'lucide-react'

export default function ScreeningSettings({ children, label = '选股设置' }: { children: (open: boolean) => ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && !root.current?.contains(event.target) && !event.target.closest('.workspace-tool-dialog')) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div ref={root} className="screening-settings" onKeyDown={event => {
    if (event.key !== 'Escape' || !open || root.current?.querySelector('[aria-haspopup="menu"][aria-expanded="true"]')) return
    event.stopPropagation(); setOpen(false); trigger.current?.focus()
  }}>
    <button ref={trigger} type="button" className="text-button screening-settings-trigger workspace-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><Settings2 size={14} aria-hidden="true" /><span>{label}</span><ChevronDown size={12} aria-hidden="true" /></button>
    <div id={id} className="screening-settings-panel" hidden={!open} role="group" aria-label={label}>{children(open)}</div>
  </div>
}
