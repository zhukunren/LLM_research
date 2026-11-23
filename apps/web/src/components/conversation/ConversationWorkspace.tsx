import LoadingState from '../LoadingState'
import TimeLabel, { fullTimeDescription } from '../TimeLabel'
import { StockText } from '../StockMentions'
import { localStorage, sessionStorage } from '../../authStorage'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { AlertCircle, ArrowDown, ArrowLeft, ArrowUp, Bookmark, ChartNoAxesCombined, Check, ChevronLeft, ChevronRight, Copy, FileSearch, History, LoaderCircle, Newspaper, Pencil, Play, Plus, RefreshCw, Search, X } from 'lucide-react'
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
  type ConversationSourceReference,
  type ConversationTurn,
  type ScreeningTaskRevision,
  type ScreeningTaskRunSummary,
  type SavedScreeningTask,
} from '../../api'
import { useSessionState } from '../../useSessionState'
import { useWorkspaceSession } from '../../WorkspaceSession'
import { useMobileWorkspace } from '../../useMobileWorkspace'
import { trapDialogTab } from '../../keyboard'
import { TaskCompositionEditor, TaskLogic, taskUniverseLabel, type CompositionEdit } from './TaskBrief'
import SavedTaskLibrary from './SavedTaskLibrary'
import ScreeningTemplates, { type ScreeningTemplate } from './ScreeningTemplates'
import ScreeningExamples, { type ScreeningExampleGroup } from './ScreeningExamples'
import ScreeningDeliveryCard from './ScreeningDeliveryCard'
import ScreeningReadiness from './ScreeningReadiness'
import ScreeningSettings from './ScreeningSettings'
import ScreeningSplitHandle from './ScreeningSplitHandle'
import './screening-simple.css'
import './screening-results-workspace.css'
import ResearchPanel from './ResearchPanel'
import ResearchAnswer from './ResearchAnswer'
import ResearchQuestionIndex from './ResearchQuestionIndex'
import ResearchResultActions from './ResearchResultActions'
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
import StockChartDialog from '../StockChartDialog'
import MyIndicators from '../indicators/MyIndicators'
import MyScreeningPlans, { isScreeningPlan, type ScreeningPlanSource } from './MyScreeningPlans'
import type { DataStatus } from '../../api'
import type { ConversationHistoryChange } from '../ConversationHistoryItem'
import ScreeningResultView from '../ScreeningResultView'
import { screeningAdjustments } from '../../screeningAdjustments'
import type { ScreeningFormMethod, ScreeningMethod, ScreeningPatternSelection } from '../../screeningMethods'
import FixedScreeningRules, { type FixedRuleScope } from '../screening/FixedScreeningRules'
import ScreeningMethodSetup from '../screening/ScreeningMethodSetup'
import ScreeningAddConditions, { type AddedScreeningSource } from '../screening/ScreeningAddConditions'
import { serviceResearchDraft, type ServiceResearchDraft } from '../../clientServiceResearchDraft'
import { draftSourceKey, MAX_DRAFT_SOURCES, mergeDraftSources, type ComposerDraft, type ConversationHandoff, type DraftSource, type DraftTransfer, type ScreeningResultLocation } from '../../workspaceHandoff'
import { clearResearchScope, hasResearchScopeLimits, useResearchConversation } from './useResearchConversation'
import { useScreeningExecution } from './useScreeningExecution'
import { RUN_PAGE_SIZE, useScreeningRunResults, type ScreeningTaskRun } from './useScreeningRunResults'

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

type CodexEvent = {
  sequence: number
  method: string
  payload: Record<string, unknown>
}

type PromptSuggestion = { label: string; prompt: string; description?: string }
type ScreeningInputIntent = 'edit' | 'question' | 'message'
type ScreeningStage = 'brief' | 'plan' | 'result'

const screeningWorkspacePromptMarker = '\n\n[选股工作台指令]\n'
const screeningQuestionPattern = /[?？]|为什么|为何|怎么(?:回事|样)?|如何|是否|能否|能不能|可否|可不可以|是不是|会不会|什么原因|解释一下|说明一下|分析一下/
const screeningClarificationEditPattern = /^请根据以下回答修改筛选方案/
const screeningNoExecutionPattern = /(?:不要|不必|不用|不需要|先不|暂不|别)(?:.{0,12})(?:执行|运行|筛选|重筛|重跑|跑)|(?:仅|只)(?:生成|查看|核对|改|更新)(?:选股|筛选)?方案|(?:先|只|仅)(?:给我(?:看看?|看下|看一下)?|列出?|看看?|看下|核对)(?:一下)?(?:选股|筛选|比较|计算)?口径/
const screeningEditPattern = /改成|改为|修改|调整|新增|增加|添加|加上|加入|删除|移除|去掉|剔除|保留|排除|只看|仅看|筛选|筛出|找出|限定|放宽|收紧|设为|设定为|替换|均线|股价|收盘价|涨幅|跌幅|成交量|成交额|市值|PE|PB|ROE|净利润|营收|负债率|股息率|行业|换手率|回撤|波动率/i
const screeningResultQuestionPattern = /^(?:请(?:帮我)?|帮我)?\s*(?:为什么|为何|怎么会|解释(?:一下)?|说明(?:一下)?|告诉我|列出|给我)[^。！？\n]*(?:入选|中选|选中|落选|没选上|命中依据|第[一二三四五六七八九十\d]+只|这批|筛选结果)|^(?:这批|上次|上一批|本次|第[一二三四五六七八九十\d]+只)[^。！？\n]*(?:原因|理由|依据|怎么|为什么|实际值|门槛|多少|几只)/
const screeningSavePattern = /^(?:请|帮我|替我|能否|可以|能不能|只|仅|把|将|这一?套|这[个份次]|当前|规则|条件|方案|策略|\s)*(?:保存|收藏|存为|存下|存起来|存入)/
const politeScreeningPattern = /^(?:请问[，,]?\s*)?(?:能否|能不能|可否|可以|可不可以|能)\s*(?:请)?(?:帮我|替我|为我|给我)\s*/

function screeningInputIntent(value: string): ScreeningInputIntent {
  const text = value.trim()
  if (!text) return 'message'
  if (screeningClarificationEditPattern.test(text)) return 'edit'
  if (screeningResultQuestionPattern.test(text)) return 'question'
  if (screeningSavePattern.test(text)) return 'message'
  const request = politeScreeningPattern.test(text) ? text.replace(politeScreeningPattern, '').replace(/[?？吗 ]+$/, '') : text
  if (screeningQuestionPattern.test(request)) return 'question'
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
const screeningUnsupportedPattern = /市净率|市值|\b(?:PB|ROE|ST)\b|净利润|营业收入|营收|财务|分钟线|分钟行情|换手率|北向资金|主力资金/i
function screeningUnsupportedHint(value: string) {
  if (!screeningUnsupportedPattern.test(value)) return ''
  return '你提到的部分字段，本地选股暂不提供。现有量价、申万行业市盈率、形态和研报或资讯条件可用。'
}

function sessionStorageKey(scope: ConversationScope) {
  return `conversation.active.${scope}`
}


function stateClass(state: string) {
  if (state === 'true' || state === 'succeeded') return 'positive'
  if (state === 'false') return 'negative'
  if (state === 'failed' || state === 'cancelled') return 'danger'
  return 'caution'
}

const validDrafts = (value: unknown): value is Record<string, string> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string')
type MessagePayload = { base_revision: number; research_scope_revision?: number; assistant_revision?: number; model_revision?: number; content: string; source_refs: ConversationSourceReference[]; attachment_ids?: string[]; execute_plan?: boolean; route_screening?: true }
type MessageAttempt = { key: string; clientId: string; payload: MessagePayload }
type AttachmentCreationIntent = { request_id: string; payload: Record<string, unknown> }
const ATTACHMENT_CREATION_KEY = 'conversation.attachmentCreationRequests'
const validSources = (value: unknown): value is Record<string, DraftSource | null> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item === null || (item && typeof item === 'object' && typeof item.label === 'string' && item.reference && typeof item.reference.kind === 'string' && typeof item.reference.source_id === 'string'))
const validExtraSources = (value: unknown): value is Record<string, DraftSource[]> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(items => Array.isArray(items) && items.every(item => item && typeof item.label === 'string' && item.reference && typeof item.reference.kind === 'string' && typeof item.reference.source_id === 'string'))
const validMessageAttempts = (value: unknown): value is Record<string, MessageAttempt> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item && typeof item === 'object' && typeof item.key === 'string' && typeof item.clientId === 'string' && item.payload && typeof item.payload.content === 'string' && Number.isInteger(item.payload.base_revision) && Array.isArray(item.payload.source_refs) && (item.payload.attachment_ids === undefined || Array.isArray(item.payload.attachment_ids) && item.payload.attachment_ids.every((id: unknown) => typeof id === 'string')) && (item.payload.research_scope_revision === undefined || Number.isInteger(item.payload.research_scope_revision)) && (item.payload.model_revision === undefined || Number.isInteger(item.payload.model_revision) && item.payload.model_revision >= 0))

function messageSource(item: Record<string, unknown>): DraftSource | undefined {
  const kind = item.kind as ConversationSourceReference['kind']
  if (typeof item.source_id !== 'string') return undefined
  const reference: ConversationSourceReference = { kind, source_id: item.source_id }
  let label = String(item.title || item.source_id)
  switch (kind) {
    case 'report_page':
      if (typeof item.page_number !== 'number') return undefined
      reference.page_number = item.page_number
      label += ` · 第${item.page_number}页`
      break
    case 'screening_run':
      if (typeof item.stock_code === 'string') reference.stock_code = item.stock_code
      break
    case 'pattern':
    case 'condition':
    case 'saved_screening_task':
    case 'screening_strategy':
      if (typeof item.version !== 'number') return undefined
      reference.version = item.version
      break
    case 'news_item':
    case 'security':
      break
    default:
      return undefined
  }
  return { reference, label }
}

function DraftSourceLabel({ source }: { source: DraftSource }) {
  const { reference, label } = source
  if (reference.kind !== 'report_page' || !reference.page_number) return <span>{label}</span>
  return <a className="draft-report-link" href={`/api/v1/documents/${encodeURIComponent(reference.source_id)}/pdf#page=${reference.page_number}`} target="_blank" rel="noreferrer">{label}</a>
}

export default function ConversationWorkspace({
  data, initialConversationId, initialPrompt, initialNewDraft = false, onPromptConsumed,
  newResearchKey, onNewResearchConsumed, initialAssistantId,
  initialScope = 'screening',
  onScopeChange,
  initialSource,
  onSourceChange,
  initialWorkflowType = 'research',
  onOpenConversation,
  onLocationChange,
  shellNavigation = false, onHistoryChange, onOpenDataServices,
  conversationUpdate, onStartIndicatorScreening, initialCommonIndicators, onStartScreening, onOpenReports,
  embedded = false, screeningMethod, onScreeningMethod, onScreeningSaved, onScreeningHistory, onScreeningCompose, onBrowseScreeningSources, onResearchResult, onServiceDraft,
  fixedRulesOpen, onCloseFixedRules, incomingPattern, onPatternApplied, handoff,
}: {
  handoff?: ConversationHandoff
  screeningMethod?: ScreeningFormMethod
  onScreeningMethod?: (method: ScreeningMethod) => void
  onScreeningCompose?: () => void
  fixedRulesOpen?: boolean
  onCloseFixedRules?: () => void
  incomingPattern?: ScreeningPatternSelection
  onPatternApplied?: () => void
  onServiceDraft?: (draft: ServiceResearchDraft) => void
  onResearchResult?: (source: DraftSource, prompt: string, position: ScreeningResultLocation) => void
  onScreeningSaved?: () => void
  onScreeningHistory?: () => void
  onBrowseScreeningSources?: (kind: 'news' | 'reports') => void
  data?: DataStatus | null
  embedded?: boolean
  initialCommonIndicators?: boolean
  onStartIndicatorScreening?: (prompt: string) => void
  onStartScreening?: (draft: ComposerDraft) => void
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
  const returnResult = handoff?.screeningResult
  const restoredResult = useRef<ScreeningResultLocation>()
  const [drafts, setDrafts] = useSessionState<Record<string, string>>('conversation.drafts', {}, validDrafts)
  const [assistantDrafts, setAssistantDrafts] = useSessionState<Record<string, string>>('conversation.assistantDrafts', {}, validDrafts)
  const [assistantSaving, setAssistantSaving] = useState(false)
  const [draftSources, setDraftSources] = useSessionState<Record<string, DraftSource | null>>('conversation.draftSources', {}, validSources)
  const [extraSources, setExtraSources] = useSessionState<Record<string, DraftSource[]>>('conversation.extraSources', {}, validExtraSources)
  const [methodDescriptionKey, setMethodDescriptionKey] = useState(0)
  const [messageAttempts, setMessageAttempts] = useSessionState<Record<string, MessageAttempt>>('conversation.messageAttempts', {}, validMessageAttempts)
  const [stockFollowUps, setStockFollowUps] = useSessionState<Record<string, string>>('conversation.stockFollowUps', {}, validDrafts)
  const baseDraftKey = `${initialWorkflowType}:${scope}:${selectedId || 'new'}`
  const stockFollowUp = !isResearch && selectedId ? stockFollowUps[baseDraftKey] : undefined
  const draftKey = stockFollowUp ? `${baseDraftKey}:stock:${stockFollowUp}` : baseDraftKey
  const pendingExtraSources = extraSources[draftKey] ?? []
  const [screeningExamplesOpen, setScreeningExamplesOpen] = useState(false)
  useEffect(() => { setScreeningExamplesOpen(false) }, [draftKey, newResearchKey])
  const baseDraft = drafts[baseDraftKey] ?? drafts[`${scope}:${selectedId || 'new'}`] ?? ''
  const draft = stockFollowUp ? drafts[draftKey] ?? '' : baseDraft
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
  const [saveOpen, setSaveOpen] = useState(false)
  const [composerSource, setPendingSource] = useState(initialSource ?? null)
  const pendingSource = stockFollowUp ? draftSources[draftKey] ?? null : composerSource
  const appliedTransfer = useRef<DraftTransfer>()
  const pendingPlan = !isResearch && isScreeningPlan(pendingSource)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [codexProgress, setCodexProgress] = useState('')
  const [researchActivities, setResearchActivities] = useState<ResearchActivity[]>([])
  const [progressUpdatedAt, setProgressUpdatedAt] = useState('')
  const [hasResearchResults, setHasResearchResults] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const resultsToggleRef = useRef<HTMLButtonElement>(null)
  const resultsCloseRef = useRef<HTMLButtonElement>(null)
  const [screeningPanelOpen, setScreeningPanelOpen] = useState(false)
  const [screeningSplit, setScreeningSplit] = useSessionState('screening.resultsSplit', 38, (value): value is number => typeof value === 'number' && value >= 30 && value <= 55)
  const automaticallyOpenedRun = useRef('')
  const [screeningDetailsMounted, setScreeningDetailsMounted] = useState(false)
  const [screeningPanelTab, setScreeningPanelTab] = useState<'plan' | 'result'>('plan')
  const [editingCurrentPlan, setEditingCurrentPlan] = useState(false)
  const [compactScreeningPanel, setCompactScreeningPanel] = useState(() => window.matchMedia?.('(max-width: 1100px)').matches ?? window.innerWidth <= 1100)
  const phoneScreeningPanel = useMobileWorkspace() && !embedded
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
  const [error, setError] = useState('')
  const [refreshIndex, setRefreshIndex] = useState(0)
  const [showLatest, setShowLatest] = useState(false)
  const [watchlists, setWatchlists] = useState<{ id: string; name: string }[]>([])
  const [scopePool, setScopePool] = useSessionState('conversation.screeningPool', 'all', (value): value is string => typeof value === 'string')
  const [scopeDate, setScopeDate] = useSessionState('conversation.screeningDate', data?.last_date ?? '', (value): value is string => typeof value === 'string')
  const [scopeOverrides, setScopeOverrides] = useSessionState('conversation.screeningOverrides', { pool: false, date: false }, (value): value is { pool: boolean; date: boolean } => !!value && typeof value === 'object' && 'pool' in value && typeof value.pool === 'boolean' && 'date' in value && typeof value.date === 'boolean')
  const [scopeEdited, setScopeEdited] = useState(false)
  const [scopeSaveState, setScopeSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [compositionSaving, setCompositionSaving] = useState(false)
  const [chart, setChart] = useState<{ code: string; date: string } | null>(null)
  const scopeAttempt = useRef<{ key: string; id: string } | null>(null)
  const compositionAttempt = useRef<{ key: string; id: string } | null>(null)
  const scopeReadyKey = useRef('')
  const scopeSavingRef = useRef(false)
  const modeChosenRef = useRef(false)
  const selectedIdRef = useRef('')
  const activeTurnId = conversation?.id === selectedId
    ? conversation.turns.find(turn => ['awaiting_agent', 'running'].includes(turn.state))?.id
    : undefined
  const turnInProgress = conversation?.turns.some(turn => ['awaiting_agent', 'running'].includes(turn.state)) ?? false
  const {
    runs, run, selection, unifiedDecisions, decisionTotal, loadingRun, runError, loadingDecisions, decisionError,
    selectRun, resetResults, browseDecisions, restorePosition, updateRunList, updateRunStatus,
    copyAllMatching: copyMatchingCodes, reloadDecisions,
  } = useScreeningRunResults({
    conversation, enabled: !isResearch, visible: screeningPanelOpen && screeningPanelTab === 'result',
    refreshKey: refreshIndex, returnResult, onReleaseResult: handoff?.onReleaseScreeningResult,
  })
  const { runId: viewingRunId, state: decisionState, query: decisionQuery, offset: decisionOffset } = selection
  const runInProgress = runs.some(item => ['queued', 'running'].includes(item.status))
  const { enqueueAuthorizedTurn, startScreening, cancelRun, retryExecution } = useScreeningExecution({
    conversation, task, enabled: !isResearch, selectedId, activeTurnId, busy, turnInProgress, runInProgress,
    reloadConversation, setBusy, setError, refresh: () => setRefreshIndex(value => value + 1),
    onQueued(conversationId, runId) {
      if (selectedIdRef.current !== conversationId) return
      handoff?.onReleaseScreeningResult()
      selectRun(runId)
    },
  })
  const { versionSelection, setVersionSelection, answerActionSaving, changeResearchAnswer, submitResearchResult } = useResearchConversation({
    conversation, enabled: isResearch, busy: busy || turnInProgress, saving,
    isSelected: id => selectedIdRef.current === id,
    onHistoryChange: () => historyChangeRef.current?.(),
    async onAnswerVersion(original, nextId) {
      if (nextId !== original.id && onOpenConversation) {
        onOpenConversation(nextId, original.entry_scope, 'research')
        return
      }
      if (nextId !== original.id) selectConversation(nextId)
      const next = await reloadConversation(nextId)
      setSessions(current => [{ ...next, title: next.title }, ...current.filter(item => item.id !== next.id)])
    },
    onScreeningDraft(id, prompt) {
      if (onOpenConversation) onOpenConversation(id, 'screening', 'screening', prompt)
      else setNotice('选股草稿已创建，尚未执行。')
    },
    setNotice, setError,
  })
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
  const templateAttemptRef = useRef<{ key: string; ownerKey: string; conversation?: Conversation; clientId: string; independent: boolean } | null>(null)
  const submitLock = useRef(false)
  const conversationCreation = useRef<{ draftKey: string; requestId: string; payload: Record<string, unknown> } | null>(null)
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
    const transfer = handoff?.transfer
    if (!transfer || appliedTransfer.current === transfer || !workspaceSession.active || loadingSessions || loadingConversation || !conversationReady
      || initialConversationId && conversation?.id !== initialConversationId) return
    const key = transfer.kind === 'add' ? transfer.key : draftKey
    const primary = key === draftKey ? pendingSource : draftSources[key]
    const existing = [...(primary ? [primary] : []), ...(extraSources[key] ?? [])]
    const sources = mergeDraftSources(existing, transfer.draft.sources)
    if (sources.length > MAX_DRAFT_SOURCES) {
      setError('此页尚未加入。请移除一项资料后再试，当前问题最多可引用 8 项资料。')
      return
    }
    appliedTransfer.current = transfer
    setDrafts(current => current[key] ? current : { ...current, [key]: transfer.draft.prompt })
    if (key === draftKey) setSource(sources[0] ?? null)
    else setDraftSources(current => ({ ...current, [key]: sources[0] ?? null }))
    setExtraSources(current => ({ ...current, [key]: sources.slice(1) }))
    handoff.onTransferApplied(transfer)
    setError('')
    if (key === draftKey && transfer.kind === 'add') textareaRef.current?.focus({ preventScroll: true })
  }, [handoff?.transfer, workspaceSession.active, loadingSessions, loadingConversation, conversationReady, conversation?.id, initialConversationId, draftKey, pendingSource, draftSources, extraSources])
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
    try {
      const message = await copyMatchingCodes()
      if (message) setNotice(message)
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
    setDraftSources(current => ({ ...current, [key]: source }))
    if (!stockFollowUp) { setPendingSource(source); onSourceChange?.(source) }
  }

  function focusComposer() {
    composerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
    globalThis.setTimeout(() => textareaRef.current?.focus(), 0)
  }

  function selectScreeningPanelTab(tab: 'plan' | 'result') {
    setScreeningPanelTab(tab)
    setEditingCurrentPlan(false)
    if (screeningPanelTab !== tab && screeningDetailsRef.current) screeningDetailsRef.current.scrollTop = 0
  }

  function openScreeningPanel(tab: 'plan' | 'result' = 'plan', openCurrent = false) {
    if (isResearch) return
    selectScreeningPanelTab(tab)
    setScreeningDetailsMounted(true)
    if (openCurrent) {
      const current = deliveryRunSummary ?? (tab === 'result' ? runs[0] : undefined)
      if (current) {
        handoff?.onReleaseScreeningResult()
        selectRun(current.id)
      }
      else if (tab === 'plan') setEditingCurrentPlan(true)
    }
    if (screeningPanelOpen) return
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
    if (next === 'brief') { if (compactScreeningPanel || embedded) setScreeningPanelOpen(false); globalThis.setTimeout(() => focusComposer(), 0); return }
    openScreeningPanel(next === 'result' ? 'result' : 'plan', true)
  }
  function closeScreeningPanel() {
    handoff?.onReleaseScreeningResult()
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
    selectScreeningPanelTab(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-panel-tab="${next}"]`)?.focus()
  }

  function prepareDraft(value: string) {
    setDraft(value)
    focusComposer()
  }

  function captureQuestion(): ComposerDraft {
    const latest = conversation?.messages.filter(message => message.role === 'user').at(-1)
    const carried = [...(pendingSource ? [pendingSource] : []), ...pendingExtraSources]
    let sources = draft.trim() || carried.length ? carried : (latest?.source_refs ?? []).flatMap(item => messageSource(item) ?? [])
    const company = companyShortcuts.company
    if (company && sources.length < MAX_DRAFT_SOURCES) {
      sources = mergeDraftSources(sources, [{ reference: { kind: 'security', source_id: company.stock_code }, label: `${company.name} · ${company.stock_code}` }])
    }
    return { key: draftKey, prompt: draft || latest?.display_content || latest?.content.split(screeningWorkspacePromptMarker, 1)[0] || '', sources }
  }

  function pickReport() {
    if (handoff) handoff.pickReport(captureQuestion())
    else if (onOpenReports) onOpenReports()
    else composerRef.current?.querySelector<HTMLInputElement>('input[type="file"]')?.click()
  }

  function resumeScreeningDraft() {
    setStockFollowUps(items => {
      const next = { ...items }
      delete next[baseDraftKey]
      return next
    })
  }

  function focusScreeningDraft() {
    if (stockFollowUp) resumeScreeningDraft()
    navigateScreeningStage('brief')
  }

  function askAboutStock(stockCode: string, state: string, batch: ScreeningTaskRun) {
    if (busy || saving) return
    const question = state === 'unknown' ? `这次为什么无法判断${stockCode}是否符合条件？` : `为什么这次${state === 'true' ? '选中了' : '没有选中'}${stockCode}？`
    const source: DraftSource = { reference: { kind: 'screening_run', source_id: batch.id, stock_code: stockCode }, label: `筛选结果 · ${batch.as_of} · v${batch.task_revision}` }
    const followUp = `${batch.id}:${stockCode}`
    const key = `${baseDraftKey}:stock:${followUp}`
    if (stockFollowUp || draft || pendingSource || pendingExtraSources.length || attachments.items.length || drafts[key]) {
      setDrafts(items => ({ ...items, [key]: items[key]?.trim() ? items[key] : question }))
      setDraftSources(items => ({ ...items, [key]: source }))
      setStockFollowUps(items => ({ ...items, [baseDraftKey]: followUp }))
    } else {
      prepareDraft(question)
      setSource(source)
    }
    setError('')
    navigateScreeningStage('brief')
  }

  function continueStockResearch(stockCode: string, batch: ScreeningTaskRun) {
    if (!conversation) return
    const position: ScreeningResultLocation = { ...selection, conversationId: conversation.id, stockCode }
    onResearchResult?.({
      reference: { kind: 'screening_run', source_id: batch.id, stock_code: stockCode },
      label: `筛选批次 · ${batch.as_of} · v${batch.task_revision}`,
    }, `请继续研究 ${stockCode}。以截至 ${batch.as_of} 的筛选批次（方案 v${batch.task_revision}）为起点，核对命中条件的依据、经营变化和主要风险。区分该批次时点与后续信息。`, position)
  }

  function composeClarification(value: string) {
    const next = draft.trim() ? `${value}\n\n${draft.trim()}` : value
    if (next.length > 8000) { setError('当前草稿加上补充回答超过 8000 字，请先精简草稿。'); return }
    prepareDraft(next)
    void submitMessage(next, undefined, false, { previewOnly: screeningExecutionPaused })
  }

  function applyScreeningAdjustment(prompt: string) {
    const next = baseDraft.trim() ? `${baseDraft}\n\n${prompt}` : prompt
    focusScreeningDraft()
    if (next.length > 8000) { setError('加入后会超过 8000 字，请先精简当前草稿。'); return }
    setDrafts(items => ({ ...items, [baseDraftKey]: next }))
  }

  function prepareIndicatorDraft(value: string) {
    const next = draft.trim() ? `${draft.trim()}\n\n${value}` : value
    if (next.length > 8000) { setError('当前草稿加上指标请求超过 8000 字，请先精简草稿。'); return false }
    setMethodDescriptionKey(current => current + 1)
    prepareDraft(next)
    return true
  }

  function prepareAdditionalCondition(value: string, source?: AddedScreeningSource) {
    const next = baseDraft.trim() ? `${baseDraft.trim()}\n\n${value}` : value
    if (next.length > 8000) { setError('叠加后的要求超过 8000 字，请先精简当前草稿。'); return false }
    if (source) setExtraSources(current => {
      const items = current[baseDraftKey] ?? []
      return { ...current, [baseDraftKey]: items.some(item => JSON.stringify(item.reference) === JSON.stringify(source.reference)) ? items : [...items, source] }
    })
    setDrafts(current => ({ ...current, [baseDraftKey]: next }))
    setNotice('新增条件已放入输入框，请核对后发送。')
    focusScreeningDraft()
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
    updateRunList(next, runList.items)
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

  async function processTurn(conversationId: string, turnId: string, executeWhenReady = true, queued?: ConversationTurn) {
    setBusy(true)
    setError('')
    setCodexProgress('')
    try {
      const before = conversation?.id === conversationId ? conversation.active_run_id : null
      const turn = queued ?? await api<ConversationTurn>(`/conversations/${conversationId}/turns/${turnId}/process`, { method: 'POST' })
      const after = await reloadConversation(conversationId)
      if (conversationWorkflow(after, initialWorkflowType) === 'screening') {
        if (!(after.active_run_id && after.active_run_id !== before) && executeWhenReady && turn.result.ready_to_execute && turn.result.execution_authorized === true) {
          await enqueueAuthorizedTurn(conversationId, turnId)
          await reloadConversation(conversationId)
        }
      }
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
    resetResults()
    if (initialWorkflowType === 'screening') setScreeningPanelOpen(false)
    setError('')
  }, [initialScope])

  useEffect(() => {
    setPendingSource(initialSource ?? draftSources[baseDraftKey] ?? null)
  }, [initialSource, baseDraftKey])

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
    resetResults()
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

  useEffect(() => {
    followLatestRef.current = true
    setShowLatest(false)
  }, [selectedId])

  useEffect(() => { setSaveOpen(false); setNotice('') }, [selectedId, task?.revision])

  const turnsByMessage = useMemo(() => new Map(
    (conversation?.turns ?? []).map((turn) => [turn.user_message_id, turn]),
  ), [conversation?.turns])
  useEffect(() => {
    if (!incomingPattern || isResearch || !workspaceSession.active || !conversationReady || loadingConversation || loadingSessions || busy || saving || turnInProgress || archived) return
    const pattern = incomingPattern
    const source = { reference: { kind: 'pattern' as const, source_id: pattern.id, version: pattern.version }, label: `${pattern.name} · v${pattern.version}` }
    const alreadyAttached = (extraSources[baseDraftKey] ?? []).some(item => item.reference.kind === 'pattern' && item.reference.source_id === pattern.id && item.reference.version === pattern.version)
    const context = task ? '请保留现有筛选方案，在原整组条件上叠加以下形态。' : '请根据以下形态整理筛选方案。'
    const requirement = `${context}使用已保存形态「${pattern.name}」第 ${pattern.version} 版，沿用该版本的相似度和匹配窗口设置。`
    if (alreadyAttached || prepareAdditionalCondition(requirement, source)) onPatternApplied?.()
  }, [incomingPattern, workspaceSession.active, conversationReady, loadingConversation, loadingSessions, busy, saving, turnInProgress, archived, baseDraft, baseDraftKey])
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
    resetResults()
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
    conversationCreation.current = null
    setScopePool('all'); setScopeDate(data?.last_date ?? ''); setScopeOverrides({ pool: false, date: false })
    selectConversation('')
    companyShortcuts.clear(initialWorkflowType + ':' + scope + ':new')
    setDrafts(current => ({ ...current, [initialWorkflowType + ':' + scope + ':new']: '' }))
    setExtraSources(current => ({ ...current, [initialWorkflowType + ':' + scope + ':new']: [] }))
    setAssistantDrafts(current => ({ ...current, [initialWorkflowType + ':' + scope + ':new']: nextAssistant }))
    setModelPreference(readModelPreference())
    setError('')
    setConversation(null)
    setTask(null)
    resetResults()
    setScreeningPanelOpen(false)
    setLoadingConversation(false)
    setLibraryTab('recent')
    setSource(source, `${initialWorkflowType}:${scope}:new`)
    focusComposer()
  }

  async function saveTask(name = saveName, snapshot = task) {
    if (!snapshot || !conversation || !name.trim() || busy || saving || archived || scopeSavingRef.current || snapshot.revision === task?.revision && scopeDirty) return
    const taskKey = `${conversation.id}:${snapshot.revision}:${name.trim()}`
    if (saveAttemptRef.current?.taskKey !== taskKey) saveAttemptRef.current = { taskKey, assetId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    setSaving(true)
    setError('')
    try {
      const saved = await api<SavedScreeningTask>(`/conversations/${conversation.id}/saved-screening-tasks`, {
        method: 'POST', body: JSON.stringify({ name: name.trim(), revision: snapshot.revision, asset_id: saveAttemptRef.current.assetId, request_id: saveAttemptRef.current.requestId }),
      })
      setSaveOpen(false)
      setNotice(`已保存“${saved.name}”。`)
      setLibraryTab('recent')
    } catch (reason) { setError((reason as Error).message) }
    finally { setSaving(false) }
  }

  async function selectTemplate(template: ScreeningTemplate, parameters: Record<string, number>, fixedScope?: FixedRuleScope): Promise<boolean> {
    const asOf = fixedScope?.asOf ?? scopeDate, pool = fixedScope?.pool ?? scopePool
    const independent = !!fixedScope
    const entryScope = independent ? 'screening' : scope
    if (templateBusyRef.current || busy || saving || modeSaving || turnInProgress || !asOf || !conversationReady || independent && !onOpenConversation) return false
    templateBusyRef.current = true
    const generation = templateGenerationRef.current
    const isCurrent = () => templateMountedRef.current && templateGenerationRef.current === generation
    const ownerKey = templateOwnerRef.current
    const key = JSON.stringify([template.id, template.version, parameters, pool, asOf, ownerKey, independent, fixedScope?.industry])
    if (templateAttemptRef.current?.key !== key) {
      const previous = templateAttemptRef.current
      templateAttemptRef.current = { key, ownerKey, independent, clientId: crypto.randomUUID(),
        conversation: previous?.ownerKey === ownerKey && previous.independent === independent ? previous.conversation : undefined }
    }
    const attempt = templateAttemptRef.current
    setBusy(true); setError('')
    try {
      if (!attempt.conversation) attempt.conversation = (independent ? null : conversation) ?? await api<Conversation>('/conversations', {
        method: 'POST', body: JSON.stringify({ entry_scope: entryScope, workflow_type: 'screening', research_depth: researchDepth, ...modelPreference, ...(independent ? { request_id: attempt.clientId } : {}) }),
      })
      const current = attempt.conversation
      if (!isCurrent() || templateOwnerRef.current !== ownerKey) return false
      const published = await api<{ task: ScreeningTaskRevision }>(`/conversations/${current.id}/screening-templates/${template.id}`, {
        method: 'POST', body: JSON.stringify({ base_revision: current.task_revision, client_message_id: attempt.clientId, version: template.version, parameters, as_of: asOf, universe: pool === 'all' ? { kind: 'all_a_shares' } : { kind: 'watchlist', watchlist_id: pool }, industry: fixedScope?.industry }),
      })
      templateAttemptRef.current = null
      if (!isCurrent() || templateOwnerRef.current !== ownerKey) return false
      if (independent) {
        onHistoryChange?.()
        onOpenConversation?.(current.id, entryScope, 'screening')
        return true
      }
      selectConversation(current.id)
      setDrafts(currentDrafts => ({ ...currentDrafts, [`${initialWorkflowType}:${scope}:${current.id}`]: '' }))
      setConversation(null); setTask(published.task); resetResults()
      setSource(null, `${initialWorkflowType}:${scope}:${current.id}`)
      try { await reloadConversation(current.id, isCurrent) }
      catch { if (isCurrent()) setError('基础方案已生成，自动筛选已发起；暂时无法读取最新状态，请刷新查看结果。') }
      api<{ items: SessionSummary[] }>(`/conversations?scope=${scope}&limit=50`).then(({ items }) => { if (isCurrent() && selectedIdRef.current === current.id) setSessions(items) }).catch(() => {})
      return true
    } catch (reason) {
      if (isCurrent() && templateOwnerRef.current === ownerKey) {
        const operation = independent ? '固定规则筛选尚未启动' : '基础方案尚未完成'
        const message = `${operation}，${(reason as Error).message}。可使用相同参数重试。`
        if (independent) throw new Error(message)
        setError(message)
      }
      return false
    }
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
      resetResults()
      setSource(null, `${initialWorkflowType}:${scope}:${current.id}`)
      setLibraryTab('recent')
      await reloadConversation(current.id)
      reuseAttemptRef.current = null
    } catch (reason) { setError(`复用未完成：${(reason as Error).message} 可再次点击复用以继续。`) }
    finally { setBusy(false) }
  }

  async function submitMessage(value = draft, originalAttachments?: ConversationAttachment[], retryOriginal = false, options?: { previewOnly?: boolean }) {
    if (archived || submitLock.current) return
    const previewOnly = options?.previewOnly === true || (!isResearch && !retryOriginal &&
      (screeningNoExecutionPattern.test(value) || embedded && (!task || screeningInputIntent(value) === 'edit')))
    if (!retryOriginal && companyShortcuts.submit(value)) return
    const attached = originalAttachments ?? attachments.ready
    const attachmentIds = attached.map(item => item.id)
    let content = value.trim() || (attachmentIds.length ? '请分析上传的文件' : '')
    if (pendingPlan && !retryOriginal) content = `${previewOnly ? '请整理' : '请执行选股，采用'}引用的选股方案（固定版本）。以该版本的条件、参数与组合逻辑为基础${value.trim() ? '，并应用下面的补充要求' : ''}。${scopeDate ? `本次行情截止日期采用 ${scopeDate}。` : ''}\n${value.trim()}`
    if (!content) return
    if (!retryOriginal) content = companyShortcuts.question(content)
    const routeScreening = isResearch && scope === 'screening' && assistantId === 'general' && !embedded && !conversation?.messages.length
    if (content.length > 8000) { setError('问题加上当前公司信息超过 8000 字，请先精简问题。'); return }
    if (!originalAttachments && attachments.hasUnready) { setError('请等待附件上传完成，或移除未上传的文件。'); return }
    if (modelUnavailable) { setError('当前模型或推理档位不可用，请选择可用模型后发送。'); return }
    const inputIntent = screeningInputIntent(content)
    const resultQuestion = !isResearch && screeningResultQuestionPattern.test(value.trim())
    if (!retryOriginal && !isResearch && !task && (pendingPlan || inputIntent !== 'question') && !resultQuestion && !screeningSavePattern.test(value.trim())) {
      const poolLabel = scopePool === 'all' ? '全部A股' : `自选分组“${watchlists.find(item => item.id === scopePool)?.name || ''}”`
      const additions = [scopeOverrides.pool || screeningMethod ? `股票范围以界面设置为准：${poolLabel}。` : `未在要求中明确指定股票范围时，默认使用${poolLabel}。`]
      if (scopeDate) additions.push(scopeOverrides.date || screeningMethod ? `行情截止日期以界面设置为准：${scopeDate}。` : `未在要求中明确指定截止日期时，默认使用${scopeDate}的行情。`)
      additions.push(previewOnly || screeningNoExecutionPattern.test(content)
        ? '仅整理筛选方案，暂不执行；有关键条件不明确时先向用户提问。'
        : '请整理筛选方案；条件完整后请开始筛选并直接返回结果，不等待用户再次确认；有关键条件不明确时先向用户提问。')
      content += `${screeningWorkspacePromptMarker}${additions.join('\n')}`
    } else if (!retryOriginal && !isResearch && task && inputIntent === 'edit') {
      content += `${screeningWorkspacePromptMarker}${previewOnly || screeningNoExecutionPattern.test(content)
        ? '用户提交了方案修改。更新方案但暂不执行；有关键条件不明确时先向用户提问。'
        : '用户提交了方案修改。更新条件后请开始筛选并直接返回新结果；有关键条件不明确时先向用户提问。'}`
    }
    if (content.length > 8000) { setError('问题加上当前设置超过 8000 字，请先精简问题。'); return }
    if (!content || !conversationReady || busy || saving || assistantSaving || modeSaving || modelSavingRef.current || scopeSavingRef.current || (!isResearch && scopeEdited && scopeDirty) || turnInProgress || loadingConversation || loadingSessions) return
    submitLock.current = true
    setBusy(true)
    setError('')
    followLatestRef.current = true
    let conversationId = conversation?.id ?? ''
    let submittingDraftKey = draftKey
    try {
      let current = conversation
      if (!current) {
        const payload = { entry_scope: scope, workflow_type: workflowType, research_depth: researchDepth, ...modelPreference, ...(isResearch ? { assistant_id: assistantId } : {}) }
        if (conversationCreation.current?.draftKey !== draftKey || JSON.stringify(conversationCreation.current.payload) !== JSON.stringify(payload)) {
          conversationCreation.current = { draftKey, requestId: crypto.randomUUID(), payload }
        }
        const created = await api<Conversation>('/conversations', {
          method: 'POST',
          body: JSON.stringify({ ...payload, request_id: conversationCreation.current.requestId }),
        })
        conversationCreation.current = null
        // Creation returns metadata, whereas React state always needs the full
        // conversation shape while the first message is being saved.
        current = { ...created, messages: [], turns: [], pending_execution: false }
        conversationId = current.id
        submittingDraftKey = `${initialWorkflowType}:${scope}:${current.id}`
        // Switch the draft's identity atomically with the new conversation.
        // Failed message writes can then be retried or restored after reload.
        setDrafts(items => { const next = { ...items, [submittingDraftKey]: items[draftKey] ?? draft }; delete next[draftKey]; return next })
        setDraftSources(items => { const next = { ...items, [submittingDraftKey]: pendingSource }; delete next[draftKey]; return next })
        setExtraSources(items => { const next = { ...items, [submittingDraftKey]: pendingExtraSources }; delete next[draftKey]; return next })
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
      const retriedMessage = retryOriginal ? conversation?.messages.filter(item => item.role === 'user' && item.content === value).at(-1) : undefined
      const selectedSources = retriedMessage?.source_refs.flatMap(item => messageSource(item) ?? [])
        ?? [...(pendingSource ? [pendingSource] : []), ...pendingExtraSources]
      const questionRunId = screeningPanelOpen && screeningPanelTab === 'result' ? viewingRunId : current.active_run_id
      if (!retryOriginal && resultQuestion && questionRunId && selectedSources.length < MAX_DRAFT_SOURCES && !selectedSources.some(item => item.reference.kind === 'screening_run')) {
        selectedSources.push({ reference: { kind: 'screening_run', source_id: questionRunId }, label: '当前筛选批次' })
      }
      const sourceRefs = mergeDraftSources([], selectedSources).map(source => source.reference)
      const messageIdentity: unknown[] = attachmentIds.length ? [value.trim(), sourceRefs, attachmentIds] : [value.trim(), sourceRefs]
      if (!isResearch && screeningMethod && !task) messageIdentity.push({ method: screeningMethod, pool: scopePool, as_of: scopeDate })
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
      if (isResearch && !retryAttempt && hasResearchScopeLimits(current.research_scope)) {
        current = await clearResearchScope(current)
        setConversation(current)
      }
      const currentPayload: MessagePayload = {
        base_revision: current.task_revision,
        ...(isResearch ? { research_scope_revision: current.research_scope_revision ?? 0 } : {}),
        ...(isResearch && current.assistant_revision != null ? { assistant_revision: current.assistant_revision } : {}),
        ...(current.model_revision != null ? { model_revision: current.model_revision } : {}),
        content,
        source_refs: sourceRefs,
        ...(routeScreening ? { route_screening: true } : {}),
        ...(!isResearch && !previewOnly && (retryOriginal ? retriedMessage?.source_refs.some(item => item.execution_requested === true) : pendingPlan) ? { execute_plan: true } : {}),
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
        workflow_type?: WorkflowType
        turn?: ConversationTurn
        processing_error?: string
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
      setExtraSources(items => ({ ...items, [submittingDraftKey]: [] }))
      setMessageAttempts(items => { const next = { ...items }; delete next[submittingDraftKey]; return next })
      attachments.clear(submittingDraftKey, messagePayload.attachment_ids ?? [])
      if (routeScreening && messageResult.workflow_type === 'screening' && onLocationChange && !messageResult.processing_error) {
        reportLocation(current.id, current.entry_scope, 'screening')
        return
      }
      if (selectedIdRef.current === current.id) {
        if (stockFollowUp) resumeScreeningDraft()
        else { setPendingSource(null); onSourceChange?.(null) }
      }
      if (['succeeded', 'failed', 'cancelled'].includes(messageResult.state)) {
        await reloadConversation(current.id)
        setRefreshIndex(index => index + 1)
      } else await processTurn(current.id, messageResult.turn_id, !previewOnly, messageResult.processing_error ? undefined : messageResult.turn)
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
      submitLock.current = false
      setBusy(false)
    }
  }

  function selectScreeningPlan(source: ScreeningPlanSource) {
    if (pendingSource && !isScreeningPlan(pendingSource)) {
      if (pendingExtraSources.length >= 7) { setError('当前引用已达到上限，请先移除部分来源。'); return }
      setExtraSources(items => ({ ...items, [draftKey]: pendingExtraSources.some(item => JSON.stringify(item.reference) === JSON.stringify(pendingSource.reference)) ? pendingExtraSources : [...pendingExtraSources, pendingSource] }))
    }
    setSource(source)
    globalThis.setTimeout(() => focusComposer(), 0)
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (companyShortcuts.keyDown(event)) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitComposer()
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
  const currentRunAvailable = !!pendingTurn || (!!task && runs.some(item => item.task_revision === task.revision))
  const filteredSessions = sessions.filter(item => (item.title ?? '').toLowerCase().includes(sessionQuery.trim().toLowerCase()))
  const missingTaskInfo = task ? [!task.conditions.length || !task.logic_tree ? '筛选条件' : '', !task.scope.universe ? '股票范围' : '', !task.scope.as_of ? '截止日' : ''].filter(Boolean).join('、') : ''
  const showTaskPanel = isResearch ? resultsOpen : screeningPanelOpen && (!!task || !!runs.length || !!viewingRunId || !!pendingTurn)
  const suggestedName = task?.conditions.map(item => item.description).join('；').slice(0, 120) || '研究方案'
  const screeningDraftIntent = !isResearch && task ? screeningInputIntent(draft) : 'message'
  const currentSessionTitle = sessions.find(item => item.id === selectedId)?.title

  useEffect(() => {
    if (!isResearch && compactScreeningPanel && screeningPanelOpen && workspaceSession.active && !screeningDetailsRef.current?.contains(document.activeElement)) screeningDetailsRef.current?.focus({ preventScroll: true })
  }, [isResearch, compactScreeningPanel, screeningPanelOpen, workspaceSession.active])
  const latestScreeningUserMessage = conversation?.messages.filter(message => message.role === 'user').at(-1)?.content ?? ''
  const screeningExecutionPaused = !isResearch && !!task && screeningNoExecutionPattern.test(latestScreeningUserMessage)
  const currentRunSummary = runs.find(item => item.id === conversation?.active_run_id && (!task || item.task_revision === task.revision))
    ?? runs.find(item => !task || item.task_revision === task.revision)
  const readableBatch = latestTurn?.state === 'failed' && !isResearch
    ? runs.find(item => item.turn_id === latestTurn.id && ['succeeded', 'partial'].includes(item.status))
      ?? runs.find(item => ['succeeded', 'partial'].includes(item.status))
    : undefined
  const deliveryRunSummary = currentRunSummary && ['queued', 'running'].includes(currentRunSummary.status)
    ? currentRunSummary : readableBatch ?? currentRunSummary
  const turnsWithAcceptedRun = new Set(runs.filter(item => ['queued', 'running', 'succeeded', 'partial'].includes(item.status)).map(item => item.turn_id))
  const viewingBatch = runs.find(item => item.id === viewingRunId)
  const historicalBatch = !!viewingBatch && (viewingBatch.id !== deliveryRunSummary?.id || viewingBatch.task_revision !== task?.revision)
  const showBatchPlan = historicalBatch && !editingCurrentPlan
  const panelPlan = showBatchPlan ? run?.id === viewingRunId ? run.task : null : task
  const materialSources = panelPlan ? ([
    { library: 'news', label: '资讯', lookback: panelPlan.scope.news_lookback_calendar_days },
    { library: 'report', label: '研报', lookback: panelPlan.scope.report_lookback_calendar_days },
  ] as const).flatMap(source => {
    const count = panelPlan.conditions.filter(condition => condition.library === source.library).length
    return count ? [{ ...source, count }] : []
  }) : []
  const updatingScreeningPlan = !isResearch && !!activeTurn && screeningInputIntent(latestScreeningUserMessage) !== 'question'
    && (!deliveryRunSummary || !task || task.revision <= activeTurn.base_revision)
  const showScreeningDelivery = !isResearch && !!conversation && (!!conversation.messages.length || !!task || !!deliveryRunSummary || !!pendingTurn)
    && (!!task || !!deliveryRunSummary || !!pendingTurn || screeningInputIntent(latestScreeningUserMessage) !== 'question')
  useEffect(() => {
    setScreeningPanelOpen(false); setScreeningPanelTab('plan'); setEditingCurrentPlan(false); setScreeningDetailsMounted(false)
    automaticallyOpenedRun.current = ''
    screeningReadingSnapshot.current = null; screeningPanelReturnFocus.current = null
  }, [isResearch, selectedId, newResearchKey])
  useEffect(() => {
    const current = deliveryRunSummary ?? runs[0]
    if (isResearch || embedded || compactScreeningPanel || conversation?.id !== selectedId || !current || automaticallyOpenedRun.current === current.id) return
    automaticallyOpenedRun.current = current.id
    if (screeningPanelOpen && historicalBatch) return
    setScreeningDetailsMounted(true)
    setScreeningPanelTab('result')
    setEditingCurrentPlan(false)
    setScreeningPanelOpen(true)
  }, [isResearch, embedded, compactScreeningPanel, selectedId, conversation?.id, deliveryRunSummary?.id, runs[0]?.id])
  useEffect(() => {
    if (isResearch || !returnResult || !workspaceSession.active || restoredResult.current === returnResult
      || returnResult.conversationId !== conversation?.id || conversation.id !== selectedId) return
    restoredResult.current = returnResult
    restorePosition(returnResult)
    openScreeningPanel('result')
  }, [returnResult, workspaceSession.active, isResearch, selectedId, conversation?.id])
  useEffect(() => {
    if (isResearch || !conversation || !task || !scopeEdited || !scopeDate || !scopeDirty || turnInProgress || loadingConversation || busy || saving || scopeSaveState === 'error' || scopeSaveState === 'saving') return
    if (scopeReadyKey.current !== `${conversation.id}:${task.revision}`) return
    const timer = globalThis.setTimeout(() => { void applyScope() }, 400)
    return () => globalThis.clearTimeout(timer)
  }, [conversation?.id, task?.revision, scopeDate, scopePool, scopeEdited, scopeDirty, turnInProgress, loadingConversation, busy, saving, scopeSaveState])

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

  const indicatorControl = !embedded && <MyIndicators onOpenDataServices={onOpenDataServices} initialCommon={openCommonIndicators && conversationReady && !loadingSessions && !loadingConversation} onInitialCommonConsumed={() => setOpenCommonIndicators(false)} key={`indicators:${draftKey}:${newResearchKey || 0}`} contextKey={`${draftKey}:${newResearchKey || 0}`} conversationId={conversationReady ? conversation?.id : undefined} workflow={workflowType} data={data} defaultAsOf={isResearch ? undefined : scopeDate || task?.scope.as_of || undefined} defaultStock={isResearch ? undefined : task?.scope.universe?.stock_codes?.[0] || (task?.scope.universe?.kind === 'watchlist' || scopePool !== 'all' && scopePool !== 'explicit' ? '' : '000001.SZ')} turnActive={turnInProgress} refreshKey={refreshIndex + (conversation?.messages.length || 0)} disabled={!!archived || busy || saving || assistantSaving || modeSaving || modelSaving || !conversationReady || loadingConversation || loadingSessions} onPrompt={prepareIndicatorDraft} onScreening={isResearch ? onStartIndicatorScreening : prepareIndicatorDraft} />
  const composerPlanControl = !embedded && (isResearch ? indicatorControl : <MyScreeningPlans disabled={!!archived || busy || saving || turnInProgress || !conversationReady || loadingConversation || loadingSessions} initialOpen={openCommonIndicators && conversationReady && !loadingSessions && !loadingConversation} onInitialOpenConsumed={() => setOpenCommonIndicators(false)} onSelect={selectScreeningPlan} />)
  const screeningHint = !isResearch ? screeningUnsupportedHint(draft) : ''
  const submitDisabled = archived || busy || saving || assistantSaving || modeSaving || modelSaving || (!companyShortcuts.isCommand && (modelUnavailable || attachments.hasUnready)) || (!isResearch && scopeEdited && scopeDirty) || scopeSaveState === 'saving' || turnInProgress || !conversationReady || loadingConversation || loadingSessions
  const planOnlyDraft = !isResearch && screeningNoExecutionPattern.test(draft)
  const savingPlan = !pendingPlan && screeningSavePattern.test(draft.trim())
  const previewByDefault = !isResearch && !embedded && !savingPlan &&
    (!!pendingPlan || !task || screeningDraftIntent === 'edit' || planOnlyDraft)
  const executeLabel = pendingPlan ? '执行选股' : task ? '修改并重筛' : '生成并筛选'
  function submitComposer() {
    void submitMessage(draft, undefined, false, { previewOnly: previewByDefault })
  }
  const submitLabel = busy ? '处理中…'
    : companyShortcuts.isCommand ? '执行命令'
    : isResearch ? '发送'
    : savingPlan ? '保存方案'
    : previewByDefault || planOnlyDraft ? (task && !pendingPlan ? '只改方案' : '只生成方案')
    : pendingPlan ? '执行选股'
    : screeningDraftIntent === 'question' ? '发送追问'
    : task ? (embedded ? '更新方案' : '修改并重筛')
    : embedded ? '生成选股草稿' : '生成并筛选'
  const showResearchStarter = isResearch && scope === 'screening' && assistantId === 'general' && !pendingSource && !pendingExtraSources.length && !messageCount && !loadingConversation
  const showDraftActions = !embedded && !showResearchStarter && assistantId !== 'qmt-script' && !!handoff
  const navigationDisabled = !!archived || busy || saving || !conversationReady || loadingConversation || loadingSessions

  const showMethodSetup = !!screeningMethod && !isResearch && !pendingPlan && !embedded && !conversation?.messages.length && !task
  const methodSettings = <ScreeningSettings label="选股设置">{open => <>
    <label className="workspace-field-label">条件核验<select aria-label="专用选股条件核验" className="workspace-field workspace-select" value={researchDepth} disabled={busy || modeSaving} onChange={event => void changeResearchDepth(event.target.value as ResearchDepth)}>{Object.entries(depthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <ResearchModelPicker visible={open} value={modelSelection} disabled={busy || modelSaving || turnInProgress} onChange={selection => void changeModel(selection)} onAvailabilityChange={available => setModelAvailability({ key: modelSelectionKey, available })} onCatalogError={setModelCatalogError} />
  </>}</ScreeningSettings>

  const composerFirst = !embedded && !messageCount && !task
  const composer = (
    <form key="composer" className="conversation-composer workspace-form" ref={composerRef} onSubmit={(event) => { event.preventDefault(); submitComposer() }}>
      {archived && <div className="conversation-pending-source workspace-feedback workspace-feedback-info" role="status"><span>此对话已归档。可在左侧更多操作中恢复后继续。</span></div>}
      {modelCatalogError && <div className="conversation-pending-source workspace-error" role="alert"><span>分析服务设置暂时无法读取：{modelCatalogError}。当前选择保留。</span><button type="button" className="text-button workspace-button" onClick={openModelPicker}>检查模型设置</button></div>}
      {modelUnavailable && <div className="conversation-pending-source workspace-feedback workspace-feedback-info" role="status"><span>当前模型或推理档位不可用，请切换后发送。</span><button type="button" className="text-button workspace-button" disabled={busy || modelSaving || turnInProgress} onClick={openModelPicker}>切换模型</button></div>}
      {conversation?.screening_draft_source && <div className="conversation-pending-source workspace-feedback workspace-feedback-info"><span>来源：研究答复</span><button type="button" className="text-button workspace-button" onClick={() => onOpenConversation?.(conversation.screening_draft_source!.source_conversation_id, 'screening', 'research')}>查看原研究</button></div>}
      <label htmlFor="conversation-input">{isResearch ? '研究要求' : '选股要求'}</label>
      {companyShortcuts.context}
      {stockFollowUp && <div className="stock-follow-up-context"><span role="status">追问草稿 · 原选股草稿已保留</span><button type="button" className="text-button workspace-button" disabled={busy || attachments.uploading} onClick={() => { resumeScreeningDraft(); focusComposer() }}>返回原选股草稿</button></div>}
      {pendingSource && <div className="conversation-pending-source workspace-feedback workspace-feedback-info" data-plan={pendingPlan || undefined} aria-label={pendingPlan ? '引用的选股方案' : undefined}><span aria-hidden="true">@</span><DraftSourceLabel source={pendingSource} /><button type="button" className="icon-button workspace-button" aria-label={pendingPlan ? '移除方案引用' : '移除来源页'} onClick={() => setSource(null)}><X size={14} /></button></div>}
      {pendingExtraSources.length > 0 && <div className="screening-extra-sources" aria-label={isResearch ? '已选资料' : '新增条件依据'}>{pendingExtraSources.map((source, index) => <span key={draftSourceKey(source)}><DraftSourceLabel source={source} /><button type="button" className="icon-button workspace-button" aria-label={`移除条件依据 ${source.label}`} onClick={() => setExtraSources(current => ({ ...current, [draftKey]: (current[draftKey] ?? []).filter((_, position) => position !== index) }))}><X size={13} /></button></span>)}</div>}
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
        placeholder={isResearch ? assistantId === 'general' && scope === 'screening' && !messageCount ? '输入问题，或描述选股条件…' : '输入公司、行业或研究问题…' : '描述选股条件，或追问已有结果…'}
      />
      {showDraftActions && <div className="conversation-handoff-actions" role="group" aria-label="当前问题操作">
        <button type="button" className="text-button workspace-button" disabled={navigationDisabled} onClick={pickReport}>选研报</button>
        {isResearch && onStartScreening && <button type="button" className="text-button workspace-button" disabled={navigationDisabled} onClick={() => onStartScreening(captureQuestion())}>带入选股</button>}
      </div>}
      {!isResearch && !task && <details className="screening-scope-editor"><summary><span>{scopeOverrides.pool || scopeOverrides.date ? '选定范围与日期' : '默认范围与日期'}</span><strong>{scopePool === 'all' ? '全部A股' : watchlists.find(item => item.id === scopePool)?.name || '指定股票池'} · {scopeDate || '待指定'}</strong><span>修改</span></summary><div className="screening-default-scope scope-picker"><label className="workspace-field-label">{scopeOverrides.pool ? '选定范围' : '默认范围'}<select aria-label="默认股票范围" disabled={busy || !conversationReady || loadingConversation || loadingSessions} value={scopePool} onChange={event => { setScopePool(event.target.value); setScopeOverrides(current => ({ ...current, pool: true })) }} className="workspace-field workspace-select"><option value="all">全部A股</option>{watchlists.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="workspace-field-label">{scopeOverrides.date ? '选定截止日' : '默认截止日'}<input aria-label="默认行情日期" disabled={busy || !conversationReady || loadingConversation || loadingSessions} type="date" max={data?.last_date} value={scopeDate} onChange={event => { setScopeDate(event.target.value); setScopeOverrides(current => ({ ...current, date: true })) }} className="workspace-field" /></label></div></details>}
      {screeningHint && <p className="screening-capability-warning workspace-feedback-inline" role="status">{screeningHint}{onOpenDataServices && <button type="button" className="text-button workspace-button" onClick={onOpenDataServices}>查看数据与服务</button>}</p>}
      <div className="conversation-composer-footer">
        <div className="conversation-composer-tools">
          {!embedded && <ResearchComposerMenu value={assistantId} snapshot={conversation?.assistant} showAssistants={false}
            disabled={archived || busy || saving || assistantSaving || modelSaving || attachments.uploading || turnInProgress || !conversationReady || loadingConversation || loadingSessions}
            onChange={id => void changeAssistant(id)} onUpload={files => void attachments.upload(files)} />}
          {isResearch && <ScreeningSettings label="研究设置" key={`research-settings:${draftKey}:${newResearchKey || 0}`}>{open => <>
            <p className="research-settings-note">默认设置即可开始研究。这里的调整只影响后续提问，历史研究保留原配置。</p>
            {!embedded && <ResearchComposerMenu value={assistantId} snapshot={conversation?.assistant} showUpload={false} disabled={!!archived || busy || saving || assistantSaving || modelSaving || attachments.uploading || turnInProgress || !conversationReady || loadingConversation || loadingSessions} onChange={id => void changeAssistant(id)} onUpload={files => void attachments.upload(files)} />}
            <ResearchModelPicker visible={open} value={modelSelection} disabled={!!archived || busy || saving || assistantSaving || modeSaving || modelSaving || attachments.uploading || turnInProgress || !conversationReady || loadingConversation || loadingSessions} onChange={selection => void changeModel(selection)} onAvailabilityChange={available => setModelAvailability({ key: modelSelectionKey, available })} onCatalogError={setModelCatalogError} />
            {indicatorControl}
          </>}</ScreeningSettings>}
          {!isResearch && <ScreeningSettings key={`${draftKey}:${newResearchKey || 0}`}>{open => <>
            <label className="studio-mode-select workspace-field-label"><span>条件核验</span><select aria-label="研究深度" value={researchDepth} disabled={busy || saving || modeSaving || modelSaving || turnInProgress || !conversationReady || loadingConversation || loadingSessions} onChange={event => void changeResearchDepth(event.target.value as ResearchDepth)} className="workspace-field workspace-select">{Object.entries(depthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{modeSaving && <LoaderCircle size={14} className="spin" />}</label>
            <ResearchModelPicker visible={open} value={modelSelection} disabled={archived || busy || saving || assistantSaving || modeSaving || modelSaving || attachments.uploading || turnInProgress || !conversationReady || loadingConversation || loadingSessions} onChange={selection => void changeModel(selection)} onAvailabilityChange={available => setModelAvailability({ key: modelSelectionKey, available })} onCatalogError={setModelCatalogError} />
          </>}</ScreeningSettings>}
        </div>
        {!isResearch && composerPlanControl}
        <span>{draft.length >= 7000 ? `${draft.length}/8000` : ''}</span>
        <div className="conversation-submit-actions">
          {previewByDefault && !planOnlyDraft && <button type="button" className="secondary-button screening-preview-button workspace-button" disabled={submitDisabled || (!draft.trim() && !attachments.ready.length && !pendingPlan)} onClick={() => void submitMessage()}>{executeLabel}</button>}
          <button className="primary-button workspace-button" type="submit" aria-keyshortcuts="Enter" disabled={submitDisabled || (!draft.trim() && !attachments.ready.length && !pendingPlan)}>
            {busy ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />}
            {submitLabel}
          </button>
        </div>
      </div>
      <p className="composer-keyboard-hint"><span>{companyShortcuts.isCommand ? 'Enter 确认 · ↑ ↓ 选择 · Esc 关闭提示' : isResearch ? 'Enter 发送 · Shift + Enter 换行 · 输入 / 使用快捷命令' : previewByDefault ? 'Enter 仅提交方案 · Shift + Enter 换行' : 'Enter 发送 · Shift + Enter 换行'}</span></p>
    </form>
  )

  return (
    <StockText><div className={`conversation-product research-studio${showMethodSetup ? ' screening-method-start' : ''}${embedded ? ' conversation-embedded' : ''}${isResearch ? '' : ` screening-studio${runs.length || pendingTurn ? ' screening-has-results' : ''}`}`}>
      {handoff?.returnAction && <div className="conversation-handoff-return"><button type="button" className="text-button workspace-button" onClick={handoff.returnAction.onClick}>{handoff.returnAction.label}</button></div>}
      {embedded && <div className="library-conversation-tabs" role="group" aria-label="资料助手视图"><button type="button" className="workspace-button" aria-pressed={!showTaskPanel} onClick={() => isResearch ? setResultsOpen(false) : closeScreeningPanel()}>对话</button><button type="button" className="workspace-button" aria-pressed={!!showTaskPanel} disabled={!conversation} onClick={() => isResearch ? setResultsOpen(true) : openScreeningPanel(currentRunAvailable ? 'result' : 'plan')}>{isResearch ? '成果与文件' : '方案与结果'}</button></div>}
      <div className="page-heading conversation-header-heading">
        <div className="conversation-heading-title">
          <h1>{isResearch ? '研究对话' : '选股对话'}</h1>
          {currentSessionTitle && <span className="conversation-session-caption" data-tooltip={currentSessionTitle}>{currentSessionTitle}</span>}
        </div>
        {!embedded && isResearch && conversation && hasResearchResults && <ResearchConversationTools resultsOpen={resultsOpen} resultsToggleRef={resultsToggleRef}
          onToggleResults={() => setResultsOpen(value => !value)} portalTargetId={shellNavigation ? 'research-tools-slot' : undefined} />}
        {(!shellNavigation || !isResearch) && <div className="conversation-heading-actions">
          {!isResearch && task && <ScreeningAddConditions asOf={task.scope.as_of || scopeDate} disabled={busy || saving || turnInProgress || !!archived} onPrepare={prepareAdditionalCondition} />}
          {!isResearch && (task || runs.length || pendingTurn) && <button ref={screeningPanelToggleRef} type="button" className="icon-button screening-results-toggle workspace-button" aria-label="筛选方案与结果" data-tooltip="筛选方案与结果" aria-expanded={showTaskPanel} aria-controls="screening-view-panel" onClick={() => screeningPanelOpen ? closeScreeningPanel() : openScreeningPanel(deliveryRunSummary ? 'result' : 'plan')}><FileSearch size={18} aria-hidden="true" /></button>}
          {!shellNavigation && <><button ref={disclosureRef} className="session-disclosure secondary-button workspace-button" aria-label={isResearch ? '最近研究对话' : '历史与方案'} aria-expanded={sessionsOpen} aria-controls="screening-sessions" onClick={() => setSessionsOpen(value => !value)}><History size={16} /><span>{isResearch ? '最近对话' : '历史与方案'}</span></button><button className="secondary-button conversation-new workspace-button" aria-label={isResearch ? '新研究' : '新选股对话'} data-tooltip={isResearch ? '新研究' : '新选股对话'} disabled={busy || saving || loadingSessions} onClick={() => { setSessionsOpen(false); createConversation() }}><Plus size={16} /><span>{isResearch ? '新研究' : '新建选股'}</span></button></>}
        </div>}
      </div>
      {!isResearch && error && (isExecutionFailure(error) ? <ResearchFailure onOpenDataServices={onOpenDataServices} onAdjustScope={focusComposer} content={error} /> : <div className="conversation-error workspace-error" role="alert"><AlertCircle size={17} /><span>{error}</span><button className="icon-button workspace-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>)}
      {!isResearch && notice && <div className="conversation-notice workspace-feedback workspace-feedback-success" role="status"><Check size={16} /><span>{notice}</span><button className="icon-button workspace-button" aria-label="关闭保存提示" onClick={() => setNotice('')}><X size={15} /></button></div>}
      <div style={{ '--screening-chat-fraction': `${screeningSplit}fr`, '--screening-result-fraction': `${100 - screeningSplit}fr` } as CSSProperties} className={`conversation-workspace conversation-workspace-start ${!conversation?.messages.length && !task ? 'conversation-workspace-empty' : ''} ${!isResearch && showTaskPanel ? 'screening-detail-open' : ''}`}>
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
                data-tooltip={fullTimeDescription(item.updated_at)}
                className={["workspace-button", `conversation-session-row ${selectedId === item.id ? 'selected' : ''}`].filter(Boolean).join(' ')}
                disabled={busy || saving}
                aria-current={selectedId === item.id ? 'true' : undefined}
                onClick={() => { setSessionsOpen(false); if (item.id === selectedId && conversation) return; openSession(item); if (onOpenConversation && conversationWorkflow(item, initialWorkflowType) !== initialWorkflowType) return; setConversation(null); setTask(null); resetResults({ keepSelection: true }); setError(''); setRefreshIndex(value => value + 1) }}
              >
                <strong>{item.title?.trim() || '新对话'}</strong>
                <span>{conversationWorkflow(item, initialWorkflowType) === 'research' ? '研究对话' : '选股对话'}{item.last_turn_state === 'failed' ? ' · 已中断' : item.last_turn_state === 'running' ? ' · 处理中' : ''} · <TimeLabel value={item.updated_at} focusable={false} /></span>
              </button>
            ))}
          </div>
        )}
        </>}
      </aside>

      <section id="screening-view-conversation" hidden={embedded && !!showTaskPanel} role={isResearch ? undefined : 'region'} tabIndex={isResearch ? undefined : 0} className="conversation-main" aria-label={isResearch ? '研究对话' : '选股对话'}>{showMethodSetup ? <ScreeningMethodSetup key={`${screeningMethod}:${newResearchKey || 0}`} method={screeningMethod!} requirement={draft} onRequirement={setDraft}
          asOf={scopeDate} pool={scopePool} watchlists={watchlists} onDate={value => { setScopeDate(value); setScopeOverrides(current => ({ ...current, date: true })) }} onPool={value => { setScopePool(value); setScopeOverrides(current => ({ ...current, pool: true })) }} data={data}
          disabled={!!archived || busy || saving || turnInProgress || !conversationReady || loadingConversation || loadingSessions || modelSaving || modeSaving} modelUnavailable={modelUnavailable}
          settings={methodSettings} indicators={composerPlanControl} descriptionKey={methodDescriptionKey}
          onSubmit={(value, previewOnly) => void submitMessage(value, undefined, false, { previewOnly })} onTemplate={(template, parameters) => void selectTemplate(template, parameters)}
          onSaved={shellNavigation ? undefined : onScreeningSaved} onHistory={shellNavigation ? undefined : onScreeningHistory} onBrowse={onBrowseScreeningSources} onOpenData={onOpenDataServices} /> : <>{!conversation?.messages.length && (isResearch || !task) && !loadingConversation && <div className="chat-empty-heading">
          <span className="research-welcome-mark" aria-hidden="true"><img src="/brand/soochow-symbol-blue.png" alt="" /></span>
          {isResearch && data?.last_date && <div className="mobile-research-date"><ChartNoAxesCombined size={14} aria-hidden="true" />行情截至 <time dateTime={data.last_date}>{data.last_date}</time></div>}
          <h1>{isResearch ? assistantId === 'qmt-script' ? '编写 QMT 脚本' : '今天想弄清楚什么？' : '想筛选什么样的股票？'}</h1>
        </div>}
        {isResearch && error && (isExecutionFailure(error) ? <ResearchFailure onOpenDataServices={onOpenDataServices} onAdjustScope={focusComposer} content={error} /> : <div className="conversation-error workspace-error" role="alert"><AlertCircle size={17} /><span>{error}</span><button className="icon-button workspace-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>)}
        {isResearch && notice && <div className="conversation-notice workspace-feedback workspace-feedback-success" role="status"><Check size={16} /><span>{notice}</span><button className="icon-button workspace-button" aria-label="关闭保存提示" onClick={() => setNotice('')}><X size={15} /></button></div>}
        {loadingConversation && <LoadingState label="正在恢复对话…" skeleton />}
        {isResearch && conversation && <ResearchQuestionIndex messages={conversation.messages} onJump={id => {
          const target = Array.from(messageListRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') || []).find(element => element.dataset.messageId === id)
          if (!target) return
          followLatestRef.current = false
          setShowLatest(true)
          target.scrollIntoView?.({ block: 'start', behavior: 'auto' })
          target.focus({ preventScroll: true })
        }} />}
        {composerFirst && composer}
        <div className="conversation-message-stage">
          <div className="conversation-message-list" ref={messageListRef} role="log" aria-live="polite" aria-relevant="additions" onScroll={onMessageListScroll} onWheel={() => { if (screeningPanelOpen) readingChangedWhilePanel.current = true }} onTouchStart={() => { if (screeningPanelOpen) readingChangedWhilePanel.current = true }} onKeyDown={event => { if (screeningPanelOpen && ['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) readingChangedWhilePanel.current = true }}>
            {embedded && !conversation?.messages.length && !task && !loadingConversation && <p className="library-context-intro">{isResearch ? '资料已带入，可修改下方问题后发送，继续核对判断与原文依据。' : '先把资料中的判断整理为选股草稿，再确认条件、范围并开始筛选。'}</p>}
            {!conversation?.messages.length && !task && !loadingConversation && !embedded && (
              <div className="conversation-empty">
                {isResearch
                  ? (assistantId === 'qmt-script' ? <p className="conversation-muted">描述策略或粘贴已有脚本，发送后生成代码、静态检查结果和 .py 下载文件。</p> : showResearchStarter ? <ResearchTaskEntry key={`${draftKey}:${newResearchKey || 0}`} draft={draft} draftKey={draftKey} disabled={navigationDisabled} onPrompt={prepareDraft} onScreening={onStartScreening && (() => onStartScreening(captureQuestion()))} onReports={pickReport} /> : <ResearchStarters items={researchSuggestions[scope]} disabled={navigationDisabled} onSelect={prepareDraft} />)
                  : <>
                    {onScreeningMethod ? <p className="conversation-muted">描述选股要求，或引用已有方案。</p> : <ResearchStarters groupLabel="常用选股任务" items={screeningQuickTasks} disabled={busy || saving || !conversationReady || loadingConversation || loadingSessions} onSelect={prepareDraft} />}
                    <div className="screening-start-tools">
                      {onScreeningCompose && <button type="button" className="text-button workspace-button" onClick={onScreeningCompose}>组合多个条件</button>}
                      <button type="button" className="text-button workspace-button" aria-expanded={screeningExamplesOpen} aria-controls="screening-start-examples" onClick={() => setScreeningExamplesOpen(value => !value)}>选股示例</button>
                      {!shellNavigation && !onScreeningSaved && <button type="button" className="text-button workspace-button" onClick={() => { setLibraryTab('saved'); setSessionsOpen(true) }}>查看已保存方案</button>}
                      <ScreeningReadiness compact showScope={false} data={data} scope={scope} task={task} asOf={scopeDate} onOpenData={onOpenDataServices} />
                    </div>
                    <section id="screening-start-examples" className="screening-start-panel" aria-label="选股示例" hidden={!screeningExamplesOpen}>
                    <ScreeningTemplates key={`${draftKey}:${newResearchKey || 0}`} disabled={busy || saving || !conversationReady || loadingConversation || loadingSessions || !scopeDate} onSelect={(template, parameters) => void selectTemplate(template, parameters)} />
                    <p className="screening-capability-line">
                      <strong>可筛</strong>日线量价、常见技术指标、申万行业与市盈率、形态、研报与资讯原文。
                      <strong>暂不筛</strong>季度财务、市净率、历史 ST 和分钟线。
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
            const retryTurn = retryQuestion && turnsByMessage.get(retryQuestion.id)
            const canRetryAnswer = retryQuestion && retryQuestion.id === conversation.messages.filter(item => item.role === 'user').at(-1)?.id
              && retryTurn?.state === 'failed' && !turnsWithAcceptedRun.has(retryTurn.id)
            const availableBatch = readableBatch && retryTurn?.id === latestTurn?.id && {
              asOf: readableBatch.as_of, revision: readableBatch.task_revision,
              onView: () => {
                handoff?.onReleaseScreeningResult()
                selectRun(readableBatch.id)
                openScreeningPanel('result')
              },
            }
            return (
              <article className={`conversation-message ${message.role}`} key={message.id} data-message-id={message.id} tabIndex={-1}>
                <div className="conversation-message-meta">
                  <strong>{message.role === 'user' ? '你' : message.role === 'assistant' ? isResearch ? '投研助手' : '选股助手' : '工具'}</strong>
                  <TimeLabel value={message.created_at} />
                  {turn && !['succeeded'].includes(turn.state) && <span className={["workspace-status", `conversation-turn-state ${stateClass(turn.state)}`].filter(Boolean).join(' ')}>{stateLabels[turn.state] ?? turn.state}</span>}
                  {turn?.assistant && turn.assistant.id !== 'general' && <span className="conversation-assistant-tag workspace-status" data-tooltip={`助手版本 ${turn.assistant.revision}`}>{turn.assistant.name}</span>}
                </div>
                {isResearch && answerTurn && <ResearchActivityHistory key={`${conversation.id}:${answerTurn.id}`} conversationId={conversation.id} turnId={answerTurn.id} />}
                {failed ? <ResearchFailure screening={!isResearch} availableBatch={availableBatch || undefined} onOpenDataServices={onOpenDataServices} onAdjustScope={focusComposer} content={message.content} disabled={busy || turnInProgress} onRetry={canRetryAnswer ? () => void submitMessage(retryQuestion.content, retryQuestion.attachments, true) : undefined} /> : message.role === 'assistant' ? <ResearchAnswer content={message.content} conversationId={message.file_conversation_id || conversation.id} messageId={message.id} references={message.source_refs} summary={isResearch ? answerTurn?.result.research_summary : undefined} /> : <p className="conversation-plain-message">{message.display_content ?? message.content}</p>}
                <MessageAttachmentChips items={message.attachments} />
                {!!message.source_refs.length && (!isResearch || message.role !== 'assistant') && <AnswerSources references={message.source_refs} />}
                {message.role === 'assistant' && !failed && (isResearch ? <ResearchResultActions onServiceDraft={onServiceDraft ? () => onServiceDraft(serviceResearchDraft(conversation, message)) : undefined} key={message.id} conversation={conversation} message={message} disabled={busy || turnInProgress || !!archived} savingAction={answerActionSaving} onCopy={() => void copyAnswer(message.content)} onSubmit={action => submitResearchResult(message.id, action)} onContinue={focusComposer} onRegenerate={() => void changeResearchAnswer(message, 'regenerate')} onBranch={() => void changeResearchAnswer(message, 'branch')} /> : <div className="studio-answer-actions"><button type="button" className="text-button workspace-button" onClick={() => void copyAnswer(message.content)}><Copy size={14} />复制答复</button></div>)}
                {isResearch && versions.length > 1 && <div className="research-answer-versions" role="group" aria-label="回答版本"><button type="button" aria-label="上一个回答版本" disabled={versionIndex === 0} onClick={() => setVersionSelection(current => ({ ...current, [message.regeneration_of || message.id]: versions[versionIndex - 1].id }))} className="workspace-button"><ChevronLeft size={14} /></button><span>{versionIndex + 1} / {versions.length}</span><button type="button" aria-label="下一个回答版本" disabled={versionIndex === versions.length - 1} onClick={() => setVersionSelection(current => ({ ...current, [message.regeneration_of || message.id]: versions[versionIndex + 1].id }))} className="workspace-button"><ChevronRight size={14} /></button></div>}
                {turn?.state === 'failed' && !turnsWithAcceptedRun.has(turn.id) && conversation.messages.filter(item => item.role === 'user').at(-1)?.id === message.id && <button className="secondary-button compact workspace-button" disabled={busy || turnInProgress} onClick={() => void submitMessage(message.content, message.attachments, true)}>重新处理</button>}{turn?.state === 'awaiting_agent' && !turn.job && <button className="secondary-button compact workspace-button" disabled={busy} onClick={() => void processTurn(conversation.id, turn.id)}><Play size={14} />继续处理</button>}
              </article>
            )
            })}
            {activeTurn && (isResearch || screeningInputIntent(latestScreeningUserMessage) === 'question') && <ResearchProgress label={codexProgress || (activeTurn.state === 'running' ? isResearch ? '正在研究' : '正在整理选股条件' : '等待开始处理')} startedAt={activeTurn.created_at} updatedAt={progressUpdatedAt || activeTurn.updated_at} activities={researchActivities} stopping={stopping} onStop={() => void stopTurn()} />}
            {showScreeningDelivery && conversation && <div className="screening-delivery-anchor" ref={screeningDeliveryRef}>
              <ScreeningDeliveryCard conversationId={conversation.id} task={task} currentRun={deliveryRunSummary} viewedRun={run} viewedRunId={viewingRunId}
                readError={runError} refreshKey={refreshIndex} active={workspaceSession.active} processing={updatingScreeningPlan} failed={latestTurn?.state === 'failed'} cancelled={latestTurn?.state === 'cancelled' && !deliveryRunSummary}
                pending={!!pendingTurn && !deliveryRunSummary} paused={screeningExecutionPaused} canStart={!!startableTurn && canExecute && !currentRunAvailable && !turnInProgress}
                disabled={busy || saving || turnInProgress || !!archived} stopping={stopping || busy}
                onPlan={() => openScreeningPanel('plan', true)} onResults={() => openScreeningPanel('result', true)} onEdit={focusScreeningDraft}
                onStart={() => void startScreening()} onReload={() => setRefreshIndex(value => value + 1)}
                onRetryStart={pendingTurn ? () => void retryExecution(pendingTurn.id) : undefined}
                onStop={updatingScreeningPlan ? () => void stopTurn() : deliveryRunSummary?.job_id ? () => void cancelRun(deliveryRunSummary.job_id) : undefined}
                onClarify={composeClarification} onContentChange={() => { if (followLatestRef.current) requestAnimationFrame(() => scrollToLatest('auto')); else setShowLatest(true) }} onRunStatus={updateRunStatus} />
            </div>}
          </div>
          {showLatest && <button type="button" className="conversation-latest-button workspace-button" onClick={() => scrollToLatest()}><ArrowDown size={14} />{!isResearch && ['succeeded', 'partial'].includes(deliveryRunSummary?.status || '') ? '筛选结果已就绪' : '查看最新'}</button>}
        </div>
        {!composerFirst && composer}
        {companyShortcuts.overlays}
      </>}
      </section>

      {!embedded && !isResearch && !compactScreeningPanel && showTaskPanel && <ScreeningSplitHandle value={screeningSplit} onChange={setScreeningSplit} />}
      {!embedded && isResearch && resultsOpen && <div className="research-results-backdrop" onClick={() => setResultsOpen(false)} aria-hidden="true" />}
      {!embedded && !isResearch && compactScreeningPanel && showTaskPanel && <div className="research-results-backdrop" onClick={closeScreeningPanel} aria-hidden="true" />}
      <aside ref={isResearch ? undefined : screeningDetailsRef} id={isResearch ? 'research-results-drawer' : 'screening-view-panel'} role={embedded || !isResearch && !compactScreeningPanel ? 'region' : 'dialog'} tabIndex={-1} aria-modal={!embedded && (isResearch || compactScreeningPanel) ? true : undefined} className={'conversation-task-panel ' + (isResearch ? 'research-results-drawer workspace-tool-dialog workspace-drawer' : 'screening-results-drawer workspace-tool-dialog workspace-drawer')} aria-label={isResearch ? '研究成果' : '筛选方案与结果'} hidden={!showTaskPanel} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); isResearch ? setResultsOpen(false) : closeScreeningPanel() }; if (!embedded && (isResearch || compactScreeningPanel)) trapDialogTab(event) }}>
        {(isResearch || screeningDetailsMounted) && <>
        <div className={isResearch ? 'research-results-heading' : 'screening-results-heading'}>
        {isResearch
          ? <button ref={resultsCloseRef} type="button" className="icon-button research-results-close workspace-button" aria-label="关闭研究成果" onClick={() => setResultsOpen(false)}><X size={19} /></button>
          : <button ref={screeningPanelCloseRef} type="button" className={phoneScreeningPanel ? 'text-button screening-panel-back workspace-button' : 'icon-button research-results-close workspace-button'} aria-label={phoneScreeningPanel ? undefined : '关闭筛选方案与结果'} onClick={closeScreeningPanel}>{phoneScreeningPanel ? <><ArrowLeft size={18} aria-hidden="true" />返回对话</> : <X size={19} />}</button>}
        <div className="studio-results-heading"><h2>{isResearch ? '研究成果' : phoneScreeningPanel ? (screeningPanelTab === 'result' ? '结果名单' : '条件方案') : '筛选方案与结果'}</h2></div>
        {!isResearch && <div className="screening-panel-navigation">
          <div className="screening-panel-tabs" role="tablist" aria-label="方案与结果详情" onKeyDown={onScreeningPanelTabsKeyDown}>
            <button type="button" role="tab" id="screening-plan-tab" data-panel-tab="plan" aria-selected={screeningPanelTab === 'plan'} aria-controls="screening-plan-detail" tabIndex={screeningPanelTab === 'plan' ? 0 : -1} className="workspace-button" onClick={() => selectScreeningPanelTab('plan')}>筛选方案</button>
            <button type="button" role="tab" id="screening-result-tab" data-panel-tab="result" aria-selected={screeningPanelTab === 'result'} aria-controls="screening-result-detail" tabIndex={screeningPanelTab === 'result' ? 0 : -1} className="workspace-button" onClick={() => selectScreeningPanelTab('result')}>筛选结果</button>
          </div>
          {(runs.length > 0 || viewingRunId) && <select aria-label="查看筛选运行" value={viewingRunId} onChange={event => { setEditingCurrentPlan(false); handoff?.onReleaseScreeningResult(); selectRun(event.target.value); if (screeningDetailsRef.current) screeningDetailsRef.current.scrollTop = 0 }} className="workspace-field workspace-select">
            {viewingRunId && !viewingBatch && <option value={viewingRunId}>原筛选批次</option>}
            {runs.map(item => {
              const batch = item.id === deliveryRunSummary?.id ? '当前' : '历史'
              const time = new Date(item.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
              const date = `${item.as_of} · ${time} · v${item.task_revision}`
              return <option key={item.id} value={item.id}>{phoneScreeningPanel ? `${date} · ${batch}` : `${batch}批次 · ${item.as_of} · v${item.task_revision} · ${time} · ${stateLabels[item.status] ?? item.status}`}</option>
            })}
          </select>}
        </div>}
        </div>

        {!isResearch && !historicalBatch && <div className="screening-drawer-readiness"><ScreeningReadiness compact={embedded} data={data} scope={scope} task={task} asOf={scopeDate} onOpenData={onOpenDataServices} /></div>}
        {isResearch && conversation?.id === selectedId && <ResearchPanel key={conversation.id} conversationId={conversation.id} turnActive={turnInProgress} refreshKey={refreshIndex + conversation.messages.length} onContentChange={setHasResearchResults} showGenerate={conversation.messages.some(message => message.role === 'assistant' && !isExecutionFailure(message.content)) && !conversation.turns.every(turn => turn.state === 'failed' || turn.state === 'cancelled')} />}
        {!isResearch && <section id="screening-plan-detail" role="tabpanel" aria-labelledby="screening-plan-tab" hidden={screeningPanelTab !== 'plan'} className="conversation-task-section">
          <div className="conversation-panel-heading">
            <h2>{showBatchPlan ? `批次方案 · v${viewingBatch!.task_revision}` : task ? `当前方案 · v${task.revision}` : '筛选方案'}</h2>
            {historicalBatch && task && <button type="button" className="secondary-button compact workspace-button" onClick={() => setEditingCurrentPlan(value => !value)}>{showBatchPlan ? `编辑当前方案 v${task.revision}` : '返回批次方案'}</button>}
          </div>
          {showBatchPlan && !panelPlan && (runError
            ? <div role="alert" className="workspace-error"><p>无法读取批次方案。{runError}</p><button type="button" className="text-button workspace-button" onClick={() => setRefreshIndex(value => value + 1)}>重新读取批次方案</button></div>
            : <p role="status">{run?.id === viewingRunId ? '这一批次暂未提供方案快照。' : '正在读取批次方案…'}</p>)}
          {!showBatchPlan && !task && <p role="status">方案尚未整理完成，请在对话中查看进展。</p>}
          {panelPlan && <>
            <div className="screening-plan-understanding" role="group" aria-label="方案理解">
              <span className="screening-plan-understanding-label">{showBatchPlan ? '批次规则快照 · 只读' : '我的理解'}</span>
              <p>{panelPlan.conditions.length
                ? `${panelPlan.conditions.slice(0, 4).map(item => item.description).join('；')}${panelPlan.conditions.length > 4 ? `；等 ${panelPlan.conditions.length} 条条件` : ''}`
                : '还没有可执行的条件。'}</p>
              <small>{taskUniverseLabel(panelPlan)} · {panelPlan.scope.as_of ? `用 ${panelPlan.scope.as_of} 的收盘数据` : '截止日待确定'}</small>
            </div>
            <div className="conversation-task-conditions">{showBatchPlan ? <TaskLogic task={panelPlan} /> : <TaskCompositionEditor task={panelPlan} disabled={busy || saving || turnInProgress || runInProgress || loadingConversation || scopeDirty || scopeSaveState === 'saving'} saving={compositionSaving} onEdit={change => void editComposition(change)} />}</div>
            <div className="conversation-task-scope">
              <span>范围</span><strong>{taskUniverseLabel(panelPlan)}</strong>
              <span>截止日</span><strong>{panelPlan.scope.as_of ?? '未确定'}</strong>
              {!showBatchPlan && panelPlan.conditions.some(item => ['technical', 'pattern'].includes(item.library)) && data?.last_date && data.last_date !== panelPlan.scope.as_of && <><span>本地行情覆盖至</span><strong>{data.last_date}</strong></>}
              {panelPlan.scope.ranking && <>
                <span>排名范围</span><strong>{({ all_a_shares: '全部A股', watchlist: '自选股票池', after_filters: '满足指定条件的股票', industry: '行业内' } as Record<string, string>)[String(panelPlan.scope.ranking.ranking_universe)] ?? '待确定'}</strong>
                <span>选取数量</span><strong>{panelPlan.scope.ranking.top_n != null ? `前 ${String(panelPlan.scope.ranking.top_n)} 名` : `前 ${Number(panelPlan.scope.ranking.top_fraction) * 100}%（人数向上取整）`}</strong>
                <span>并列处理</span><strong>{panelPlan.scope.ranking.ties_policy === 'include_all' ? '保留全部并列' : '同分按股票代码排序'}</strong>
                <span>缺失处理</span><strong>{panelPlan.scope.ranking.missing_policy === 'exclude_with_notice' ? '排除缺失并说明' : '范围不完整时保留未知'}</strong>
              </>}
            </div>
            {panelPlan.conditions.some(item => ['technical', 'pattern'].includes(item.library)) && <p className="conversation-muted">本地日线 · {({ unadjusted: '不复权', forward_adjusted: '前复权', back_adjusted: '后复权' } as Record<string, string>)[panelPlan.scope.price_basis || ''] ?? (showBatchPlan ? '复权方式未记录' : ({ forward_adjusted: '前复权', back_adjusted: '后复权' } as Record<string, string>)[data?.price_basis || ''] ?? '不复权')}</p>}
            {(!showBatchPlan || materialSources.length > 0) && <section className="screening-materials" aria-label="资料条件">
              <header><h3>资料条件</h3>{!showBatchPlan && <ScreeningAddConditions materialsOnly asOf={panelPlan.scope.as_of || scopeDate} disabled={busy || saving || turnInProgress || !!archived} onPrepare={prepareAdditionalCondition} />}</header>
              {materialSources.length > 0 && <ul>{materialSources.map(source => <li key={source.library}>{source.label} · {source.count} 条{source.lookback != null ? ` · 近 ${source.lookback} 个自然日` : ''}</li>)}</ul>}
            </section>}
          </>}
          {!showBatchPlan && task && <>
            {!!task.unresolved.length && <section aria-label="方案待补充信息"><h3>还有 {task.unresolved.length} 项需要补充</h3>{task.unresolved.map((item, index) => <p key={index}>{item.question}</p>)}<button type="button" className="text-button workspace-button" onClick={focusScreeningQuestions}>在对话中补充</button></section>}
            <details className="screening-plan-edit"><summary>修改范围与日期</summary><div className="scope-picker">
              <label className="workspace-field-label">股票范围<select aria-label="调整股票范围" value={scopePool} disabled={busy || turnInProgress || scopeSaveState === 'saving'} onChange={event => { setScopePool(event.target.value); setScopeEdited(true); setScopeSaveState('idle') }} className="workspace-field workspace-select"><option value="all">全部A股</option>{task.scope.universe?.kind === 'explicit' && <option value="explicit">当前指定股票</option>}{watchlists.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
              <label className="workspace-field-label">行情日期<input aria-label="调整行情日期" type="date" value={scopeDate} max={data?.last_date} disabled={busy || turnInProgress || scopeSaveState === 'saving'} onChange={event => { setScopeDate(event.target.value); setScopeEdited(true); setScopeSaveState('idle') }} className="workspace-field" /></label>
              {data?.last_date && <button className="text-button workspace-button" disabled={busy || turnInProgress || scopeSaveState === 'saving'} onClick={() => { setScopeDate(data.last_date!); setScopeEdited(true); setScopeSaveState('idle') }}>选用最新行情日</button>}
              {(scopeDirty && scopeEdited || scopeSaveState !== 'idle') && <span className="scope-save-status conversation-muted workspace-feedback-inline" role="status">{scopeSaveState === 'saving' ? '正在自动保存…' : scopeSaveState === 'saved' ? '范围和日期已自动保存' : scopeSaveState === 'error' ? '自动保存失败' : '等待自动保存'}{scopeSaveState === 'error' && <button className="icon-button workspace-button" data-tooltip="重试保存范围和日期" aria-label="重试保存范围和日期" onClick={() => void applyScope()}><RefreshCw size={14} /></button>}</span>}
            </div>
            </details>
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
              ) : <button className="secondary-button workspace-button" disabled={busy || saving || turnInProgress} onClick={focusScreeningDraft}>补充筛选要求</button>}
              <button className="text-button workspace-button" disabled={busy || saving || turnInProgress} onClick={focusScreeningDraft}>修改条件</button>
            </div>
            {!canExecute && !task.unresolved.length && <p className="conversation-muted">请先{scopeDirty && scopeEdited ? '等待范围与日期自动保存' : missingTaskInfo || '完整条件'}。</p>}
            {canExecute && !!draft.trim() && <p className="conversation-muted">输入框中有未发送的草稿，可回到对话继续编辑。</p>}
            <details className="screening-plan-secondary"><summary>命名与保存</summary>
              <button className="text-button workspace-button" disabled={!canSave || busy || saving || turnInProgress || scopeDirty || scopeSaveState === 'saving'} data-tooltip={!canSave ? '请先补充完整条件和股票范围' : undefined} onClick={() => void saveTask(suggestedName)}>{saving ? <LoaderCircle size={14} className="spin" /> : <Bookmark size={14} />}{saving ? '保存中…' : '保存方案'}</button>
              <button className="icon-button workspace-button" disabled={!canSave || busy || saving || turnInProgress} data-tooltip="设置方案名称" aria-label="设置方案名称" aria-expanded={saveOpen} onClick={() => { setSaveName(suggestedName); setSaveOpen(value => !value) }}><Pencil size={15} /></button>
            {saveOpen && <form className="conversation-save-form workspace-form" onSubmit={event => { event.preventDefault(); void saveTask() }}>
              <label htmlFor="saved-task-name">方案名称</label>
              <input id="saved-task-name" autoFocus value={saveName} maxLength={120} disabled={saving} onChange={event => setSaveName(event.target.value)} placeholder="方案名称" className="workspace-field" />
              <div><button className="primary-button compact workspace-button" disabled={saving || !saveName.trim()} type="submit">{saving ? '保存中…' : '确认保存'}</button><button className="text-button workspace-button" type="button" disabled={saving} onClick={() => setSaveOpen(false)}>取消</button></div>
            </form>}
            </details>
          </>}
        </section>}

        {!isResearch && screeningPanelTab === 'result' && !runs.length && !viewingRunId && !pendingTurn && <p>方案就绪后可开始筛选。</p>}
        {!isResearch && (!!runs.length || !!viewingRunId || !!pendingTurn) && <section id="screening-result-detail" role="tabpanel" aria-labelledby="screening-result-tab" hidden={screeningPanelTab !== 'result'} className="conversation-run-section">
          <div className="conversation-panel-heading screening-result-section-heading">
            <h2>候选名单与判断依据</h2>
          </div>
          {pendingTurn && !historicalBatch && <div className="conversation-retry-notice" role="status">
            <span>筛选尚未启动。</span>
            <button className="secondary-button compact workspace-button" disabled={busy} onClick={() => void retryExecution(pendingTurn.id)}><Play size={14} />{busy ? '正在启动…' : '重试启动筛选'}</button>
          </div>}
          {!runs.length && !viewingRunId ? (
            <p className="conversation-muted">尚无筛选运行</p>
          ) : runError ? (
            <div role="alert" className="saved-task-empty workspace-error"><strong>筛选运行加载失败</strong><p>{runError}</p><p>尚未读取运行状态，不能据此判断是否匹配。</p><button type="button" className="secondary-button compact workspace-button" onClick={() => setRefreshIndex(value => value + 1)}>重新加载筛选运行</button></div>
          ) : loadingRun || !run || run.id !== viewingRunId ? (
            <p className="conversation-muted" role="status"><LoaderCircle size={14} className="spin" />正在读取运行…</p>
          ) : (
            <ScreeningResultView
              key={run.id}
              evidenceLayout={embedded ? 'drawer' : 'inline'}
              onResearchStock={onResearchResult ? stockCode => continueStockResearch(stockCode, run) : undefined}
              restorePosition={showTaskPanel && screeningPanelTab === 'result' && returnResult?.conversationId === conversation?.id && returnResult?.runId === run.id ? returnResult : undefined}
              onEvidenceSelect={stockCode => { if (returnResult?.stockCode !== stockCode) handoff?.onReleaseScreeningResult() }}
              resultKey={run.id}
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
              onStateFilterChange={state => browseDecisions({ state, offset: 0 })}
              onQueryChange={query => browseDecisions({ query, offset: 0 })}
              onPageChange={offset => browseDecisions({ offset })}
              onCancel={() => void cancelRun(run.job_id)}
              onAskStock={(stockCode, state) => askAboutStock(stockCode, state, run)}
              onCopyAll={() => void copyAllMatching()}
              onExportUrl={`/api/v1/conversations/${conversation!.id}/screening-runs/${run.id}/export?state=${decisionState}&query=${encodeURIComponent(decisionQuery)}`}
              onViewChart={(code) => setChart({ code, date: run.as_of })}
              onAdjustRequirements={focusScreeningDraft}
              adjustments={resultAdjustments}
              onApplyAdjustment={applyScreeningAdjustment}
              onOpenData={onOpenDataServices}
              onSavePlan={run.task?.conditions.length && run.task.references.length && run.task.logic_tree && run.task.scope.universe && !run.task.unresolved.length ? () => void saveTask(run.task.conditions.map(item => item.description).join('；').slice(0, 120) || '选股方案', run.task) : undefined}
              savePlanDisabled={busy || saving || !!archived || turnInProgress || scopeSaveState === 'saving' || run.task_revision === task?.revision && scopeDirty}
              savingPlan={saving}
              onReload={reloadDecisions}
            />
          )}
        </section>}
        </>}
      </aside>
      </div>
      {chart && <StockChartDialog code={chart.code} asOf={chart.date} onClose={() => setChart(null)} />}
      {fixedRulesOpen && workspaceSession.active && !isResearch && !embedded && onCloseFixedRules && <FixedScreeningRules
        date={scopeDate} pool={scopePool} latestDate={data?.last_date} watchlists={watchlists}
        disabled={!!archived || busy || saving || modeSaving || turnInProgress || !conversationReady || loadingConversation || loadingSessions}
        running={busy} onClose={onCloseFixedRules} onRun={selectTemplate}
        onPrepare={rule => prepareAdditionalCondition(task ? `请保留现有筛选方案，在原整组条件上增加固定规则：${rule}。` : `请按以下固定规则选股：${rule}。`)}
      />}
    </div></StockText>
  )
}
