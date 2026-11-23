import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Conversation, type ScreeningTaskDecision, type ScreeningTaskRevision, type ScreeningTaskRunSummary } from '../../api'
import type { ScreeningResultLocation } from '../../workspaceHandoff'
import type { UnifiedDecisionItem } from '../ScreeningResultView'

export const RUN_PAGE_SIZE = 20

export type ScreeningTaskRun = ScreeningTaskRunSummary & {
  conversation_id: string
  execution_request_id: string
  execution_version: string
  task: ScreeningTaskRevision
  result: {
    coverage?: {
      target_total: number
      true_count: number
      false_count: number
      unknown_count: number
      failed_count: number
      not_evaluated_count: number
    }
  }
  job?: { state: string; progress: number; message: string } | null
}

type DecisionFilters = Pick<ScreeningResultLocation, 'state' | 'query' | 'offset'>
const firstPage = (runId: string) => ({ runId, state: 'true', query: '', offset: 0 })

export function useScreeningRunResults({
  conversation, enabled, visible, refreshKey, returnResult, onReleaseResult,
}: {
  conversation: Conversation | null
  enabled: boolean
  visible: boolean
  refreshKey: number
  returnResult?: ScreeningResultLocation
  onReleaseResult?: () => void
}) {
  const conversationId = conversation?.id
  const [runs, setRuns] = useState<ScreeningTaskRunSummary[]>([])
  const [selection, setSelection] = useState(() => firstPage(''))
  const { runId, state, query, offset } = selection
  const [run, setRun] = useState<ScreeningTaskRun | null>(null)
  const [loadingRun, setLoadingRun] = useState(false)
  const [runError, setRunError] = useState('')
  const [decisions, setDecisions] = useState<ScreeningTaskDecision[]>([])
  const [decisionTotal, setDecisionTotal] = useState(0)
  const [decisionError, setDecisionError] = useState('')
  const [loadingDecisions, setLoadingDecisions] = useState(false)
  const [decisionReload, setDecisionReload] = useState(0)
  const returnResultRef = useRef(returnResult)
  returnResultRef.current = returnResult

  function selectRun(id: string) {
    setSelection(current => current.runId === id ? current : firstPage(id))
  }

  function resetResults({ keepSelection = false } = {}) {
    setRuns([])
    setRun(null)
    if (!keepSelection) selectRun('')
  }

  function browseDecisions(change: Partial<DecisionFilters>) {
    onReleaseResult?.()
    setSelection(current => ({ ...current, ...change }))
  }

  function restorePosition(position: ScreeningResultLocation) {
    setSelection({ runId: position.runId, state: position.state, query: position.query, offset: position.offset })
  }

  function updateRunList(next: Conversation, items: ScreeningTaskRunSummary[]) {
    setRuns(items)
    setSelection(current => {
      const latest = next.active_run_id ?? items[0]?.id ?? ''
      if (latest && conversation?.id === next.id && conversation.active_run_id !== latest && current.runId === conversation.active_run_id) {
        return firstPage(latest)
      }
      const returning = returnResultRef.current
      if (current.runId && (items.some(item => item.id === current.runId)
        || returning?.conversationId === next.id && returning.runId === current.runId)) return current
      return firstPage(latest)
    })
  }

  function updateRunStatus(id: string, status: string) {
    setRuns(items => items.map(item => item.id === id && item.status !== status ? { ...item, status } : item))
  }

  useEffect(() => {
    setRun(null)
    setRunError('')
    if (!enabled || !conversationId || !runId) {
      setLoadingRun(false)
      setDecisions([])
      setDecisionTotal(0)
      return
    }
    let active = true
    let pending = false
    let completed = false
    let timer = 0
    const load = async () => {
      if (pending || completed) return
      pending = true
      try {
        const next = await api<ScreeningTaskRun>(`/conversations/${conversationId}/screening-runs/${runId}`)
        if (!active) return
        setRun(next)
        setRunError('')
        const summary = {
          id: next.id, as_of: next.as_of, task_revision: next.task_revision, status: next.status,
          created_at: next.created_at, job_id: next.job_id, turn_id: next.turn_id, finished_at: next.finished_at ?? null,
        }
        setRuns(items => items.some(item => item.id === next.id)
          ? items.map(item => item.id === next.id ? { ...item, status: next.status } : item)
          : [...items, summary])
        completed = !['queued', 'running'].includes(next.status)
        if (completed) globalThis.clearInterval(timer)
      } catch (reason) {
        if (active) setRunError((reason as Error).message)
      } finally {
        pending = false
        if (active) setLoadingRun(false)
      }
    }
    setLoadingRun(true)
    void load()
    timer = globalThis.setInterval(() => { void load() }, 1500)
    return () => { active = false; globalThis.clearInterval(timer) }
  }, [conversationId, runId, refreshKey, enabled])

  useEffect(() => {
    setDecisionError('')
    setDecisions([])
    setDecisionTotal(0)
  }, [conversationId, runId])

  useEffect(() => {
    if (!enabled || !visible) return
    if (!conversationId || !run || run.id !== runId || ['queued', 'running'].includes(run.status)) {
      setDecisions([])
      setDecisionTotal(0)
      setLoadingDecisions(false)
      return
    }
    let active = true
    setLoadingDecisions(true)
    setDecisionError('')
    setDecisions([])
    setDecisionTotal(0)
    const params = new URLSearchParams({ state, query, offset: String(offset), limit: String(RUN_PAGE_SIZE) })
    const timer = globalThis.setTimeout(() => {
      api<{ items: ScreeningTaskDecision[]; total: number }>(
        `/conversations/${conversationId}/screening-runs/${runId}/decisions?${params.toString()}`,
      ).then(value => {
        if (!active) return
        const returning = returnResultRef.current
        if (returning?.runId === runId && returning.conversationId === conversationId
          && !value.items.some(item => item.stock_code === returning.stockCode)
          && (query !== returning.stockCode || offset !== 0 || state)) {
          setSelection({ runId, query: returning.stockCode, offset: 0, state: '' })
          return
        }
        setDecisions(value.items)
        setDecisionTotal(value.total)
      }).catch(reason => { if (active) setDecisionError((reason as Error).message) })
        .finally(() => { if (active) setLoadingDecisions(false) })
    }, 180)
    return () => { active = false; globalThis.clearTimeout(timer) }
  }, [conversationId, run?.id, run?.status, runId, state, query, offset, decisionReload, visible, enabled])

  const unifiedDecisions: UnifiedDecisionItem[] = useMemo(() => {
    if (!run?.task) return []
    return decisions.map(decision => ({
      stock_code: decision.stock_code,
      state: decision.state,
      conditions: decision.condition_decisions.map(condition => ({
        reference_id: condition.reference_id,
        condition_id: condition.condition_id,
        name: run.task.references.find(item => item.reference_id === condition.reference_id)?.source_quote
          || run.task.conditions.find(item => item.condition_id === condition.condition_id)?.description
          || '筛选条件',
        state: condition.state,
        explanation: condition.explanation,
      })),
    }))
  }, [decisions, run])

  async function copyAllMatching() {
    if (!run || !conversationId) return undefined
    const result = await api<{ items: string[] }>(`/conversations/${conversationId}/screening-runs/${run.id}/codes?state=true&query=${encodeURIComponent(query)}`)
    if (!result.items.length) return '当前搜索范围没有符合项可复制。'
    if (!navigator.clipboard?.writeText) throw new Error('浏览器未开放复制权限，请使用导出按钮。')
    await navigator.clipboard.writeText(result.items.join('\n'))
    return `已复制当前搜索范围全部 ${result.items.length} 只符合条件的股票代码。`
  }

  return {
    runs, run, selection, unifiedDecisions, decisionTotal, loadingRun, runError, loadingDecisions, decisionError,
    selectRun, resetResults, browseDecisions, restorePosition, updateRunList, updateRunStatus, copyAllMatching,
    reloadDecisions: () => setDecisionReload(value => value + 1),
  }
}
