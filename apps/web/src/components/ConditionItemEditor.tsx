import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { NodeEditor, type Asset, type Node } from '../pages/StrategyPage'
import { trapDialogTab } from '../keyboard'

export default function ConditionItemEditor({ node, catalog, title, parameters, depth, disabled, onApply, onClose }: { node: Node; catalog: Asset[]; title: string; parameters: boolean; depth: number; disabled: boolean; onApply: (node: Node) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Node>(() => structuredClone(node))
  const closeButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const origin = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; closeButton.current?.focus()
    return () => { document.body.style.overflow = overflow; if (origin?.isConnected) origin.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => { if (dialog.current && !dialog.current.contains(document.activeElement)) closeButton.current?.focus() }, [draft])
  const dirty = JSON.stringify(node) !== JSON.stringify(draft)
  return createPortal(<div className="workspace-modal-backdrop condition-item-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialog} className="condition-item-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }; trapDialogTab(event) }}>
      <header><h2>{title}</h2><button ref={closeButton} type="button" className="icon-button" aria-label="关闭条件编辑" onClick={onClose}><X size={18} /></button></header>
      <div className="condition-item-editor-body"><NodeEditor node={draft} catalog={catalog} onChange={setDraft} depth={depth} disabled={disabled} expandParameters={parameters} /></div>
      <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={disabled} onClick={() => { if (dirty) onApply(draft); else onClose() }}>应用修改</button></footer>
    </section>
  </div>, document.body)
}
