import LoadingState from '../LoadingState'
import { StockText } from '../StockMentions'
import { localStorage, sessionStorage } from '../../authStorage'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, Bookmark, ChartNoAxesCombined, Check, ChevronLeft, ChevronRight, Copy, FileSearch, History, LoaderCircle, Newspaper, Pencil, Play, Plus, RefreshCw, Search, X } from 'lucide-react'
import {
  api,
  ApiRequestError,
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
import { useWorkspaceSession } from '../../WorkspaceSession'
import { trapDialogTab } from '../../keyboard'
import { TaskCompositionEditor, taskUniverseLabel, type CompositionEdit } from './TaskBrief'
import SavedTaskLibrary from './SavedTaskLibrary'
import ScreeningTemplates, { type ScreeningTemplate } from './ScreeningTemplates'
import ScreeningExamples, { type ScreeningExampleGroup } from './ScreeningExamples'
import ScreeningDeliveryCard from './ScreeningDeliveryCard'
import ScreeningReadiness from './ScreeningReadiness'
import ScreeningSettings from './ScreeningSettings'
import './screening-simple.css'
import ResearchPanel from './ResearchPanel'
import ResearchAnswer from './ResearchAnswer'
import ResearchResultActions, { type ResearchResultRequest } from './ResearchResultActions'
import AnswerSources from './AnswerSources'
import { isExecutionFailure, ResearchFailure, ResearchProgress } from './ResearchFeedback'
import { appendResearchActivity, codexEventLabel, type ResearchActivity } from './researchProgress'
import ResearchActivityHistory from './ResearchActivityHistory'
import { answerVersions, displayedMessages } from './answerVersions'
import ResearchModelPicker from './ResearchModelPicker'
import ResearchConversationTools from './ResearchConversationTools'
import ResearchComposerMenu from './ResearchComposerMenu'
import ResearchStarters from './ResearchStarters'
import ResearchTaskEntry from './ResearchTaskEntry'
import { useCompanyCommands } from './useCompanyCommands'
import { DraftAttachmentChips, MessageAttachmentChips } from './AttachmentChips'
import { useConversationAttachments, type ConversationAttachment } from './useConversationAttachments'
import { readModelPreference, writeModelPreference, type ModelSelection } from '../../modelSelection'
import ProjectMembership from './ProjectMembership'
import StockChartDialog from '../StockChartDialog'
import MyIndicators from '../indicators/MyIndicators'
import type { DataStatus } from '../../api'
import type { ConversationHistoryChange } from '../ConversationHistoryItem'
import ScreeningResultView, { type UnifiedDecisionItem } from '../ScreeningResultView'
import { screeningAdjustments } from '../../screeningAdjustments'

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
  created_at: string
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
  job?: { state: string; progress: number; message: string } | null
}

type CodexEvent = {
  sequence: number
  method: string
  payload: Record<string, unknown>
}

type PromptSuggestion = { label: string; prompt: string; description?: string }
type ScreeningInputIntent = 'edit' | 'question' | 'message'
type ScreeningStage = 'brief' | 'plan' | 'result'

const screeningWorkspacePromptMarker = '\n\n[选股工作台指令]\n'
const screeningQuestionPattern = /[?？]|为什么|为何|怎么(?:回事|样)?|如何|是否|能否|可否|是不是|会不会|什么原因|解释一下|说明一下|分析一下/
const screeningClarificationEditPattern = /^请根据以下回答修改筛选方案/
const screeningNoExecutionPattern = /(?:不要|不必|不用|不需要|先不|暂不|别)(?:.{0,12})(?:执行|运行|筛选|重筛|重跑)|仅(?:生成|查看|核对)(?:筛选)?方案/
const screeningEditPattern = /改成|改为|修改|调整|新增|增加|添加|加上|加入|删除|移除|去掉|剔除|保留|排除|只看|仅看|筛选|筛出|找出|限定|放宽|收紧|设为|设定为|替换|均线|股价|收盘价|涨幅|跌幅|成交量|成交额|市值|PE|PB|ROE|净利润|营收|负债率|股息率|行业|换手率|回撤|波动率/i

function screeningInputIntent(value: string): ScreeningInputIntent {
  const text = value.trim()
  if (!text) return 'message'
  if (screeningClarificationEditPattern.test(text)) return 'edit'
  if (screeningQuestionPattern.test(text)) return 'question'
  if (screeningNoExecutionPattern.test(text)) return 'message'
  return screeningEditPattern.test(text) ? 'edit' : 'message'
}

const scopeLabels: Record<ConversationScope, string> = {
  screening: '所有资料',
  technical: '行情',
  report: '研报',
  news: '资讯',
  pattern: '形态',
}
const depthLabels: Record<ResearchDepth, string> = { standard: '普通', deep: '深入' }
const unrestrictedResearchScope: ResearchScope = {
  as_of: null, stock_codes: [], report_lookback_calendar_days: null,
  news_lookback_calendar_days: null, price_basis: null,
}
function hasResearchLimits(scope?: ResearchScope) {
  return !!scope && (!!scope.as_of || !!scope.stock_codes?.length || scope.report_lookback_calendar_days != null
    || scope.news_lookback_calendar_days != null || scope.price_basis != null)
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
const promptSuggestions: Record<ConversationScope, PromptSuggestion[]> = {
  screening: [
    { label: '市场机会', description: '走势 · 线索 · 风险', prompt: '最近哪些股票值得进一步研究？请结合走势、成交和已有资料，列出理由与风险。' },
    { label: '公司比较', description: '经营 · 估值 · 差异', prompt: '比较贵州茅台和五粮液最近的经营表现、估值与风险，标明数据日期和来源。' },
    { label: '研报证据', description: '原文 · 事实 · 预测', prompt: '从已有研报中找出有订单增长实际证据的公司，区分已实现与预测，并列出原文。' },
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
const screeningQuickTasks = [
  { label: '趋势选股', description: '均线 · 涨幅 · 趋势', prompt: promptSuggestions.technical[0].prompt, icon: ChartNoAxesCombined },
  { label: '研报选股', description: '订单 · 业绩 · 证据', prompt: promptSuggestions.report[0].prompt, icon: FileSearch },
  { label: '资讯选股', description: '公告 · 催化 · 变化', prompt: promptSuggestions.news[2].prompt, icon: Newspaper },
]
const screeningSuggestionLabels: Partial<Record<ConversationScope, string>> = {
  technical: '行情条件', report: '研报证据', news: '资讯事件', pattern: '走势形态',
}
const screeningExampleGoals: Record<string, string> = {
  '均线上方且上涨': '找趋势走强的股票',
  '低 RSI 且低于均线': '找超跌反弹的股票',
  '缩量回调': '找缩量回调的股票',
  '订单证据': '找研报里订单已落地的公司',
  '业绩兑现': '找研报里业绩已兑现的公司',
  '风险提示': '找研报明确提示风险的公司',
  '业绩预告': '找业绩预告改善的公司',
  '订单动态': '找新增订单落地的公司',
  '重要催化': '找有明确业务催化的公司',
  '突破形态': '找向上突破形态的股票',
  '底部反转': '找底部反转形态的股票',
  '趋势延续': '找上升趋势延续的股票',
}
const screeningExampleGroups: ScreeningExampleGroup[] = (Object.entries(screeningSuggestionLabels) as [ConversationScope, string][])
  .map(([id, label]) => ({
    id, label, items: promptSuggestions[id].map(item => ({ ...item, goal: screeningExampleGoals[item.label] ?? item.label })),
  }))
const screeningUnsupportedPattern = /市盈率|市净率|市值|\b(?:PE|PB|ROE|ST)\b|净利润|营业收入|营收|财务|估值|历史行业|行业分类|行业归属|所属行业|分钟线|分钟行情|换手率|北向资金|主力资金/i
function screeningUnsupportedHint(value: string) {
  if (!screeningUnsupportedPattern.test(value)) return ''
  return '你提到的估值、财务、行业或分钟线字段，本地选股暂不提供；可以改用价格、成交量、形态或研报/资讯原文条件。'
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

const validDrafts = (value: unknown): value is Record<string, string> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string')
type DraftSource = { reference: ConversationSourceReference; label: string }
type MessagePayload = { base_revision: number; research_scope_revision?: number; assistant_revision?: number; model_revision?: number; content: string; source_refs: ConversationSourceReference[]; attachment_ids?: string[] }
type MessageAttempt = { key: string; clientId: string; payload: MessagePayload }
type AttachmentCreationIntent = { request_id: string; payload: Record<string, unknown> }
const ATTACHMENT_CREATION_KEY = 'conversation.attachmentCreationRequests'
const validSources = (value: unknown): value is Record<string, DraftSource | null> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item === null || (item && typeof item === 'object' && typeof item.label === 'string' && item.reference && typeof item.reference.kind === 'string' && typeof item.reference.source_id === 'string'))
const validMessageAttempts = (value: unknown): value is Record<string, MessageAttempt> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item && typeof item === 'object' && typeof item.key === 'string' && typeof item.clientId === 'string' && item.payload && typeof item.payload.content === 'string' && Number.isInteger(item.payload.base_revision) && Array.isArray(item.payload.source_refs) && (item.payload.attachment_ids === undefined || Array.isArray(item.payload.attachment_ids) && item.payload.attachment_ids.every((id: unknown) => typeof id === 'string')) && (item.payload.research_scope_revision === undefined || Number.isInteger(item.payload.research_scope_revision)) && (item.payload.model_revision === undefined || Number.isInteger(item.payload.model_revision) && item.payload.model_revision >= 0))

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
  conversationUpdate, onStartIndicatorScreening, initialCommonIndicators, onStartScreening, onOpenReports,
  embedded = false,
}: {
  data?: DataStatus | null
  embedded?: boolean
  initialCommonIndicators?: boolean
  onStartIndicatorScreening?: (prompt: string) => void
  onStartScreening?: () => void
  onOpenReports?: () => void
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
  conversationUpdate?: { id: string } & ConversationHistoryChange
}) {
  const [openCommonIndicators, setOpenCommonIndicators] = useState(!!initialCommonIndicators)
  const workspaceSession = useWorkspaceSession()
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
  const [researchDepth, setResearchDepth] = useState<ResearchDepth>('standard')
  const [modeSaving, setModeSaving] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [conversation, setConversation] = useState<Conversation | null>(null)
  useEffect(() => {
    if (!conversation) return
    const title = conversation.title || conversation.messages.find(message => message.role === 'user')?.content
    if (title) workspaceSession.setTitle?.(title)
  }, [conversation?.id, conversation?.title, conversation?.messages.length])
  const archived = conversation?.state === 'archived'
  useEffect(() => {
    if (!conversationUpdate) return
    setConversation(current => current?.id === conversationUpdate.id ? { ...current, ...conversationUpdate } : current)
    setSessions(current => current.map(item => item.id === conversationUpdate.id ? { ...item, ...conversationUpdate } : item))
  }, [conversationUpdate])
  const [modelPreference, setModelPreference] = useState<ModelSelection | null>(readModelPreference)
  const [modelSaving, setModelSaving] = useState(false)
  const modelSavingRef = useRef(false)
  const modelSelection = conversation ? { model_id: conversation.model_id, reasoning_effort: conversation.reasoning_effort } : modelPreference ?? undefined
  const modelSelectionKey = JSON.stringify([modelSelection?.model_id, modelSelection?.reasoning_effort])
  const [modelAvailability, setModelAvailability] = useState<{ key: string; available: boolean } | null>(null)
  const [modelCatalogError, setModelCatalogError] = useState('')
  const modelUnavailable = modelAvailability?.key === modelSelectionKey && !modelAvailability.available
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
  const [screeningExamplesOpen, setScreeningExamplesOpen] = useState(false)
  useEffect(() => { setScreeningExamplesOpen(false) }, [draftKey, newResearchKey])
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
  const [researchActivities, setResearchActivities] = useState<ResearchActivity[]>([])
  const [versionSelection, setVersionSelection] = useState<Record<string, string>>({})
  const answerVersionAttempt = useRef<{ key: string; requestId: string } | null>(null)
  const answerVersionLock = useRef(false)
  const [progressUpdatedAt, setProgressUpdatedAt] = useState('')
  const [savedNoteProject, setSavedNoteProject] = useState('')
  const [hasResearchResults, setHasResearchResults] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const resultsToggleRef = useRef<HTMLButtonElement>(null)
  const resultsCloseRef = useRef<HTMLButtonElement>(null)
  const [screeningPanelOpen, setScreeningPanelOpen] = useState(false)
  const [screeningDetailsMounted, setScreeningDetailsMounted] = useState(false)
  const [screeningPanelTab, setScreeningPanelTab] = useState<'plan' | 'result'>('plan')
  const [compactScreeningPanel, setCompactScreeningPanel] = useState(() => window.matchMedia?.('(max-width: 1100px)').matches ?? window.innerWidth <= 1100)
  const screeningDetailsRef = useRef<HTMLElement>(null)
  const screeningDeliveryRef = useRef<HTMLDivElement>(null)
  const screeningPanelReturnFocus = useRef<HTMLElement | null>(null)
  const screeningReadingSnapshot = useRef<{ id: string; top: number; follow: boolean } | null>(null)
  const readingChangedWhilePanel = useRef(false)
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 1100px)')
    if (!media) return
    const update = () => setCompactScreeningPanel(media.matches)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const screeningPanelToggleRef = useRef<HTMLButtonElement>(null)
  const screeningPanelCloseRef = useRef<HTMLButtonElement>(null)
  const [loadingSessions, setLoadingSessions] = useState(true)
  const [loadingConversation, setLoadingConversation] = useState(false)
  const [loadingRun, setLoadingRun] = useState(false)
  const [runError, setRunError] = useState('')
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
  const [compositionSaving, setCompositionSaving] = useState(false)
  const [answerActionSaving, setAnswerActionSaving] = useState(false)
  const answerActionAttempt = useRef<{ key: string; id: string } | null>(null)
  const [chart, setChart] = useState<{ code: string; date: string } | null>(null)
  const scopeAttempt = useRef<{ key: string; id: string } | null>(null)
  const compositionAttempt = useRef<{ key: string; id: string } | null>(null)
  const scopeReadyKey = useRef('')
  const scopeSavingRef = useRef(false)
  const modeChosenRef = useRef(false)
  const selectedIdRef = useRef('')
  const initialSelectionRef = useRef<{ loaded: boolean; id?: string }>({ loaded: false })
  const freshConversationRef = useRef(false)
  const messageListRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!isResearch) return
    const resizeComposer = () => {
      const input = textareaRef.current
      if (!input) return
      input.style.height = '0px'
      const naturalHeight = input.scrollHeight
      input.style.height = `${Math.max(56, Math.min(160, naturalHeight))}px`
      input.style.overflowY = naturalHeight > 160 ? 'auto' : 'hidden'
    }
    resizeComposer()
    window.addEventListener('resize', resizeComposer)
    return () => window.removeEventListener('resize', resizeComposer)
  }, [isResearch, draft, selectedId])
  const sessionsRef = useRef<HTMLElement>(null)
  const disclosureRef = useRef<HTMLButtonElement>(null)
  const consumedNewResearchRef = useRef<number | null>(null)
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
  const buttonExecutionAttempt = useRef<{ key: string; requestId: string } | null>(null)
  const attachmentCreationRef = useRef<{ key: string; promise: Promise<{ conversationId: string; draftKey: string }> } | null>(null)
  const attachmentCreationIntents = useRef<Record<string, AttachmentCreationIntent>>({})
  const attachmentOwnerRef = useRef('')
  attachmentOwnerRef.current = JSON.stringify([initialWorkflowType, scope, selectedId, initialConversationId || '', initialNewDraft, newResearchKey || 0])
  const attachments = useConversationAttachments(draftKey, conversation?.id, ensureAttachmentConversation)

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
  useEffect(() => {
    if (loadingSessions || !initialPrompt || (initialConversationId && selectedId !== initialConversationId)) return
    if (!initialConversationId) createConversation(initialAssistantId || 'general')
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
    if (loadingSessions || busy || modeSaving || modelSaving || attachments.uploading || scopeSavingRef.current || consumedNewResearchRef.current === newResearchKey) return
    consumedNewResearchRef.current = newResearchKey
    createConversation(initialAssistantId || 'general', initialSource ?? null)
    onNewResearchConsumed?.()
  }, [newResearchKey, loadingSessions, busy, modeSaving, modelSaving, attachments.uploading, onNewResearchConsumed, initialAssistantId])
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

  async function editComposition(change: CompositionEdit) {
    if (isResearch || !conversation || !task || busy || saving || turnInProgress || scopeDirty || scopeSaveState === 'saving') return
    const operation = change.remove_reference_id ? `remove:${change.remove_reference_id}` : `logic:${change.logic_mode}`
    const expectedReferenceIds = task.references.map(item => item.reference_id)
    const key = JSON.stringify([conversation.id, task.revision, operation, task.logic_tree, expectedReferenceIds])
    if (compositionAttempt.current?.key !== key) compositionAttempt.current = { key, id: crypto.randomUUID() }
    setCompositionSaving(true); setBusy(true); setError('')
    try {
      await api(`/conversations/${conversation.id}/composition`, {
        method: 'POST',
        body: JSON.stringify({
          base_revision: task.revision,
          client_message_id: compositionAttempt.current.id,
          expected_logic_tree: task.logic_tree,
          expected_reference_ids: expectedReferenceIds,
          ...change,
        }),
      })
      await reloadConversation(conversation.id)
      if (selectedIdRef.current === conversation.id) compositionAttempt.current = null
    } catch (reason) {
      if (selectedIdRef.current === conversation.id) {
        setError((reason as Error).message)
        if (/方案已更新|组合已被其他操作更新|相同请求ID/.test((reason as Error).message)) {
          compositionAttempt.current = null
          try { await reloadConversation(conversation.id) } catch { /* Keep the original edit error visible. */ }
        }
      }
    } finally {
      if (selectedIdRef.current === conversation.id) setCompositionSaving(false)
      setBusy(false)
    }
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
    try { if (!embedded) { localStorage.setItem(`${sessionStorageKey(scope)}.${initialWorkflowType}`, id || '__new__'); localStorage.setItem(sessionStorageKey(scope), id || '__new__') } } catch { /* Keep selection available when storage is unavailable. */ }
    freshConversationRef.current = !id
    selectedIdRef.current = id
    setScopeEdited(false)
    setScopeSaveState('idle')
    scopeAttempt.current = null
    setSelectedId(id)
    if (!id && !isResearch) setScreeningPanelOpen(false)
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

  function openScreeningPanel(tab: 'plan' | 'result' = 'plan') {
    if (isResearch) return
    setScreeningPanelTab(tab)
    setScreeningDetailsMounted(true)
    if (tab === 'result') {
      const current = runs.find(item => item.id === conversation?.active_run_id) ?? runs.find(item => item.task_revision === task?.revision) ?? runs[0]
      if (current) setViewingRunId(current.id)
    }
    if (screeningPanelOpen) {
      if (screeningPanelTab !== tab) requestAnimationFrame(() => { if (screeningDetailsRef.current) screeningDetailsRef.current.scrollTop = 0 })
      return
    }
    screeningPanelReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    screeningReadingSnapshot.current = { id: selectedId || '', top: messageListRef.current?.scrollTop || 0, follow: followLatestRef.current }
    readingChangedWhilePanel.current = false
    setScreeningPanelOpen(true)
    requestAnimationFrame(() => {
      if (!screeningDetailsRef.current) return
      screeningDetailsRef.current.scrollTop = 0
      screeningDetailsRef.current.focus({ preventScroll: true })
    })
  }
  function navigateScreeningStage(next: ScreeningStage) {
    if (isResearch) return
    if (next === 'brief') { setScreeningPanelOpen(false); globalThis.setTimeout(() => focusComposer(), 0); return }
    openScreeningPanel(next === 'result' ? 'result' : 'plan')
  }
  function closeScreeningPanel() {
    setScreeningPanelOpen(false)
    const snapshot = screeningReadingSnapshot.current
    requestAnimationFrame(() => {
      if (snapshot?.id === (selectedIdRef.current || '') && !readingChangedWhilePanel.current && messageListRef.current) {
        messageListRef.current.scrollTop = snapshot.top
        followLatestRef.current = snapshot.follow
      }
      const origin = screeningPanelReturnFocus.current
      if (origin?.isConnected) origin.focus({ preventScroll: true })
      else screeningPanelToggleRef.current?.focus({ preventScroll: true })
    })
  }
  function focusScreeningQuestions() {
    setScreeningPanelOpen(false)
    requestAnimationFrame(() => screeningDeliveryRef.current?.querySelector<HTMLInputElement>('input')?.focus())
  }
  function onScreeningPanelTabsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'plan' : event.key === 'End' ? 'result' : screeningPanelTab === 'plan' ? 'result' : 'plan'
    setScreeningPanelTab(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-panel-tab="${next}"]`)?.focus()
  }

  function prepareDraft(value: string) {
    setDraft(value)
    focusComposer()
  }

  function composeClarification(value: string) {
    const next = draft.trim() ? `${value}\n\n${draft.trim()}` : value
    if (next.length > 8000) { setError('当前草稿加上补充回答超过 8000 字，请先精简草稿。'); return }
    prepareDraft(next)
    void submitMessage(next, undefined, false, { previewOnly: screeningExecutionPaused })
  }

  function applyScreeningAdjustment(prompt: string) {
    navigateScreeningStage('brief')
    prepareDraft(prompt)
  }

  function prepareIndicatorDraft(value: string) {
    const next = draft.trim() ? `${draft.trim()}\n\n${value}` : value
    if (next.length > 8000) { setError('当前草稿加上指标请求超过 8000 字，请先精简草稿。'); return false }
    prepareDraft(next)
    return true
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
    setTask(nextTask)
    setRuns(runList.items)
    setViewingRunId((current) => (
      current && runList.items.some((item) => item.id === current)
        ? current
        : next.active_run_id ?? runList.items[0]?.id ?? ''
    ))
    setSessions((current) => current.map((item) => item.id === next.id ? {
      ...item,
      title: next.title || next.messages.find((message) => message.role === 'user')?.content.slice(0, 120) || item.title,
      task_revision: next.task_revision,
      workflow_type: conversationWorkflow(next, initialWorkflowType),
      research_depth: next.research_depth,
      last_turn_state: next.turns.find(turn => turn.user_message_id === next.messages.filter(message => message.role === 'user').at(-1)?.id)?.state,
      active_run_id: next.active_run_id,
      updated_at: next.updated_at,
    } : item).sort((left, right) => right.updated_at.localeCompare(left.updated_at)))
    return next
  }

  async function enqueueAuthorizedTurn(conversationId: string, turnId: string, action: 'message' | 'button' = 'message', button?: { revision: number; requestId: string }) {
    if (action === 'button' && !button) throw new Error('缺少本次筛选的方案版本。')
    const key = action === 'button'
      ? `${conversationId}:${turnId}:button:${button!.revision}:${button!.requestId}`
      : `${conversationId}:${turnId}:message`
    let request = executionAttempts.current.get(key)
    if (!request) {
      request = api<{ run_id: string }>(`/conversations/${conversationId}/turns/${turnId}/execute`, {
        method: 'POST',
        body: JSON.stringify(action === 'button' ? { action, revision: button!.revision, request_id: button!.requestId } : { action }),
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
      const before = await reloadConversation(conversationId)
      const turn = await api<ConversationTurn>(`/conversations/${conversationId}/turns/${turnId}/process`, { method: 'POST' })
      const after = await reloadConversation(conversationId)
      if (!isResearch) {
        if (!(after.active_run_id && after.active_run_id !== before.active_run_id) && executeWhenReady && turn.result.ready_to_execute && turn.result.execution_authorized === true) {
          await enqueueAuthorizedTurn(conversationId, turnId)
          await reloadConversation(conversationId)
        }
      }
      if (isResearch) await reloadConversation(conversationId)
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
    if (initialWorkflowType === 'screening') setScreeningPanelOpen(false)
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
    if (embedded) {
      initialSelectionRef.current = { loaded: true, id: initialConversationId }
      selectConversation(initialConversationId || '')
      setLoadingSessions(false)
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
    if (initialWorkflowType === 'screening') setScreeningPanelOpen(false)
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
    if (loadingSessions || !selectedId || (!embedded && !sessions.some((item) => item.id === selectedId))) return
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
    setResearchActivities([])
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
        for (let batch = 0; active && batch < 10; batch++) {
          const events = await api<{ items: CodexEvent[]; next_after: number; has_more?: boolean }>(
            `/conversations/${selectedId}/turns/${activeTurnId}/codex-events?after=${eventCursor}&limit=500`,
          )
          if (active && selectedIdRef.current === selectedId) {
            if (events.items.length) setProgressUpdatedAt(new Date().toISOString())
            for (const event of events.items) {
              const label = codexEventLabel(event)
              if (label) setCodexProgress(label)
            }
            setResearchActivities(previous => events.items.reduce(appendResearchActivity, previous))
          }
          const advanced = events.next_after > eventCursor
          // Consume the final page too, so the next poll does not replay deltas
          // or refresh the apparent progress time with already-seen events.
          if (advanced) eventCursor = events.next_after
          if (!events.has_more || !advanced) break
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
      setRunError('')
      setDecisions([])
      setDecisionTotal(0)
      return
    }
    let active = true
    let pending = false
    let completed = false
    let timer = 0
    setRun(null)
    setRunError('')
    const load = async () => {
      if (pending || completed) return
      pending = true
      try {
        const next = await api<TaskRun>(`/conversations/${conversation.id}/screening-runs/${viewingRunId}`)
        if (active) {
          setRun(next)
          setRunError('')
          setRuns(items => items.map(item => item.id === next.id ? { ...item, status: next.status } : item))
          completed = !['queued', 'running'].includes(next.status)
          if (completed) globalThis.clearInterval(timer)
        }
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
  }, [conversation?.id, viewingRunId, refreshIndex, isResearch])

  useEffect(() => { setDecisionOffset(0); setDecisionQuery(''); setDecisionState('true'); setDecisionError(''); setDecisions([]); setDecisionTotal(0) }, [viewingRunId])
  useEffect(() => { setSaveOpen(false); setNotice('') }, [selectedId, task?.revision])

  useEffect(() => {
    if (!screeningPanelOpen || screeningPanelTab !== 'result') return
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
  }, [conversation?.id, run?.id, run?.status, decisionState, decisionQuery, decisionOffset, decisionReload, screeningPanelOpen, screeningPanelTab])

  const turnsByMessage = useMemo(() => new Map(
    (conversation?.turns ?? []).map((turn) => [turn.user_message_id, turn]),
  ), [conversation?.turns])
  const turnInProgress = conversation?.turns.some((turn) => ['awaiting_agent', 'running'].includes(turn.state)) ?? false
  const companyShortcuts = useCompanyCommands({
    enabled: isResearch, draft, contextKey: draftKey, anchor: textareaRef, onChange: setDraft,
    disabled: !!archived || busy || saving || assistantSaving || modeSaving || modelSaving || turnInProgress || !conversationReady || loadingConversation || loadingSessions,
  })
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

  function createConversation(nextAssistant = 'general', source: { reference: ConversationSourceReference; label: string } | null = null) {
    if (busy || modeSaving || modelSavingRef.current || scopeSavingRef.current || attachments.uploading) return
    templateGenerationRef.current += 1
    templateAttemptRef.current = null
    setScopePool('all'); setScopeDate(data?.last_date ?? ''); setScopeOverrides({ pool: false, date: false })
    selectConversation('')
    companyShortcuts.clear(initialWorkflowType + ':' + scope + ':new')
    setDrafts(current => ({ ...current, [initialWorkflowType + ':' + scope + ':new']: '' }))
    setAssistantDrafts(current => ({ ...current, [initialWorkflowType + ':' + scope + ':new']: nextAssistant }))
    setModelPreference(readModelPreference())
    setError('')
    setConversation(null)
    setTask(null)
    setRuns([])
    setRun(null)
    setViewingRunId('')
    setScreeningPanelOpen(false)
    setLoadingConversation(false)
    setLibraryTab('recent')
    setSource(source, `${initialWorkflowType}:${scope}:new`)
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
      if (!attempt.conversation) attempt.conversation = conversation ?? await api<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ entry_scope: scope, workflow_type: 'screening', research_depth: researchDepth, ...modelPreference }) })
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
      catch { if (isCurrent()) setError('基础方案已生成，自动筛选已发起；暂时无法读取最新状态，请刷新查看结果。') }
      api<{ items: SessionSummary[] }>(`/conversations?scope=${scope}&limit=50`).then(({ items }) => { if (isCurrent() && selectedIdRef.current === current.id) setSessions(items) }).catch(() => {})
    } catch (reason) { if (isCurrent() && templateOwnerRef.current === ownerKey) setError(`基础方案尚未完成：${(reason as Error).message}。可修改参数或范围后重试；若连接中断，保持参数不变再次点击可恢复。`) }
    finally { templateBusyRef.current = false; if (templateMountedRef.current) setBusy(false) }
  }

  async function reuseTask(saved: SavedScreeningTask, useLatest = false) {
    if (busy || saving || modeSaving || scopeSavingRef.current) return
    if (useLatest && !data?.last_date) { setError('最新行情日期尚未就绪，可稍后重试或在详情中按原日期复用。'); return }
    const reuseDate = useLatest ? data?.last_date : undefined
    const key = `${scope}:${saved.id}:${saved.version}:${reuseDate || 'original'}`
    if (reuseAttemptRef.current?.key !== key) reuseAttemptRef.current = { key, clientId: crypto.randomUUID() }
    const attempt = reuseAttemptRef.current
    setBusy(true)
    setError('')
    try {
      if (!attempt.conversation) attempt.conversation = await api<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ entry_scope: scope, workflow_type: 'screening', research_depth: researchDepth, ...modelPreference }) })
      const current = attempt.conversation
      if (!attempt.messageId) {
        const message = await api<{ message_id: string }>(`/conversations/${current.id}/messages`, {
          method: 'POST', body: JSON.stringify({ client_message_id: attempt.clientId, base_revision: 0, ...(current.model_revision != null ? { model_revision: current.model_revision } : {}), content: `复用已保存方案“${saved.name}”（第${saved.version}版）${reuseDate ? `，采用${reuseDate}的行情` : '，保留原截止日'}` }),
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
    } catch (reason) { setError(`复用未完成：${(reason as Error).message} 可再次点击复用以继续。`) }
    finally { setBusy(false) }
  }

  async function submitMessage(value = draft, originalAttachments?: ConversationAttachment[], retryOriginal = false, options?: { previewOnly?: boolean }) {
    if (archived) return
    const previewOnly = options?.previewOnly === true || (embedded && !isResearch && !retryOriginal && (!task || screeningInputIntent(value) === 'edit'))
    if (!retryOriginal && companyShortcuts.submit(value)) return
    const attached = originalAttachments ?? attachments.ready
    const attachmentIds = attached.map(item => item.id)
    let content = value.trim() || (attachmentIds.length ? '请分析上传的文件' : '')
    if (!content) return
    if (!retryOriginal) content = companyShortcuts.question(content)
    if (content.length > 8000) { setError('问题加上当前公司信息超过 8000 字，请先精简问题。'); return }
    if (!originalAttachments && attachments.hasUnready) { setError('请等待附件上传完成，或移除未上传的文件。'); return }
    if (modelUnavailable) { setError('当前模型或推理档位不可用，请选择可用模型后发送。'); return }
    const inputIntent = screeningInputIntent(content)
    if (!retryOriginal && !isResearch && !task) {
      const poolLabel = scopePool === 'all' ? '全部A股' : `自选分组“${watchlists.find(item => item.id === scopePool)?.name || ''}”`
      const additions = [scopeOverrides.pool ? `股票范围以界面设置为准：${poolLabel}。` : `未在要求中明确指定股票范围时，默认使用${poolLabel}。`]
      if (scopeDate) additions.push(scopeOverrides.date ? `行情截止日期以界面设置为准：${scopeDate}。` : `未在要求中明确指定截止日期时，默认使用${scopeDate}的行情。`)
      additions.push(previewOnly || screeningNoExecutionPattern.test(content)
        ? '仅整理筛选方案，暂不执行；有关键条件不明确时先向用户提问。'
        : '请整理筛选方案；条件完整后请开始筛选并直接返回结果，不等待用户再次确认；有关键条件不明确时先向用户提问。')
      content += `${screeningWorkspacePromptMarker}${additions.join('\n')}`
    } else if (!retryOriginal && !isResearch && task && inputIntent === 'edit') {
      content += `${screeningWorkspacePromptMarker}${previewOnly || screeningNoExecutionPattern.test(content)
        ? '用户提交了方案修改。更新方案但暂不执行；有关键条件不明确时先向用户提问。'
        : '用户提交了方案修改。更新条件后请开始筛选并直接返回新结果；有关键条件不明确时先向用户提问。'}`
    }
    if (!content || !conversationReady || busy || saving || assistantSaving || modeSaving || modelSavingRef.current || scopeSavingRef.current || (!isResearch && scopeEdited && scopeDirty) || turnInProgress || !conversationReady || loadingConversation || loadingSessions) return
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
          body: JSON.stringify({ entry_scope: scope, workflow_type: workflowType, research_depth: researchDepth, ...modelPreference, ...(isResearch ? { assistant_id: assistantId } : {}) }),
        })
        // Creation returns metadata, whereas React state always needs the full
        // conversation shape while the first message is being saved.
        current = { ...created, messages: [], turns: [], pending_execution: false }
        conversationId = current.id
        submittingDraftKey = `${initialWorkflowType}:${scope}:${current.id}`
        // Switch the draft's identity atomically with the new conversation.
        // Failed message writes can then be retried or restored after reload.
        setDrafts(items => { const next = { ...items, [submittingDraftKey]: items[draftKey] ?? draft }; delete next[draftKey]; return next })
        setDraftSources(items => { const next = { ...items, [submittingDraftKey]: pendingSource }; delete next[draftKey]; return next })
        if (messageAttempts[draftKey]) setMessageAttempts(items => { const next = { ...items, [submittingDraftKey]: items[draftKey] }; delete next[draftKey]; return next })
        attachments.move(draftKey, submittingDraftKey)
        companyShortcuts.move(draftKey, submittingDraftKey)
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
      const sourceRefs = pendingSource ? [pendingSource.reference] : []
      const messageIdentity: unknown[] = attachmentIds.length ? [value.trim(), sourceRefs, attachmentIds] : [value.trim(), sourceRefs]
      if (isResearch && !retryOriginal && companyShortcuts.company) messageIdentity.push({ company: companyShortcuts.company.stock_code })
      // A preview request and an execute request are different messages even
      // when the visible draft is identical; never replay one as the other.
      if (!isResearch && previewOnly) messageIdentity.push({ preview_only: true })
      const messageKey = JSON.stringify(messageIdentity)
      const previousAttempt = messageAttempts[submittingDraftKey] ?? messageAttempts[draftKey]
      const retryAttempt = previousAttempt?.key === messageKey ? previousAttempt : null
      // New research follows the question, without an inherited hidden date,
      // stock universe or lookback window. Old immutable turns remain intact.
      // An uncertain message retry must retain its original frozen payload.
      if (isResearch && !retryAttempt && hasResearchLimits(current.research_scope)) {
        const updated = await api<{ research_scope: ResearchScope; research_scope_revision: number }>(`/conversations/${current.id}/research-scope`, {
          method: 'PATCH', body: JSON.stringify({ base_revision: current.research_scope_revision ?? 0, ...unrestrictedResearchScope }),
        })
        if (!updated.research_scope || hasResearchLimits(updated.research_scope)
          || !Number.isInteger(updated.research_scope_revision) || updated.research_scope_revision <= (current.research_scope_revision ?? 0)) {
          throw new Error('研究设置暂未更新，请稍后重试。')
        }
        current = { ...current, ...updated }
        setConversation(current)
      }
      const currentPayload: MessagePayload = {
        base_revision: current.task_revision,
        ...(isResearch ? { research_scope_revision: current.research_scope_revision ?? 0 } : {}),
        ...(isResearch && current.assistant_revision != null ? { assistant_revision: current.assistant_revision } : {}),
        ...(current.model_revision != null ? { model_revision: current.model_revision } : {}),
        content,
        source_refs: sourceRefs,
        ...(attachmentIds.length ? { attachment_ids: attachmentIds } : {}),
      }
      // Retry an unchanged draft with the original versioned payload. The
      // server may have accepted it and advanced the task/scope before a lost
      // response; rebuilding from current revisions would create a new turn.
      const attempt = retryAttempt ?? { key: messageKey, clientId: crypto.randomUUID(), payload: currentPayload }
      const messagePayload = attempt.payload
      setMessageAttempts(items => ({ ...items, [submittingDraftKey]: attempt }))
      const messageResult = await api<{
        message_id: string
        turn_id: string
        base_revision: number
        state: string
        source_refs?: Record<string, unknown>[]
        attachments?: ConversationAttachment[]
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
        display_content: current.messages.find(message => message.role === 'user' && message.content === messagePayload.content)?.display_content
          ?? (messagePayload.content.includes(screeningWorkspacePromptMarker) ? messagePayload.content.split(screeningWorkspacePromptMarker, 1)[0] : undefined),
        source_refs: messageResult.source_refs ?? [],
        attachments: messageResult.attachments ?? attached,
        created_at: new Date().toISOString(),
      }
      setConversation((old) => old && old.id === current!.id
        ? { ...old, messages: old.messages.some(message => message.id === optimisticMessage.id) ? old.messages : [...old.messages, optimisticMessage] }
        : old)
      setDrafts(items => ({ ...items, [submittingDraftKey]: '' }))
      setDraftSources(items => ({ ...items, [submittingDraftKey]: null }))
      setMessageAttempts(items => { const next = { ...items }; delete next[submittingDraftKey]; return next })
      attachments.clear(submittingDraftKey, messagePayload.attachment_ids ?? [])
      if (selectedIdRef.current === current.id) { setPendingSource(null); onSourceChange?.(null) }
      if (['succeeded', 'failed', 'cancelled'].includes(messageResult.state)) {
        await reloadConversation(current.id)
        setRefreshIndex(index => index + 1)
      } else await processTurn(current.id, messageResult.turn_id, true)
    } catch (reason) {
      setError((reason as Error).message)
      // A definite stale-settings rejection did not accept the request. Release
      // only that attempt; uncertain network failures keep their original ID.
      if (/模型设置已(?:经)?变化|研究范围版本已经变化/.test((reason as Error).message)) {
        setMessageAttempts(items => { const next = { ...items }; delete next[submittingDraftKey]; return next })
      }
      if (conversationId) {
        try { await reloadConversation(conversationId) } catch { /* Keep the original request error visible. */ }
      }
    } finally {
      setBusy(false)
    }
  }

  async function cancelRun(jobId = run?.job_id) {
    if (!jobId) return
    setBusy(true)
    setError('')
    try {
      await api(`/jobs/${jobId}/cancel`, { method: 'POST' })
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

  async function startScreening() {
    if (!conversation || !task || busy || turnInProgress) return
    if (runs.some(item => ['queued', 'running'].includes(item.status)) || conversation.pending_execution) return
    const latest = conversation.turns[0]
    if (!latest || latest.state !== 'succeeded' || latest.result?.task_revision !== task.revision) {
      setError('当前方案对应的回合已经变化，请刷新后再开始筛选。')
      return
    }
    const key = `${conversation.id}:${latest.id}:${task.revision}`
    if (buttonExecutionAttempt.current?.key !== key) buttonExecutionAttempt.current = { key, requestId: crypto.randomUUID() }
    const requestId = buttonExecutionAttempt.current.requestId
    setBusy(true)
    setError('')
    try {
      await enqueueAuthorizedTurn(conversation.id, latest.id, 'button', { revision: task.revision, requestId })
    } catch (reason) {
      setError(`筛选启动未确认：${(reason as Error).message} 可再次点击“开始筛选”；同一请求不会重复创建运行。`)
      setBusy(false)
      return
    }
    try {
      await reloadConversation(conversation.id)
      buttonExecutionAttempt.current = null
      setRefreshIndex(value => value + 1)
    } catch {
      setError('筛选已启动，但暂时无法读取最新状态；请刷新页面查看结果。')
    } finally {
      setBusy(false)
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (companyShortcuts.keyDown(event)) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submitMessage()
    }
  }

  const activeRun = conversation?.active_run_id === viewingRunId
  const coverage = run?.result?.coverage
  const pendingTurn = !isResearch && conversation?.pending_execution
    ? conversation.turns.find((turn) => turn.state === 'succeeded' && turn.result.ready_to_execute && turn.result.execution_authorized)
    : undefined
  const canSave = !!task?.conditions.length && !!task.references.length && !!task.logic_tree && !!task.scope.universe && !task.unresolved.length
  const scopeDirty = !isResearch && !!task && (!task.scope.universe || scopeDate !== task.scope.as_of || scopePool !== (task.scope.universe?.kind === 'watchlist' ? task.scope.universe.watchlist_id : task.scope.universe?.kind === 'explicit' ? 'explicit' : 'all'))
  const canExecute = canSave && !!task?.scope.as_of && !scopeDirty
  const resultAdjustments = useMemo(() => screeningAdjustments(run?.task ?? task), [run?.task, task])
  const latestTurn = conversation?.turns[0]
  const startableTurn = !isResearch && task && latestTurn?.state === 'succeeded' && latestTurn.result?.task_revision === task.revision ? latestTurn : undefined
  const runInProgress = runs.some(item => ['queued', 'running'].includes(item.status))
  const currentRunAvailable = !!pendingTurn || (!!task && runs.some(item => item.task_revision === task.revision))
  const filteredSessions = sessions.filter(item => (item.title ?? '').toLowerCase().includes(sessionQuery.trim().toLowerCase()))
  const missingTaskInfo = task ? [!task.conditions.length || !task.logic_tree ? '筛选条件' : '', !task.scope.universe ? '股票范围' : '', !task.scope.as_of ? '截止日' : ''].filter(Boolean).join('、') : ''
  const showTaskPanel = isResearch ? resultsOpen : screeningPanelOpen && (!!task || !!runs.length || !!pendingTurn)
  const suggestedName = task?.conditions.map(item => item.description).join('；').slice(0, 120) || '研究方案'
  const screeningDraftIntent = !isResearch && task ? screeningInputIntent(draft) : 'message'
  const currentSessionTitle = sessions.find(item => item.id === selectedId)?.title

  useEffect(() => {
    if (!isResearch && compactScreeningPanel && screeningPanelOpen && workspaceSession.active && !screeningDetailsRef.current?.contains(document.activeElement)) screeningDetailsRef.current?.focus({ preventScroll: true })
  }, [isResearch, compactScreeningPanel, screeningPanelOpen, workspaceSession.active])
  const latestScreeningUserMessage = conversation?.messages.filter(message => message.role === 'user').at(-1)?.content ?? ''
  const screeningExecutionPaused = !isResearch && !!task && screeningNoExecutionPattern.test(latestScreeningUserMessage)
  const deliveryRunSummary = runs.find(item => item.id === conversation?.active_run_id && (!task || item.task_revision === task.revision))
    ?? runs.find(item => !task || item.task_revision === task.revision)
  const updatingScreeningPlan = !isResearch && !!activeTurn && screeningInputIntent(latestScreeningUserMessage) !== 'question'
    && (!deliveryRunSummary || !task || task.revision <= activeTurn.base_revision)
  const showScreeningDelivery = !isResearch && !!conversation && (!!conversation.messages.length || !!task || !!deliveryRunSummary || !!pendingTurn)
    && (!!task || !!deliveryRunSummary || !!pendingTurn || screeningInputIntent(latestScreeningUserMessage) !== 'question')
  useEffect(() => {
    setScreeningPanelOpen(false); setScreeningPanelTab('plan'); setScreeningDetailsMounted(false)
    screeningReadingSnapshot.current = null; screeningPanelReturnFocus.current = null
  }, [isResearch, selectedId, newResearchKey])
  useEffect(() => {
    if (isResearch || !conversation || !task || !scopeEdited || !scopeDate || !scopeDirty || turnInProgress || loadingConversation || busy || saving || scopeSaveState === 'error' || scopeSaveState === 'saving') return
    if (scopeReadyKey.current !== `${conversation.id}:${task.revision}`) return
    const timer = globalThis.setTimeout(() => { void applyScope() }, 400)
    return () => globalThis.clearTimeout(timer)
  }, [conversation?.id, task?.revision, scopeDate, scopePool, scopeEdited, scopeDirty, turnInProgress, loadingConversation, busy, saving, scopeSaveState])

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

  async function changeResearchAnswer(message: ConversationMessage, kind: 'regenerate' | 'branch') {
    if (!conversation || !isResearch || busy || saving || turnInProgress || answerActionSaving || answerVersionLock.current) return
    const id = conversation.id, key = JSON.stringify([id, message.id, kind])
    if (answerVersionAttempt.current?.key !== key) answerVersionAttempt.current = { key, requestId: crypto.randomUUID() }
    answerVersionLock.current = true; setAnswerActionSaving(true); setError('')
    try {
      const result = await api<{ conversation_id: string; turn_id: string | null }>(`/conversations/${id}/answers/${kind}`, {
        method: 'POST', body: JSON.stringify({ message_id: message.id, request_id: answerVersionAttempt.current.requestId }),
      })
      answerVersionAttempt.current = null
      historyChangeRef.current?.()
      if (selectedIdRef.current !== id) return
      setVersionSelection(current => { const next = { ...current }; delete next[message.regeneration_of || message.id]; return next })
      if (result.conversation_id !== id && onOpenConversation) {
        onOpenConversation(result.conversation_id, conversation.entry_scope, 'research')
      } else {
        if (result.conversation_id !== id) selectConversation(result.conversation_id)
        const next = await reloadConversation(result.conversation_id)
        setSessions(current => [{ ...next, title: next.title }, ...current.filter(item => item.id !== next.id)])
      }
      setNotice(kind === 'branch' ? '已从这条答复打开新分支。' : result.conversation_id === id ? '正在重新生成，原回答已保留。' : '正在新分支中重新生成，后续对话已保留。')
    } catch (reason) { if (selectedIdRef.current === id) setError((reason as Error).message) }
    finally { answerVersionLock.current = false; setAnswerActionSaving(false) }
  }

  function openSession(item: SessionSummary) {
    const type = conversationWorkflow(item, initialWorkflowType)
    if (onOpenConversation && type !== initialWorkflowType) { onOpenConversation(item.id, item.entry_scope, type); return }
    selectConversation(item.id); setSessionsOpen(false)
  }

  async function changeAssistant(id: string) {
    if (!isResearch || busy || saving || assistantSaving || modelSavingRef.current || attachments.uploading || turnInProgress || !conversationReady || loadingConversation) return
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

  async function changeModel(selection: ModelSelection) {
    if (busy || saving || assistantSaving || modeSaving || modelSavingRef.current || turnInProgress || !conversationReady || loadingConversation || loadingSessions) return
    if (!conversation) {
      setModelPreference(selection); writeModelPreference(selection); setError('')
      return
    }
    const id = conversation.id
    modelSavingRef.current = true; setModelSaving(true); setError('')
    try {
      const result = await api<ModelSelection & { model_revision: number }>(`/conversations/${id}/model`, {
        method: 'PATCH', body: JSON.stringify({ ...selection, base_revision: conversation.model_revision ?? 0 }),
      })
      if (selectedIdRef.current !== id) return
      setConversation(current => current?.id === id ? { ...current, ...result } : current)
      const confirmed = { model_id: result.model_id, reasoning_effort: result.reasoning_effort }
      setModelPreference(confirmed); writeModelPreference(confirmed)
    } catch (reason) {
      if (selectedIdRef.current === id) {
        setError((reason as Error).message)
        try { await reloadConversation(id) } catch { /* Keep the original model error visible. */ }
      }
    } finally { modelSavingRef.current = false; setModelSaving(false) }
  }

  function openModelPicker() {
    const container = composerRef.current
    const settings = container?.querySelector<HTMLButtonElement>('.screening-settings-trigger')
    if (settings?.getAttribute('aria-expanded') === 'false') settings.click()
    requestAnimationFrame(() => {
      const trigger = container?.querySelector<HTMLButtonElement>('.research-model-trigger')
      trigger?.focus()
      if (trigger?.getAttribute('aria-expanded') !== 'true') trigger?.click()
    })
  }


  async function ensureAttachmentConversation() {
    if (conversation?.id && conversation.id === selectedIdRef.current) return { conversationId: conversation.id, draftKey }
    const owner = draftKey
    const generation = templateGenerationRef.current
    const ownerRoute = attachmentOwnerRef.current
    const key = `${owner}:${generation}`
    if (attachmentCreationRef.current?.key === key) return attachmentCreationRef.current.promise
    const capturedDraft = draft
    const capturedSource = pendingSource
    const capturedCompany = companyShortcuts.company
    let intents: Record<string, AttachmentCreationIntent> = attachmentCreationIntents.current
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(ATTACHMENT_CREATION_KEY) ?? '{}')
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) intents = saved as Record<string, AttachmentCreationIntent>
    } catch { /* The current-page intent is retained when storage is unavailable. */ }
    let intent = intents[owner]
    if (intent?.payload && typeof intent.payload === 'object' && 'interaction_mode' in intent.payload) {
      const payload = { ...intent.payload }
      delete payload.interaction_mode
      intent = { ...intent, payload }
      intents = { ...intents, [owner]: intent }
      try { sessionStorage.setItem(ATTACHMENT_CREATION_KEY, JSON.stringify(intents)) } catch { /* Keep the in-memory identity. */ }
    }
    if (!intent || typeof intent.request_id !== 'string' || !intent.payload || typeof intent.payload !== 'object') {
      intent = { request_id: crypto.randomUUID(), payload: { entry_scope: scope, workflow_type: workflowType, research_depth: researchDepth,
        ...modelPreference, ...(isResearch ? { assistant_id: assistantId } : {}) } }
      intents = { ...intents, [owner]: intent }
      try { sessionStorage.setItem(ATTACHMENT_CREATION_KEY, JSON.stringify(intents)) } catch { /* Keep the in-memory identity. */ }
    }
    attachmentCreationIntents.current = intents
    function releaseIntent() {
      let latest = attachmentCreationIntents.current
      try { latest = JSON.parse(sessionStorage.getItem(ATTACHMENT_CREATION_KEY) ?? '{}') } catch { /* Use the in-memory identity. */ }
      if (!latest || typeof latest !== 'object' || latest[owner]?.request_id !== intent.request_id) return
      latest = { ...latest }; delete latest[owner]
      attachmentCreationIntents.current = latest
      try { sessionStorage.setItem(ATTACHMENT_CREATION_KEY, JSON.stringify(latest)) } catch { /* Current page remains usable. */ }
    }
    const request = (async () => {
      let created: Conversation
      try {
        created = await api<Conversation>('/conversations', {
          method: 'POST', body: JSON.stringify({ ...intent.payload, request_id: intent.request_id }),
        })
      } catch (reason) {
        if (reason instanceof ApiRequestError && reason.status === 422) releaseIntent()
        throw reason
      }
      if (!created?.id) throw new Error('对话尚未创建，请重试上传。')
      const current: Conversation = { ...created, messages: [], turns: [], pending_execution: false }
      const targetKey = `${initialWorkflowType}:${scope}:${current.id}`
      if (!templateMountedRef.current) return { conversationId: current.id, draftKey: targetKey }
      const stillHere = templateMountedRef.current && templateGenerationRef.current === generation
        && attachmentOwnerRef.current === ownerRoute && !selectedIdRef.current
      // The metadata belongs to the draft that selected the file, even if the
      // user navigates away before creation returns. Never replace a new draft.
      setDrafts(items => {
        const next = { ...items, [targetKey]: stillHere ? items[owner] ?? capturedDraft : capturedDraft }
        if (stillHere) delete next[owner]
        return next
      })
      setDraftSources(items => {
        const next = { ...items, [targetKey]: capturedSource }
        if (stillHere) delete next[owner]
        return next
      })
      if (stillHere) {
        companyShortcuts.move(owner, targetKey)
        setSessions(items => [{ id: current.id, entry_scope: current.entry_scope, workflow_type: workflowType, task_revision: 0,
          active_run_id: null, state: 'active', title: null, updated_at: current.updated_at }, ...items.filter(item => item.id !== current.id)])
        selectConversation(current.id)
        setConversation(current)
        reportLocation(current.id, current.entry_scope, workflowType)
        releaseIntent()
      } else companyShortcuts.remember(targetKey, capturedCompany)
      historyChangeRef.current?.()
      return { conversationId: current.id, draftKey: targetKey }
    })()
    attachmentCreationRef.current = { key, promise: request }
    try { return await request }
    finally { if (attachmentCreationRef.current?.promise === request) attachmentCreationRef.current = null }
  }

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
        setNotice('已加入关注。')
      }
      answerActionAttempt.current = null
      return true
    } catch (reason) { if (selectedIdRef.current === id) setError((reason as Error).message); return false }
    finally { setAnswerActionSaving(false) }
  }

  const indicatorControl = !embedded && <MyIndicators onOpenDataServices={onOpenDataServices} initialCommon={openCommonIndicators && conversationReady && !loadingSessions && !loadingConversation} onInitialCommonConsumed={() => setOpenCommonIndicators(false)} key={`indicators:${draftKey}:${newResearchKey || 0}`} contextKey={`${draftKey}:${newResearchKey || 0}`} conversationId={conversationReady ? conversation?.id : undefined} workflow={workflowType} data={data} defaultAsOf={isResearch ? undefined : scopeDate || task?.scope.as_of || undefined} defaultStock={isResearch ? undefined : task?.scope.universe?.stock_codes?.[0] || (task?.scope.universe?.kind === 'watchlist' || scopePool !== 'all' && scopePool !== 'explicit' ? '' : '000001.SZ')} turnActive={turnInProgress} refreshKey={refreshIndex + (conversation?.messages.length || 0)} disabled={!!archived || busy || saving || assistantSaving || modeSaving || modelSaving || !conversationReady || loadingConversation || loadingSessions} onPrompt={prepareIndicatorDraft} onScreening={isResearch ? onStartIndicatorScreening : prepareIndicatorDraft} />
  const screeningHint = !isResearch ? screeningUnsupportedHint(draft) : ''
  const submitDisabled = archived || busy || saving || assistantSaving || modeSaving || modelSaving || (!companyShortcuts.isCommand && (modelUnavailable || attachments.hasUnready)) || (!isResearch && scopeEdited && scopeDirty) || scopeSaveState === 'saving' || turnInProgress || !conversationReady || loadingConversation || loadingSessions
  const submitLabel = busy ? '处理中…' : companyShortcuts.isCommand ? '执行命令' : isResearch ? '发送' : !task ? embedded ? '生成选股草稿' : '生成并筛选' : screeningDraftIntent === 'question' ? '发送追问' : embedded ? '更新方案' : '修改并重筛'

  return (
    <StockText><div className={`conversation-product research-studio${embedded ? ' conversation-embedded' : ''}${isResearch ? '' : ` screening-studio${runs.length || pendingTurn ? ' screening-has-results' : ''}`}`}>
      {embedded && <div className="library-conversation-tabs" role="group" aria-label="资料助手视图"><button type="button" className="workspace-button" aria-pressed={!showTaskPanel} onClick={() => isResearch ? setResultsOpen(false) : closeScreeningPanel()}>对话</button><button type="button" className="workspace-button" aria-pressed={!!showTaskPanel} disabled={!conversation} onClick={() => isResearch ? setResultsOpen(true) : openScreeningPanel(currentRunAvailable ? 'result' : 'plan')}>{isResearch ? '成果与文件' : '方案与结果'}</button></div>}
      <div className="page-heading conversation-header-heading">
        <div className="conversation-heading-title">
          <h1>{isResearch ? '研究对话' : '选股对话'}</h1>
          {currentSessionTitle && <span className="conversation-session-caption" data-tooltip={currentSessionTitle}>{currentSessionTitle}</span>}
        </div>
        {!embedded && isResearch && conversation && <ResearchConversationTools conversationId={conversation.id} projectId={conversation.project_id}
          disabled={busy || saving || turnInProgress} hasResults={hasResearchResults} resultsOpen={resultsOpen} resultsToggleRef={resultsToggleRef}
          onToggleResults={() => setResultsOpen(value => !value)} onProjectChange={projectId => setConversation(current => current?.id === conversation.id ? { ...current, project_id: projectId } : current)}
          onError={setError} onOpenProject={onOpenProject} portalTargetId={shellNavigation ? 'research-tools-slot' : undefined} />}
        {(!shellNavigation || !isResearch) && <div className="conversation-heading-actions">
          {!isResearch && (task || runs.length || pendingTurn) && <button ref={screeningPanelToggleRef} type="button" className="icon-button screening-results-toggle workspace-button" aria-label="筛选方案与结果" data-tooltip="筛选方案与结果" aria-expanded={showTaskPanel} aria-controls="screening-view-panel" onClick={() => screeningPanelOpen ? closeScreeningPanel() : openScreeningPanel(deliveryRunSummary ? 'result' : 'plan')}><FileSearch size={18} aria-hidden="true" /></button>}
          {!shellNavigation && <><button ref={disclosureRef} className="session-disclosure secondary-button workspace-button" aria-label={isResearch ? '最近研究对话' : '历史与方案'} aria-expanded={sessionsOpen} aria-controls="screening-sessions" onClick={() => setSessionsOpen(value => !value)}><History size={16} /><span>{isResearch ? '最近对话' : '历史与方案'}</span></button><button className="secondary-button conversation-new workspace-button" aria-label={isResearch ? '新研究' : '新选股对话'} data-tooltip={isResearch ? '新研究' : '新选股对话'} disabled={busy || saving || loadingSessions} onClick={() => { setSessionsOpen(false); createConversation() }}><Plus size={16} /><span>{isResearch ? '新研究' : '新建选股'}</span></button></>}
        </div>}
      </div>
      {!isResearch && error && (isExecutionFailure(error) ? <ResearchFailure onOpenDataServices={onOpenDataServices} onAdjustScope={focusComposer} content={error} /> : <div className="conversation-error workspace-error" role="alert"><AlertCircle size={17} /><span>{error}</span><button className="icon-button workspace-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>)}
      {!isResearch && notice && <div className="conversation-notice workspace-feedback workspace-feedback-success" role="status"><Check size={16} /><span>{notice}</span>{savedNoteProject && onOpenProject && <button className="text-button workspace-button" onClick={() => onOpenProject(savedNoteProject)}>查看笔记</button>}<button className="icon-button workspace-button" aria-label="关闭保存提示" onClick={() => { setNotice(''); setSavedNoteProject('') }}><X size={15} /></button></div>}
      <div className={`conversation-workspace conversation-workspace-start ${!conversation?.messages.length && !task ? 'conversation-workspace-empty' : ''} ${!isResearch && showTaskPanel ? 'screening-detail-open' : ''}`}>
      {sessionsOpen && <div className="studio-library-backdrop" onClick={() => setSessionsOpen(false)} aria-hidden="true" />}
      <aside ref={sessionsRef} id="screening-sessions" role="dialog" aria-modal="true" hidden={!sessionsOpen} onKeyDown={onSessionsKeyDown} className={`conversation-sessions workspace-tool-dialog workspace-drawer ${sessionsOpen ? 'sessions-open' : ''}`} aria-label={isResearch ? '最近研究对话' : '历史与方案'}>
        <div className="conversation-panel-heading">
          <div><span className="studio-eyebrow">{isResearch ? '研究资料' : '选股工作区'}</span><h2>{isResearch ? '最近对话' : '历史与方案'}</h2></div>
          <button className="icon-button workspace-button" aria-label={isResearch ? '关闭最近研究对话' : '关闭历史与方案'} onClick={() => setSessionsOpen(false)}><X size={18} /></button>
        </div>
        <label className="conversation-scope-select workspace-field-label">
          <span>对话分类</span>
          <select aria-label="对话范围" value={scope} disabled={busy || saving || loadingSessions} onChange={(event) => changeScope(event.target.value as ConversationScope)} className="workspace-field workspace-select">
            {Object.entries(scopeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <div className="conversation-library-tabs" aria-label="对话与方案">
          <button type="button" aria-pressed={libraryTab === 'recent'} onClick={() => setLibraryTab('recent')} className="workspace-button">最近对话</button>
          {!isResearch && <button type="button" aria-pressed={libraryTab === 'saved'} onClick={() => setLibraryTab('saved')} className="workspace-button">已保存方案</button>}
        </div>
        {!isResearch && libraryTab === 'saved' ? <SavedTaskLibrary embedded latestDate={data?.last_date} scope={scope} busy={busy || saving} refreshKey={`${refreshIndex}:${conversation?.turns[0]?.state}`} onReuse={(saved, latest) => void reuseTask(saved, latest)} /> : <>
        {!!sessions.length && <label className="conversation-search workspace-field-shell"><Search size={14} /><input aria-label="搜索最近对话" placeholder="搜索最近对话" value={sessionQuery} onChange={event => setSessionQuery(event.target.value)} className="workspace-field" /></label>}
        {loadingSessions ? <LoadingState compact label="正在载入对话…" /> : sessionError ? <div className="saved-task-empty workspace-error" role="alert"><p>{sessionError}</p><button className="secondary-button compact workspace-button" onClick={() => setSessionReload(value => value + 1)}>重新加载对话</button></div> : !sessions.length ? <p className="conversation-muted">暂无对话</p> : !filteredSessions.length ? <div className="saved-task-empty"><p>没有找到匹配的对话</p><button className="text-button workspace-button" onClick={() => setSessionQuery('')}>清除搜索</button></div> : (
          <div className="conversation-session-list">
            {filteredSessions.map((item) => (
              <button
                key={item.id}
                className={["workspace-button", `conversation-session-row ${selectedId === item.id ? 'selected' : ''}`].filter(Boolean).join(' ')}
                disabled={busy || saving}
                aria-current={selectedId === item.id ? 'true' : undefined}
                onClick={() => { setSessionsOpen(false); if (item.id === selectedId && conversation) return; openSession(item); if (onOpenConversation && conversationWorkflow(item, initialWorkflowType) !== initialWorkflowType) return; setConversation(null); setTask(null); setRuns([]); setRun(null); setError(''); setRefreshIndex(value => value + 1) }}
              >
                <strong>{item.title?.trim() || '新对话'}</strong>
                <span>{conversationWorkflow(item, initialWorkflowType) === 'research' ? '研究对话' : '选股对话'}{item.last_turn_state === 'failed' ? ' · 已中断' : item.last_turn_state === 'running' ? ' · 处理中' : ''} · {shortTime(item.updated_at)}</span>
              </button>
            ))}
          </div>
        )}
        </>}
      </aside>

      <section id="screening-view-conversation" hidden={embedded && !!showTaskPanel} role={isResearch ? undefined : 'region'} tabIndex={isResearch ? undefined : 0} className="conversation-main" aria-label={isResearch ? '研究对话' : '选股对话'}>{!conversation?.messages.length && (isResearch || !task) && !loadingConversation && <div className="chat-empty-heading"><span className="research-welcome-mark" aria-hidden="true"><img src="/brand/soochow-symbol-blue.png" alt="" /></span><h1>{isResearch ? assistantId === 'qmt-script' ? '编写 QMT 脚本' : '今天想弄清楚什么？' : '想筛选什么样的股票？'}</h1></div>}
        {isResearch && error && (isExecutionFailure(error) ? <ResearchFailure onOpenDataServices={onOpenDataServices} onAdjustScope={focusComposer} content={error} /> : <div className="conversation-error workspace-error" role="alert"><AlertCircle size={17} /><span>{error}</span><button className="icon-button workspace-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>)}
        {isResearch && notice && <div className="conversation-notice workspace-feedback workspace-feedback-success" role="status"><Check size={16} /><span>{notice}</span>{savedNoteProject && onOpenProject && <button className="text-button workspace-button" onClick={() => onOpenProject(savedNoteProject)}>查看笔记</button>}<button className="icon-button workspace-button" aria-label="关闭保存提示" onClick={() => { setNotice(''); setSavedNoteProject('') }}><X size={15} /></button></div>}
        {loadingConversation && <LoadingState label="正在恢复对话…" skeleton />}
        <div className="conversation-message-stage">
          <div className="conversation-message-list" ref={messageListRef} role="log" aria-live="polite" aria-relevant="additions" onScroll={onMessageListScroll} onWheel={() => { if (screeningPanelOpen) readingChangedWhilePanel.current = true }} onTouchStart={() => { if (screeningPanelOpen) readingChangedWhilePanel.current = true }} onKeyDown={event => { if (screeningPanelOpen && ['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) readingChangedWhilePanel.current = true }}>
            {embedded && !conversation?.messages.length && !task && !loadingConversation && <p className="library-context-intro">{isResearch ? '资料已带入，可修改下方问题后发送，继续核对判断与原文依据。' : '先把资料中的判断整理为选股草稿，再确认条件、范围并开始筛选。'}</p>}
            {!conversation?.messages.length && !task && !loadingConversation && !embedded && (
              <div className="conversation-empty">
                {isResearch
                  ? (assistantId === 'qmt-script' ? <p className="conversation-muted">描述策略或粘贴已有脚本，发送后生成代码、静态检查结果和 .py 下载文件。</p> : scope === 'screening' && assistantId === 'general' && !pendingSource ? <ResearchTaskEntry key={`${draftKey}:${newResearchKey || 0}`} disabled={busy || saving || !conversationReady || loadingConversation || loadingSessions} onPrompt={prepareDraft} onScreening={onStartScreening} onReports={() => { if (onOpenReports) onOpenReports(); else composerRef.current?.querySelector<HTMLInputElement>('input[type="file"]')?.click() }} /> : <ResearchStarters items={researchSuggestions[scope]} disabled={busy || saving || !conversationReady || loadingConversation || loadingSessions} onSelect={prepareDraft} />)
                  : <>
                    <ResearchStarters groupLabel="常用选股任务" items={screeningQuickTasks} disabled={busy || saving || !conversationReady || loadingConversation || loadingSessions} onSelect={prepareDraft} />
                    <div className="screening-start-tools">
                      <button type="button" className="text-button workspace-button" aria-expanded={screeningExamplesOpen} aria-controls="screening-start-examples" onClick={() => setScreeningExamplesOpen(value => !value)}>选股示例</button>
                      <button type="button" className="text-button workspace-button" aria-label="复用已保存方案" onClick={() => { setLibraryTab('saved'); setSessionsOpen(true) }}>已保存方案</button>
                      <ScreeningReadiness compact showScope={false} data={data} scope={scope} task={task} asOf={scopeDate} onOpenData={onOpenDataServices} />
                    </div>
                    <section id="screening-start-examples" className="screening-start-panel" aria-label="选股示例" hidden={!screeningExamplesOpen}>
                    <ScreeningTemplates key={`${draftKey}:${newResearchKey || 0}`} disabled={busy || saving || !conversationReady || loadingConversation || loadingSessions || !scopeDate} onSelect={(template, parameters) => void selectTemplate(template, parameters)} />
                    <p className="screening-capability-line">
                      <strong>可筛</strong>日线价格、成交量、常见技术指标、形态、研报与资讯原文。
                      <strong>暂不筛</strong>财务/估值、历史行业/ST、分钟线（研究侧可查）。
                      {onOpenDataServices && <button type="button" className="text-button workspace-button" onClick={onOpenDataServices}>查看数据与服务</button>}
                    </p>
                    <ScreeningExamples groups={screeningExampleGroups} disabled={busy || saving || !conversationReady || loadingConversation || loadingSessions} modelUnavailable={modelUnavailable} onSelect={prepareDraft} />
                    </section>
                  </>}
              </div>
            )}
            {conversation && displayedMessages(conversation.messages, versionSelection).map(message => {
            const messageIndex = conversation!.messages.findIndex(item => item.id === message.id)
            const turn = turnsByMessage.get(message.id)
            const answerTurn = message.role === 'assistant' ? (message.turn_id ? conversation!.turns.find(item => item.id === message.turn_id) : conversation!.turns.find(item => item.user_message_id === conversation!.messages.slice(0, messageIndex).reverse().find(previous => previous.role === 'user')?.id)) : undefined
            const versions = answerVersions(conversation!.messages).get(message.regeneration_of || message.id) || []
            const versionIndex = versions.findIndex(item => item.id === message.id)
            const failed = message.role === 'assistant' && (isExecutionFailure(message.content) || conversation.turns.some(item => item.state === 'failed' && item.response_text === message.content))
            const retryQuestion = failed ? conversation.messages.slice(0, messageIndex).reverse().find(item => item.role === 'user') : undefined
            const canRetryAnswer = retryQuestion && retryQuestion.id === conversation.messages.filter(item => item.role === 'user').at(-1)?.id && turnsByMessage.get(retryQuestion.id)?.state === 'failed'
            return (
              <article className={`conversation-message ${message.role}`} key={message.id}>
                <div className="conversation-message-meta">
                  <strong>{message.role === 'user' ? '你' : message.role === 'assistant' ? isResearch ? '投研助手' : '选股助手' : '工具'}</strong>
                  <time dateTime={message.created_at}>{shortTime(message.created_at)}</time>
                  {turn && !['succeeded'].includes(turn.state) && <span className={["workspace-status", `conversation-turn-state ${stateClass(turn.state)}`].filter(Boolean).join(' ')}>{stateLabels[turn.state] ?? turn.state}</span>}
                  {turn?.assistant && turn.assistant.id !== 'general' && <span className="conversation-assistant-tag workspace-status" data-tooltip={`助手版本 ${turn.assistant.revision}`}>{turn.assistant.name}</span>}
                </div>
                {isResearch && answerTurn && <ResearchActivityHistory key={`${conversation.id}:${answerTurn.id}`} conversationId={conversation.id} turnId={answerTurn.id} />}
                {failed ? <ResearchFailure onOpenDataServices={onOpenDataServices} onAdjustScope={focusComposer} content={message.content} disabled={busy || turnInProgress} onRetry={canRetryAnswer ? () => void submitMessage(retryQuestion.content, retryQuestion.attachments, true) : undefined} /> : message.role === 'assistant' ? <ResearchAnswer content={message.content} conversationId={message.file_conversation_id || conversation.id} messageId={message.id} references={message.source_refs} summary={isResearch ? answerTurn?.result.research_summary : undefined} /> : <p className="conversation-plain-message">{message.display_content ?? message.content}</p>}
                <MessageAttachmentChips items={message.attachments} />
                {!!message.source_refs.length && (!isResearch || message.role !== 'assistant') && <AnswerSources references={message.source_refs} />}
                {message.role === 'assistant' && !failed && (isResearch ? <ResearchResultActions key={message.id} conversation={conversation} message={message} disabled={busy || turnInProgress || !!savingNote || !!archived} savingNote={savingNote === message.id} savingAction={answerActionSaving} onSave={() => saveResearchAnswer(message.id)} onCopy={() => void copyAnswer(message.content)} onSubmit={action => submitResearchResult(message.id, action)} onContinue={focusComposer} onRegenerate={() => void changeResearchAnswer(message, 'regenerate')} onBranch={() => void changeResearchAnswer(message, 'branch')} /> : <div className="studio-answer-actions"><button type="button" className="text-button workspace-button" onClick={() => void copyAnswer(message.content)}><Copy size={14} />复制答复</button>{conversation.project_id && <button type="button" className="text-button research-save-answer workspace-button" disabled={!!savingNote} onClick={() => void saveResearchAnswer(message.id)}><Bookmark size={14} />{savingNote === message.id ? '正在保存…' : '保存为研究笔记'}</button>}</div>)}
                {isResearch && versions.length > 1 && <div className="research-answer-versions" role="group" aria-label="回答版本"><button type="button" aria-label="上一个回答版本" disabled={versionIndex === 0} onClick={() => setVersionSelection(current => ({ ...current, [message.regeneration_of || message.id]: versions[versionIndex - 1].id }))} className="workspace-button"><ChevronLeft size={14} /></button><span>{versionIndex + 1} / {versions.length}</span><button type="button" aria-label="下一个回答版本" disabled={versionIndex === versions.length - 1} onClick={() => setVersionSelection(current => ({ ...current, [message.regeneration_of || message.id]: versions[versionIndex + 1].id }))} className="workspace-button"><ChevronRight size={14} /></button></div>}
                {turn?.state === 'failed' && conversation.messages.filter(item => item.role === 'user').at(-1)?.id === message.id && <button className="secondary-button compact workspace-button" disabled={busy || turnInProgress} onClick={() => void submitMessage(message.content, message.attachments, true)}>重新处理</button>}{turn?.state === 'awaiting_agent' && !turn.job && <button className="secondary-button compact workspace-button" disabled={busy} onClick={() => void processTurn(conversation.id, turn.id)}><Play size={14} />继续处理</button>}
              </article>
            )
            })}
            {activeTurn && (isResearch || screeningInputIntent(latestScreeningUserMessage) === 'question') && <ResearchProgress label={codexProgress || (activeTurn.state === 'running' ? isResearch ? '正在研究' : '正在整理选股条件' : '等待开始处理')} startedAt={activeTurn.created_at} updatedAt={progressUpdatedAt || activeTurn.updated_at} activities={researchActivities} stopping={stopping} onStop={() => void stopTurn()} />}
            {showScreeningDelivery && conversation && <div className="screening-delivery-anchor" ref={screeningDeliveryRef}>
              <ScreeningDeliveryCard conversationId={conversation.id} task={task} currentRun={deliveryRunSummary} viewedRun={run} viewedRunId={viewingRunId}
                readError={runError} refreshKey={refreshIndex} active={workspaceSession.active} processing={updatingScreeningPlan} failed={latestTurn?.state === 'failed'} cancelled={latestTurn?.state === 'cancelled' && !deliveryRunSummary}
                pending={!!pendingTurn && !deliveryRunSummary} paused={screeningExecutionPaused} canStart={!!startableTurn && canExecute && !currentRunAvailable && !turnInProgress}
                disabled={busy || saving || turnInProgress || !!archived} stopping={stopping || busy}
                onPlan={() => openScreeningPanel('plan')} onResults={() => openScreeningPanel('result')} onEdit={() => navigateScreeningStage('brief')}
                onStart={() => void startScreening()} onReload={() => setRefreshIndex(value => value + 1)}
                onRetryStart={pendingTurn ? () => void retryExecution(pendingTurn.id) : undefined}
                onStop={updatingScreeningPlan ? () => void stopTurn() : deliveryRunSummary?.job_id ? () => void cancelRun(deliveryRunSummary.job_id) : undefined}
                onClarify={composeClarification} onContentChange={() => { if (followLatestRef.current) requestAnimationFrame(() => scrollToLatest('auto')); else setShowLatest(true) }} onRunStatus={(id, status) => setRuns(items => items.map(item => item.id === id && item.status !== status ? { ...item, status } : item))} />
            </div>}
          </div>
          {showLatest && <button type="button" className="conversation-latest-button workspace-button" onClick={() => scrollToLatest()}><ArrowDown size={14} />{!isResearch && ['succeeded', 'partial'].includes(deliveryRunSummary?.status || '') ? '筛选结果已就绪' : '查看最新'}</button>}
        </div>
        <form className="conversation-composer workspace-form" ref={composerRef} onSubmit={(event) => { event.preventDefault(); void submitMessage() }}>
          {archived && <div className="conversation-pending-source workspace-feedback workspace-feedback-info" role="status"><span>此对话已归档。可在左侧更多操作中恢复后继续。</span></div>}
          {modelCatalogError && <div className="conversation-pending-source workspace-error" role="alert"><span>分析服务设置暂时无法读取：{modelCatalogError}。当前选择保留。</span><button type="button" className="text-button workspace-button" onClick={openModelPicker}>检查模型设置</button></div>}
          {modelUnavailable && <div className="conversation-pending-source workspace-feedback workspace-feedback-info" role="status"><span>当前模型或推理档位不可用，请切换后发送。</span><button type="button" className="text-button workspace-button" disabled={busy || modelSaving || turnInProgress} onClick={openModelPicker}>切换模型</button></div>}
          {conversation?.screening_draft_source && <div className="conversation-pending-source workspace-feedback workspace-feedback-info"><span>来源：研究答复</span><button type="button" className="text-button workspace-button" onClick={() => onOpenConversation?.(conversation.screening_draft_source!.source_conversation_id, 'screening', 'research')}>查看原研究</button></div>}
          <label htmlFor="conversation-input">{isResearch ? '研究要求' : '选股要求'}</label>
          {companyShortcuts.context}
          {pendingSource && <div className="conversation-pending-source workspace-feedback workspace-feedback-info"><span aria-hidden="true">@</span><span>{pendingSource.label}</span><button type="button" className="icon-button workspace-button" aria-label="移除来源页" onClick={() => setSource(null)}><X size={14} /></button></div>}
          <DraftAttachmentChips items={attachments.items} disabled={busy || saving || turnInProgress} onRemove={attachments.remove} onCancel={attachments.cancel} onRetry={(id, file) => void attachments.retry(id, file)} />
          {attachments.error && <p className="composer-attachment-error workspace-error" role="alert">{attachments.error}</p>}
            <textarea
            id="conversation-input"
            aria-label={isResearch ? '研究要求' : '选股要求'}
            {...companyShortcuts.inputProps}
            ref={textareaRef}
            value={draft}
            maxLength={8000}
            disabled={archived || busy || saving || !conversationReady || loadingConversation || loadingSessions}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={isResearch ? '输入公司、行业或研究问题…' : '描述你的选股条件…'}
          />
          {!isResearch && !task && <details className="screening-scope-editor"><summary><span>{scopeOverrides.pool || scopeOverrides.date ? '选定范围与日期' : '默认范围与日期'}</span><strong>{scopePool === 'all' ? '全部A股' : watchlists.find(item => item.id === scopePool)?.name || '指定股票池'} · {scopeDate || '待指定'}</strong><span>修改</span></summary><div className="screening-default-scope scope-picker"><label className="workspace-field-label">{scopeOverrides.pool ? '选定范围' : '默认范围'}<select aria-label="默认股票范围" disabled={busy || !conversationReady || loadingConversation || loadingSessions} value={scopePool} onChange={event => { setScopePool(event.target.value); setScopeOverrides(current => ({ ...current, pool: true })) }} className="workspace-field workspace-select"><option value="all">全部A股</option>{watchlists.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="workspace-field-label">{scopeOverrides.date ? '选定截止日' : '默认截止日'}<input aria-label="默认行情日期" disabled={busy || !conversationReady || loadingConversation || loadingSessions} type="date" max={data?.last_date} value={scopeDate} onChange={event => { setScopeDate(event.target.value); setScopeOverrides(current => ({ ...current, date: true })) }} className="workspace-field" /></label></div></details>}
          {screeningHint && <p className="screening-capability-warning workspace-feedback-inline" role="status">{screeningHint}{onOpenDataServices && <button type="button" className="text-button workspace-button" onClick={onOpenDataServices}>查看数据与服务</button>}</p>}
          <div className="conversation-composer-footer">
            <div className="conversation-composer-tools">
              {!embedded && <ResearchComposerMenu value={assistantId} snapshot={conversation?.assistant} showAssistants={false}
                disabled={archived || busy || saving || assistantSaving || modelSaving || attachments.uploading || turnInProgress || !conversationReady || loadingConversation || loadingSessions}
                onChange={id => void changeAssistant(id)} onUpload={files => void attachments.upload(files)} />}
              {isResearch && <ScreeningSettings label="研究设置" key={`research-settings:${draftKey}:${newResearchKey || 0}`}>{open => <>
                <p className="research-settings-note">默认设置即可开始研究。这里的调整只影响后续提问，历史研究保留原配置。</p>
                {!embedded && <ResearchComposerMenu value={assistantId} snapshot={conversation?.assistant} showUpload={false} disabled={!!archived || busy || saving || assistantSaving || modelSaving || turnInProgress || !conversationReady || loadingConversation || loadingSessions} onChange={id => void changeAssistant(id)} onUpload={files => void attachments.upload(files)} />}
                <ResearchModelPicker visible={open} value={modelSelection} disabled={!!archived || busy || saving || assistantSaving || modeSaving || modelSaving || attachments.uploading || turnInProgress || !conversationReady || loadingConversation || loadingSessions} onChange={selection => void changeModel(selection)} onAvailabilityChange={available => setModelAvailability({ key: modelSelectionKey, available })} onCatalogError={setModelCatalogError} />
                {indicatorControl}
              </>}</ScreeningSettings>}
              {!isResearch && <ScreeningSettings key={`${draftKey}:${newResearchKey || 0}`}>{open => <>
                <label className="studio-mode-select workspace-field-label"><span>条件核验</span><select aria-label="研究深度" value={researchDepth} disabled={busy || saving || modeSaving || modelSaving || turnInProgress || !conversationReady || loadingConversation || loadingSessions} onChange={event => void changeResearchDepth(event.target.value as ResearchDepth)} className="workspace-field workspace-select">{Object.entries(depthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{modeSaving && <LoaderCircle size={14} className="spin" />}</label>
                <ResearchModelPicker visible={open} value={modelSelection} disabled={archived || busy || saving || assistantSaving || modeSaving || modelSaving || attachments.uploading || turnInProgress || !conversationReady || loadingConversation || loadingSessions} onChange={selection => void changeModel(selection)} onAvailabilityChange={available => setModelAvailability({ key: modelSelectionKey, available })} onCatalogError={setModelCatalogError} />
              {!isResearch && (!task || screeningDraftIntent === 'edit') && <button type="button" className="text-button screening-preview-button workspace-button" data-tooltip={task ? '只更新方案，确认后再开始筛选' : '只整理方案，确认后再开始筛选'} disabled={submitDisabled || !draft.trim()} onClick={() => void submitMessage(draft, undefined, false, { previewOnly: true })}>{task ? '只改方案' : '只生成方案'}</button>}
              </>}</ScreeningSettings>}
            </div>
            {!isResearch && indicatorControl}
            <span>{draft.length >= 7000 ? `${draft.length}/8000` : ''}</span>
            <button className={["workspace-button", !isResearch && task && screeningDraftIntent !== 'edit' ? "secondary-button" : "primary-button"].filter(Boolean).join(' ')} type="submit" aria-label={submitLabel} data-tooltip={submitLabel} disabled={submitDisabled || (!draft.trim() && !attachments.ready.length)}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={16} />}
              {submitLabel}
            </button>
          </div>
          <p className="composer-keyboard-hint"><span>{companyShortcuts.isCommand ? 'Enter 确认 · ↑ ↓ 选择 · Esc 关闭提示' : isResearch ? 'Enter 发送 · Shift + Enter 换行 · 输入 / 使用快捷命令' : 'Enter 发送 · Shift + Enter 换行'}</span></p>
        </form>
        {companyShortcuts.overlays}
        {!embedded && !isResearch && conversation && !task && <details className="screening-plan-secondary"><summary>项目归属</summary><ProjectMembership conversationId={conversation.id} projectId={conversation.project_id} disabled={busy || saving || turnInProgress} onChange={projectId => setConversation(current => current?.id === conversation.id ? { ...current, project_id: projectId } : current)} onError={setError} onOpenProject={onOpenProject} /></details>}
      </section>

      {!embedded && isResearch && resultsOpen && <div className="research-results-backdrop" onClick={() => setResultsOpen(false)} aria-hidden="true" />}
      {!embedded && !isResearch && compactScreeningPanel && showTaskPanel && <div className="research-results-backdrop" onClick={closeScreeningPanel} aria-hidden="true" />}
      <aside ref={isResearch ? undefined : screeningDetailsRef} id={isResearch ? 'research-results-drawer' : 'screening-view-panel'} role={embedded ? 'region' : 'dialog'} tabIndex={-1} aria-modal={embedded ? undefined : isResearch || compactScreeningPanel} className={'conversation-task-panel ' + (isResearch ? 'research-results-drawer workspace-tool-dialog workspace-drawer' : 'screening-results-drawer workspace-tool-dialog workspace-drawer')} aria-label={isResearch ? '研究成果' : '筛选方案与结果'} hidden={!showTaskPanel} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); isResearch ? setResultsOpen(false) : closeScreeningPanel() }; if (!embedded && (isResearch || compactScreeningPanel)) trapDialogTab(event) }}>
        {(isResearch || screeningDetailsMounted) && <>
        {isResearch
          ? <button ref={resultsCloseRef} type="button" className="icon-button research-results-close workspace-button" aria-label="关闭研究成果" onClick={() => setResultsOpen(false)}><X size={19} /></button>
          : <button ref={screeningPanelCloseRef} type="button" className="icon-button research-results-close workspace-button" aria-label="关闭筛选方案与结果" onClick={closeScreeningPanel}><X size={19} /></button>}
        <div className="studio-results-heading"><h2>{isResearch ? '研究成果' : '筛选方案与结果'}</h2></div>
        {!isResearch && <div className="screening-panel-tabs" role="tablist" aria-label="方案与结果详情" onKeyDown={onScreeningPanelTabsKeyDown}>
          <button type="button" role="tab" id="screening-plan-tab" data-panel-tab="plan" aria-selected={screeningPanelTab === 'plan'} aria-controls="screening-plan-detail" tabIndex={screeningPanelTab === 'plan' ? 0 : -1} className="workspace-button" onClick={() => setScreeningPanelTab('plan')}>筛选方案</button>
          <button type="button" role="tab" id="screening-result-tab" data-panel-tab="result" aria-selected={screeningPanelTab === 'result'} aria-controls="screening-result-detail" tabIndex={screeningPanelTab === 'result' ? 0 : -1} className="workspace-button" onClick={() => setScreeningPanelTab('result')}>筛选结果</button>
        </div>}
        {!isResearch && screeningPanelTab === 'plan' && !task && <p role="status">方案尚未整理完成，请在对话中查看进展。</p>}

        {!isResearch && <div className="screening-drawer-readiness"><ScreeningReadiness compact={embedded} data={data} scope={scope} task={task} asOf={scopeDate} onOpenData={onOpenDataServices} /></div>}
        {isResearch && conversation?.id === selectedId && <ResearchPanel key={conversation.id} conversationId={conversation.id} turnActive={turnInProgress} refreshKey={refreshIndex + conversation.messages.length} onContentChange={setHasResearchResults} showGenerate={conversation.messages.some(message => message.role === 'assistant' && !isExecutionFailure(message.content)) && !conversation.turns.every(turn => turn.state === 'failed' || turn.state === 'cancelled')} />}
        {!isResearch && task && <section id="screening-plan-detail" role="tabpanel" aria-labelledby="screening-plan-tab" hidden={screeningPanelTab !== 'plan'} className="conversation-task-section">
          <div className="conversation-panel-heading">
            <h2>筛选方案</h2>
          </div>
          <div className="screening-plan-understanding" role="group" aria-label="方案理解">
            <span className="screening-plan-understanding-label">我的理解</span>
            <p>{task.conditions.length
              ? `${task.conditions.slice(0, 4).map(item => item.description).join('；')}${task.conditions.length > 4 ? `；等 ${task.conditions.length} 条条件` : ''}`
              : '还没有可执行的条件。'}</p>
            <small>{taskUniverseLabel(task)} · {task.scope.as_of ? `用 ${task.scope.as_of} 的收盘数据` : '截止日待确定'}</small>
          </div>
          <>
            <div className="conversation-task-conditions"><TaskCompositionEditor task={task} disabled={busy || saving || turnInProgress || runInProgress || loadingConversation || scopeDirty || scopeSaveState === 'saving'} saving={compositionSaving} onEdit={change => void editComposition(change)} /></div>
            <div className="conversation-task-scope">
              <span>范围</span><strong>{taskUniverseLabel(task)}</strong>
              <span>截止日</span><strong>{task.scope.as_of ?? '未确定'}</strong>
              {task.conditions.some(item => ['technical', 'pattern'].includes(item.library)) && data?.last_date && data.last_date !== task.scope.as_of && <><span>本地行情覆盖至</span><strong>{data.last_date}</strong></>}
              {task.scope.report_lookback_calendar_days != null && <><span>研报回溯</span><strong>近 {task.scope.report_lookback_calendar_days} 个自然日</strong></>}
              {task.scope.news_lookback_calendar_days != null && <><span>资讯回溯</span><strong>近 {task.scope.news_lookback_calendar_days} 个自然日</strong></>}
              {task.scope.ranking && <>
                <span>排名范围</span><strong>{({ all_a_shares: '全部A股', watchlist: '自选股票池', after_filters: '满足指定条件的股票', industry: '行业内' } as Record<string, string>)[String(task.scope.ranking.ranking_universe)] ?? '待确定'}</strong>
                <span>选取数量</span><strong>{task.scope.ranking.top_n != null ? `前 ${String(task.scope.ranking.top_n)} 名` : `前 ${Number(task.scope.ranking.top_fraction) * 100}%（人数向上取整）`}</strong>
                <span>并列处理</span><strong>{task.scope.ranking.ties_policy === 'include_all' ? '保留全部并列' : '同分按股票代码排序'}</strong>
                <span>缺失处理</span><strong>{task.scope.ranking.missing_policy === 'exclude_with_notice' ? '排除缺失并说明' : '范围不完整时保留未知'}</strong>
              </>}
            </div>
            {!!task.unresolved.length && <section aria-label="方案待补充信息"><h3>还有 {task.unresolved.length} 项需要补充</h3>{task.unresolved.map((item, index) => <p key={index}>{item.question}</p>)}<button type="button" className="text-button workspace-button" onClick={focusScreeningQuestions}>在对话中补充</button></section>}
            <details className="screening-plan-edit"><summary>修改范围与日期</summary><div className="scope-picker">
              <label className="workspace-field-label">股票范围<select aria-label="调整股票范围" value={scopePool} disabled={busy || turnInProgress || scopeSaveState === 'saving'} onChange={event => { setScopePool(event.target.value); setScopeEdited(true); setScopeSaveState('idle') }} className="workspace-field workspace-select"><option value="all">全部A股</option>{task.scope.universe?.kind === 'explicit' && <option value="explicit">当前指定股票</option>}{watchlists.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
              <label className="workspace-field-label">行情日期<input aria-label="调整行情日期" type="date" value={scopeDate} max={data?.last_date} disabled={busy || turnInProgress || scopeSaveState === 'saving'} onChange={event => { setScopeDate(event.target.value); setScopeEdited(true); setScopeSaveState('idle') }} className="workspace-field" /></label>
              {data?.last_date && <button className="text-button workspace-button" disabled={busy || turnInProgress || scopeSaveState === 'saving'} onClick={() => { setScopeDate(data.last_date!); setScopeEdited(true); setScopeSaveState('idle') }}>选用最新行情日</button>}
              {(scopeDirty && scopeEdited || scopeSaveState !== 'idle') && <span className="scope-save-status conversation-muted workspace-feedback-inline" role="status">{scopeSaveState === 'saving' ? '正在自动保存…' : scopeSaveState === 'saved' ? '范围和日期已自动保存' : scopeSaveState === 'error' ? '自动保存失败' : '等待自动保存'}{scopeSaveState === 'error' && <button className="icon-button workspace-button" data-tooltip="重试保存范围和日期" aria-label="重试保存范围和日期" onClick={() => void applyScope()}><RefreshCw size={14} /></button>}</span>}
            </div>
            </details>
            {task.conditions.some(item => ['technical', 'pattern'].includes(item.library)) && <p className="conversation-muted">本地日线 · {({ unadjusted: '不复权', forward_adjusted: '前复权', back_adjusted: '后复权' } as Record<string, string>)[task.scope.price_basis && task.scope.price_basis !== 'unknown' ? task.scope.price_basis : data?.price_basis || 'unadjusted'] || '不复权'}</p>}
            <div className="conversation-task-actions">
              {canExecute ? (runInProgress || pendingTurn
                ? <span className="screening-auto-execution-note" role="status"><LoaderCircle size={14} className="spin" />{runInProgress ? '正在自动筛选…' : '方案已生成，正在开始筛选…'}</span>
                : currentRunAvailable
                  ? <button className="secondary-button workspace-button" disabled={busy || saving || turnInProgress} onClick={() => navigateScreeningStage('result')}>查看筛选结果</button>
                  : <>
                    {screeningExecutionPaused && <span className="screening-auto-execution-note is-paused" role="status">方案已生成，按要求暂不筛选</span>}
                    {startableTurn
                      ? <button className="primary-button workspace-button" data-tooltip="按当前方案和范围开始筛选" disabled={busy || saving || turnInProgress} onClick={() => void startScreening()}>
                        {busy ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}{busy ? '正在启动…' : '开始筛选'}
                      </button>
                      : <span className="screening-auto-execution-note is-paused" role="status">当前方案没有可执行的最近回合，请在输入框补充要求后重新生成。</span>}
                  </>
              ) : <button className="secondary-button workspace-button" disabled={busy || saving || turnInProgress} onClick={() => navigateScreeningStage('brief')}>补充筛选要求</button>}
              <button className="text-button workspace-button" disabled={busy || saving || turnInProgress} onClick={() => navigateScreeningStage('brief')}>修改条件</button>
            </div>
            {!canExecute && !task.unresolved.length && <p className="conversation-muted">请先{scopeDirty && scopeEdited ? '等待范围与日期自动保存' : missingTaskInfo || '完整条件'}。</p>}
            {canExecute && !!draft.trim() && <p className="conversation-muted">输入框中还有未发送的内容；发送后会自动更新条件并重筛。</p>}
            <details className="screening-plan-secondary"><summary>保存方案与项目归属</summary>
              <button className="text-button workspace-button" disabled={!canSave || busy || saving || turnInProgress || scopeDirty || scopeSaveState === 'saving'} data-tooltip={!canSave ? '请先补充完整条件和股票范围' : undefined} onClick={() => void saveTask(suggestedName)}>{saving ? <LoaderCircle size={14} className="spin" /> : <Bookmark size={14} />}{saving ? '保存中…' : '保存方案'}</button>
              <button className="icon-button workspace-button" disabled={!canSave || busy || saving || turnInProgress} data-tooltip="设置方案名称" aria-label="设置方案名称" aria-expanded={saveOpen} onClick={() => { setSaveName(suggestedName); setSaveOpen(value => !value) }}><Pencil size={15} /></button>
              {conversation && <ProjectMembership conversationId={conversation.id} projectId={conversation.project_id} disabled={busy || saving || turnInProgress} onChange={projectId => setConversation(current => current?.id === conversation.id ? { ...current, project_id: projectId } : current)} onError={setError} onOpenProject={onOpenProject} />}
            {saveOpen && <form className="conversation-save-form workspace-form" onSubmit={event => { event.preventDefault(); void saveTask() }}>
              <label htmlFor="saved-task-name">方案名称</label>
              <input id="saved-task-name" autoFocus value={saveName} maxLength={120} disabled={saving} onChange={event => setSaveName(event.target.value)} placeholder="方案名称" className="workspace-field" />
              <div><button className="primary-button compact workspace-button" disabled={saving || !saveName.trim()} type="submit">{saving ? '保存中…' : '确认保存'}</button><button className="text-button workspace-button" type="button" disabled={saving} onClick={() => setSaveOpen(false)}>取消</button></div>
            </form>}
            </details>
          </>
        </section>}

        {!isResearch && screeningPanelTab === 'result' && !runs.length && !pendingTurn && <p>尚无筛选结果；方案就绪后可开始筛选。</p>}
        {!isResearch && (!!runs.length || !!pendingTurn) && <section id="screening-result-detail" role="tabpanel" aria-labelledby="screening-result-tab" hidden={screeningPanelTab !== 'result'} className="conversation-run-section">
          <div className="conversation-panel-heading">
            <h2>筛选结果</h2>
            {runs.length > 0 && <select aria-label="查看筛选运行" value={viewingRunId} onChange={(event) => setViewingRunId(event.target.value)} className="workspace-field workspace-select">
              {runs.map((item) => <option key={item.id} value={item.id}>{item.as_of} · {new Date(item.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · {stateLabels[item.status] ?? item.status}</option>)}
            </select>}
          </div>
          {pendingTurn && <div className="conversation-retry-notice" role="status">
            <span>筛选尚未启动。</span>
            <button className="secondary-button compact workspace-button" disabled={busy} onClick={() => void retryExecution(pendingTurn.id)}><Play size={14} />{busy ? '正在启动…' : '重试启动筛选'}</button>
          </div>}
          {!runs.length ? (
            <p className="conversation-muted">尚无筛选运行</p>
          ) : runError ? (
            <div role="alert" className="saved-task-empty workspace-error"><strong>筛选运行加载失败</strong><p>{runError}</p><p>尚未读取运行状态，不能据此判断是否匹配。</p><button type="button" className="secondary-button compact workspace-button" onClick={() => setRefreshIndex(value => value + 1)}>重新加载筛选运行</button></div>
          ) : loadingRun || !run ? (
            <p className="conversation-muted" role="status"><LoaderCircle size={14} className="spin" />正在读取运行…</p>
          ) : (
            <ScreeningResultView
              key={run.id}
              asOf={run.as_of}
              revision={run.task_revision}
              status={run.status}
              isCurrent={Boolean(activeRun)}
              progress={{
                message: run.job?.message ?? stateLabels[run.status] ?? run.status,
                percent: run.job?.progress ?? (run.status === 'succeeded' || run.status === 'partial' ? 1 : 0),
              }}
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
                navigateScreeningStage('brief')
                prepareDraft(state === 'unknown' ? `这次为什么无法判断${stockCode}是否符合条件？` : `为什么这次${state === 'true' ? '选中了' : '没有选中'}${stockCode}？`)
                setSource({ reference: { kind: 'screening_run', source_id: run.id }, label: `筛选结果 · ${run.as_of} · v${run.task_revision}` })
                setError('')
              }}
              onCopyAll={() => void copyAllMatching()}
              onExportUrl={`/api/v1/conversations/${conversation!.id}/screening-runs/${run.id}/export?state=${decisionState}&query=${encodeURIComponent(decisionQuery)}`}
              onViewChart={(code) => setChart({ code, date: run.as_of })}
              onAdjustRequirements={() => navigateScreeningStage('brief')}
              adjustments={resultAdjustments}
              onApplyAdjustment={applyScreeningAdjustment}
              onOpenData={onOpenDataServices}
              onSavePlan={canSave && !scopeDirty ? () => void saveTask(suggestedName) : undefined}
              savePlanDisabled={busy || saving || scopeSaveState === 'saving'}
              savingPlan={saving}
              onReload={() => setDecisionReload(v => v + 1)}
            />
          )}
        </section>}
        </>}
      </aside>
      </div>
      {chart && <StockChartDialog code={chart.code} asOf={chart.date} onClose={() => setChart(null)} />}
    </div></StockText>
  )
}
