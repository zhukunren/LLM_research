import { ListFilter, MessageCircle } from 'lucide-react'
import './library-reading-controls.css'

export default function LibraryReadingActions({ onResearch, onScreening, disabled = false, context }: {
  onResearch?: () => void; onScreening?: () => void; disabled?: boolean; context?: string
}) {
  if (!onResearch && !onScreening) return null
  return <div className="library-reading-actions" role="group" aria-label="当前资料操作">
    {context && <span className="library-reading-context">{context}</span>}
    <div>{onResearch && <button type="button" className="primary-button workspace-button" disabled={disabled} onClick={onResearch} data-tooltip={context ? `研究${context}` : '基于当前阅读的资料发起研究'}><MessageCircle size={14} />研究当前资料</button>}
      {onScreening && <button type="button" className="secondary-button workspace-button" disabled={disabled} onClick={onScreening} data-tooltip={context ? `将${context}带入选股草稿` : '将当前资料带入选股草稿'}><ListFilter size={14} />用于选股</button>}</div>
  </div>
}
