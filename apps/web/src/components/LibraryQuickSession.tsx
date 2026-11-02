import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
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

export default function LibraryQuickSession({ entry, open, expanded = false, onExpand, data, onClose, onChange, onHistoryChange }: {
  entry: LibraryQuickEntry; open: boolean; expanded?: boolean; onExpand?: () => void; data: DataStatus | null
  onClose: () => void; onChange: (change: Partial<LibraryQuickEntry>) => void; onHistoryChange?: () => void
}) {
  const parent = useWorkspaceSession()
  const [host] = useState(() => document.createElement('div'))
  const mount = useRef<HTMLDivElement>(null)
  const active = open && parent.active
  const returnButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!active || !expanded) return
    const frame = requestAnimationFrame(() => returnButton.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [active, expanded])
  const positions = useRef(new Map<HTMLElement, { top: number; left: number }>())
  useLayoutEffect(() => {
    host.className = 'library-quick-session-host'
    if (active) {
      mount.current?.append(host)
      for (const [element, position] of positions.current) { element.scrollTop = position.top; element.scrollLeft = position.left }
    }
    else host.remove()
    const frame = active ? requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))) : 0
    return () => {
      cancelAnimationFrame(frame)
      positions.current = new Map(Array.from(host.querySelectorAll<HTMLElement>('*')).filter(element => element.scrollTop || element.scrollLeft).map(element => [element, { top: element.scrollTop, left: element.scrollLeft }]))
      host.remove()
    }
  }, [active, expanded, host])
  return <>
    {active && !expanded && <ConditionWorkspaceDrawer title={entry.workflow === 'research' ? '研究当前资料' : '用于选股'} description={entry.source.label} closeLabel="关闭资料助手" className="library-quick-drawer" onClose={onClose} footer={onExpand && <button type="button" className="secondary-button workspace-button" onClick={onExpand}>{entry.workflow === 'research' ? '展开研究' : '展开选股'}</button>}><div ref={mount} className="library-quick-session-mount" /></ConditionWorkspaceDrawer>}
    {active && expanded && <section className="library-quick-expanded library-quick-drawer" aria-label={entry.workflow === 'research' ? '资料研究完整视图' : '资料选股完整视图'}>
      <header><div><h2>{entry.workflow === 'research' ? '研究当前资料' : '用于选股'}</h2><p>{entry.source.label}</p></div><button ref={returnButton} type="button" className="secondary-button workspace-button" onClick={onClose}>返回资料</button></header>
      <div ref={mount} className="library-quick-session-mount" />
    </section>}
    {createPortal(<EmbeddedWorkspaceSession id={entry.id} active={active} portalTarget={host}><Suspense fallback={<LoadingState label="正在打开资料助手…" />}><ConversationWorkspace
      embedded shellNavigation initialScope={entry.scope} initialWorkflowType={entry.workflow} data={data}
      initialNewDraft={!entry.conversationId} initialConversationId={entry.conversationId}
      initialPrompt={entry.promptConsumed ? undefined : entry.prompt} onPromptConsumed={() => onChange({ promptConsumed: true })}
      initialSource={entry.sourceConsumed ? null : entry.source} onSourceChange={source => onChange({ sourceConsumed: !source })}
      onLocationChange={id => onChange({ conversationId: id || undefined })} onHistoryChange={onHistoryChange}
    /></Suspense></EmbeddedWorkspaceSession>, host)}
  </>
}
