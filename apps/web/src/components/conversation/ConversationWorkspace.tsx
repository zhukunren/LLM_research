import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AlertCircle, ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Bookmark, ChartNoAxesCombined, Check, Copy, FileSearch, GitCompareArrows, History, LoaderCircle, Pencil, Play, Plus, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react'
import {
  api,
  conversationWorkflow,
  type Conversation,
  type ConversationMessage,
  type ConversationScope,
  type ResearchMode,
  type WorkflowType,
  type ResearchDepth,
  type ResearchScope,
  type ScreeningDraftSource,
  type ConversationSourceReference,
  type ConversationTurn,
  type ScreeningTaskDecision,
  type ScreeningTaskRevision,
  type ScreeningTaskRunSummary,
  type SavedScreeningTask,
} from '../../api'
import { useSessionState } from '../../useSessionState'
import { trapDialogTab } from '../../keyboard'
import { TaskLogic, taskUniverseLabel } from './TaskBrief'
import SavedTaskLibrary from './SavedTaskLibrary'
import ScreeningTemplates, { type ScreeningTemplate } from './ScreeningTemplates'
import ScreeningReadiness from './ScreeningReadiness'
import ResearchPanel from './ResearchPanel'
import ResearchAnswer from './ResearchAnswer'
import ResearchResultActions, { type ResearchResultRequest } from './ResearchResultActions'
import AnswerSources from './AnswerSources'
import { isExecutionFailure, ResearchFailure, ResearchProgress } from './ResearchFeedback'
import ProjectMembership from './ProjectMembership'
import StockChartDialog from '../StockChartDialog'
import ResearchAssistantSelect from '../ResearchAssistantSelect'
import type { DataStatus } from '../../api'
import ScreeningResultView, { type UnifiedDecisionItem } from '../ScreeningResultView'

type SessionSummary = {
  id: string
  entry_scope: ConversationScope
  research_mode?: ResearchMode
  workflow_type?: WorkflowType
  research_depth?: ResearchDepth
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
const depthLabels: Record<ResearchDepth, string> = { standard: '普通', deep: '深入' }
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
    { label: '均线上方且上涨', prompt: '筛选收盘价高于20日均线，且近5个交易日涨幅大于3%的股票。' },
    { label: '低 RSI 且低于均线', prompt: '筛选RSI14小于30，且收盘价低于10日均线的股票。' },
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
const researchSuggestions: Record<ConversationScope, PromptSuggestion[]> = {
  screening: promptSuggestions.screening,
  technical: [{ label: '解释走势', prompt: '解释近期的价格与成交变化，注明计算日期、指标口径和局限。' }, { label: '比较公司', prompt: '比较两家公司的走势与成交变化，核对差异和风险。' }],
  report: [{ label: '核对事实', prompt: '解释所选研报的核心判断，区分事实、预测和推断，列出对应原文。' }, { label: '寻找反证', prompt: '研报中有哪些支持或反对公司经营改善的证据？列出待验证事项。' }],
  news: [{ label: '事件核验', prompt: '核对近期资讯中的业务事件，区分计划、公告和实际兑现。' }, { label: '比较变化', prompt: '比较公司前后披露的业务变化，注明事件日期、来源和风险。' }],
  pattern: [{ label: '解释形态', prompt: '解释当前形态的走势与成交特点，注明匹配口径和局限。' }, { label: '核对差异', prompt: '比较目标形态与实际走势的差异，不把相似度当作未来收益概率。' }],
}
const screeningSuggestionLabels: Partial<Record<ConversationScope, string>> = {
  technical: '行情条件', report: '研报证据', news: '资讯事件', pattern: '走势形态',
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
type DraftSource = { reference: ConversationSourceReference; label: string }
type MessagePayload = { base_revision: number; research_scope_revision?: number; assistant_revision?: number; content: string; source_refs: ConversationSourceReference[] }
type MessageAttempt = { key: string; clientId: string; payload: MessagePayload }
const validSources = (value: unknown): value is Record<string, DraftSource | null> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item === null || (item && typeof item === 'object' && typeof item.label === 'string' && item.reference && typeof item.reference.kind === 'string' && typeof item.reference.source_id === 'string'))
const validMessageAttempts = (value: unknown): value is Record<string, MessageAttempt> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item && typeof item === 'object' && typeof item.key === 'string' && typeof item.clientId === 'string' && item.payload && typeof item.payload.content === 'string' && Number.isInteger(item.payload.base_revision) && Array.isArray(item.payload.source_refs) && (item.payload.research_scope_revision === undefined || Number.isInteger(item.payload.research_scope_revision)))

export default function ConversationWorkspace({
  data, initialConversationId, initialPrompt, initialNewDraft = false, onPromptConsumed,
  newResearchKey, onNewResearchConsumed, initialAssistantId,
  initialScope = 'screening',
  onScopeChange,
  initialSource,
  onSourceChange,
  onOpenProject,
  initialWorkflowType = 'research',
  onOpenConversation,
  onLocationChange,
  shellNavigation = false, onHistoryChange, onOpenDataServices,
}: {
  data?: DataStatus | null
  initialConversationId?: string
  initialPrompt?: string
  initialNewDraft?: boolean
  onPromptConsumed?: () => void
  newResearchKey?: number
  onNewResearchConsumed?: () => void
  initialAssistantId?: string
  initialScope?: ConversationScope
  onScopeChange?: (scope: ConversationScope) => void
  initialSource?: { reference: ConversationSourceReference; label: string } | null
  onSourceChange?: (source: { reference: ConversationSourceReference; label: string } | null) => void
  onOpenProject?: (id: string) => void
  initialWorkflowType?: WorkflowType
  onOpenConversation?: (id: string, scope: ConversationScope, workflow?: WorkflowType, prompt?: string) => void
  onLocationChange?: (id: string, scope: ConversationScope, workflow: WorkflowType) => void
  shellNavigation?: boolean
  onHistoryChange?: () => void
  onOpenDataServices?: () => void
}) {
  const historyChangeRef = useRef(onHistoryChange)
  historyChangeRef.current = onHistoryChange
  const locationChangeRef = useRef(onLocationChange)
  locationChangeRef.current = onLocationChange
  const reportedLocation = useRef('')
  function reportLocation(id: string, entryScope: ConversationScope, workflow: WorkflowType) {
    const key = JSON.stringify([id, entryScope, workflow])
    if (reportedLocation.current === key) return
    reportedLocation.current = key
    locationChangeRef.current?.(id, entryScope, workflow)
  }
  const [scope, setScope] = useState<ConversationScope>(initialScope)
  const [suggestionScope, setSuggestionScope] = useState<ConversationScope>(initialScope === 'screening' ? 'technical' : initialScope)
  const [researchDepth, setResearchDepth] = useState<ResearchDepth>('standard')
  const [modeSaving, setModeSaving] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const conversationReady = !selectedId || conversation?.id === selectedId
  const workflowType = conversation ? conversationWorkflow(conversation, initialWorkflowType) : initialWorkflowType
  const isResearch = workflowType === 'research'
  const [task, setTask] = useState<ScreeningTaskRevision | null>(null)
  const [runs, setRuns] = useState<ScreeningTaskRunSummary[]>([])
  const [viewingRunId, setViewingRunId] = useState('')
  const [run, setRun] = useState<TaskRun | null>(null)
  const [decisions, setDecisions] = useState<ScreeningTaskDecision[]>([])
  const [decisionState, setDecisionState] = useState('true')
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
  const [assistantDrafts, setAssistantDrafts] = useSessionState<Record<string, string>>('conversation.assistantDrafts', {}, validDrafts)
  const [assistantSaving, setAssistantSaving] = useState(false)
  const [draftSources, setDraftSources] = useSessionState<Record<string, DraftSource | null>>('conversation.draftSources', {}, validSources)
  const [messageAttempts, setMessageAttempts] = useSessionState<Record<string, MessageAttempt>>('conversation.messageAttempts', {}, validMessageAttempts)
  const draftKey = `${initialWorkflowType}:${scope}:${selectedId || 'new'}`
  const draft = drafts[draftKey] ?? drafts[`${scope}:${selectedId || 'new'}`] ?? ''
  const assistantId = conversation?.assistant?.id ?? assistantDrafts[draftKey] ?? 'general'
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
  const [progressUpdatedAt, setProgressUpdatedAt] = useState('')
  const [savedNoteProject, setSavedNoteProject] = useState('')
  const [hasResearchResults, setHasResearchResults] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const resultsToggleRef = useRef<HTMLButtonElement>(null)
  const resultsCloseRef = useRef<HTMLButtonElement>(null)
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
  const [scopeOverrides, setScopeOverrides] = useState({ pool: false, date: false })
  const [scopeEdited, setScopeEdited] = useState(false)
  const [scopeSaveState, setScopeSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [researchDate, setResearchDate] = useState(data?.last_date ?? '')
  const researchDateEdited = useRef(false)
  const [researchCodesInput, setResearchCodesInput] = useState('')
  const [researchScopeSaving, setResearchScopeSaving] = useState(false)
  const researchScopeReadyKey = useRef('')
  const researchScopeSavingRef = useRef(false)
  const [answerActionSaving, setAnswerActionSaving] = useState(false)
  const answerActionAttempt = useRef<{ key: string; id: string } | null>(null)
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
  const taskPanelRef = useRef<HTMLElement>(null)
  const runSectionRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sessionsRef = useRef<HTMLElement>(null)
  const disclosureRef = useRef<HTMLButtonElement>(null)
  const consumedNewResearchRef = useRef<number | null>(null)
  useEffect(() => {
    // Data status may arrive after a bookmarked new draft has mounted.
    if (isResearch && !selectedId && !researchDateEdited.current && data?.last_date) setResearchDate(data.last_date)
  }, [isResearch, selectedId, data?.last_date])
  const followLatestRef = useRef(true)
  const saveAttemptRef = useRef<{ taskKey: string; assetId: string; requestId: string } | null>(null)
  const reuseAttemptRef = useRef<{ key: string; conversation?: Conversation; messageId?: string; clientId: string } | null>(null)
  const templateGenerationRef = useRef(0)
  const templateNewKeyRef = useRef(newResearchKey)
  const templateMountedRef = useRef(true)
  if (newResearchKey !== templateNewKeyRef.current) {
    // Consuming a request resets its key to zero; only a new positive request
    // invalidates pending starter work, even if the empty draft id is unchanged.
    if (newResearchKey && newResearchKey > 0) templateGenerationRef.current += 1
    templateNewKeyRef.current = newResearchKey
  }
  useEffect(() => {
    templateMountedRef.current = true
    return () => { templateMountedRef.current = false; templateGenerationRef.current += 1 }
  }, [])
  const templateOwnerRef = useRef('')
  templateOwnerRef.current = `${initialWorkflowType}:${scope}:${selectedId}`
  const templateBusyRef = useRef(false)
  const templateAttemptRef = useRef<{ key: string; ownerKey: string; conversation?: Conversation; clientId: string } | null>(null)
  const executionAttempts = useRef(new Map<string, Promise<{ run_id: string }>>())

  useEffect(() => {
    api<{ items: { id: string; name: string }[] }>('/watchlists')
      .then((res) => setWatchlists(res.items || []))
      .catch(() => {})
  }, [refreshIndex])

  useEffect(() => { if (!scopeDate && data?.last_date) setScopeDate(data.last_date) }, [data?.last_date, scopeDate])
  useEffect(() => { setHasResearchResults(false); setResultsOpen(false) }, [selectedId])
  useEffect(() => {
    if (conversation) historyChangeRef.current?.()
  }, [conversation?.id, conversation?.messages.length, conversation?.turns[0]?.state])
  useEffect(() => {
    if (!resultsOpen) return
    resultsCloseRef.current?.focus()
    return () => { resultsToggleRef.current?.focus() }
  }, [resultsOpen])
  useEffect(() => { setSuggestionScope(scope === 'screening' ? 'technical' : scope) }, [scope])
  useEffect(() => {
    if (loadingSessions || !initialPrompt || (initialConversationId && selectedId !== initialConversationId)) return
    if (!initialConversationId) createConversation()
    setDrafts(current => ({ ...current, [`${initialWorkflowType}:${scope}:${initialConversationId || 'new'}`]: initialPrompt }))
    setSource(initialSource ?? null); onPromptConsumed?.()
  }, [loadingSessions, initialPrompt, selectedId, initialConversationId])
  useEffect(() => {
    const source = conversation?.screening_draft_source
    if (!source || conversation.messages.length || drafts[`${initialWorkflowType}:${scope}:${conversation.id}`] !== undefined) return
    setDrafts(current => ({ ...current, [`${initialWorkflowType}:${scope}:${conversation.id}`]: source.draft_prompt }))
  }, [conversation?.id, conversation?.screening_draft_source?.request_id, conversation?.messages.length])
  useEffect(() => {
    if (!newResearchKey || newResearchKey <= 0) { consumedNewResearchRef.current = null; return }
    if (loadingSessions || busy || modeSaving || scopeSavingRef.current || consumedNewResearchRef.current === newResearchKey) return
    consumedNewResearchRef.current = newResearchKey
    createConversation(initialAssistantId || 'general')
    onNewResearchConsumed?.()
  }, [newResearchKey, loadingSessions, busy, modeSaving, onNewResearchConsumed, initialAssistantId])
  useEffect(() => {
    if (!sessionsOpen) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sessionsRef.current?.querySelector<HTMLElement>('button, input, select')?.focus()
    return () => { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }) }
  }, [sessionsOpen])

  function onSessionsKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); setSessionsOpen(false); return }
    if (event.key !== 'Tab') return
    const controls = Array.from(sessionsRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary') ?? []).filter(control => control.getClientRects().length > 0)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }

  async function copyAnswer(content: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('浏览器暂时无法复制，请选中答复文字复制。')
      await navigator.clipboard.writeText(content)
      setNotice('答复已复制。')
    } catch (reason) { setError((reason as Error).message) }
  }
  useEffect(() => {
    if (!task || isResearch) return
    setScopeDate(task.scope.as_of || data?.last_date || '')
    setScopePool(task.scope.universe?.kind === 'watchlist' ? task.scope.universe.watchlist_id || 'all' : task.scope.universe?.kind === 'explicit' ? 'explicit' : 'all')
    const nextKey = `${conversation?.id || ''}:${task.revision}`
    if (!scopeReadyKey.current.startsWith(`${conversation?.id || ''}:`)) setScopeSaveState('idle')
    scopeReadyKey.current = nextKey
    setScopeEdited(false)
  }, [task?.revision, task?.task_id, conversation?.id, isResearch])

  async function applyScope() {
    if (isResearch || !conversation || !task || !scopeDate || scopeSavingRef.current || busy || saving || turnInProgress) return
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
      setNotice(`已复制当前搜索范围全部 ${result.items.length} 只符合条件的股票代码。`)
    } catch (reason) { setError((reason as Error).message) }
  }

  function selectConversation(id: string) {
    try { localStorage.setItem(`${sessionStorageKey(scope)}.${initialWorkflowType}`, id || '__new__'); localStorage.setItem(sessionStorageKey(scope), id || '__new__') } catch { /* Keep selection available when storage is unavailable. */ }
    freshConversationRef.current = !id
    selectedIdRef.current = id
    setScopeEdited(false)
    setScopeSaveState('idle')
    researchScopeReadyKey.current = ''
    scopeAttempt.current = null
    setSelectedId(id)
    if (!id) reportLocation('', scope, initialWorkflowType)
  }

  function setSource(source: { reference: ConversationSourceReference; label: string } | null, key = draftKey) {
    setPendingSource(source)
    setDraftSources(current => ({ ...current, [key]: source }))
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
    const research = conversationWorkflow(next, initialWorkflowType) === 'research'
    const [nextTask, runList] = await Promise.all([
      !research && next.task_revision > 0
        ? api<ScreeningTaskRevision>(`/conversations/${conversationId}/revisions/${next.task_revision}`)
        : Promise.resolve(null),
      research ? Promise.resolve({ items: [] as ScreeningTaskRunSummary[] }) : api<{ items: ScreeningTaskRunSummary[] }>(`/conversations/${conversationId}/screening-runs`),
    ])
    if (!accept() || selectedIdRef.current !== conversationId) return next
    setConversation(next)
    reportLocation(next.id, next.entry_scope, conversationWorkflow(next, initialWorkflowType))
    setResearchDepth(next.research_depth ?? (next.research_mode === 'advanced' ? 'deep' : 'standard'))
    const researchScopeKey = `${next.id}:${next.research_scope_revision ?? 0}`
    if (research && researchScopeReadyKey.current !== researchScopeKey) {
      setResearchDate(next.research_scope?.as_of || data?.last_date || '')
      setResearchCodesInput((next.research_scope?.stock_codes ?? []).join(', '))
      researchScopeReadyKey.current = researchScopeKey
    }
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
      workflow_type: conversationWorkflow(next, initialWorkflowType),
      research_depth: next.research_depth,
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

  async function processTurn(conversationId: string, turnId: string, executeWhenReady = true) {
    setBusy(true)
    setError('')
    setCodexProgress('')
    try {
      await reloadConversation(conversationId)
      const turn = await api<ConversationTurn>(`/conversations/${conversationId}/turns/${turnId}/process`, { method: 'POST' })
      if (!isResearch && executeWhenReady && turn.result.ready_to_execute && turn.result.execution_authorized !== false) {
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
    freshConversationRef.current = false
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
    setPendingSource(initialSource ?? draftSources[draftKey] ?? null)
  }, [initialSource, draftKey])

  useEffect(() => {
    let active = true
    const requested = !initialSelectionRef.current.loaded || initialSelectionRef.current.id !== initialConversationId ? initialConversationId : undefined
    // Publishing the URL of a conversation already restored from history must
    // not clear that same conversation and restart selection.
    if (requested && requested === selectedIdRef.current && conversation?.id === requested) {
      initialSelectionRef.current = { loaded: true, id: initialConversationId }
      return
    }
    const remainFresh = (initialNewDraft || freshConversationRef.current) && !requested
    const stored = requested || selectedIdRef.current || localStorage.getItem(`${sessionStorageKey(scope)}.${initialWorkflowType}`) || localStorage.getItem(sessionStorageKey(scope))
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
        const matching = items.filter(item => !item.workflow_type || conversationWorkflow(item, initialWorkflowType) === initialWorkflowType)
        const requestedMatch = requested && matching.some(item => item.id === requested) ? requested : ''
        const preferred = remainFresh || stored === '__new__' ? '' : matching.some(item => item.id === stored)
          ? stored!
          : requestedMatch || matching[0]?.id || ''
        selectConversation(preferred)
      })
      .catch((reason) => { if (active) setSessionError((reason as Error).message) })
      .finally(() => { if (active) setLoadingSessions(false) })
    return () => { active = false }
  }, [scope, sessionReload, initialConversationId, initialWorkflowType, initialNewDraft])


  useEffect(() => {
    if (loadingSessions || !selectedId || !sessions.some((item) => item.id === selectedId)) return
    let active = true
    setLoadingConversation(true)
    reloadConversation(selectedId, () => active)
      .catch((reason) => { if (active) setError((reason as Error).message) })
      .finally(() => { if (active) setLoadingConversation(false) })
    return () => { active = false }
  }, [selectedId, sessions.length, refreshIndex, loadingSessions])

  const activeTurnId = conversation?.id === selectedId
    ? conversation.turns.find(turn => ['awaiting_agent', 'running'].includes(turn.state))?.id
    : undefined
  useEffect(() => {
    setCodexProgress('')
    setProgressUpdatedAt('')
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
          if (events.items.length) setProgressUpdatedAt(new Date().toISOString())
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

  const readyTurnId = !isResearch && conversation?.id === selectedId && conversation.pending_execution && !activeTurnId
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
    if (isResearch || !conversation || !viewingRunId) {
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
  }, [conversation?.id, viewingRunId, refreshIndex, isResearch])

  useEffect(() => { setDecisionOffset(0); setDecisionQuery(''); setDecisionState('true'); setDecisionError('') }, [viewingRunId])
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
  const activeTurn = conversation?.turns.find(turn => ['awaiting_agent', 'running'].includes(turn.state))
  const messageCount = conversation?.messages.length ?? 0

  useEffect(() => {
    if (!messageListRef.current) return
    if (!messageCount) { messageListRef.current.scrollTop = 0; return }
    if (followLatestRef.current) scrollToLatest('auto')
    else if (messageCount) setShowLatest(true)
  }, [conversation?.id, messageCount])

  function changeScope(next: ConversationScope) {
    if (busy || modeSaving || scopeSavingRef.current || next === scope) return
    freshConversationRef.current = false
    setScope(next)
    setSelectedId('')
    setConversation(null)
    setTask(null)
    setRun(null)
    setRuns([])
    setViewingRunId('')
    selectedIdRef.current = ''
    setPendingSource(null)
    onSourceChange?.(null)
    setError('')
    onScopeChange?.(next)
  }

  async function changeResearchDepth(next: ResearchDepth) {
    if (!conversationReady || busy || saving || modeSaving || turnInProgress || next === researchDepth) return
    modeChosenRef.current = true
    if (!conversation) { setResearchDepth(next); return }
    setModeSaving(true)
    try {
      await api(`/conversations/${conversation.id}/workflow`, { method: 'PATCH', body: JSON.stringify({ research_depth: next, ...(conversation.workflow_revision != null ? { base_revision: conversation.workflow_revision } : {}) }) })
      if (selectedIdRef.current === conversation.id) {
        setResearchDepth(next)
        await reloadConversation(conversation.id)
        setNotice(`研究深度已设为“${depthLabels[next]}”。`)
      }
    } catch (reason) {
      setError((reason as Error).message)
    } finally { setModeSaving(false) }
  }

  function createConversation(nextAssistant = 'general') {
    if (busy || modeSaving || scopeSavingRef.current) return
    templateGenerationRef.current += 1
    templateAttemptRef.current = null
    setScopePool('all'); setScopeDate(data?.last_date ?? ''); setScopeOverrides({ pool: false, date: false })
    researchDateEdited.current = false
    setResearchDate(data?.last_date ?? ''); setResearchCodesInput('')
    selectConversation('')
    setDrafts(current => ({ ...current, [initialWorkflowType + ':' + scope + ':new']: '' }))
    setAssistantDrafts(current => ({ ...current, [initialWorkflowType + ':' + scope + ':new']: nextAssistant }))
    setError('')
    setConversation(null)
    setTask(null)
    setRuns([])
    setRun(null)
    setViewingRunId('')
    setLoadingConversation(false)
    setLibraryTab('recent')
    setSource(null, `${initialWorkflowType}:${scope}:new`)
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
      setNotice(`已保存“${saved.name}”。`)
      setLibraryTab('recent')
    } catch (reason) { setError((reason as Error).message) }
    finally { setSaving(false) }
  }

  async function selectTemplate(template: ScreeningTemplate, parameters: Record<string, number>) {
    if (templateBusyRef.current || busy || saving || modeSaving || turnInProgress || !scopeDate || !conversationReady) return
    templateBusyRef.current = true
    const generation = templateGenerationRef.current
    const isCurrent = () => templateMountedRef.current && templateGenerationRef.current === generation
    const ownerKey = templateOwnerRef.current
    const key = JSON.stringify([template.id, template.version, parameters, scopePool, scopeDate, ownerKey])
    if (templateAttemptRef.current?.key !== key) templateAttemptRef.current = { key, ownerKey, clientId: crypto.randomUUID(), conversation: templateAttemptRef.current?.ownerKey === ownerKey ? templateAttemptRef.current.conversation : undefined }
    const attempt = templateAttemptRef.current
    setBusy(true); setError('')
    try {
      if (!attempt.conversation) attempt.conversation = conversation ?? await api<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ entry_scope: scope, workflow_type: 'screening', research_depth: researchDepth }) })
      const current = attempt.conversation
      if (!isCurrent() || templateOwnerRef.current !== ownerKey) return
      const published = await api<{ task: ScreeningTaskRevision }>(`/conversations/${current.id}/screening-templates/${template.id}`, {
        method: 'POST', body: JSON.stringify({ base_revision: current.task_revision, client_message_id: attempt.clientId, version: template.version, parameters, as_of: scopeDate, universe: scopePool === 'all' ? { kind: 'all_a_shares' } : { kind: 'watchlist', watchlist_id: scopePool } }),
      })
      templateAttemptRef.current = null
      if (!isCurrent() || templateOwnerRef.current !== ownerKey) return
      selectConversation(current.id)
      setDrafts(currentDrafts => ({ ...currentDrafts, [`${initialWorkflowType}:${scope}:${current.id}`]: '' }))
      setConversation(null); setTask(published.task); setRun(null); setRuns([]); setViewingRunId('')
      setSource(null, `${initialWorkflowType}:${scope}:${current.id}`)
      try { await reloadConversation(current.id, isCurrent) }
      catch { if (isCurrent()) setError('基础方案已保存，尚未执行；暂时无法读取对话，请刷新后核对方案。') }
      api<{ items: SessionSummary[] }>(`/conversations?scope=${scope}&limit=50`).then(({ items }) => { if (isCurrent() && selectedIdRef.current === current.id) setSessions(items) }).catch(() => {})
      globalThis.setTimeout(() => { if (isCurrent() && selectedIdRef.current === current.id) taskPanelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }) }, 100)
    } catch (reason) { if (isCurrent() && templateOwnerRef.current === ownerKey) setError(`基础方案尚未完成：${(reason as Error).message}。可修改参数或范围后重试；若连接中断，保持参数不变再次点击可恢复。`) }
    finally { templateBusyRef.current = false; if (templateMountedRef.current) setBusy(false) }
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
      if (!attempt.conversation) attempt.conversation = await api<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ entry_scope: scope, workflow_type: 'screening', research_depth: researchDepth }) })
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
      setSource(null, `${initialWorkflowType}:${scope}:${current.id}`)
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
    if (!isResearch && !task) {
      const poolLabel = scopePool === 'all' ? '全部A股' : `自选分组“${watchlists.find(item => item.id === scopePool)?.name || ''}”`
      const additions = [scopeOverrides.pool ? `股票范围以界面设置为准：${poolLabel}。` : `未在要求中明确指定股票范围时，默认使用${poolLabel}。`]
      if (scopeDate) additions.push(scopeOverrides.date ? `行情截止日期以界面设置为准：${scopeDate}。` : `未在要求中明确指定截止日期时，默认使用${scopeDate}的行情。`)
      additions.push('请先整理筛选方案，本次不要执行筛选。')
      content += '\n' + additions.join('')
    }
    if (!content || !conversationReady || busy || saving || assistantSaving || modeSaving || scopeSavingRef.current || researchScopeSavingRef.current || (isResearch ? !!researchScopeIssue || (!!conversation && researchScopeDirty) : (scopeEdited && scopeDirty)) || turnInProgress || !conversationReady || loadingConversation || loadingSessions) return
    setBusy(true)
    setError('')
    followLatestRef.current = true
    let conversationId = conversation?.id ?? ''
    let submittingDraftKey = draftKey
    try {
      let current = conversation
      if (!current) {
        const created = await api<Conversation>('/conversations', {
          method: 'POST',
          body: JSON.stringify({ entry_scope: scope, workflow_type: workflowType, research_depth: researchDepth, ...(isResearch ? { assistant_id: assistantId } : {}) }),
        })
        // Creation returns metadata, whereas React state always needs the full
        // conversation shape, including during the following scope PATCH.
        current = { ...created, messages: [], turns: [], pending_execution: false }
        conversationId = current.id
        submittingDraftKey = `${initialWorkflowType}:${scope}:${current.id}`
        // Switch the draft's identity atomically with the new conversation.
        // Failed message writes can then be retried or restored after reload.
        setDrafts(items => { const next = { ...items, [submittingDraftKey]: items[draftKey] ?? draft }; delete next[draftKey]; return next })
        setDraftSources(items => { const next = { ...items, [submittingDraftKey]: pendingSource }; delete next[draftKey]; return next })
        if (messageAttempts[draftKey]) setMessageAttempts(items => { const next = { ...items, [submittingDraftKey]: items[draftKey] }; delete next[draftKey]; return next })
        setSessions((items) => [{
          id: current!.id,
          entry_scope: current!.entry_scope,
          workflow_type: workflowType,
          task_revision: 0,
          active_run_id: null,
          state: 'active',
          title: null,
          updated_at: current!.updated_at,
        }, ...items])
        selectConversation(current.id)
        setConversation(current)
      }
      if (isResearch && !conversation && (researchDate || researchCodes.length)) {
        const updated = await api<{ research_scope: ResearchScope; research_scope_revision: number }>(`/conversations/${current.id}/research-scope`, { method: 'PATCH', body: JSON.stringify({ base_revision: current.research_scope_revision ?? 0, as_of: researchDate || null, stock_codes: researchCodes }) })
        current = { ...current, ...updated }
        setConversation(current)
      }
      const currentPayload: MessagePayload = {
        base_revision: current.task_revision,
        ...(isResearch ? { research_scope_revision: current.research_scope_revision ?? 0 } : {}),
        ...(isResearch && current.assistant_revision != null ? { assistant_revision: current.assistant_revision } : {}),
        content,
        source_refs: pendingSource ? [pendingSource.reference] : [],
      }
      // Retry an unchanged draft with the original versioned payload. The
      // server may have accepted it and advanced the task/scope before a lost
      // response; rebuilding from current revisions would create a new turn.
      const messageKey = JSON.stringify([value.trim(), currentPayload.source_refs])
      const previousAttempt = messageAttempts[submittingDraftKey] ?? messageAttempts[draftKey]
      const attempt = previousAttempt?.key === messageKey ? previousAttempt : { key: messageKey, clientId: crypto.randomUUID(), payload: currentPayload }
      const messagePayload = attempt.payload
      setMessageAttempts(items => ({ ...items, [submittingDraftKey]: attempt }))
      const messageResult = await api<{
        message_id: string
        turn_id: string
        base_revision: number
        state: string
        source_refs?: Record<string, unknown>[]
      }>(`/conversations/${current.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          client_message_id: attempt.clientId,
          ...messagePayload,
        }),
      })
      const optimisticMessage: ConversationMessage = {
        id: messageResult.message_id,
        role: 'user',
        content: messagePayload.content,
        source_refs: messageResult.source_refs ?? [],
        created_at: new Date().toISOString(),
      }
      setConversation((old) => old && old.id === current!.id
        ? { ...old, messages: old.messages.some(message => message.id === optimisticMessage.id) ? old.messages : [...old.messages, optimisticMessage] }
        : old)
      setDrafts(items => ({ ...items, [submittingDraftKey]: '' }))
      setDraftSources(items => ({ ...items, [submittingDraftKey]: null }))
      setMessageAttempts(items => { const next = { ...items }; delete next[submittingDraftKey]; return next })
      if (selectedIdRef.current === current.id) { setPendingSource(null); onSourceChange?.(null) }
      if (['succeeded', 'failed', 'cancelled'].includes(messageResult.state)) {
        await reloadConversation(current.id)
        setRefreshIndex(index => index + 1)
      } else await processTurn(current.id, messageResult.turn_id, !!task)
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
  const pendingTurn = !isResearch && conversation?.pending_execution
    ? conversation.turns.find((turn) => turn.state === 'succeeded' && turn.result.ready_to_execute && turn.result.execution_authorized)
    : undefined
  const canSave = !!task?.conditions.length && !!task.references.length && !!task.logic_tree && !!task.scope.universe && !task.unresolved.length
  const scopeDirty = !isResearch && !!task && (!task.scope.universe || scopeDate !== task.scope.as_of || scopePool !== (task.scope.universe?.kind === 'watchlist' ? task.scope.universe.watchlist_id : task.scope.universe?.kind === 'explicit' ? 'explicit' : 'all'))
  const researchCodes = [...new Set(researchCodesInput.toUpperCase().split(/[\s,，;；、]+/).filter(Boolean))]
  const researchScopeIssue = researchCodes.some(code => !/^\d{6}\.(SH|SZ|BJ)$/.test(code)) ? '股票代码请填写六位代码及市场，例如 600000.SH。' : ''
  const researchScopeDirty = isResearch && !!conversation && (researchDate !== (conversation.research_scope?.as_of || data?.last_date || '') || JSON.stringify(researchCodes) !== JSON.stringify(conversation.research_scope?.stock_codes ?? []))
  const canExecute = canSave && !!task?.scope.as_of && !scopeDirty
  const runInProgress = runs.some(item => ['queued', 'running'].includes(item.status))
  const taskHasRun = !!run && run.task_revision === task?.revision
  const filteredSessions = sessions.filter(item => (item.title ?? '').toLowerCase().includes(sessionQuery.trim().toLowerCase()))
  const missingTaskInfo = task ? [!task.conditions.length || !task.logic_tree ? '筛选条件' : '', !task.scope.universe ? '股票范围' : '', !task.scope.as_of ? '截止日' : ''].filter(Boolean).join('、') : ''
  const showTaskPanel = isResearch ? resultsOpen : !!task || !!runs.length || !!pendingTurn || hasResearchResults
  const suggestedName = task?.conditions.map(item => item.description).join('；').slice(0, 120) || '研究方案'
  const screeningStarted = !!conversation?.messages.length || !!task
  const screeningStep = pendingTurn || runs.some(item => item.task_revision === task?.revision) ? 3 : task ? 2 : 1
  const currentSessionTitle = sessions.find(item => item.id === selectedId)?.title

  useEffect(() => {
    if (isResearch || !conversation || !task || !scopeEdited || !scopeDate || !scopeDirty || turnInProgress || loadingConversation || busy || saving || scopeSaveState === 'error' || scopeSaveState === 'saving') return
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
    if (!conversation || savingNote) return false
    const id = conversation.id
    setSavingNote(messageId); setError('')
    try {
      const note = await api<{ project_id: string; pdf_error?: string; pdf?: { status?: string } }>(conversation.project_id ? `/research-projects/${conversation.project_id}/notes/from-message` : `/conversations/${id}/notes/from-message`, {
        method: 'POST', body: JSON.stringify({ message_id: messageId }),
      })
      if (selectedIdRef.current !== id) return false
      setSavedNoteProject(note.project_id || conversation.project_id || '')
      setNotice('研究笔记已保存。' + (note.pdf_error ? 'PDF 暂未生成。' : ['queued','running'].includes(note.pdf?.status || '') ? 'PDF 后台生成中。' : ''))
      return true
    } catch (reason) { if (selectedIdRef.current === id) setError((reason as Error).message); return false }
    finally { setSavingNote('') }
  }

  async function saveResearchScope() {
    if (!conversation || !isResearch || researchScopeIssue || researchScopeSavingRef.current || busy || turnInProgress) return
    const id = conversation.id
    researchScopeSavingRef.current = true; setResearchScopeSaving(true); setError('')
    try {
      const result = await api<{ research_scope: ResearchScope; research_scope_revision: number }>(`/conversations/${id}/research-scope`, { method: 'PATCH', body: JSON.stringify({ base_revision: conversation.research_scope_revision ?? 0, as_of: researchDate || null, stock_codes: researchCodes }) })
      if (selectedIdRef.current !== id) return
      researchScopeReadyKey.current = `${id}:${result.research_scope_revision}`
      setConversation(current => current?.id === id ? { ...current, ...result } : current)
      setNotice('研究范围已保存。')
    } catch (reason) { if (selectedIdRef.current === id) setError((reason as Error).message) }
    finally { researchScopeSavingRef.current = false; setResearchScopeSaving(false) }
  }

  function openSession(item: SessionSummary) {
    const type = conversationWorkflow(item, initialWorkflowType)
    if (onOpenConversation && type !== initialWorkflowType) { onOpenConversation(item.id, item.entry_scope, type); return }
    selectConversation(item.id); setSessionsOpen(false)
  }

  async function changeAssistant(id: string) {
    if (!isResearch || busy || saving || assistantSaving || turnInProgress || !conversationReady || loadingConversation) return
    if (!conversation) { setAssistantDrafts(current => ({ ...current, [draftKey]: id })); return }
    const selected = conversation.id
    setAssistantSaving(true); setError('')
    try {
      const result = await api<Pick<Conversation, 'assistant' | 'assistant_revision'>>(`/conversations/${selected}/assistant`, { method: 'PATCH', body: JSON.stringify({ assistant_id: id, base_revision: conversation.assistant_revision ?? 0 }) })
      if (selectedIdRef.current === selected) {
        setConversation(current => current?.id === selected ? { ...current, ...result } : current)
        setMessageAttempts(current => { const next = { ...current }; delete next[draftKey]; return next })
        setNotice(`后续消息将使用“${result.assistant?.name || '通用投研'}”，历史研究保留原版本。`)
      }
    } catch (reason) { if (selectedIdRef.current === selected) setError((reason as Error).message) }
    finally { setAssistantSaving(false) }
  }

  const SuggestionContainer = 'details'

  async function submitResearchResult(messageId: string, action: ResearchResultRequest) {
    if (!conversation || !isResearch || answerActionSaving || busy || turnInProgress) return false
    const id = conversation.id
    const payload = action.kind === 'draft'
      ? { source_message_id: messageId, instructions: action.instructions.trim() }
      : { conversation_id: id, source_message_id: messageId, stock_code: action.stock_code.trim().toUpperCase(), note: action.note.trim(), verification: action.verification.trim(), invalidation: action.invalidation.trim() }
    if (action.kind === 'draft' ? !action.instructions.trim() : !/^\d{6}\.(SH|SZ|BJ)$/.test(action.stock_code.trim().toUpperCase())) return false
    const key = JSON.stringify([id, action.kind, payload])
    if (answerActionAttempt.current?.key !== key) answerActionAttempt.current = { key, id: crypto.randomUUID() }
    setAnswerActionSaving(true); setError('')
    try {
      if (action.kind === 'draft') {
        const result = await api<{ conversation_id: string; turn_id: null; draft_prompt: string; source: ScreeningDraftSource }>(`/conversations/${id}/screening-draft`, { method: 'POST', body: JSON.stringify({ ...payload, request_id: answerActionAttempt.current.id }) })
        if (selectedIdRef.current !== id) return false
        if (onOpenConversation) onOpenConversation(result.conversation_id, 'screening', 'screening', result.draft_prompt)
        else setNotice('选股草稿已创建，尚未执行。')
      } else {
        await api('/observation/research-candidates', { method: 'POST', body: JSON.stringify({ ...payload, request_id: answerActionAttempt.current.id }) })
        if (selectedIdRef.current !== id) return false
        setNotice('已加入研究候选观察。')
      }
      answerActionAttempt.current = null
      return true
    } catch (reason) { if (selectedIdRef.current === id) setError((reason as Error).message); return false }
    finally { setAnswerActionSaving(false) }
  }

  return (
    <div className={`conversation-product research-studio${isResearch ? '' : ' screening-studio'}`}>
      <div className="page-heading conversation-header-heading">
        <div className="conversation-heading-title">
          {isResearch ? <h1>研究对话</h1> : <h2>{screeningStarted ? '继续完善方案' : '新建选股方案'}</h2>}
          {currentSessionTitle && <span className="conversation-session-caption" title={currentSessionTitle}>{currentSessionTitle}</span>}
        </div>
        <div className="conversation-heading-actions">{isResearch && hasResearchResults && <button ref={resultsToggleRef} type="button" className="secondary-button" aria-expanded={resultsOpen} aria-controls="research-results-drawer" onClick={() => setResultsOpen(value => !value)}><FileSearch size={16} />成果与文件</button>}<button hidden={shellNavigation && isResearch} ref={disclosureRef} className="session-disclosure secondary-button" aria-label={isResearch ? '最近研究对话' : '历史与方案'} aria-expanded={sessionsOpen} aria-controls="screening-sessions" onClick={() => setSessionsOpen(value => !value)}><History size={16} /><span>{isResearch ? '最近对话' : '历史与方案'}</span></button><button hidden={shellNavigation && isResearch} className="secondary-button conversation-new" aria-label={isResearch ? '新研究' : '新选股对话'} title={isResearch ? '新研究' : '新选股对话'} disabled={busy || saving || loadingSessions} onClick={() => { setSessionsOpen(false); createConversation() }}><Plus size={16} /><span>{isResearch ? '新研究' : '新建选股'}</span></button></div>
      </div>
      {!isResearch && <nav className="screening-path" aria-label="本次选股进度">
        <button type="button" className={screeningStep === 1 ? 'active' : 'complete'} aria-current={screeningStep === 1 ? 'step' : undefined} onClick={focusComposer}><span>{screeningStep > 1 ? <Check size={14} /> : '1'}</span><strong>描述条件</strong></button>
        <ArrowRight size={15} aria-hidden="true" />
        <button type="button" className={screeningStep === 2 ? 'active' : screeningStep > 2 ? 'complete' : ''} aria-current={screeningStep === 2 ? 'step' : undefined} disabled={!task} onClick={() => taskPanelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}><span>{screeningStep > 2 ? <Check size={14} /> : '2'}</span><strong>确认方案</strong></button>
        <ArrowRight size={15} aria-hidden="true" />
        <button type="button" className={screeningStep === 3 ? 'active' : ''} aria-current={screeningStep === 3 ? 'step' : undefined} disabled={!runs.length && !pendingTurn} onClick={() => runSectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}><span>3</span><strong>查看结果</strong></button>
        <span className="screening-path-date">{data?.last_date ? `行情截至 ${data.last_date}` : '行情日期待指定'}</span>
      </nav>}
      {conversation && <details className="studio-project"><summary>{conversation.project_id ? '已归入研究项目' : isResearch ? '独立研究' : '独立选股'}<span>项目归属</span></summary><ProjectMembership conversationId={conversation.id} projectId={conversation.project_id} disabled={busy || saving || turnInProgress} onChange={projectId => setConversation(current => current?.id === conversation.id ? { ...current, project_id: projectId } : current)} onError={setError} onOpenProject={onOpenProject} /></details>}
      <div className={`conversation-workspace ${showTaskPanel && !isResearch ? '' : 'conversation-workspace-start'} ${!conversation?.messages.length && !task ? 'conversation-workspace-empty' : ''}`}>
      {sessionsOpen && <div className="studio-library-backdrop" onClick={() => setSessionsOpen(false)} aria-hidden="true" />}
      <aside ref={sessionsRef} id="screening-sessions" role="dialog" aria-modal="true" hidden={!sessionsOpen} onKeyDown={onSessionsKeyDown} className={`conversation-sessions ${sessionsOpen ? 'sessions-open' : ''}`} aria-label={isResearch ? '最近研究对话' : '历史与方案'}>
        <div className="conversation-panel-heading">
          <div><span className="studio-eyebrow">{isResearch ? '研究资料' : '选股工作区'}</span><h2>{isResearch ? '最近对话' : '历史与方案'}</h2></div>
          <button className="icon-button" aria-label={isResearch ? '关闭最近研究对话' : '关闭历史与方案'} onClick={() => setSessionsOpen(false)}><X size={18} /></button>
        </div>
        <label className="conversation-scope-select">
          <span>对话分类</span>
          <select aria-label="对话范围" value={scope} disabled={busy || saving || loadingSessions} onChange={(event) => changeScope(event.target.value as ConversationScope)}>
            {Object.entries(scopeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <div className="conversation-library-tabs" aria-label="对话与方案">
          <button type="button" aria-pressed={libraryTab === 'recent'} onClick={() => setLibraryTab('recent')}>最近对话</button>
          {!isResearch && <button type="button" aria-pressed={libraryTab === 'saved'} onClick={() => setLibraryTab('saved')}>已保存方案</button>}
        </div>
        {!isResearch && libraryTab === 'saved' ? <SavedTaskLibrary latestDate={data?.last_date} scope={scope} busy={busy || saving} refreshKey={`${refreshIndex}:${conversation?.turns[0]?.state}`} onReuse={(saved, latest) => void reuseTask(saved, latest)} /> : <>
        {!!sessions.length && <label className="conversation-search"><Search size={14} /><input aria-label="搜索最近对话" placeholder="搜索最近对话" value={sessionQuery} onChange={event => setSessionQuery(event.target.value)} /></label>}
        {loadingSessions ? <p className="conversation-muted">正在载入对话…</p> : sessionError ? <div className="saved-task-empty" role="alert"><p>{sessionError}</p><button className="secondary-button compact" onClick={() => setSessionReload(value => value + 1)}>重新加载对话</button></div> : !sessions.length ? <p className="conversation-muted">暂无对话</p> : !filteredSessions.length ? <div className="saved-task-empty"><p>没有找到匹配的对话</p><button className="text-button" onClick={() => setSessionQuery('')}>清除搜索</button></div> : (
          <div className="conversation-session-list">
            {filteredSessions.map((item) => (
              <button
                key={item.id}
                className={`conversation-session-row ${selectedId === item.id ? 'selected' : ''}`}
                disabled={busy || saving}
                aria-current={selectedId === item.id ? 'true' : undefined}
                onClick={() => { setSessionsOpen(false); if (item.id === selectedId && conversation) return; openSession(item); if (onOpenConversation && conversationWorkflow(item, initialWorkflowType) !== initialWorkflowType) return; setConversation(null); setTask(null); setRuns([]); setRun(null); setError(''); setRefreshIndex(value => value + 1) }}
              >
                <strong>{item.title?.trim() || '新对话'}</strong>
                <span>{conversationWorkflow(item, initialWorkflowType) === 'research' ? '研究对话' : '选股对话'}{item.last_turn_state === 'failed' ? ' · 已中断' : item.last_turn_state === 'running' ? ' · 处理中' : item.task_revision ? ` · 方案第${item.task_revision}版` : ''} · {shortTime(item.updated_at)}</span>
              </button>
            ))}
          </div>
        )}
        </>}
      </aside>

      <section className="conversation-main" aria-label={isResearch ? '研究对话' : '选股对话'}>{isResearch && !conversation?.messages.length && !loadingConversation && <div className="chat-empty-heading"><h1>开始研究</h1><p>输入公司、行业或你想核实的问题</p></div>}
        {!isResearch && !screeningStarted && <div className="screening-entry-heading"><span className="screening-entry-icon"><SlidersHorizontal size={20} /></span><h2>选股条件</h2><button type="button" className="text-button" onClick={() => { setLibraryTab('saved'); setSessionsOpen(true) }}><Bookmark size={14} />复用已保存方案</button></div>}
        {!isResearch && <ScreeningReadiness onOpenData={onOpenDataServices} data={data} scope={scope} task={task} asOf={scopeDate} selectedUniverseLabel={scopePool === 'all' ? '全部A股' : watchlists.find(item => item.id === scopePool)?.name || '指定股票池'} />}
        {error && (isExecutionFailure(error) ? <ResearchFailure content={error} /> : <div className="conversation-error" role="alert"><AlertCircle size={17} /><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>)}
        {notice && <div className="conversation-notice" role="status"><Check size={16} /><span>{notice}</span>{savedNoteProject && onOpenProject && <button className="text-button" onClick={() => onOpenProject(savedNoteProject)}>查看笔记</button>}<button className="icon-button" aria-label="关闭保存提示" onClick={() => { setNotice(''); setSavedNoteProject('') }}><X size={15} /></button></div>}
        {loadingConversation && <div className="conversation-loading"><LoaderCircle size={16} className="spin" />正在恢复对话…</div>}
        <div className="conversation-message-stage">
          <div className="conversation-message-list" ref={messageListRef} role="log" aria-live="polite" aria-relevant="additions" onScroll={onMessageListScroll}>
            {!conversation?.messages.length && !task && !loadingConversation && (
              <div className="conversation-empty">
                {!isResearch && <ScreeningTemplates disabled={busy || saving || !conversationReady || loadingConversation || loadingSessions || !scopeDate} onSelect={(template, parameters) => void selectTemplate(template, parameters)} />}
                <SuggestionContainer className={isResearch ? 'research-examples' : 'screening-examples'}><summary>{isResearch ? '示例问题' : '更多条件示例（需要模型解析）'}</summary>{!isResearch && <div className="screening-example-tabs" role="group" aria-label="选股示例分类">{Object.entries(screeningSuggestionLabels).map(([value, label]) => <button key={value} type="button" aria-pressed={suggestionScope === value} onClick={() => setSuggestionScope(value as ConversationScope)}>{label}</button>)}</div>}<div className="conversation-suggestions" aria-label={isResearch ? '常用研究问题' : '常用选股条件'}>
                  {(isResearch ? researchSuggestions[scope] : promptSuggestions[suggestionScope]).map((item, index) => { const Icon = suggestionIcons[index % suggestionIcons.length]; return <button type="button" key={item.label} aria-label={item.label} disabled={busy || saving || !conversationReady || loadingConversation || loadingSessions} onClick={() => prepareDraft(item.prompt)}><span className="suggestion-icon"><Icon size={20} strokeWidth={1.6} /></span><span className="suggestion-copy"><span className="suggestion-title">{item.label}</span>{isResearch && <span className="suggestion-description">{item.prompt}</span>}</span><ArrowUpRight size={16} className="suggestion-arrow" /></button> })}
                </div></SuggestionContainer>
              </div>
            )}
            {conversation?.messages.map((message, messageIndex) => {
            const turn = turnsByMessage.get(message.id)
            const failed = message.role === 'assistant' && (isExecutionFailure(message.content) || conversation.turns.some(item => item.state === 'failed' && item.response_text === message.content))
            const retryQuestion = failed ? conversation.messages.slice(0, messageIndex).reverse().find(item => item.role === 'user') : undefined
            const canRetryAnswer = retryQuestion && retryQuestion.id === conversation.messages.filter(item => item.role === 'user').at(-1)?.id && turnsByMessage.get(retryQuestion.id)?.state === 'failed'
            return (
              <article className={`conversation-message ${message.role}`} key={message.id}>
                <div className="conversation-message-meta">
                  <strong>{message.role === 'user' ? '你' : message.role === 'assistant' ? isResearch ? '投研助手' : '选股助手' : '工具'}</strong>
                  <time dateTime={message.created_at}>{shortTime(message.created_at)}</time>
                  {turn && <span className={`conversation-turn-state ${stateClass(turn.state)}`}>{stateLabels[turn.state] ?? turn.state}</span>}
                  {turn?.assistant && turn.assistant.id !== 'general' && <span className="conversation-assistant-tag" title={`助手版本 ${turn.assistant.revision}`}>{turn.assistant.name}</span>}
                </div>
                {failed ? <ResearchFailure content={message.content} disabled={busy || turnInProgress} onRetry={canRetryAnswer ? () => void submitMessage(retryQuestion.content) : undefined} /> : message.role === 'assistant' ? <ResearchAnswer content={message.content} conversationId={conversation.id} messageId={message.id} /> : <p className="conversation-plain-message">{message.content}</p>}
                {!!message.source_refs.length && <AnswerSources references={message.source_refs} />}
                {message.role === 'assistant' && !failed && (isResearch ? <ResearchResultActions conversation={conversation} message={message} disabled={busy || turnInProgress || !!savingNote} savingNote={savingNote === message.id} savingAction={answerActionSaving} onSave={() => saveResearchAnswer(message.id)} onCopy={() => void copyAnswer(message.content)} onSubmit={action => submitResearchResult(message.id, action)} onContinue={focusComposer} /> : <div className="studio-answer-actions"><button type="button" className="text-button" onClick={() => void copyAnswer(message.content)}><Copy size={14} />复制答复</button>{conversation.project_id && <button type="button" className="text-button research-save-answer" disabled={!!savingNote} onClick={() => void saveResearchAnswer(message.id)}><Bookmark size={14} />{savingNote === message.id ? '正在保存…' : '保存为研究笔记'}</button>}</div>)}
                {turn?.state === 'failed' && conversation.messages.filter(item => item.role === 'user').at(-1)?.id === message.id && <button className="secondary-button compact" disabled={busy || turnInProgress} onClick={() => void submitMessage(message.content)}>重新处理</button>}{turn?.state === 'awaiting_agent' && !turn.job && <button className="secondary-button compact" disabled={busy} onClick={() => void processTurn(conversation.id, turn.id)}><Play size={14} />继续处理</button>}
              </article>
            )
            })}
            {activeTurn && <ResearchProgress label={codexProgress || (activeTurn.state === 'running' ? isResearch ? '正在研究' : '正在整理选股条件' : '等待开始处理')} startedAt={activeTurn.created_at} updatedAt={progressUpdatedAt || activeTurn.updated_at} stopping={stopping} onStop={() => void stopTurn()} />}
          </div>
          {showLatest && <button type="button" className="conversation-latest-button" onClick={() => scrollToLatest()}><ArrowDown size={14} />查看最新</button>}
        </div>
        <form className="conversation-composer" ref={composerRef} onSubmit={(event) => { event.preventDefault(); void submitMessage() }}>
          {isResearch && <details className="default-scope-details"><summary>研究范围：{researchCodes.length ? `${researchCodes.length} 只指定股票` : '不限研究股票'} · 截止 {researchDate || '待指定'}<span>修改</span></summary><div className="scope-picker"><label>研究截止日<input aria-label="研究截止日" type="date" value={researchDate} disabled={busy || turnInProgress || researchScopeSaving || loadingConversation} onChange={event => { researchDateEdited.current = true; setResearchDate(event.target.value) }} /></label><label>研究股票代码<textarea aria-label="研究股票代码" rows={2} value={researchCodesInput} disabled={busy || turnInProgress || researchScopeSaving || loadingConversation} onChange={event => setResearchCodesInput(event.target.value)} placeholder="600000.SH, 000001.SZ" /></label>{researchScopeIssue && <p role="alert">{researchScopeIssue}</p>}{conversation && <button type="button" className="secondary-button compact" disabled={!researchScopeDirty || !!researchScopeIssue || busy || turnInProgress || researchScopeSaving} onClick={() => void saveResearchScope()}>{researchScopeSaving ? '保存中…' : '保存研究范围'}</button>}{researchScopeDirty && <small>范围有未保存修改。</small>}</div></details>}
          {conversation?.screening_draft_source && <div className="conversation-pending-source"><span>来源：研究答复</span><button type="button" className="text-button" onClick={() => onOpenConversation?.(conversation.screening_draft_source!.source_conversation_id, 'screening', 'research')}>查看原研究</button></div>}
          <label htmlFor="conversation-input">{isResearch ? '研究要求' : '选股要求'}</label>
          {pendingSource && <div className="conversation-pending-source"><span>{pendingSource.label}</span><button type="button" className="icon-button" aria-label="移除来源页" onClick={() => setSource(null)}><X size={14} /></button></div>}
            <textarea
            id="conversation-input"
            aria-label={isResearch ? '研究要求' : '选股要求'}
            ref={textareaRef}
            value={draft}
            maxLength={8000}
            disabled={busy || saving || !conversationReady || loadingConversation || loadingSessions}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={isResearch ? '输入公司、行业或研究问题…' : '描述你的选股条件…'}
          />
          {!isResearch && !task && <details className="screening-scope-editor"><summary><span>{scopeOverrides.pool || scopeOverrides.date ? '选定范围与日期' : '默认范围与日期'}</span><strong>{scopePool === 'all' ? '全部A股' : watchlists.find(item => item.id === scopePool)?.name || '指定股票池'} · {scopeDate || '待指定'}</strong><span>修改</span></summary><div className="screening-default-scope scope-picker"><label>{scopeOverrides.pool ? '选定范围' : '默认范围'}<select aria-label="默认股票范围" disabled={busy || !conversationReady || loadingConversation || loadingSessions} value={scopePool} onChange={event => { setScopePool(event.target.value); setScopeOverrides(current => ({ ...current, pool: true })) }}><option value="all">全部A股</option>{watchlists.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>{scopeOverrides.date ? '选定截止日' : '默认截止日'}<input aria-label="默认行情日期" disabled={busy || !conversationReady || loadingConversation || loadingSessions} type="date" max={data?.last_date} value={scopeDate} onChange={event => { setScopeDate(event.target.value); setScopeOverrides(current => ({ ...current, date: true })) }} /></label></div></details>}
          <div className="conversation-composer-footer">
            {isResearch && <ResearchAssistantSelect value={assistantId} snapshot={conversation?.assistant} disabled={busy || saving || assistantSaving || turnInProgress || !conversationReady || loadingConversation || loadingSessions} onChange={id => void changeAssistant(id)} />}
            <label className="studio-mode-select"><span>{isResearch ? '研究深度' : '条件核验'}</span><select aria-label="研究深度" value={researchDepth} disabled={busy || saving || modeSaving || turnInProgress || !conversationReady || loadingConversation || loadingSessions} onChange={event => void changeResearchDepth(event.target.value as ResearchDepth)}>{Object.entries(depthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{modeSaving && <LoaderCircle size={14} className="spin" />}</label>
            <span>{draft.length >= 7000 ? `${draft.length}/8000` : ''}</span>
            <button className="primary-button" type="submit" disabled={busy || saving || assistantSaving || modeSaving || researchScopeSaving || (isResearch ? !!researchScopeIssue || researchScopeDirty : scopeEdited && scopeDirty) || scopeSaveState === 'saving' || turnInProgress || !conversationReady || loadingConversation || loadingSessions || !draft.trim()}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={16} />}
              {busy ? '处理中…' : isResearch ? '发送' : screeningStarted ? '发送修改' : '生成筛选方案'}
            </button>
          </div>
          <p className="composer-keyboard-hint"><span>Enter 发送 · Shift + Enter 换行</span></p>
        </form>
      </section>

      {isResearch && resultsOpen && <div className="research-results-backdrop" onClick={() => setResultsOpen(false)} aria-hidden="true" />}
      <aside ref={taskPanelRef} id={isResearch ? 'research-results-drawer' : undefined} className={'conversation-task-panel ' + (isResearch ? 'research-results-drawer' : '')} role={isResearch ? 'dialog' : undefined} aria-modal={isResearch ? true : undefined} aria-label={isResearch ? '研究成果' : '当前筛选任务和结果'} hidden={!showTaskPanel} onKeyDown={event => { if (!isResearch) return; if (event.key === 'Escape') { event.stopPropagation(); setResultsOpen(false) }; trapDialogTab(event) }}>
        {isResearch && <button ref={resultsCloseRef} type="button" className="icon-button research-results-close" aria-label="关闭研究成果" onClick={() => setResultsOpen(false)}><X size={19} /></button>}
        <div className="studio-results-heading"><div><span className="studio-eyebrow">{isResearch ? '本次研究' : '本次选股'}</span><h2>{isResearch ? '研究成果' : '方案与结果'}</h2></div>{!isResearch && task && <span className={`screening-plan-status ${canExecute ? 'ready' : ''}`}>{canExecute ? '条件就绪' : '待补全'}</span>}</div>
        {conversation?.id === selectedId && <ResearchPanel key={conversation.id} conversationId={conversation.id} turnActive={turnInProgress} refreshKey={refreshIndex + conversation.messages.length} onContentChange={setHasResearchResults} showGenerate={isResearch && conversation.messages.some(message => message.role === 'assistant' && !isExecutionFailure(message.content)) && !conversation.turns.every(turn => turn.state === 'failed' || turn.state === 'cancelled')} />}
        {!isResearch && task && <section className="conversation-task-section">
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
            <p className="conversation-muted">本地日线 · 复权口径未核实</p>
            <div className="conversation-task-actions">
              {canExecute ? <button className="primary-button" disabled={busy || saving || turnInProgress || loadingConversation || runInProgress || !!pendingTurn || !!draft.trim() || !executableTurn} onClick={() => void startScreening()}><Play size={15} />{runInProgress ? '正在筛选…' : taskHasRun ? '按当前条件再筛一次' : '确认并开始筛选'}</button> : <button className="secondary-button" disabled={busy || saving || turnInProgress} onClick={focusComposer}>补充筛选要求</button>}
              <button className="secondary-button" disabled={!canSave || busy || saving || turnInProgress || scopeDirty || scopeSaveState === 'saving'} title={!canSave ? '请先补充完整条件和股票范围' : undefined} onClick={() => void saveTask(suggestedName)}>{saving ? <LoaderCircle size={14} className="spin" /> : <Bookmark size={14} />}{saving ? '保存中…' : '保存方案'}</button>
              <button className="icon-button" disabled={!canSave || busy || saving || turnInProgress} title="设置方案名称" aria-label="设置方案名称" aria-expanded={saveOpen} onClick={() => { setSaveName(suggestedName); setSaveOpen(value => !value) }}><Pencil size={15} /></button>
            </div>
            {!canExecute && !task.unresolved.length && <p className="conversation-muted">请先{scopeDirty && scopeEdited ? '等待范围与日期自动保存' : missingTaskInfo || '完整条件'}。</p>}
            {canExecute && !!draft.trim() && <p className="conversation-muted">输入框中还有未发送的内容，请先发送或清空，再确认筛选。</p>}
            {saveOpen && <form className="conversation-save-form" onSubmit={event => { event.preventDefault(); void saveTask() }}>
              <label htmlFor="saved-task-name">方案名称</label>
              <input id="saved-task-name" autoFocus value={saveName} maxLength={120} disabled={saving} onChange={event => setSaveName(event.target.value)} placeholder="方案名称" />
              <div><button className="primary-button compact" disabled={saving || !saveName.trim()} type="submit">{saving ? '保存中…' : '确认保存'}</button><button className="text-button" type="button" disabled={saving} onClick={() => setSaveOpen(false)}>取消</button></div>
            </form>}
          </>
        </section>}

        {!isResearch && (!!runs.length || !!pendingTurn) && <section ref={runSectionRef} className="conversation-run-section">
          <div className="conversation-panel-heading">
            <h2>筛选结果</h2>
            {runs.length > 0 && <select aria-label="查看筛选运行" value={viewingRunId} onChange={(event) => setViewingRunId(event.target.value)}>
              {runs.map((item) => <option key={item.id} value={item.id}>v{item.task_revision} · {item.as_of} · {stateLabels[item.status] ?? item.status}</option>)}
            </select>}
          </div>
          {pendingTurn && <div className="conversation-retry-notice" role="status">
            <span>筛选尚未启动。</span>
            <button className="secondary-button compact" disabled={busy} onClick={() => void retryExecution(pendingTurn.id)}><Play size={14} />{busy ? '正在启动…' : '重试启动筛选'}</button>
          </div>}
          {!runs.length ? (
            <p className="conversation-muted">尚无筛选运行</p>
          ) : loadingRun || !run ? (
            <p className="conversation-muted"><LoaderCircle size={14} className="spin" />正在读取运行…</p>
          ) : (
            <ScreeningResultView
              asOf={run.as_of}
              revision={run.task_revision}
              status={run.status}
              isCurrent={Boolean(activeRun)}
              progress={{ message: run.job.message, percent: run.job.progress }}
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
            />
          )}
        </section>}
      </aside>
      </div>
      {chart && <StockChartDialog code={chart.code} asOf={chart.date} onClose={() => setChart(null)} />}
    </div>
  )
}
