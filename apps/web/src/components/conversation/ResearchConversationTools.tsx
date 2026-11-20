import { useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { FileSearch } from 'lucide-react'

type Props = {
  resultsOpen: boolean
  resultsToggleRef: RefObject<HTMLButtonElement>
  onToggleResults: () => void
  portalTargetId?: string
}

export default function ResearchConversationTools({ resultsOpen, resultsToggleRef, onToggleResults, portalTargetId }: Props) {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    if (!portalTargetId) { setPortalTarget(null); return }
    const findTarget = () => setPortalTarget(document.getElementById(portalTargetId))
    findTarget()
    const observer = new MutationObserver(findTarget)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [portalTargetId])

  const content = <div className="research-conversation-tools">
    <button ref={resultsToggleRef} type="button" className="icon-button research-conversation-results workspace-button"
      aria-label="成果与文件" data-tooltip="成果与文件" aria-expanded={resultsOpen} aria-controls="research-results-drawer"
      onClick={onToggleResults}><FileSearch size={18} aria-hidden="true" /></button>
  </div>
  return portalTarget ? createPortal(content, portalTarget) : content
}
