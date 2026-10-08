import { useEffect, useRef, useState } from 'react'
import { api, type Conversation, type ConversationScope, type DataStatus, type SavedScreeningTask, type WorkflowType } from '../api'
import SavedTaskLibrary from '../components/conversation/SavedTaskLibrary'
import { readModelPreference } from '../modelSelection'

export default function SavedScreeningPlans({ data, onOpenConversation }: {
  data?: DataStatus | null
  onOpenConversation?: (id: string, scope: ConversationScope, workflow?: WorkflowType) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const attempt = useRef<{ key: string; requestId: string; messageKey: string; conversation?: Conversation; messageId?: string } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function reuse(saved: SavedScreeningTask, latest = false) {
    if (inFlight.current) return
    const asOf = latest ? data?.last_date : undefined
    const key = JSON.stringify([saved.id, saved.version, asOf])
    if (attempt.current?.key !== key) attempt.current = { key, requestId: crypto.randomUUID(), messageKey: crypto.randomUUID() }
    const currentAttempt = attempt.current
    inFlight.current = true; setBusy(true); setError('')
    try {
      if (!currentAttempt.conversation) currentAttempt.conversation = await api<Conversation>('/conversations', {
        method: 'POST', body: JSON.stringify({ request_id: currentAttempt.requestId, entry_scope: 'screening', workflow_type: 'screening', ...readModelPreference() }),
      })
      const conversation = currentAttempt.conversation
      if (!currentAttempt.messageId) {
        const message = await api<{ message_id: string }>(`/conversations/${conversation.id}/messages`, {
          method: 'POST', body: JSON.stringify({ client_message_id: currentAttempt.messageKey, base_revision: 0,
            content: `复用已保存方案“${saved.name}”（第${saved.version}版）${asOf ? `，采用${asOf}的行情` : '，保留原截止日'}` }),
        })
        currentAttempt.messageId = message.message_id
      }
      await api(`/conversations/${conversation.id}/saved-screening-tasks/${saved.id}/reuse`, {
        method: 'POST', body: JSON.stringify({ base_revision: 0, source_message_id: currentAttempt.messageId, version: saved.version, ...(asOf ? { as_of: asOf } : {}) }),
      })
      if (mounted.current) onOpenConversation?.(conversation.id, 'screening', 'screening')
      attempt.current = null
    } catch (reason) { if (mounted.current) setError(`复用未完成：${(reason as Error).message} 可以再次点击复用以继续。`) }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  return <div className="page-content saved-screening-page">
    <header className="page-heading"><div><h1>已保存方案</h1><p className="page-description">复用已有条件，核对范围与截止日后开始筛选。</p></div></header>
    {error && <p className="research-error" role="alert">{error}</p>}
    <SavedTaskLibrary scope="screening" busy={busy} latestDate={data?.last_date} onReuse={(saved, latest) => void reuse(saved, latest)} />
  </div>
}
