import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Settings2 } from 'lucide-react'

export default function ScreeningSettings({ children }: { children: (open: boolean) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && !root.current?.contains(event.target) && !event.target.closest('.research-model-popover')) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div ref={root} className="screening-settings" onKeyDown={event => {
    if (event.key !== 'Escape' || !open || root.current?.querySelector('.research-model-trigger[aria-expanded="true"]')) return
    event.stopPropagation(); setOpen(false); trigger.current?.focus()
  }}>
    <button ref={trigger} type="button" className="text-button screening-settings-trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><Settings2 size={16} aria-hidden="true" />选股设置</button>
    <div id={id} className="screening-settings-panel" hidden={!open} role="group" aria-label="选股设置">{children(open)}</div>
  </div>
}
