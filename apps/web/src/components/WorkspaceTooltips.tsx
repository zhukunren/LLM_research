import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { tooltipPosition } from './tooltipPosition'

export default function WorkspaceTooltips({ children }: { children: ReactNode }) {
  const id = useId(), tip = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<{ target: Element; text: string } | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, target: Element | null = null, suppressed: Element | null = null
    let input: 'pointer' | 'keyboard' | 'touch' = 'keyboard'
    const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined }
    const hide = () => { clearTimer(); target = null; setActive(null) }
    const find = (node: EventTarget | null) => node instanceof Element ? node.closest('[data-tooltip]') : null
    const show = (node: Element | null, delay: number) => {
      if (!node || node === target || node === suppressed) return
      const text = node.getAttribute('data-tooltip')?.trim()
      hide()
      if (!text) return
      target = node
      const reveal = () => { if (target === node && node.isConnected) { setPosition(null); setActive({ target: node, text }) } }
      if (delay) timer = setTimeout(reveal, delay)
      else reveal()
    }
    const over = (event: PointerEvent) => { if (event.pointerType !== 'touch') show(find(event.target), 350) }
    const out = (event: PointerEvent) => {
      const node = find(event.target)
      if (node && event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return
      if (node === suppressed) suppressed = null
      if (node === target) hide()
    }
    const focus = (event: FocusEvent) => { if (input === 'keyboard') show(find(event.target), 0) }
    const blur = (event: FocusEvent) => { if (find(event.target) === target) hide(); suppressed = null }
    const down = (event: PointerEvent) => { input = event.pointerType === 'touch' ? 'touch' : 'pointer'; suppressed = find(event.target); hide() }
    const key = (event: globalThis.KeyboardEvent) => {
      input = 'keyboard'
      if (event.key === 'Escape') { suppressed = target; hide() }
    }
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerout', out)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', blur)
    document.addEventListener('keydown', key, true)
    window.addEventListener('blur', hide)
    return () => {
      clearTimer()
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerout', out)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', blur)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', hide)
    }
  }, [])
  useLayoutEffect(() => {
    if (!active) return
    const target = active.target
    const descriptions = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean))
    descriptions.add(id); target.setAttribute('aria-describedby', [...descriptions].join(' '))
    const reposition = () => {
      if (!target.isConnected || !tip.current) { setActive(null); return }
      const viewport = window.visualViewport
      const box = target.getBoundingClientRect()
      const bounds = { left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0, width: viewport?.width || window.innerWidth, height: viewport?.height || window.innerHeight }
      if (box.bottom < bounds.top || box.top > bounds.top + bounds.height || !target.getClientRects().length) { setActive(null); return }
      setPosition(tooltipPosition(box, tip.current.getBoundingClientRect(), bounds))
    }
    reposition()
    const observer = new MutationObserver(() => {
      if (!target.isConnected || target.closest('[hidden],[aria-hidden=true]')) { setActive(null); return }
      const text = target.getAttribute('data-tooltip')?.trim()
      if (text !== active.text) setActive(text ? { target, text } : null)
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'data-tooltip'] })
    window.addEventListener('resize', reposition)
    document.addEventListener('scroll', reposition, true)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    return () => {
      observer.disconnect()
      const remaining = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(value => value && value !== id)
      if (remaining.length) target.setAttribute('aria-describedby', remaining.join(' '))
      else target.removeAttribute('aria-describedby')
      window.removeEventListener('resize', reposition)
      document.removeEventListener('scroll', reposition, true)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
    }
  }, [active, id])
  return <>{children}{active && createPortal(<div ref={tip} id={id} role="tooltip" className="workspace-tooltip" style={{ left: position?.left || 0, top: position?.top || 0, visibility: position ? 'visible' : 'hidden' }}>{active.text}</div>, document.body)}</>
}
