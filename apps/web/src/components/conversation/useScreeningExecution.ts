import { useEffect, useRef } from 'react'
import { api, type Conversation, type ScreeningTaskRevision } from '../../api'

type Confirmation = { revision: number; requestId: string }

export function useScreeningExecution({
  conversation, task, enabled, selectedId, activeTurnId, busy, turnInProgress, runInProgress,
  reloadConversation, onQueued, refresh, setBusy, setError,
}: {
  conversation: Conversation | null
  task: ScreeningTaskRevision | null
  enabled: boolean
  selectedId: string
  activeTurnId?: string
  busy: boolean
  turnInProgress: boolean
  runInProgress: boolean
  reloadConversation: (id: string, accept?: () => boolean) => Promise<Conversation>
  onQueued: (conversationId: string, runId: string) => void
  refresh: () => void
  setBusy: (value: boolean) => void
  setError: (message: string) => void
}) {
  const requests = useRef(new Map<string, Promise<{ run_id: string }>>())

  async function enqueueAuthorizedTurn(conversationId: string, turnId: string, confirmation?: Confirmation) {
    const key = confirmation
      ? `${conversationId}:${turnId}:button:${confirmation.revision}:${confirmation.requestId}`
      : `${conversationId}:${turnId}:message`
    let request = requests.current.get(key)
    if (!request) {
      const payload = confirmation
        ? { action: 'button', revision: confirmation.revision, request_id: confirmation.requestId }
        : { action: 'message' }
      request = api<{ run_id: string }>(`/conversations/${conversationId}/turns/${turnId}/execute`, {
        method: 'POST', body: JSON.stringify(payload),
      })
      requests.current.set(key, request)
    }
    const queued = await request.catch(reason => {
      // The reply can be lost after the server accepts the run. Retry the same
      // submission, using its original turn or confirmation request ID.
      if (requests.current.get(key) === request) requests.current.delete(key)
      throw reason
    })
    onQueued(conversationId, queued.run_id)
  }

  const readyTurnId = enabled && conversation?.id === selectedId && conversation.pending_execution && !activeTurnId
    ? conversation.turns.find(turn => turn.state === 'succeeded' && turn.result.ready_to_execute
      && turn.result.execution_authorized && turn.result.task_revision === conversation.task_revision)?.id
    : undefined

  useEffect(() => {
    if (!selectedId || !readyTurnId) return
    let active = true
    // Resume the already-authorized action after a reload or lost process response.
    enqueueAuthorizedTurn(selectedId, readyTurnId)
      .then(() => { if (active) return reloadConversation(selectedId, () => active) })
      .catch(reason => { if (active) setError((reason as Error).message) })
    return () => { active = false }
  }, [selectedId, readyTurnId])

  async function cancelRun(jobId?: string) {
    if (!jobId) return
    setBusy(true)
    setError('')
    try {
      await api(`/jobs/${jobId}/cancel`, { method: 'POST' })
      refresh()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function retryExecution(turnId: string) {
    if (!conversation || busy) return
    setBusy(true)
    setError('')
    try {
      requests.current.delete(`${conversation.id}:${turnId}:message`)
      await enqueueAuthorizedTurn(conversation.id, turnId)
      refresh()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function startScreening() {
    if (!enabled || !conversation || !task || busy || turnInProgress || runInProgress || conversation.pending_execution) return
    const latest = conversation.turns[0]
    if (!latest || latest.state !== 'succeeded' || latest.result?.task_revision !== task.revision) {
      setError('当前方案对应的回合已经变化，请刷新后再开始筛选。')
      return
    }
    const requestId = `confirmed-${latest.id}-v${task.revision}`
    setBusy(true)
    setError('')
    try {
      await enqueueAuthorizedTurn(conversation.id, latest.id, { revision: task.revision, requestId })
    } catch (reason) {
      setError(`筛选启动未确认：${(reason as Error).message} 可再次点击“开始筛选”；同一请求不会重复创建运行。`)
      setBusy(false)
      return
    }
    try {
      await reloadConversation(conversation.id)
      refresh()
    } catch {
      setError('筛选已启动，但暂时无法读取最新状态；请刷新页面查看结果。')
    } finally {
      setBusy(false)
    }
  }

  return { enqueueAuthorizedTurn, startScreening, cancelRun, retryExecution }
}
