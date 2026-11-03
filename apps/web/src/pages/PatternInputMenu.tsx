import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { ChartNoAxesCombined, ChevronDown, ImageUp, PencilLine, Sparkles } from 'lucide-react'
import type { PatternSource } from './patternWorkspace'

export const patternInputActions = [
  { value: 'market_window', label: '截取行情区间', description: '选择股票与日期', Icon: ChartNoAxesCombined },
  { value: 'screenshot', label: '上传截图', description: '提取图中走势', Icon: ImageUp },
  { value: 'natural_language', label: '描述目标走势', description: '用文字生成候选', Icon: Sparkles },
  { value: 'drawing', label: '绘制新形态', description: '直接在画布绘制', Icon: PencilLine },
] as const

type Props = { hasTarget: boolean; disabled: boolean; onChoose: (source: PatternSource) => void; buttonRef: RefObject<HTMLButtonElement> }

export default function PatternInputMenu({ hasTarget, disabled, onChoose, buttonRef }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const initialIndex = useRef(0)
  const id = useId()

  function close(restoreFocus = false) {
    setOpen(false)
    if (restoreFocus) buttonRef.current?.focus()
  }
  function show(index = 0) { initialIndex.current = index; setOpen(true) }
  useEffect(() => {
    if (!open) return
    menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[initialIndex.current]?.focus()
    function dismiss(event: Event) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss) }
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key === 'Tab') { close(true); return }
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : event.key === 'ArrowUp' ? (current + items.length - 1) % items.length : null
    if (next !== null) { event.preventDefault(); items[next]?.focus() }
  }
  return <div className="pattern-input-menu" ref={root}>
    <button ref={buttonRef} type="button" className="secondary-button workspace-button pattern-input-trigger" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => open ? close() : show()} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp' ? patternInputActions.length - 1 : 0) }
        else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true) }
      }}>{hasTarget ? '替换目标' : '创建目标'}<ChevronDown size={13} /></button>
    {open && <div id={id} ref={menu} className="pattern-input-action-menu" role="menu" aria-label="创建目标方式" onKeyDown={handleKey}>
      {patternInputActions.map(({ value, label, Icon }) => <button type="button" role="menuitem" tabIndex={-1} className="workspace-button" key={value} onClick={() => { close(); onChoose(value) }}><Icon size={15} aria-hidden="true" />{label}</button>)}
    </div>}
  </div>
}
