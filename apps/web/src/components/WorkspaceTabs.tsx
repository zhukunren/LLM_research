import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeftToLine, ArrowRightToLine, List, ListX, Plus, RotateCcw, SquareX, X } from 'lucide-react'
import type { WorkflowType } from '../api'
import type { WorkspaceTab } from '../workspaceTabs'
import { workspaceMenus } from '../navigation'

export default function WorkspaceTabs({ tabs, activeId, onActivate, onClose, onCloseOthers, onCloseSide, onCloseAll, canReopen, onReopen, onMove, onNew, newWorkflow = 'research' }: { tabs: WorkspaceTab[]; activeId: string; onActivate: (id: string) => void; onClose: (id: string) => void; onCloseOthers: (id: string) => void; onCloseSide: (id: string, side: 'left' | 'right') => void; onCloseAll: () => void; canReopen: boolean; onReopen: () => void; onMove: (id: string, targetId: string, placement: 'before' | 'after') => void; onNew: () => void; newWorkflow?: WorkflowType }) {
  const list = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const allTrigger = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; all?: boolean } | null>(null)
  const menuIndex = tabs.findIndex(tab => tab.id === menu?.id)
  const drag = useRef<{ id: string; x: number } | null>(null)
  const scrollFrame = useRef(0)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: 'before' | 'after' } | null>(null)

  function stopDragScroll() {
    cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = 0
  }
  function finishDrag() {
    stopDragScroll()
    drag.current = null
    setDraggingId(null)
    setDropTarget(null)
  }
  function scrollDuringDrag() {
    const node = list.current, current = drag.current
    if (!node || !current) { scrollFrame.current = 0; return }
    const rect = node.getBoundingClientRect(), edge = Math.min(36, rect.width / 4)
    const distance = current.x < rect.left + edge ? current.x - rect.left - edge : current.x > rect.right - edge ? current.x - rect.right + edge : 0
    if (distance) node.scrollLeft += Math.sign(distance) * Math.min(16, Math.ceil(Math.abs(distance) / 3))
    scrollFrame.current = requestAnimationFrame(scrollDuringDrag)
  }
  function dragTarget(event: DragEvent<HTMLDivElement>) {
    const node = event.target instanceof Element ? event.target.closest<HTMLElement>('.workspace-tab-item') : null
    if (node?.dataset.tabId && list.current?.contains(node)) {
      const rect = node.getBoundingClientRect()
      return { id: node.dataset.tabId, placement: event.clientX < rect.left + rect.width / 2 ? 'before' as const : 'after' as const }
    }
    const last = tabs.at(-1)
    return last ? { id: last.id, placement: 'after' as const } : null
  }
  function dragOver(event: DragEvent<HTMLDivElement>) {
    if (!drag.current) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    drag.current.x = event.clientX
    const target = dragTarget(event)
    const next = target?.id !== drag.current.id ? target : null
    setDropTarget(current => current?.id === next?.id && current?.placement === next?.placement ? current : next)
    if (!scrollFrame.current) scrollFrame.current = requestAnimationFrame(scrollDuringDrag)
  }
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), [])
  useEffect(() => { if (draggingId && !tabs.some(tab => tab.id === draggingId)) finishDrag() }, [tabs, draggingId])
  function focusTab(id?: string) {
    const target = id ? list.current?.querySelector<HTMLButtonElement>(`#workspace-tab-${id}`) : null
    ;(target ?? list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]'))?.focus()
  }
  function closeMenu(restoreFocus = true) {
    setMenu(null)
    if (restoreFocus) { if (menu?.all) allTrigger.current?.focus(); else focusTab(menu?.id) }
  }
  function menuAction(action: () => void) {
    setMenu(null)
    action()
    requestAnimationFrame(() => focusTab())
  }
  useLayoutEffect(() => {
    if (!menu || !popup.current) return
    const node = popup.current, rect = node.getBoundingClientRect()
    node.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`
    node.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menu])
  useEffect(() => {
    if (!menu) return
    const dismiss = () => setMenu(null)
    const width = window.innerWidth, height = window.innerHeight
    // Activating a workspace emits a synthetic resize for charts; it must not
    // dismiss a menu opened before that pending layout frame has completed.
    const resize = () => { if (window.innerWidth !== width || window.innerHeight !== height) dismiss() }
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !popup.current?.contains(event.target) && !(menu.all && allTrigger.current?.contains(event.target))) dismiss() }
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) dismiss() }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', resize)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', resize)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', dismiss)
    }
  }, [menu])
  useEffect(() => { if (menu && !menu.all && !tabs.some(tab => tab.id === menu.id)) setMenu(null) }, [tabs, menu])
  useEffect(() => {
    const node = list.current
    if (!node) return
    const revealActiveTab = () => {
      if (!drag.current) node.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    }
    revealActiveTab()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(revealActiveTab) : null
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [activeId, tabs.length])
  function keyDown(event: KeyboardEvent, index: number) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      closeMenu(false)
      const target = tabs[index + (event.key === 'ArrowLeft' ? -1 : 1)]
      if (target) { onMove(tabs[index].id, target.id, event.key === 'ArrowLeft' ? 'before' : 'after'); requestAnimationFrame(() => focusTab(tabs[index].id)) }
      return
    }
    if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      setMenu({ id: tabs[index].id, x: rect.left, y: rect.bottom })
      return
    }
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else if (event.key === 'Delete') { event.preventDefault(); onClose(tabs[index].id); requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()); return }
    else return
    event.preventDefault()
    onActivate(tabs[next].id)
    list.current?.querySelector<HTMLButtonElement>(`#workspace-tab-${tabs[next].id}`)?.focus()
  }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { event.stopPropagation(); return }
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); closeMenu(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  return <div className="workspace-tab-bar">
    <div ref={list} role="tablist" aria-label="工作区标签" className="workspace-tab-list" onDragOver={dragOver} onDragLeave={event => {
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) { stopDragScroll(); setDropTarget(null) }
    }} onDrop={event => {
      if (!drag.current) return
      event.preventDefault()
      const target = dragTarget(event), id = drag.current.id
      finishDrag()
      if (target && target.id !== id) onMove(id, target.id, target.placement)
    }}>
      {tabs.map((tab, index) => {
        const Icon = workspaceMenus.find(item => item.id === tab.route.page)?.icon
        return <div key={tab.id} className="workspace-tab-item" data-tab-id={tab.id} data-active={tab.id === activeId} data-dragging={draggingId === tab.id || undefined} data-drop={dropTarget?.id === tab.id ? dropTarget.placement : undefined} onContextMenu={event => {
          event.preventDefault()
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          setMenu({ id: tab.id, x: event.clientX || rect.left, y: event.clientY || rect.bottom })
        }}>
          <button id={`workspace-tab-${tab.id}`} role="tab" type="button" draggable={tabs.length > 1} onDragStart={event => {
            closeMenu(false)
            drag.current = { id: tab.id, x: event.clientX }
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('application/x-llmr-workspace-tab', tab.id)
            setDraggingId(tab.id)
          }} onDragEnd={finishDrag} aria-selected={tab.id === activeId} aria-controls={`workspace-panel-${tab.id}`} aria-haspopup="menu" aria-expanded={menu?.id === tab.id} aria-describedby={menu?.id === tab.id ? menuId : undefined} tabIndex={tab.id === activeId ? 0 : -1} data-tooltip={`${tab.title} · 拖动可调整顺序`} onClick={() => { closeMenu(false); onActivate(tab.id) }} onKeyDown={event => keyDown(event, index)} className="workspace-button">{Icon && <Icon size={14} aria-hidden="true" />}<span>{tab.title}</span></button>
          <button type="button" className="workspace-tab-close workspace-button" aria-label={`关闭标签：${tab.title}`} data-tooltip="关闭标签（不停止后台任务）" onClick={() => onClose(tab.id)}><X size={13} aria-hidden="true" /></button>
        </div>
      })}
    </div>
    <button type="button" className="workspace-tab-new workspace-button" aria-label={newWorkflow === 'screening' ? '新建选股标签' : '新建研究标签'} data-tooltip={newWorkflow === 'screening' ? '新建选股标签' : '新建研究标签'} onClick={onNew}><Plus size={16} aria-hidden="true" /></button>
    <button ref={allTrigger} type="button" className="workspace-tab-new workspace-button" aria-label={`已打开工作区（${tabs.length}）`} aria-haspopup="menu" aria-expanded={!!menu?.all} aria-controls={menu?.all ? menuId : undefined} onClick={event => {
      if (menu?.all) { closeMenu(); return }
      const rect = event.currentTarget.getBoundingClientRect()
      setMenu({ id: '', x: rect.right - 320, y: rect.bottom, all: true })
    }}><List size={16} aria-hidden="true" /></button>
    {menu && createPortal(<div ref={popup} id={menuId} role="menu" aria-label={menu.all ? '已打开工作区' : '标签页操作'} className={`workspace-tab-context-menu workspace-tool-dialog workspace-popover workspace-menu${menu.all ? ' workspace-tab-overflow' : ''}`} style={{ left: menu.x, top: menu.y }} onKeyDown={menuKeys} onContextMenu={event => event.preventDefault()}>
      {menu.all ? tabs.map(tab => <button key={tab.id} type="button" role="menuitem" aria-current={tab.id === activeId ? 'page' : undefined} onClick={() => menuAction(() => onActivate(tab.id))} className="workspace-button workspace-menu-option"><small>{tab.route.page === 'conditions' || tab.route.workspace === 'screening' ? '选股' : tab.route.page === 'screening' ? '研究' : '资料'}</small><span>{tab.title}</span></button>) : <>
      <button type="button" role="menuitem" onClick={() => menuAction(() => onClose(menu.id))} className="workspace-button workspace-menu-option"><X size={15} aria-hidden="true" /><span>关闭当前标签</span></button>
      <button type="button" role="menuitem" disabled={tabs.length === 1} onClick={() => menuAction(() => onCloseOthers(menu.id))} className="workspace-button workspace-menu-option"><SquareX size={15} aria-hidden="true" /><span>关闭其他标签</span></button>
      <button type="button" role="menuitem" disabled={menuIndex <= 0} onClick={() => menuAction(() => onCloseSide(menu.id, 'left'))} className="workspace-button workspace-menu-option"><ArrowLeftToLine size={15} aria-hidden="true" /><span>关闭左侧标签</span></button>
      <button type="button" role="menuitem" disabled={menuIndex < 0 || menuIndex === tabs.length - 1} onClick={() => menuAction(() => onCloseSide(menu.id, 'right'))} className="workspace-button workspace-menu-option"><ArrowRightToLine size={15} aria-hidden="true" /><span>关闭右侧标签</span></button>
      <div role="separator" />
      <button type="button" role="menuitem" onClick={() => menuAction(onCloseAll)} className="workspace-button workspace-menu-option"><ListX size={15} aria-hidden="true" /><span>关闭全部标签</span></button>
      <div role="separator" />
      <button type="button" role="menuitem" disabled={!canReopen} onClick={() => menuAction(onReopen)} className="workspace-button workspace-menu-option"><RotateCcw size={15} aria-hidden="true" /><span>重新打开关闭的标签</span></button>
      </>}
    </div>, document.body)}
  </div>
}
