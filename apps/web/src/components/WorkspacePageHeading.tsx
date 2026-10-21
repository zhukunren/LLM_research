import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceSession } from '../WorkspaceSession'

/** Keep handlers and selection in their page; only the active page owns the toolbar. */
export default function WorkspacePageHeading({ className = 'page-heading', actionsClassName = 'heading-actions', children, actions }: {
  className?: string; actionsClassName?: string; children: ReactNode; actions: ReactNode
}) {
  const session = useWorkspaceSession()
  const integrated = !!session.id && !!session.actionsTarget
  const controls = <div className={`workspace-page-actions${integrated ? '' : ` ${actionsClassName}`}`}>{actions}</div>
  return <div className={`${className}${integrated ? ' workspace-heading-integrated' : ''}`}>
    <div className="library-title workspace-page-heading-copy">{children}</div>
    {integrated ? session.active ? createPortal(controls, session.actionsTarget!, session.id) : null : controls}
  </div>
}
