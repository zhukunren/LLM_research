import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Building2, ChevronDown, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { useWorkspaceSession } from '../WorkspaceSession'

export type ResearchAnalysisTool = 'comparison' | 'quality'

export default function ResearchAnalysisMenu({ context, onSelect }: { context: string; onSelect: (tool: ResearchAnalysisTool) => void }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  const id = useId(), session = useWorkspaceSession()
  function close() { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  const positionMenu = useCallback(() => {
    if (!trigger.current || !menu.current) return
    const anchor = trigger.current.getBoundingClientRect(), box = menu.current.getBoundingClientRect()
    if (anchor.height > 0 && (anchor.bottom <= 0 || anchor.top >= window.innerHeight)) { setOpen(false); return }
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - box.width - 8, anchor.right - box.width)), top: Math.max(8, anchor.bottom + box.height + 6 <= window.innerHeight ? anchor.bottom + 4 : anchor.top - box.height - 4) })
  }, [])
  useLayoutEffect(() => {
    if (!open) return
    positionMenu()
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [open, positionMenu])
  useEffect(() => { setOpen(false) }, [context, session.active])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false) }
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) positionMenu() }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', positionMenu)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', positionMenu) }
  }, [open, positionMenu])
  return <>
    <button ref={trigger} type="button" className="secondary-button research-analysis-launch workspace-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true) } }}><SlidersHorizontal size={14} />分析工具<ChevronDown size={12} /></button>
    {open && session.active && createPortal(<div ref={menu} id={id} role="menu" aria-label="分析工具" className="research-analysis-menu workspace-menu" style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
      if (event.key === 'Tab') { close(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') || [])
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }}>
      <button type="button" role="menuitem" onClick={() => { close(); onSelect('comparison') }}><Building2 size={16} /><span><strong>同业对比</strong><small>比较项目公司与研究矩阵</small></span></button>
      <button type="button" role="menuitem" onClick={() => { close(); onSelect('quality') }}><ShieldCheck size={16} /><span><strong>质量评测</strong><small>核验项目判断与引用依据</small></span></button>
    </div>, session.portalTarget ?? document.body)}
  </>
}
