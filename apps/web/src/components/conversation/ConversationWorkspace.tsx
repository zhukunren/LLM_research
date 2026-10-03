import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpRight, Bookmark, ChartNoAxesCombined, Check, FileSearch, GitCompareArrows, LoaderCircle, MessageCircle, Pencil, Play, Plus, RefreshCw, Search, Square, X } from 'lucide-react'
import {
  api,
  type Conversation,
  type ConversationMessage,
  type ConversationScope,
  type ResearchMode,
  type ConversationSourceReference,
  type ConversationTurn,
  type ScreeningTaskDecision,
  type ScreeningTaskRevision,
  type ScreeningTaskRunSummary,
  type SavedScreeningTask,
} from '../../api'
import { useSessionState } from '../../useSessionState'
import { TaskLogic, taskUniverseLabel } from './TaskBrief'
import SavedTaskLibrary from './SavedTaskLibrary'
import ResearchPanel from './ResearchPanel'
import ResearchAnswer from './ResearchAnswer'
import ProjectMembership from './ProjectMembership'
import StockChartDialog from '../StockChartDialog'
import type { DataStatus } from '../../api'
import ScreeningResultView, { type UnifiedDecisionItem } from '../ScreeningResultView'

type SessionSummary = {
  id: string
  entry_scope: ConversationScope
  research_mode?: ResearchMode
  task_revision: number
  active_run_id: string | null
  state: 'active' | 'archived'
  title?: string | null
  last_turn_state?: string
  updated_at: string
}

type TaskRun = {
  id: string
  conversation_id: string
  task_revision: number
  execution_request_id: string
  job_id: string
  as_of: string
  status: string
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
  job: { state: string; progress: number; message: string }
}

type CodexEvent = {
  sequence: number
  method: string
  payload: Record<string, unknown>
}

type PromptSuggestion = { label: string; prompt: string }

const scopeLabels: Record<ConversationScope, string> = {
  screening: '所有资料',
  technical: '行情',
  report: '研报',
  news: '资讯',
  pattern: '形态',
}
const researchModeLabels: Record<ResearchMode, string> = {
  research: '研究模式',
  screening: '筛选模式',
  advanced: '深度研究',
}
const stateLabels: Record<string, string> = {
  awaiting_agent: '等待处理',
  running: '正在处理',
  awaiting_user: '等你补充',
  succeeded: '已完成',
  failed: '处理失败',
  cancelled: '已取消',
  queued: '等待执行',
  partial: '部分结果',
  true: '符合',
  false: '不符合',
  unknown: '数据不足',
  not_evaluated: '未处理',
}
const RUN_PAGE_SIZE = 20
const suggestionIcons = [ChartNoAxesCombined, GitCompareArrows, FileSearch]
const promptSuggestions: Record<ConversationScope, PromptSuggestion[]> = {
  screening: [
    { label: '市场机会', prompt: '最近哪些股票值得进一步研究？请结合走势、成交和已有资料，列出理由与风险。' },
    { label: '公司比较', prompt: '比较贵州茅台和五粮液最近的经营表现、估值与风险，标明数据日期和来源。' },
    { label: '研报证据', prompt: '从已有研报中找出有订单增长实际证据的公司，区分已实现与预测，并列出原文。' },
  ],
  technical: [
    { label: '强势突破', prompt: '筛选收盘价高于20日均线，且近5个交易日涨幅大于3%的股票。' },
    { label: '超跌回升', prompt: '筛选RSI14小于30，且收盘价低于10日均线的股票。' },
    { label: '缩量回调', prompt: '找出处于20日均线上方、近5个交易日缩量回调的股票。' },
  ],
  report: [
    { label: '订单证据', prompt: '找出研报中出现订单增长实际证据的公司，并列出对应原文。' },
    { label: '业绩兑现', prompt: '筛选研报中已出现业绩兑现证据的公司，区分已实现和预测。' },
    { label: '风险提示', prompt: '找出研报明确提示订单或业绩风险的公司。' },
  ],
  news: [
    { label: '业绩预告', prompt: '找出近期资讯中披露业绩预告改善的公司。' },
    { label: '订单动态', prompt: '筛选近期资讯中出现新增订单或订单落地的公司。' },
    { label: '重要催化', prompt: '找出近期有明确业务催化且能定位原始资讯的公司。' },
  ],
  pattern: [
    { label: '突破形态', prompt: '找出近期出现向上突破形态的股票。' },
    { label: '底部反转', prompt: '筛选近期出现底部反转形态的股票。' },
    { label: '趋势延续', prompt: '找出形态显示上升趋势延续的股票。' },
  ],
}

function sessionStorageKey(scope: ConversationScope) {
  return `conversation.active.${scope}`
}

function shortTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function stateClass(state: string) {
  if (state === 'true' || state === 'succeeded') return 'positive'
  if (state === 'false') return 'negative'
  if (state === 'failed' || state === 'cancelled') return 'danger'
  return 'caution'
}

function codexEventLabel(event: CodexEvent): string | null {
  const item = event.payload.item as Record<string, unknown> | undefined
  if (event.method === 'turn/started') return '已开始研究'
  if (event.method === 'item/started' && item?.type === 'mcpToolCall') {
    return '正在查询资料与数据'
  }
  if (event.method === 'item/completed' && item?.type === 'mcpToolCall') {
    return item.status === 'failed' ? '投研工具返回错误，正在调整步骤' : '投研工具已返回结果'
  }
  if (event.method === 'item/started' && item?.type === 'reasoning') return '正在整理研究步骤'
  if (event.method === 'item/started' && item?.type === 'commandExecution') return '正在计算与核对数据'
  if (event.method === 'item/started' && item?.type === 'fileChange') return '正在整理研究成果'
  if (event.method === 'item/agentMessage/delta') return '正在生成研究答复'
  return null
}

const validDrafts = (value: unknown): value is Record<string, string> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string')

export default function ConversationWorkspace({
  data, initialConversationId, initialPrompt, onPromptConsumed,
  initialScope = 'screening',
  onScopeChange,
  initialSource,
  onSourceChange,
  onOpenProject,
}: {
  data?: DataStatus | null
  initialConversationId?: string
  initialPrompt?: string
  onPromptConsumed?: () => void
  initialScope?: ConversationScope
  onScopeChange?: (scope: ConversationScope) => void
  initialSource?: { reference: ConversationSourceReference; label: string } | null
  onSourceChange?: (source: { reference: ConversationSourceReference; label: string } | null) => void
  onOpenProject?: (id: string) => void
}) {
  const [scope, setScope] = useState<ConversationScope>(initialScope)
  const [researchMode, setResearchMode] = useState<ResearchMode>('research')
  const [modeSaving, setModeSaving] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [task, setTask] = useState<ScreeningTaskRevision | null>(null)
  const [runs, setRuns] = useState<ScreeningTaskRunSummary[]>([])
  const [viewingRunId, setViewingRunId] = useState('')
  const [run, setRun] = useState<TaskRun | null>(null)
  const [decisions, setDecisions] = useState<ScreeningTaskDecision[]>([])
  const [decisionState, setDecisionState] = useState('')
  const [decisionQuery, setDecisionQuery] = useState('')
  const [decisionOffset, setDecisionOffset] = useState(0)
  const [decisionTotal, setDecisionTotal] = useState(0)

  const unifiedDecisions: UnifiedDecisionItem[] = useMemo(() => {
    if (!run) return []
    return decisions.map((decision) => ({
      stock_code: decision.stock_code,
      state: decision.state,
      conditions: decision.condition_decisions.map((condition) => ({
        reference_id: condition.reference_id,
        condition_id: condition.condition_id,
        name:
          run.task.references.find((item) => item.reference_id === condition.reference_id)?.source_quote ||
          run.task.conditions.find((item) => item.condition_id === condition.condition_id)?.description ||
          '筛选条件',
        state: condition.state,
        explanation: condition.explanation,
      })),
    }))
  }, [decisions, run])
  const [drafts, setDrafts] = useSessionState<Record<string, string>>('conversation.drafts', {}, validDrafts)
  const draftKey = `${scope}:${selectedId || 'new'}`
  const draft = drafts[draftKey] ?? ''
  function setDraft(value: string) { setDrafts(current => ({ ...current, [draftKey]: value })) }
  const [libraryTab, setLibraryTab] = useState<'recent' | 'saved'>('recent')
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessionQuery, setSessionQuery] = useState('')
  const [sessionReload, setSessionReload] = useState(0)
  const [sessionError, setSessionError] = useState('')
  const [notice, setNotice] = useState('')
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)
  const [savingNote, setSavingNote] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [decisionError, setDecisionError] = useState('')
  const [decisionReload, setDecisionReload] = useState(0)
  const [pendingSource, setPendingSource] = useState(initialSource ?? null)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [codexProgress, setCodexProgress] = useState('')
  const [hasResearchResults, setHasResearchResults] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(true)
  const [loadingConversation, setLoadingConversation] = useState(false)
  const [loadingRun, setLoadingRun] = useState(false)
  const [loadingDecisions, setLoadingDecisions] = useState(false)
  const [error, setError] = useState('')
  const [refreshIndex, setRefreshIndex] = useState(0)
  const [showLatest, setShowLatest] = useState(false)
  const [watchlists, setWatchlists] = useState<{ id: string; name: string }[]>([])
  const [scopePool, setScopePool] = useState('all')
  const [scopeDate, setScopeDate] = useState(data?.last_date ?? '')
  const [scopeCustomized, setScopeCustomized] = useState(false)
  const [scopeEdited, setScopeEdited] = useState(false)
  const [scopeSaveState, setScopeSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [chart, setChart] = useState<{ code: string; date: string } | null>(null)
  const scopeAttempt = useRef<{ key: string; id: string } | null>(null)
  const buttonAttempt = useRef<{ key: string; id: string } | null>(null)
  const scopeReadyKey = useRef('')
  const scopeSavingRef = useRef(false)
  const modeChosenRef = useRef(false)
  const selectedIdRef = useRef('')
  const initialSelectionRef = useRef<{ loaded: boolean; id?: string }>({ loaded: false })
  const freshConversationRef = useRef(false)
  const messageListRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const followLatestRef = useRef(true)
  const saveAttemptRef = useRef<{ taskKey: string; assetId: string; requestId: string } | null>(null)
  const reuseAttemptRef = useRef<{ key: string; conversation?: Conversation; messageId?: string; clientId: string } | null>(null)
  const executionAttempts = useRef(new Map<string, Promise<{ run_id: string }>>())

  useEffect(() => {
    let active = true
    api<{ default_mode: ResearchMode }>('/conversations/research-modes').then(result => {
      if (active && !modeChosenRef.current && !selectedIdRef.current && result.default_mode in researchModeLabels) setResearchMode(result.default_mode)
    }).catch(() => {})
    return () => { active = false }
  }, [])

  useEffect(() => {
    api<{ items: { id: string; name: string }[] }>('/watchlists')
      .then((res) => setWatchlists(res.items || []))
      .catch(() => {})
  }, [refreshIndex])

  useEffect(() => { if (!scopeDate && data?.last_date) setScopeDate(data.last_date) }, [data?.last_date, scopeDate])
  useEffect(() => { setHasResearchResults(false) }, [selectedId])
  useEffect(() => {
    if (!loadingSessions && initialPrompt) { createConversation(); setDrafts(current => ({ ...current, [`${scope}:new`]: initialPrompt })); setSource(initialSource ?? null); onPromptConsumed?.() }
  }, [loadingSessions, initialPrompt])
  useEffect(() => {
    if (!task) return
    setScopeDate(task.scope.as_of || data?.last_date || '')
    setScopePool(task.scope.universe?.kind === 'watchlist' ? task.scope.universe.watchlist_id || 'all' : task.scope.universe?.kind === 'explicit' ? 'explicit' : 'all')
    const nextKey = `${conversation?.id || ''}:${task.revision}`
    if (!scopeReadyKey.current.startsWith(`${conversation?.id || ''}:`)) setScopeSaveState('idle')
    scopeReadyKey.current = nextKey
    setScopeEdited(false)
  }, [task?.revision, task?.task_id, conversation?.id])

  async function applyScope() {
    if (!conversation || !task || !scopeDate || scopeSavingRef.current || busy || saving || turnInProgress) return
    const universe = scopePool === 'all' ? { kind: 'all_a_shares', stock_codes: [] } : scopePool === 'explicit' ? task.scope.universe : { kind: 'watchlist', watchlist_id: scopePool, stock_codes: [] }
    const key = JSON.stringify([conversation.id, task.revision, universe, scopeDate])
    if (scopeAttempt.current?.key !== key) scopeAttempt.current = { key, id: crypto.randomUUID() }
    scopeSavingRef.current = true
    setScopeSaveState('saving'); setError('')
    try {
      await api(`/conversations/${conversation.id}/scope`, { method: 'POST', body: JSON.stringify({ base_revision: task.revision, client_message_id: scopeAttempt.current.id, universe, as_of: scopeDate }) })
      await reloadConversation(conversation.id)
      if (selectedIdRef.current === conversation.id) {
        scopeAttempt.current = null
        setScopeSaveState('saved')
      }
    } catch (reason) {
      if (selectedIdRef.current === conversation.id) { setScopeSaveState('error'); setError((reason as Error).message) }
    }
    finally { scopeSavingRef.current = false }
  }

  async function copyAllMatching() {
    if (!run || !conversation) return
    try {
      const result = await api<{ items: string[] }>(`/conversations/${conversation.id}/screening-runs/${run.id}/codes?state=true&query=${encodeURIComponent(decisionQuery)}`)
      if (!result.items.length) { setNotice('当前搜索范围没有符合项可复制。'); return }
      if (!navigator.clipboard?.writeText) throw new Error('浏览器未开放复制权限，请使用导出按钮。')
      await navigator.clipboard.writeText(result.items.join('\n'))
      setNotice(`已复制全部 ${result.items.length} 只符合条件的股票代码。`)
    } catch (reason) { setError((reason as Error).message) }
  }

  function selectConversation(id: string) {
    freshConversationRef.current = !id
    selectedIdRef.current = id
    setScopeEdited(false)
    setScopeSaveState('idle')
    scopeAttempt.current = null
    setSelectedId(id)
  }

  function setSource(source: { reference: ConversationSourceReference; label: string } | null) {
    setPendingSource(source)
    onSourceChange?.(source)
  }

  function focusComposer() {
    composerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
    globalThis.setTimeout(() => textareaRef.current?.focus(), 0)
  }

  function prepareDraft(value: string) {
    setDraft(value)
    focusComposer()
  }

  function scrollToLatest(behavior: ScrollBehavior = 'smooth') {
    const list = messageListRef.current
    if (!list) return
    followLatestRef.current = true
    list.scrollTo?.({ top: list.scrollHeight, behavior })
    setShowLatest(false)
  }

  function onMessageListScroll() {
    const list = messageListRef.current
    if (!list) return
    const nearLatest = list.scrollHeight - list.scrollTop - list.clientHeight < 48
    followLatestRef.current = nearLatest
    if (nearLatest) setShowLatest(false)
  }

  async function reloadConversation(conversationId: string, accept = () => true) {
    const next = await api<Conversation>(`/conversations/${conversationId}`)
    const [nextTask, runList] = await Promise.all([
      next.task_revision > 0
        ? api<ScreeningTaskRevision>(`/conversations/${conversationId}/revisions/${next.task_revision}`)
        : Promise.resolve(null),
      api<{ items: ScreeningTaskRunSummary[] }>(`/conversations/${conversationId}/screening-runs`),
    ])
    if (!accept() || selectedIdRef.current !== conversationId) return next
    setConversation(next)
    setResearchMode(next.research_mode || 'research')
    setTask(nextTask)
    setRuns(runList.items)
    setViewingRunId((current) => (
      current && runList.items.some((item) => item.id === current)
        ? current
        : next.active_run_id ?? runList.items[0]?.id ?? ''
    ))
    setSessions((current) => current.map((item) => item.id === next.id ? {
      ...item,
      title: next.messages.find((message) => message.role === 'user')?.content.slice(0, 120) ?? item.title,
      task_revision: next.task_revision,
      last_turn_state: next.turns.find(turn => turn.user_message_id === next.messages.filter(message => message.role === 'user').at(-1)?.id)?.state,
      active_run_id: next.active_run_id,
      updated_at: next.updated_at,
    } : item).sort((left, right) => right.updated_at.localeCompare(left.updated_at)))
    return next
  }

  async function enqueueAuthorizedTurn(conversationId: string, turnId: string, action: 'message' | 'button' = 'message') {
    const key = `${conversationId}:${turnId}:${action}`
    let request = executionAttempts.current.get(key)
    if (!request) {
      const requestId = buttonAttempt.current?.id
      request = api<{ run_id: string }>(`/conversations/${conversationId}/turns/${turnId}/execute`, {
        method: 'POST',
        body: JSON.stringify({ action, ...(action === 'button' && task ? { revision: task.revision, request_id: requestId } : {}) }),
      })
      executionAttempts.current.set(key, request)
    }
    const queued = await request
    if (selectedIdRef.current === conversationId) setViewingRunId(queued.run_id)
  }

  async function processTurn(conversationId: string, turnId: string) {
    setBusy(true)
    setError('')
    setCodexProgress('')
    try {
      await reloadConversation(conversationId)
      const turn = await api<ConversationTurn>(`/conversations/${conversationId}/turns/${turnId}/process`, { method: 'POST' })
      if (turn.result.ready_to_execute) {
        await enqueueAuthorizedTurn(conversationId, turnId)
      }
      await reloadConversation(conversationId)
      setRefreshIndex((value) => value + 1)
    } catch (reason) {
      setError((reason as Error).message)
      try { await reloadConversation(conversationId) } catch { /* Keep the original request error visible. */ }
    } finally {
      setCodexProgress('')
      setBusy(false)
    }
  }

  async function stopTurn() {
    if (!selectedId || !activeTurnId) return
    setStopping(true)
    try {
      await api(`/conversations/${selectedId}/turns/${activeTurnId}/cancel`, { method: 'POST' })
      await reloadConversation(selectedId)
      setRefreshIndex(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setStopping(false) }
  }

  useEffect(() => {
    if (initialScope === scope) return
    selectedIdRef.current = ''
    setScope(initialScope)
    setSelectedId('')
    setConversation(null)
    setTask(null)
    setRun(null)
    setRuns([])
    setViewingRunId('')
    setError('')
  }, [initialScope])

  useEffect(() => {
    setPendingSource(initialSource ?? null)
  }, [initialSource])

  useEffect(() => {
    let active = true
    const requested = !initialSelectionRef.current.loaded || initialSelectionRef.current.id !== initialConversationId ? initialConversationId : undefined
    const remainFresh = freshConversationRef.current && !requested
    const stored = requested || selectedIdRef.current || localStorage.getItem(sessionStorageKey(scope))
    setLoadingSessions(true)
    setSessionError('')
    setSessions([])
    setConversation(null)
    setTask(null)
    setRuns([])
    setRun(null)
    setViewingRunId('')
    selectedIdRef.current = ''
    api<{ items: SessionSummary[] }>(`/conversations?scope=${scope}&limit=50`)
      .then(async ({ items }) => {
        if (!active) return
        if (requested && !items.some(item => item.id === requested)) {
          const historical = await api<Conversation>(`/conversations/${requested}`)
          if (!active) return
          items = [{ ...historical, title: historical.messages.find(item => item.role === 'user')?.content.slice(0, 120) }, ...items]
        }
        setSessions(items)
        initialSelectionRef.current = { loaded: true, id: initialConversationId }
        const preferred = remainFresh ? '' : items.some((item) => item.id === stored)
          ? stored!
          : items[0]?.id ?? ''
        selectConversation(preferred)
      })
      .catch((reason) => { if (active) setSessionError((reason as Error).message) })
      .finally(() => { if (active) setLoadingSessions(false) })
    return () => { active = false }
  }, [scope, sessionReload, initialConversationId])

  useEffect(() => {
    if (selectedId) localStorage.setItem(sessionStorageKey(scope), selectedId)
    else localStorage.removeItem(sessionStorageKey(scope))
  }, [scope, selectedId])

  useEffect(() => {
    if (!selectedId || !sessions.some((item) => item.id === selectedId)) return
    let active = true
    setLoadingConversation(true)
    reloadConversation(selectedId)
      .catch((reason) => { if (active) setError((reason as Error).message) })
      .finally(() => { if (active) setLoadingConversation(false) })
    return () => { active = false }
  }, [selectedId, sessions.length, refreshIndex])

  const activeTurnId = conversation?.id === selectedId
    ? conversation.turns.find(turn => ['awaiting_agent', 'running'].includes(turn.state))?.id
    : undefined
  useEffect(() => {
    setCodexProgress('')
    if (!selectedId || !activeTurnId) return
    let active = true
    let polling = false
    let eventCursor = -1
    const poll = async () => {
      if (polling || !active) return
      polling = true
      try {
        await reloadConversation(selectedId, () => active)
      } catch (reason) {
        if (active) setError((reason as Error).message)
      }
      try {
        const events = await api<{ items: CodexEvent[]; next_after: number }>(
          `/conversations/${selectedId}/turns/${activeTurnId}/codex-events?after=${eventCursor}&limit=100`,
        )
        if (active && selectedIdRef.current === selectedId) {
          for (const event of events.items) {
            const label = codexEventLabel(event)
            if (label) setCodexProgress(label)
          }
          eventCursor = events.next_after
        }
      } catch { /* Conversation polling still delivers completion when events are unavailable. */ }
      finally { polling = false }
    }
    void poll()
    const timer = globalThis.setInterval(() => { void poll() }, 1200)
    return () => { active = false; globalThis.clearInterval(timer) }
  }, [selectedId, activeTurnId])

  const readyTurnId = conversation?.id === selectedId && conversation.pending_execution && !activeTurnId
    ? conversation.turns.find(turn => turn.state === 'succeeded' && turn.result.ready_to_execute
      && turn.result.execution_authorized && turn.result.task_revision === conversation.task_revision)?.id
    : undefined
  useEffect(() => {
    if (!selectedId || !readyTurnId) return
    let active = true
    // Resume the already-authorized action after a reload or lost process response.
    enqueueAuthorizedTurn(selectedId, readyTurnId, 'message')
      .then(() => { if (active) return reloadConversation(selectedId, () => active) })
      .catch(reason => { if (active) setError((reason as Error).message) })
    return () => { active = false }
  }, [selectedId, readyTurnId])

  useEffect(() => {
    followLatestRef.current = true
    setShowLatest(false)
  }, [selectedId])

  useEffect(() => {
    if (!conversation || !viewingRunId) {
      setRun(null)
      setDecisions([])
      setDecisionTotal(0)
      return
    }
    let active = true
    let pending = false
    let completed = false
    let timer = 0
    setRun(null)
    const load = async () => {
      if (pending || completed) return
      pending = true
      try {
        const next = await api<TaskRun>(`/conversations/${conversation.id}/screening-runs/${viewingRunId}`)
        if (active) {
          setRun(next)
          setRuns(items => items.map(item => item.id === next.id ? { ...item, status: next.status } : item))
          completed = !['queued', 'running'].includes(next.status)
          if (completed) globalThis.clearInterval(timer)
        }
      } catch (reason) {
        if (active) setError((reason as Error).message)
      } finally {
        pending = false
        if (active) setLoadingRun(false)
      }
    }
    setLoadingRun(true)
    void load()
    timer = globalThis.setInterval(() => { void load() }, 1500)
    return () => { active = false; globalThis.clearInterval(timer) }
  }, [conversation?.id, viewingRunId, refreshIndex])

  useEffect(() => { setDecisionOffset(0); setDecisionQuery(''); setDecisionState(''); setDecisionError('') }, [viewingRunId])
  useEffect(() => { setSaveOpen(false); setNotice('') }, [selectedId, task?.revision])

  useEffect(() => {
    if (!conversation || !run || run.id !== viewingRunId || ['queued', 'running'].includes(run.status)) {
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
    const params = new URLSearchParams({
      state: decisionState,
      query: decisionQuery,
      offset: String(decisionOffset),
      limit: String(RUN_PAGE_SIZE),
    })
    const timer = globalThis.setTimeout(() => {
      api<{ items: ScreeningTaskDecision[]; total: number }>(
        `/conversations/${conversation.id}/screening-runs/${run.id}/decisions?${params.toString()}`,
      ).then((value) => {
        if (active) { setDecisions(value.items); setDecisionTotal(value.total) }
      }).catch((reason) => { if (active) setDecisionError((reason as Error).message) }).finally(() => { if (active) setLoadingDecisions(false) })
    }, 180)
    return () => { active = false; globalThis.clearTimeout(timer) }
  }, [conversation?.id, run?.id, run?.status, decisionState, decisionQuery, decisionOffset, decisionReload])

  const turnsByMessage = useMemo(() => new Map(
    (conversation?.turns ?? []).map((turn) => [turn.user_message_id, turn]),
  ), [conversation?.turns])
  const turnInProgress = conversation?.turns.some((turn) => ['awaiting_agent', 'running'].includes(turn.state)) ?? false
  const messageCount = conversation?.messages.length ?? 0

  useEffect(() => {
    if (!messageListRef.current) return
    if (followLatestRef.current) scrollToLatest('auto')
    else if (messageCount) setShowLatest(true)
  }, [conversation?.id, messageCount])

  function changeScope(next: ConversationScope) {
    if (busy || modeSaving || scopeSavingRef.current || next === scope) return
    setScope(next)
    setSelectedId('')
    setConversation(null)
    setTask(null)
    setRun(null)
    setRuns([])
    setViewingRunId('')
    selectedIdRef.current = ''
    setSource(null)
    setError('')
    onScopeChange?.(next)
  }

  async function changeResearchMode(next: ResearchMode) {
    if (busy || saving || modeSaving || turnInProgress || next === researchMode) return
    modeChosenRef.current = true
    if (!conversation) { setResearchMode(next); return }
    setModeSaving(true)
    try {
      await api(`/conversations/${conversation.id}/mode`, { method: 'PATCH', body: JSON.stringify({ research_mode: next }) })
      if (selectedIdRef.current === conversation.id) {
        setResearchMode(next)
        setConversation(current => current?.id === conversation.id ? { ...current, research_mode: next } : current)
        setNotice(`已切换为${researchModeLabels[next]}。`)
      }
    } catch (reason) {
      setError((reason as Error).message)
    } finally { setModeSaving(false) }
  }

  function createConversation() {
    if (busy || modeSaving || scopeSavingRef.current) return
    setScopePool('all'); setScopeDate(data?.last_date ?? ''); setScopeCustomized(false)
    selectConversation('')
    setError('')
    setConversation(null)
    setTask(null)
    setRuns([])
    setRun(null)
    setViewingRunId('')
    setLoadingConversation(false)
    setLibraryTab('recent')
    setSource(null)
    focusComposer()
  }

  async function saveTask(name = saveName) {
    if (!task || !conversation || !name.trim() || busy || saving || scopeSavingRef.current || scopeDirty) return
    const taskKey = `${conversation.id}:${task.revision}:${name.trim()}`
    if (saveAttemptRef.current?.taskKey !== taskKey) saveAttemptRef.current = { taskKey, assetId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    setSaving(true)
    setError('')
    try {
      const saved = await api<SavedScreeningTask>(`/conversations/${conversation.id}/saved-screening-tasks`, {
        method: 'POST', body: JSON.stringify({ name: name.trim(), revision: task.revision, asset_id: saveAttemptRef.current.assetId, request_id: saveAttemptRef.current.requestId }),
      })
      setSaveOpen(false)
      setNotice(`已保存“${saved.name}”，可在左侧“已保存方案”中复用。`)
      setLibraryTab('recent')
    } catch (reason) { setError((reason as Error).message) }
    finally { setSaving(false) }
  }

  async function reuseTask(saved: SavedScreeningTask, useLatest = false) {
    if (busy || saving || modeSaving || scopeSavingRef.current) return
    const reuseDate = useLatest ? data?.last_date : undefined
    const key = `${scope}:${saved.id}:${saved.version}:${reuseDate || 'original'}`
    if (reuseAttemptRef.current?.key !== key) reuseAttemptRef.current = { key, clientId: crypto.randomUUID() }
    const attempt = reuseAttemptRef.current
    setBusy(true)
    setError('')
    try {
      if (!attempt.conversation) attempt.conversation = await api<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ entry_scope: scope, research_mode: researchMode }) })
      const current = attempt.conversation
      if (!attempt.messageId) {
        const message = await api<{ message_id: string }>(`/conversations/${current.id}/messages`, {
          method: 'POST', body: JSON.stringify({ client_message_id: attempt.clientId, base_revision: 0, content: `复用已保存方案“${saved.name}”（第${saved.version}版）${reuseDate ? `，采用${reuseDate}的行情` : '，保留原截止日'}` }),
        })
        attempt.messageId = message.message_id
      }
      await api(`/conversations/${current.id}/saved-screening-tasks/${saved.id}/reuse`, {
        method: 'POST', body: JSON.stringify({ base_revision: 0, source_message_id: attempt.messageId, version: saved.version, ...(reuseDate ? { as_of: reuseDate } : {}) }),
      })
      const { items } = await api<{ items: SessionSummary[] }>(`/conversations?scope=${scope}&limit=50`)
      setSessions(items)
      selectConversation(current.id)
      setConversation(null)
      setTask(null)
      setRun(null)
      setRuns([])
      setViewingRunId('')
      setSource(null)
      setLibraryTab('recent')
      await reloadConversation(current.id)
      reuseAttemptRef.current = null
      focusComposer()
    } catch (reason) { setError(`复用未完成：${(reason as Error).message} 可再次点击复用以继续。`) }
    finally { setBusy(false) }
  }

  async function submitMessage(value = draft) {
    let content = value.trim()
    if (!content) return
    if (!task && scopeCustomized) {
      const additions = []
      if (!/全[部市场]*A股|全市场|股票池|自选|观察池|\d{6}|范围/.test(content)) additions.push(scopePool === 'all' ? '范围为全部A股' : `范围为自选分组“${watchlists.find(item => item.id === scopePool)?.name || ''}”`)
      if (!/20\d{2}[-年/]\d{1,2}|截至|截止/.test(content) && scopeDate) additions.push(`截止日期为${scopeDate}`)
      if (additions.length) content += '\n' + additions.join('，') + '。'
    }
    if (!content || busy || saving || modeSaving || scopeSavingRef.current || (scopeEdited && scopeDirty) || turnInProgress || loadingConversation || loadingSessions) return
    setBusy(true)
    setError('')
    followLatestRef.current = true
    let conversationId = conversation?.id ?? ''
    try {
      let current = conversation
      if (!current) {
        current = await api<Conversation>('/conversations', {
          method: 'POST',
          body: JSON.stringify({ entry_scope: scope, research_mode: researchMode }),
        })
        conversationId = current.id
        setSessions((items) => [{
          id: current!.id,
          entry_scope: current!.entry_scope,
          task_revision: 0,
          active_run_id: null,
          state: 'active',
          title: null,
          updated_at: current!.updated_at,
        }, ...items])
        selectConversation(current.id)
        setConversation({ ...current, messages: [], turns: [], pending_execution: false })
      }
      const messageResult = await api<{
        message_id: string
        turn_id: string
        base_revision: number
        state: string
        source_refs?: Record<string, unknown>[]
      }>(`/conversations/${current.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          client_message_id: crypto.randomUUID(),
          base_revision: current.task_revision,
          content,
          source_refs: pendingSource ? [pendingSource.reference] : [],
        }),
      })
      const optimisticMessage: ConversationMessage = {
        id: messageResult.message_id,
        role: 'user',
        content,
        source_refs: messageResult.source_refs ?? [],
        created_at: new Date().toISOString(),
      }
      setConversation((old) => old && old.id === current!.id
        ? { ...old, messages: [...old.messages, optimisticMessage] }
        : old)
      setDraft('')
      setSource(null)
      await processTurn(current.id, messageResult.turn_id)
    } catch (reason) {
      setError((reason as Error).message)
      if (conversationId) {
        try { await reloadConversation(conversationId) } catch { /* Keep the original request error visible. */ }
      }
    } finally {
      setBusy(false)
    }
  }

  async function cancelRun() {
    if (!run) return
    setBusy(true)
    setError('')
    try {
      await api(`/jobs/${run.job_id}/cancel`, { method: 'POST' })
      setRefreshIndex((value) => value + 1)
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
      executionAttempts.current.delete(`${conversation.id}:${turnId}:message`)
      await enqueueAuthorizedTurn(conversation.id, turnId)
      setRefreshIndex((value) => value + 1)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submitMessage()
    }
  }

  const activeRun = conversation?.active_run_id === viewingRunId
  const coverage = run?.result.coverage
  const pendingTurn = conversation?.pending_execution
    ? conversation.turns.find((turn) => turn.state === 'succeeded' && turn.result.ready_to_execute && turn.result.execution_authorized)
    : undefined
  const canSave = !!task?.conditions.length && !!task.references.length && !!task.logic_tree && !!task.scope.universe && !task.unresolved.length
  const scopeDirty = !!task && (!task.scope.universe || scopeDate !== task.scope.as_of || scopePool !== (task.scope.universe?.kind === 'watchlist' ? task.scope.universe.watchlist_id : task.scope.universe?.kind === 'explicit' ? 'explicit' : 'all'))
  const canExecute = canSave && !!task?.scope.as_of && !scopeDirty
  const runInProgress = runs.some(item => ['queued', 'running'].includes(item.status))
  const taskHasRun = !!run && run.task_revision === task?.revision
  const filteredSessions = sessions.filter(item => (item.title ?? '').toLowerCase().includes(sessionQuery.trim().toLowerCase()))
  const missingTaskInfo = task ? [!task.conditions.length || !task.logic_tree ? '筛选条件' : '', !task.scope.universe ? '股票范围' : '', !task.scope.as_of ? '截止日' : ''].filter(Boolean).join('、') : ''
  const showTaskPanel = !!task || !!runs.length || !!pendingTurn || hasResearchResults
  const suggestedName = task?.conditions.map(item => item.description).join('；').slice(0, 120) || '研究方案'

  useEffect(() => {
    if (!conversation || !task || !scopeEdited || !scopeDate || !scopeDirty || turnInProgress || loadingConversation || busy || saving || scopeSaveState === 'error' || scopeSaveState === 'saving') return
    if (scopeReadyKey.current !== `${conversation.id}:${task.revision}`) return
    const timer = globalThis.setTimeout(() => { void applyScope() }, 400)
    return () => globalThis.clearTimeout(timer)
  }, [conversation?.id, task?.revision, scopeDate, scopePool, scopeEdited, scopeDirty, turnInProgress, loadingConversation, busy, saving, scopeSaveState])

  const executableTurn = canExecute && conversation
    ? conversation.turns[0]?.state === 'succeeded' ? conversation.turns[0] : undefined
    : undefined
  async function startScreening() {
    if (busy || saving || !conversation || !executableTurn) return
    setBusy(true); setError('')
    try {
      const attemptKey = `${conversation.id}:${task?.revision || 0}:${executableTurn.id}`
      if (buttonAttempt.current?.key !== attemptKey) buttonAttempt.current = { key: attemptKey, id: crypto.randomUUID() }
      executionAttempts.current.delete(`${conversation.id}:${executableTurn.id}:button`)
      await enqueueAuthorizedTurn(conversation.id, executableTurn.id, 'button')
      buttonAttempt.current = null
      await reloadConversation(conversation.id)
      setRefreshIndex(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }

  async function saveResearchAnswer(messageId: string) {
    if (!conversation?.project_id || savingNote) return
    setSavingNote(messageId); setError('')
    try {
      await api(`/research-projects/${conversation.project_id}/notes/from-message`, {
        method: 'POST', body: JSON.stringify({ message_id: messageId }),
      })
      setNotice('答复已保存为研究笔记，可在研究中心补充验证事项和失效条件。')
    } catch (reason) { setError((reason as Error).message) }
    finally { setSavingNote('') }
  }

  return (
    <div className="conversation-product">
      <div className="page-heading conversation-header-heading">
        <div className="conversation-heading-title">
          <h1>投研助手</h1>
          <span className="conversation-session-caption">{sessions.find(item => item.id === selectedId)?.title || '新研究'}</span>
        </div>
        <div className="conversation-heading-actions"><button className="session-disclosure secondary-button" aria-expanded={sessionsOpen} aria-controls="screening-sessions" onClick={() => setSessionsOpen(value => !value)}><MessageCircle size={15} />{sessionsOpen ? '收起对话与方案' : '对话与方案'}</button><button className="secondary-button conversation-new" aria-label="新研究" title="新研究" disabled={busy || saving || loadingSessions} onClick={createConversation}><Plus size={15} /><span>新研究</span></button></div>
      </div>
      {conversation && <ProjectMembership conversationId={conversation.id} projectId={conversation.project_id} disabled={busy || saving || turnInProgress} onChange={projectId => setConversation(current => current?.id === conversation.id ? { ...current, project_id: projectId } : current)} onError={setError} onOpenProject={onOpenProject} />}
      <div className={`conversation-workspace ${showTaskPanel ? '' : 'conversation-workspace-start'} ${!conversation?.messages.length && !task ? 'conversation-workspace-empty' : ''}`}>
      <aside id="screening-sessions" className={`conversation-sessions ${sessionsOpen ? 'sessions-open' : ''}`} aria-label="对话列表">
        <div className="conversation-panel-heading">
          <h2>对话与方案</h2>
          <button className="secondary-button compact" aria-label="开始新对话" title="开始新对话" disabled={busy || saving || loadingSessions} onClick={createConversation}>
            <Plus size={14} /><span className="session-new-label">新建</span>
          </button>
        </div>
        <label className="conversation-scope-select">
          <span>对话分类</span>
          <select aria-label="对话范围" value={scope} disabled={busy || saving || loadingSessions} onChange={(event) => changeScope(event.target.value as ConversationScope)}>
            {Object.entries(scopeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <div className="conversation-library-tabs" aria-label="筛选资料">
          <button type="button" aria-pressed={libraryTab === 'recent'} onClick={() => setLibraryTab('recent')}>最近对话</button>
          <button type="button" aria-pressed={libraryTab === 'saved'} onClick={() => setLibraryTab('saved')}>已保存方案</button>
        </div>
        {libraryTab === 'saved' ? <SavedTaskLibrary latestDate={data?.last_date} scope={scope} busy={busy || saving} refreshKey={`${refreshIndex}:${conversation?.turns[0]?.state}`} onReuse={(saved, latest) => void reuseTask(saved, latest)} /> : <>
        {!!sessions.length && <label className="conversation-search"><Search size={14} /><input aria-label="搜索最近对话" placeholder="搜索最近对话" value={sessionQuery} onChange={event => setSessionQuery(event.target.value)} /></label>}
        {loadingSessions ? <p className="conversation-muted">正在载入对话…</p> : sessionError ? <div className="saved-task-empty" role="alert"><p>{sessionError}</p><button className="secondary-button compact" onClick={() => setSessionReload(value => value + 1)}>重新加载对话</button></div> : !sessions.length ? <p className="conversation-muted">暂无对话</p> : !filteredSessions.length ? <div className="saved-task-empty"><p>没有找到匹配的对话</p><button className="text-button" onClick={() => setSessionQuery('')}>清除搜索</button></div> : (
          <div className="conversation-session-list">
            {filteredSessions.map((item) => (
              <button
                key={item.id}
                className={`conversation-session-row ${selectedId === item.id ? 'selected' : ''}`}
                disabled={busy || saving}
                aria-current={selectedId === item.id ? 'true' : undefined}
                onClick={() => { if (item.id === selectedId && conversation) return; selectConversation(item.id); setConversation(null); setTask(null); setRuns([]); setRun(null); setError(''); setRefreshIndex(value => value + 1) }}
              >
                <strong>{item.title?.trim() || '新对话'}</strong>
                <span>{item.last_turn_state === 'failed' ? '研究中断' : item.last_turn_state === 'running' ? '正在研究' : item.task_revision ? `方案第${item.task_revision}版` : '研究对话'} · {shortTime(item.updated_at)}</span>
              </button>
            ))}
          </div>
        )}
        </>}
      </aside>

      <section className="conversation-main" aria-label="筛选对话">
        {error && <div className="conversation-error" role="alert"><AlertCircle size={17} /><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>}
        {notice && <div className="conversation-notice" role="status"><Check size={16} /><span>{notice}</span><button className="icon-button" aria-label="关闭保存提示" onClick={() => setNotice('')}><X size={15} /></button></div>}
        {loadingConversation && <div className="conversation-loading"><LoaderCircle size={16} className="spin" />正在恢复对话…</div>}
        <div className="conversation-message-stage">
          <div className="conversation-message-list" ref={messageListRef} role="log" aria-live="polite" aria-relevant="additions" onScroll={onMessageListScroll}>
            {!conversation?.messages.length && !task && !loadingConversation && (
              <div className="conversation-empty">
                <MessageCircle size={22} />
                <strong>今天想研究什么？</strong>
                <div className="conversation-suggestions" aria-label="常用研究问题">
                  {promptSuggestions[scope].map((item, index) => { const Icon = suggestionIcons[index % suggestionIcons.length]; return <button type="button" key={item.label} aria-label={item.label} disabled={busy || saving || loadingConversation || loadingSessions} onClick={() => prepareDraft(item.prompt)}><span className="suggestion-icon"><Icon size={20} strokeWidth={1.6} /></span><span className="suggestion-copy"><span className="suggestion-title">{item.label}</span><span className="suggestion-description">{item.prompt}</span></span><ArrowUpRight size={16} className="suggestion-arrow" /></button> })}
                </div>
              </div>
            )}
            {conversation?.messages.map((message) => {
            const turn = turnsByMessage.get(message.id)
            return (
              <article className={`conversation-message ${message.role}`} key={message.id}>
                <div className="conversation-message-meta">
                  <strong>{message.role === 'user' ? '你' : message.role === 'assistant' ? '投研助手' : '工具'}</strong>
                  <time>{shortTime(message.created_at)}</time>
                  {turn && <span className={`conversation-turn-state ${stateClass(turn.state)}`}>{stateLabels[turn.state] ?? turn.state}</span>}
                </div>
                {message.role === 'assistant' ? <ResearchAnswer content={message.content} conversationId={conversation.id} /> : <p className="conversation-plain-message">{message.content}</p>}
                {message.role === 'assistant' && conversation.project_id && <button type="button" className="text-button research-save-answer" disabled={!!savingNote} onClick={() => void saveResearchAnswer(message.id)}><Bookmark size={14} />{savingNote === message.id ? '正在保存…' : '保存为研究笔记'}</button>}
                {!!message.source_refs.length && <div className="conversation-source-refs">{message.source_refs.map((ref, index) => <span key={`${String(ref.source_id)}-${index}`}>{ref.kind === 'report_page' ? `${String(ref.title ?? '研报')} · 第 ${String(ref.page_number ?? '?')} 页` : String(ref.title ?? ref.source_id)}</span>)}</div>}
                {turn?.state === 'failed' && conversation.messages.filter(item => item.role === 'user').at(-1)?.id === message.id && <button className="secondary-button compact" disabled={busy || turnInProgress} onClick={() => void submitMessage(message.content)}>重新处理</button>}{turn?.state === 'awaiting_agent' && !turn.job && <button className="secondary-button compact" disabled={busy} onClick={() => void processTurn(conversation.id, turn.id)}><Play size={14} />继续处理</button>}
              </article>
            )
            })}
            {turnInProgress && <div className="conversation-loading"><LoaderCircle size={16} className="spin" />{codexProgress || (conversation?.turns.some(turn => turn.state === 'running') ? '正在研究' : '等待开始研究')}<button type="button" className="icon-button" aria-label="停止当前研究" title="停止当前研究" disabled={stopping} onClick={() => void stopTurn()}><Square size={14} /></button></div>}
          </div>
          {showLatest && <button type="button" className="conversation-latest-button" onClick={() => scrollToLatest()}><ArrowDown size={14} />查看最新</button>}
        </div>
        <form className="conversation-composer" ref={composerRef} onSubmit={(event) => { event.preventDefault(); void submitMessage() }}>
          {!task && data?.last_date && <details className="default-scope-details"><summary>研究范围：{scopePool === 'all' ? '全部A股' : watchlists.find(item => item.id === scopePool)?.name || '所选观察池'} · 行情截至 {scopeDate || data.last_date}<span>修改</span></summary><div className="scope-picker"><label>股票范围<select aria-label="默认股票范围" disabled={busy || loadingConversation || loadingSessions} value={scopePool} onChange={event => { setScopePool(event.target.value); setScopeCustomized(true) }}><option value="all">全部A股</option>{watchlists.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>行情日期<input aria-label="默认行情日期" disabled={busy || loadingConversation || loadingSessions} type="date" max={data.last_date} value={scopeDate} onChange={event => { setScopeDate(event.target.value); setScopeCustomized(true) }} /></label></div></details>}
          <label htmlFor="conversation-input">研究要求</label>
          {pendingSource && <div className="conversation-pending-source"><span>{pendingSource.label}</span><button type="button" className="icon-button" aria-label="移除来源页" onClick={() => setSource(null)}><X size={14} /></button></div>}
            <textarea
            id="conversation-input"
            aria-label="研究要求"
            ref={textareaRef}
            value={draft}
            maxLength={8000}
            disabled={busy || saving || turnInProgress || loadingConversation || loadingSessions}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="告诉我想研究的公司、资料或假设，例如：比较这两家公司的订单兑现质量"
          />
          <div className="conversation-composer-footer">
            <div className="conversation-mode-control" role="group" aria-label="研究模式选择">{Object.entries(researchModeLabels).map(([value, label]) => <button key={value} type="button" aria-label={label} title={label} aria-pressed={researchMode === value} disabled={busy || saving || modeSaving || turnInProgress || loadingConversation || loadingSessions} onClick={() => void changeResearchMode(value as ResearchMode)}>{label.replace('模式', '')}</button>)}{modeSaving && <LoaderCircle size={14} className="spin" />}</div>
            <span>{draft.length >= 7000 ? `${draft.length}/8000` : ''}</span>
            <button className="primary-button" type="submit" disabled={busy || saving || modeSaving || (scopeEdited && scopeDirty) || scopeSaveState === 'saving' || turnInProgress || loadingConversation || loadingSessions || !draft.trim()}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={16} />}
              {busy ? '处理中…' : '发送'}
            </button>
          </div>
        </form>
      </section>

      <aside className="conversation-task-panel" aria-label="当前筛选任务和结果" hidden={!showTaskPanel}>
        {conversation?.id === selectedId && <ResearchPanel key={conversation.id} conversationId={conversation.id} turnActive={turnInProgress} refreshKey={refreshIndex + conversation.messages.length} onContentChange={setHasResearchResults} />}
        {task && <section className="conversation-task-section">
          <div className="conversation-panel-heading">
            <h2>筛选方案</h2>
            <span>{conversation ? `v${conversation.task_revision}` : '未建立'}</span>
          </div>
          <>
            <div className="conversation-task-conditions"><TaskLogic task={task} /></div>
            <div className="conversation-task-scope">
              <span>范围</span><strong>{taskUniverseLabel(task)}</strong>
              <span>截止日</span><strong>{task.scope.as_of ?? '未确定'}</strong>
              {task.scope.report_lookback_calendar_days != null && <><span>研报回溯</span><strong>近 {task.scope.report_lookback_calendar_days} 个自然日</strong></>}
              {task.scope.news_lookback_calendar_days != null && <><span>资讯回溯</span><strong>近 {task.scope.news_lookback_calendar_days} 个自然日</strong></>}
              {task.scope.ranking && <>
                <span>排名范围</span><strong>{({ all_a_shares: '全部A股', watchlist: '自选股票池', after_filters: '满足指定条件的股票', industry: '行业内' } as Record<string, string>)[String(task.scope.ranking.ranking_universe)] ?? '待确定'}</strong>
                <span>选取数量</span><strong>{task.scope.ranking.top_n != null ? `前 ${String(task.scope.ranking.top_n)} 名` : `前 ${Number(task.scope.ranking.top_fraction) * 100}%（人数向上取整）`}</strong>
                <span>并列处理</span><strong>{task.scope.ranking.ties_policy === 'include_all' ? '保留全部并列' : '同分按股票代码排序'}</strong>
                <span>缺失处理</span><strong>{task.scope.ranking.missing_policy === 'exclude_with_notice' ? '排除缺失并说明' : '范围不完整时保留未知'}</strong>
              </>}
            </div>
            {task.unresolved.map((item, index) => <p className="conversation-unresolved" key={`${item.source_quote}-${index}`}>{item.question}</p>)}
            <div className="scope-picker">
              <label>股票范围<select aria-label="调整股票范围" value={scopePool} disabled={busy || turnInProgress || scopeSaveState === 'saving'} onChange={event => { setScopePool(event.target.value); setScopeEdited(true); setScopeSaveState('idle') }}><option value="all">全部A股</option>{task.scope.universe?.kind === 'explicit' && <option value="explicit">当前指定股票</option>}{watchlists.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
              <label>行情日期<input aria-label="调整行情日期" type="date" value={scopeDate} max={data?.last_date} disabled={busy || turnInProgress || scopeSaveState === 'saving'} onChange={event => { setScopeDate(event.target.value); setScopeEdited(true); setScopeSaveState('idle') }} /></label>
              {data?.last_date && <button className="text-button" disabled={busy || turnInProgress || scopeSaveState === 'saving'} onClick={() => { setScopeDate(data.last_date!); setScopeEdited(true); setScopeSaveState('idle') }}>选用最新行情日</button>}
              {(scopeDirty && scopeEdited || scopeSaveState !== 'idle') && <span className="scope-save-status conversation-muted" role="status">{scopeSaveState === 'saving' ? '正在自动保存…' : scopeSaveState === 'saved' ? '范围和日期已自动保存' : scopeSaveState === 'error' ? '自动保存失败' : '等待自动保存'}{scopeSaveState === 'error' && <button className="icon-button" title="重试保存范围和日期" aria-label="重试保存范围和日期" onClick={() => void applyScope()}><RefreshCw size={14} /></button>}</span>}
            </div>
            <p className="conversation-muted">使用本地日线。价格复权口径尚待核实；符合筛选条件不代表未来会上涨。</p>
            <div className="conversation-task-actions">
              {canExecute ? <button className="primary-button" disabled={busy || saving || turnInProgress || loadingConversation || runInProgress || !!pendingTurn || !!draft.trim() || !executableTurn} onClick={() => void startScreening()}><Play size={15} />{runInProgress ? '正在筛选…' : taskHasRun ? '按当前条件再筛一次' : '确认并开始筛选'}</button> : <button className="secondary-button" disabled={busy || saving || turnInProgress} onClick={focusComposer}>补充筛选要求</button>}
              <button className="secondary-button" disabled={!canSave || busy || saving || turnInProgress || scopeDirty || scopeSaveState === 'saving'} title={!canSave ? '请先补充完整条件和股票范围' : undefined} onClick={() => void saveTask(suggestedName)}>{saving ? <LoaderCircle size={14} className="spin" /> : <Bookmark size={14} />}{saving ? '保存中…' : '保存方案'}</button>
              <button className="icon-button" disabled={!canSave || busy || saving || turnInProgress} title="设置方案名称" aria-label="设置方案名称" aria-expanded={saveOpen} onClick={() => { setSaveName(suggestedName); setSaveOpen(value => !value) }}><Pencil size={15} /></button>
            </div>
            {!canExecute && !task.unresolved.length && <p className="conversation-muted">请先{scopeDirty && scopeEdited ? '等待范围与日期自动保存' : missingTaskInfo || '完整条件'}。</p>}
            {canExecute && !!draft.trim() && <p className="conversation-muted">输入框中还有未发送的内容，请先发送或清空，再确认筛选。</p>}
            {saveOpen && <form className="conversation-save-form" onSubmit={event => { event.preventDefault(); void saveTask() }}>
              <label htmlFor="saved-task-name">方案名称</label>
              <input id="saved-task-name" autoFocus value={saveName} maxLength={120} disabled={saving} onChange={event => setSaveName(event.target.value)} placeholder="给这组条件起个名字" />
              <small>保存条件、股票范围和截止日，供下次复用。</small>
              <div><button className="primary-button compact" disabled={saving || !saveName.trim()} type="submit">{saving ? '保存中…' : '确认保存'}</button><button className="text-button" type="button" disabled={saving} onClick={() => setSaveOpen(false)}>取消</button></div>
            </form>}
          </>
        </section>}

        {(!!runs.length || !!pendingTurn) && <section className="conversation-run-section">
          <div className="conversation-panel-heading">
            <h2>筛选结果</h2>
            {runs.length > 0 && <select aria-label="查看筛选运行" value={viewingRunId} onChange={(event) => setViewingRunId(event.target.value)}>
              {runs.map((item) => <option key={item.id} value={item.id}>v{item.task_revision} · {item.as_of} · {stateLabels[item.status] ?? item.status}</option>)}
            </select>}
          </div>
          {pendingTurn && <div className="conversation-retry-notice" role="status">
            <span>条件和执行授权已保留，可以继续启动筛选。</span>
            <button className="secondary-button compact" disabled={busy} onClick={() => void retryExecution(pendingTurn.id)}><Play size={14} />{busy ? '正在启动…' : '重试启动筛选'}</button>
          </div>}
          {!runs.length ? (
            <p className="conversation-muted">尚无筛选运行</p>
          ) : loadingRun || !run ? (
            <p className="conversation-muted"><LoaderCircle size={14} className="spin" />正在读取运行…</p>
          ) : (
            <><p className="conversation-muted">入选结果已自动保留，可到“观察池”按本次选股批次查看后续走势和记录备注。</p><ScreeningResultView
              asOf={run.as_of}
              revision={run.task_revision}
              status={run.status}
              isCurrent={Boolean(activeRun)}
              progress={['queued', 'running'].includes(run.status) ? { message: run.job.message, percent: run.job.progress } : undefined}
              coverage={coverage ?? undefined}
              decisions={unifiedDecisions}
              loading={loadingDecisions}
              error={decisionError}
              total={decisionTotal}
              offset={decisionOffset}
              pageSize={RUN_PAGE_SIZE}
              stateFilter={decisionState}
              query={decisionQuery}
              onStateFilterChange={(state) => { setDecisionState(state); setDecisionOffset(0) }}
              onQueryChange={(q) => { setDecisionQuery(q); setDecisionOffset(0) }}
              onPageChange={(newOffset) => setDecisionOffset(newOffset)}
              onCancel={() => void cancelRun()}
              onAskStock={(stockCode, state) => {
                prepareDraft(state === 'unknown' ? `这次为什么无法判断${stockCode}是否符合条件？` : `为什么这次${state === 'true' ? '选中了' : '没有选中'}${stockCode}？`)
                setSource({ reference: { kind: 'screening_run', source_id: run.id }, label: `筛选结果 · ${run.as_of} · v${run.task_revision}` })
                setError('')
              }}
              onCopyAll={() => void copyAllMatching()}
              onExportUrl={`/api/v1/conversations/${conversation!.id}/screening-runs/${run.id}/export?state=${decisionState}&query=${encodeURIComponent(decisionQuery)}`}
              onViewChart={(code) => setChart({ code, date: run.as_of })}
              onAdjustRequirements={focusComposer}
              onReload={() => setDecisionReload(v => v + 1)}
            /></>
          )}
        </section>}
      </aside>
      </div>
      {chart && <StockChartDialog code={chart.code} asOf={chart.date} onClose={() => setChart(null)} />}
    </div>
  )
}
