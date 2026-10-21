import type { ReactNode } from 'react'
import { Search, type LucideIcon } from 'lucide-react'
import './empty-state.css'

/** Shared hierarchy for empty catalogs, filtered lists and detail placeholders. */
export default function EmptyState({ title, description, icon: Icon = Search, actions, compact = false, className = '', titleAs: Title = 'strong' }: {
  title: string; description?: string; icon?: LucideIcon; actions?: ReactNode; compact?: boolean; className?: string; titleAs?: 'strong' | 'h2' | 'h3'
}) {
  return <div className={`workspace-empty-state ${compact ? 'workspace-empty-compact' : ''} ${className}`}>
    <span className="workspace-empty-icon" aria-hidden="true"><Icon size={24} strokeWidth={1.5} /></span>
    <Title className="workspace-empty-title">{title}</Title>
    {description && <p className="workspace-empty-description">{description}</p>}
    {actions && <div className="workspace-empty-actions">{actions}</div>}
  </div>
}
