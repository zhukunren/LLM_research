import { LoaderCircle } from 'lucide-react'
import './loading-state.css'

export default function LoadingState({ label = '正在加载…', compact = false, skeleton = false, className = '' }: {
  label?: string; compact?: boolean; skeleton?: boolean; className?: string
}) {
  return <div className={`workspace-loading-state ${compact ? 'workspace-loading-compact' : ''} ${className}`} role="status">
    <span className="workspace-loading-label"><LoaderCircle size={18} strokeWidth={1.6} aria-hidden="true" />{label}</span>
    {skeleton && <div className="workspace-loading-lines" aria-hidden="true"><span /><span /><span /></div>}
  </div>
}
