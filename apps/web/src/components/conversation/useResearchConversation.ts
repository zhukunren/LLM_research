import { useRef, useState } from 'react'
import { api, type Conversation, type ConversationMessage, type ResearchScope } from '../../api'
import type { ResearchResultRequest } from './ResearchResultActions'

const unrestrictedScope: ResearchScope = {
  as_of: null, stock_codes: [], report_lookback_calendar_days: null,
  news_lookback_calendar_days: null, price_basis: null,
}

export function hasResearchScopeLimits(scope?: ResearchScope) {
  return !!scope && (!!scope.as_of || !!scope.stock_codes?.length || scope.report_lookback_calendar_days != null
    || scope.news_lookback_calendar_days != null || scope.price_basis != null)
}

export async function clearResearchScope(conversation: Conversation): Promise<Conversation> {
  const baseRevision = conversation.research_scope_revision ?? 0
  const updated = await api<{ research_scope: ResearchScope; research_scope_revision: number }>(
    `/conversations/${conversation.id}/research-scope`,
    { method: 'PATCH', body: JSON.stringify({ base_revision: baseRevision, ...unrestrictedScope }) },
  )
  if (!updated.research_scope || hasResearchScopeLimits(updated.research_scope)
    || !Number.isInteger(updated.research_scope_revision) || updated.research_scope_revision <= baseRevision) {
    throw new Error('研究设置暂未更新，请稍后重试。')
  }
  return { ...conversation, ...updated }
}

export function useResearchConversation({
  conversation, enabled, busy, saving, isSelected, onHistoryChange, onAnswerVersion,
  onScreeningDraft, setNotice, setError,
}: {
  conversation: Conversation | null
  enabled: boolean
  busy: boolean
  saving: boolean
  isSelected: (id: string) => boolean
  onHistoryChange: () => void
  onAnswerVersion: (original: Conversation, nextId: string) => Promise<void>
  onScreeningDraft: (id: string, prompt: string) => void
  setNotice: (notice: string) => void
  setError: (message: string) => void
}) {
  const [versionSelection, setVersionSelection] = useState<Record<string, string>>({})
  const [answerActionSaving, setAnswerActionSaving] = useState(false)
  const versionAttempt = useRef<{ key: string; requestId: string } | null>(null)
  const resultAttempt = useRef<{ key: string; requestId: string } | null>(null)
  const submitting = useRef(false)

  async function changeResearchAnswer(message: ConversationMessage, kind: 'regenerate' | 'branch') {
    if (!conversation || !enabled || busy || saving || submitting.current) return
    const id = conversation.id
    const key = JSON.stringify([id, message.id, kind])
    if (versionAttempt.current?.key !== key) versionAttempt.current = { key, requestId: crypto.randomUUID() }
    submitting.current = true
    setAnswerActionSaving(true)
    setError('')
    try {
      const result = await api<{ conversation_id: string }>(`/conversations/${id}/answers/${kind}`, {
        method: 'POST', body: JSON.stringify({ message_id: message.id, request_id: versionAttempt.current.requestId }),
      })
      versionAttempt.current = null
      onHistoryChange()
      if (!isSelected(id)) return
      setVersionSelection(current => {
        const next = { ...current }
        delete next[message.regeneration_of || message.id]
        return next
      })
      await onAnswerVersion(conversation, result.conversation_id)
      setNotice(kind === 'branch' ? '已从这条答复打开新分支。' : result.conversation_id === id ? '正在重新生成，原回答已保留。' : '正在新分支中重新生成，后续对话已保留。')
    } catch (reason) {
      if (isSelected(id)) setError((reason as Error).message)
    } finally {
      submitting.current = false
      setAnswerActionSaving(false)
    }
  }

  async function submitResearchResult(messageId: string, action: ResearchResultRequest) {
    if (!conversation || !enabled || busy || submitting.current) return false
    const id = conversation.id
    const payload = action.kind === 'draft'
      ? { source_message_id: messageId, instructions: action.instructions.trim() }
      : {
          conversation_id: id, source_message_id: messageId, stock_code: action.stock_code.trim().toUpperCase(),
          note: action.note.trim(), verification: action.verification.trim(), invalidation: action.invalidation.trim(),
        }
    if (action.kind === 'draft' ? !action.instructions.trim() : !/^\d{6}\.(SH|SZ|BJ)$/.test(action.stock_code.trim().toUpperCase())) return false
    const key = JSON.stringify([id, action.kind, payload])
    if (resultAttempt.current?.key !== key) resultAttempt.current = { key, requestId: crypto.randomUUID() }
    const body = JSON.stringify({ ...payload, request_id: resultAttempt.current.requestId })
    submitting.current = true
    setAnswerActionSaving(true)
    setError('')
    try {
      if (action.kind === 'draft') {
        const result = await api<{ conversation_id: string; draft_prompt: string }>(
          `/conversations/${id}/screening-draft`, { method: 'POST', body },
        )
        if (!isSelected(id)) return false
        onScreeningDraft(result.conversation_id, result.draft_prompt)
      } else {
        await api('/observation/research-candidates', { method: 'POST', body })
        if (!isSelected(id)) return false
        setNotice('已加入关注。')
      }
      resultAttempt.current = null
      return true
    } catch (reason) {
      if (isSelected(id)) setError((reason as Error).message)
      return false
    } finally {
      submitting.current = false
      setAnswerActionSaving(false)
    }
  }

  return { versionSelection, setVersionSelection, answerActionSaving, changeResearchAnswer, submitResearchResult }
}
