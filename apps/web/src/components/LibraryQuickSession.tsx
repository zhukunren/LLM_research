import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ConversationScope, ConversationSourceReference, DataStatus, WorkflowType } from '../api'
import { EmbeddedWorkspaceSession, useWorkspaceSession } from '../WorkspaceSession'
import ConditionWorkspaceDrawer from './ConditionWorkspaceDrawer'
import LoadingState from './LoadingState'
import './library-quick-session.css'

const ConversationWorkspace = lazy(() => import('./conversation/ConversationWorkspace'))
export type LibraryQuickEntry = {
  id: string; scope: ConversationScope; workflow: WorkflowType; prompt: string
  source: { reference: ConversationSourceReference; label: string }
  conversationId?: string; promptConsumed?: boolean; sourceConsumed?: boolean
}

export function validLibraryQuickEntries(value: unknown): value is Record<string, LibraryQuickEntry> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => {
    if (!item || typeof item !== 'object') return false
    const entry = item as LibraryQuickEntry, reference = entry.source?.reference
    return typeof entry.id === 'string' && ['news', 'report'].includes(entry.scope) && ['research', 'screening'].includes(entry.workflow)
      && typeof entry.prompt === 'string' && typeof entry.source?.label === 'string'
      && !!reference && typeof reference.source_id === 'string'
      && (reference.kind === 'news_item' || reference.kind === 'report_page' && typeof reference.page_number === 'number' && Number.isInteger(reference.page_number) && reference.page_number > 0)
      && (entry.conversationId === undefined || typeof entry.conversationId === 'string')
      && (entry.promptConsumed === undefined || typeof entry.promptConsumed === 'boolean')
      && (entry.sourceConsumed === undefined || typeof entry.sourceConsumed === 'boolean')
  })
}

export default function LibraryQuickSession({ entry, open, data, onClose, onChange, onHistoryChange }: {
  entry: LibraryQuickEntry; open: boolean; data: DataStatus | null
  onClose: () => void; onChange: (change: Partial<LibraryQuickEntry>) => void; onHistoryChange?: () => void
}) {
  const parent = useWorkspaceSession()
  const [host] = useState(() => document.createElement('div'))
  const mount = useRef<HTMLDivElement>(null)
  const active = open && parent.active
  useLayoutEffect(() => {
    host.className = 'library-quick-session-host'
    if (active) mount.current?.append(host)
    else host.remove()
    const frame = active ? requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))) : 0
    return () => { cancelAnimationFrame(frame); host.remove() }
  }, [active, host])
  return <>
    {active && <ConditionWorkspaceDrawer title={entry.workflow === 'research' ? '研究当前资料' : '用于选股'} description={entry.source.label} closeLabel="关闭资料助手" className="library-quick-drawer" onClose={onClose}><div ref={mount} className="library-quick-session-mount" /></ConditionWorkspaceDrawer>}
    {createPortal(<EmbeddedWorkspaceSession id={entry.id} active={active} portalTarget={host}><Suspense fallback={<LoadingState label="正在打开资料助手…" />}><ConversationWorkspace
      embedded shellNavigation initialScope={entry.scope} initialWorkflowType={entry.workflow} data={data}
      initialNewDraft={!entry.conversationId} initialConversationId={entry.conversationId}
      initialPrompt={entry.promptConsumed ? undefined : entry.prompt} onPromptConsumed={() => onChange({ promptConsumed: true })}
      initialSource={entry.sourceConsumed ? null : entry.source} onSourceChange={source => onChange({ sourceConsumed: !source })}
      onLocationChange={id => onChange({ conversationId: id || undefined })} onHistoryChange={onHistoryChange}
    /></Suspense></EmbeddedWorkspaceSession>, host)}
  </>
}
