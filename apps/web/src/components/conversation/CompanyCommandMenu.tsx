import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceSession } from '../../WorkspaceSession'

export type CompanyCommandOption = { id: string; label: string; detail: string; choose: () => void }

export default function CompanyCommandMenu({ id, anchor, options, selected, title, message, retry, onSelect }: {
  id: string; anchor: RefObject<HTMLTextAreaElement>; options: CompanyCommandOption[]; selected: number
  title: string; message: string; retry?: () => void; onSelect: (index: number) => void
}) {
  const session = useWorkspaceSession(), root = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 12, top: 12, width: 320, maxHeight: 320 })
  useLayoutEffect(() => {
    function place() {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const top = viewport?.offsetTop || 0, left = viewport?.offsetLeft || 0
      const width = Math.min(Math.max(240, rect.width), (viewport?.width || window.innerWidth) - 24)
      const bottom = top + (viewport?.height || window.innerHeight)
      const above = rect.top - top - 12, below = bottom - rect.bottom - 12
      const height = Math.min(root.current?.scrollHeight || 320, 360)
      const useAbove = above >= height || above >= below
      const maxHeight = Math.max(60, Math.min(360, useAbove ? above - 8 : below - 8))
      setPosition({
        left: Math.max(left + 12, Math.min(rect.left, left + (viewport?.width || window.innerWidth) - width - 12)),
        top: Math.max(top + 8, useAbove ? rect.top - Math.min(height, maxHeight) - 8 : rect.bottom + 8), width, maxHeight,
      })
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    if (anchor.current) observer?.observe(anchor.current)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [anchor, options.length, title, message])
  useLayoutEffect(() => {
    const option = root.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    option?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])
  return createPortal(<div ref={root} className="company-command-menu workspace-tool-dialog" style={position} onMouseDown={event => event.preventDefault()}>
    <p className="company-command-heading">{title}</p>
    <div id={id} role="listbox" aria-label="快捷命令建议">
      {options.map((option, index) => <button type="button" role="option" tabIndex={-1} id={id + '-' + index} key={option.id}
        aria-selected={selected === index} className="company-command-option workspace-button" onMouseMove={() => onSelect(index)} onClick={option.choose}>
        <strong>{option.label}</strong><span>{option.detail}</span>
      </button>)}
    </div>
    {message && <p role="status" className="company-command-message">{message}{retry && <button type="button" className="text-button workspace-button" onClick={retry}>重试公司列表</button>}</p>}
    <p className="company-command-keys">↑ ↓ 选择 · Enter 确认 · Tab 补全 · Esc 关闭</p>
  </div>, session.portalTarget ?? document.body)
}
