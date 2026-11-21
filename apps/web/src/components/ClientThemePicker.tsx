import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { cardThemes, type CardTheme } from '../clientService'
import { useWorkspaceSession } from '../WorkspaceSession'

export default function ClientThemePicker({ theme, onSelect, thumbnail, caption, ariaLabel = '卡片套图', footer }: {
  theme: CardTheme
  onSelect: (theme: CardTheme) => void
  thumbnail: (theme: CardTheme) => ReactNode
  caption: string
  ariaLabel?: string
  footer?: ReactNode
}) {
  const { active } = useWorkspaceSession()
  const listRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ up: false, down: false })

  useEffect(() => {
    const list = listRef.current
    if (!active || !list) return
    const measure = () => {
      const value = { up: list.scrollTop > 1, down: list.scrollTop + list.clientHeight < list.scrollHeight - 1 }
      setEdges(current => current.up === value.up && current.down === value.down ? current : value)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(list)
    if (list.firstElementChild) observer?.observe(list.firstElementChild)
    list.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    const frame = requestAnimationFrame(measure)
    return () => {
      observer?.disconnect()
      list.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      cancelAnimationFrame(frame)
    }
  }, [active])

  useEffect(() => {
    const list = listRef.current
    const selected = list?.querySelector<HTMLElement>('[aria-pressed=true]')
    if (!active || !list || !selected || !list.clientHeight) return
    const top = selected.offsetTop, bottom = top + selected.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [active, theme])

  function browse(direction: -1 | 1) {
    const list = listRef.current
    if (list) list.scrollBy({ top: direction * Math.max(100, list.clientHeight * .75), behavior: 'smooth' })
  }

  return <aside className="client-theme-picker" aria-label={ariaLabel}>
    <div className="client-section-heading"><h3>选择套图</h3><span>{caption}</span></div>
    <button type="button" className="workspace-button client-theme-scroll" aria-label="向上浏览套图"
      disabled={!edges.up} onClick={() => browse(-1)}><ChevronUp size={18} /></button>
    <div ref={listRef} className="client-theme-list" role="group" aria-label="套图风格">
      {cardThemes.map(item => <button type="button" key={item.id} className="workspace-button"
        aria-pressed={theme === item.id} aria-label={item.name} onClick={() => onSelect(item.id)}>
        {thumbnail(item.id)}
        <strong>{item.name}{theme === item.id && <Check size={12} />}</strong>
        <small>{item.description}</small>
      </button>)}
    </div>
    <button type="button" className="workspace-button client-theme-scroll" aria-label="向下浏览套图"
      disabled={!edges.down} onClick={() => browse(1)}><ChevronDown size={18} /></button>
    {footer && <footer>{footer}</footer>}
  </aside>
}
