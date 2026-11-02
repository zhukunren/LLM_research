import LoadingState from '../components/LoadingState'
import { StockText } from '../components/StockMentions'
import { localStorage } from '../authStorage'
import ConversationRunView from '../components/ConversationRunView'
import ScreeningResultView from '../components/ScreeningResultView'
import StockChartDialog from '../components/StockChartDialog'
import './history-results-layout.css'
import StockSearch from '../components/StockSearch'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowRight, Check, ChevronDown, CircleHelp, Clock3, Database, GitBranch, Library, ListOrdered, MessageCircle, Play, Plus, RefreshCw, Save, Search, SlidersHorizontal, Sparkles, TrendingUp, X } from 'lucide-react'
import { api, type ConversationScope, type ConversationSourceReference, type DataStatus, type Filter, type Pattern, type Strategy, type WorkflowType } from '../api'
import { ParameterNumber, type Asset, type Node } from './StrategyPage'
import { actualLabel, applyConditionParameters, conditionParameter, conditionText, distinctConditionDescription, targetLabel } from '../conditionText'
import { libraryCopy, writeCombination, type LibraryScope, type LibrarySeed } from '../libraryContext'
import ConversationWorkspace from '../components/conversation/ConversationWorkspace'
import type { ConversationHistoryChange } from '../components/ConversationHistoryItem'
import { appendConditionPlan, compositionFingerprint, compositionIssues, executionDateIssue } from '../screeningWorkflow'
import { referencedConditionKeys } from '../conditionTransfer'
import ConditionTransferEditor from '../components/ConditionTransferEditor'
import ConditionWorkspaceDrawer from '../components/ConditionWorkspaceDrawer'
import CompositionPicker from '../components/CompositionPicker'
import CompositionRankingSettings from '../components/CompositionRankingSettings'
import ConditionReferenceDetails from '../components/ConditionReferenceDetails'
import { compositionNode, replaceCompositionNode } from '../compositionReferences'
import './condition-workspace.css'
import EmptyState from '../components/EmptyState'
import ReportEvaluations from './ReportEvaluations'

export type Section = 'conversation' | 'create' | 'library' | 'compose' | 'history' | 'saved'
type Contract = NonNullable<Filter['contract']>
type DraftCondition = { key: string; name: string; source_quote: string; library: Filter['library']; expression: Filter['expression']; contract: Contract; parameters: Filter['parameters'] }
type Edit = { name?: string; parameters?: Record<string, string | number> }
type SavedDraft = { filters: Filter[]; tree: Node; confirmation?: { edits: Record<string, Edit> } }
type NewsMatch = { candidate_count: number; matched_count: number; start_date: string | null; end_date: string | null; items: { id: string; title: string; body: string; source: string; reason: string; quote: string }[] }
type Draft = { news_matches?: NewsMatch; id: string; prompt: string; original_prompt: string; source: string; model: string | null; compiler_version: string; status: string; conditions: DraftCondition[]; tree: PlanNode | null; issues: { kind: string; text: string; suggestion: string }[]; assumptions: string[]; saved?: SavedDraft; source_document?: { document_id: string; title: string; page: number } }
type PlanNode = { op: string; key?: string; children?: PlanNode[] }
type Pool = { id: string; name: string; items: { stock_code: string }[] }
type Evidence = { document_id: string; title: string; criteria?: { label: string; state: string; summary: string; evidence: { page: number; quote: string }[] }[] }
type FormulaTrace = { op: string; label: string; value?: number | string | null; state?: string; operator?: string; left?: FormulaTrace; right?: FormulaTrace; input?: FormulaTrace; children?: FormulaTrace[]; previous?: { left: number | null; right: number | null }; daily_values?: { date: string | null; state: string; formula: FormulaTrace }[] }
type Detail = { name: string; summary?: string; effective_expression?: Filter['expression']; formula_trace?: FormulaTrace | null; program_trace?: { code_hash: string; metrics: Record<string, number | null>; daily_values: { date: string | null; state: string; metrics: Record<string, number | null> }[] } | null; daily_values?: { date: string | null; state: string; actual?: number; baseline?: number; reason?: string }[]; state: string; reason?: string; actual?: number | string | Record<string, number>; similarity?: number; threshold?: number; operator?: string; unit?: string; version?: number; node_path?: string; previous?: Record<string, number>; baseline?: number; start_date?: string; end_date?: string; data_date?: string; provenance?: Filter['provenance']; assessments?: Evidence[] }
type Logic = { op: string; name?: string; state: string; children?: Logic[] }
type Decision = { stock_code: string; state: string; close: number | null; score: number; as_of: string | null; reason?: string; details: Detail[]; logic?: Logic }
type Run = { id: string; strategy_id: string; strategy_version: number; as_of: string; status: string; created_at: string; result: { counts?: Record<string, number>; results?: Decision[]; unknown_sample?: Decision[]; blockers?: string[]; trace_version?: string; data_snapshot?: { watermark: string; sha256?: string }; condition_snapshots?: Filter[] }; context?: { universe?: { name: string; codes?: string[] }; strategy_snapshot?: Strategy }; job?: { id: string; message: string; progress: number } }
type RunSummary = Pick<Run, 'id' | 'strategy_id' | 'strategy_version' | 'as_of' | 'status' | 'created_at'> & { kind?: string; name?: string; conversation_id?: string; entry_scope?: ConversationScope }
type Preview = { state: string; stock_code: string; actual_date: string | null; details: Detail[] }

const sections: { id: Section; title: string; icon: typeof Sparkles }[] = [{ id: 'conversation', title: '研究对话', icon: MessageCircle }, { id: 'create', title: '描述条件', icon: Sparkles }, { id: 'library', title: '我的条件', icon: Library }, { id: 'compose', title: '高级组合', icon: GitBranch }, { id: 'history', title: '筛选记录', icon: Clock3 }]

const stateLabels: Record<string, string> = { true: '符合', false: '不符合', unknown: '数据不足', queued: '等待执行', running: '正在筛选', succeeded: '已完成', partial: '已完成 · 有数据不足', failed: '执行失败', cancelled: '已取消', blocked_dependency: '缺少所需数据' }
const libraryNames = { technical: '行情条件', report: '研报条件', news: '资讯条件' }
const emptyTree = (): Node => ({ op: 'all', children: [] })
const countRefs = (node: Node): number => node.op.endsWith('_ref') ? 1 : (node.children ?? []).reduce((sum, child) => sum + countRefs(child), 0)
const numberText = (value: number | null | undefined) => value == null ? '—' : Number.isFinite(value) ? Number(value.toFixed(4)).toLocaleString('zh-CN', { maximumFractionDigits: 4 }) : '—'
const dateText = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

function useStored<T,>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : initial } catch { return initial } })
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* A full browser store must not prevent execution. */ } }, [key, value])
  return [value, setValue] as const
}

export default function WorkbenchPage({ onReports, initialCommonIndicators, conversationUpdate, onHistoryChange, shellNavigation = false, workflowOnly = false, onOpenDataServices, onConditions, onResumeConversation, newResearchKey, onNewResearchConsumed, conversationId, onOpenProject, conversationPrompt, conversationNewDraft = false, onPromptConsumed, data, scope, view, onViewChange, onCompose, seed, screeningOnly = false, onCreateCondition, onSeedConsumed, conversationScope = 'screening', conversationWorkflowType = 'research', onLocationChange, onConversationScopeChange, onConversation, conversationSource, onConversationSourceChange }: { initialCommonIndicators?: boolean; conversationUpdate?: { id: string } & ConversationHistoryChange; onHistoryChange?: () => void; shellNavigation?: boolean; workflowOnly?: boolean; onOpenDataServices?: () => void; onConditions?: () => void; onResumeConversation?: (id: string, scope: ConversationScope, workflow?: WorkflowType, prompt?: string) => void; newResearchKey?: number; onNewResearchConsumed?: () => void; conversationId?: string; onOpenProject?: (id: string) => void; conversationPrompt?: string; conversationNewDraft?: boolean; onPromptConsumed?: () => void; data: DataStatus | null; onReports: (filter?: Filter) => void; scope?: LibraryScope; view?: Section; onViewChange?: (section: Section) => void; onCompose?: () => void; seed?: LibrarySeed; screeningOnly?: boolean; onCreateCondition?: () => void; onSeedConsumed?: () => void; conversationScope?: ConversationScope; conversationWorkflowType?: WorkflowType; onLocationChange?: (id: string, scope: ConversationScope, workflow: WorkflowType) => void; onConversationScopeChange?: (scope: ConversationScope) => void; onConversation?: (scope: LibraryScope, source?: { reference: ConversationSourceReference; label: string }, prompt?: string, workflow?: WorkflowType) => void; conversationSource?: { reference: ConversationSourceReference; label: string } | null; onConversationSourceChange?: (source: { reference: ConversationSourceReference; label: string } | null) => void }) {
  const prefix = scope ? `library.${scope}` : 'workbench'
  const copy = scope ? libraryCopy[scope] : null
  const [storedSection, setStoredSection] = useStored<Section>(`${prefix}.section`, screeningOnly || workflowOnly ? 'conversation' : 'create')
  const conditionTools = workflowOnly && !scope
  const requestedSection = view ?? (screeningOnly && !['conversation', 'compose', 'history'].includes(storedSection) ? 'conversation' : storedSection)
  const [creationOrigin, setCreationOrigin] = useState<'library' | 'compose'>(requestedSection === 'compose' ? 'compose' : 'library')
  const [creationOpen, setCreationOpen] = useState(conditionTools && requestedSection === 'create')
  const section = conditionTools && requestedSection === 'create' ? creationOrigin : requestedSection
  useEffect(() => { if (conditionTools) setCreationOpen(requestedSection === 'create') }, [conditionTools, requestedSection])
  const [advancedToolsOpen, setAdvancedToolsOpen] = useState(false)
  const [evaluationFilter, setEvaluationFilter] = useState<Filter | null>(null)
  const advancedToolsVisible = advancedToolsOpen || ['create', 'library', 'compose'].includes(section)
  function setSection(next: Section) {
    if (conditionTools && next === 'create') { setCreationOrigin(section === 'compose' ? 'compose' : 'library'); setCreationOpen(true); setNotice(''); setError(''); return }
    setCreationOpen(false)
    if (screeningOnly && (next === 'create' || next === 'library')) { onCreateCondition?.(); return }
    if (scope && (next === 'compose' || next === 'history')) { localStorage.setItem('workbench.section', JSON.stringify(next)); onCompose?.(); return }
    setStoredSection(next); onViewChange?.(next)
  }
  const [prompt, setPrompt] = useStored(`${prefix}.prompt`, '')
  const [newsStart, setNewsStart] = useStored('library.news.start', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))
  const [newsEnd, setNewsEnd] = useStored('library.news.end', new Date().toISOString().slice(0, 10))
  const [draftId, setDraftId] = useStored(`${prefix}.draft`, '')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [edits, setEdits] = useStored<Record<string, Edit>>(`${prefix}.edits`, {})
  const [sourceDocument, setSourceDocument] = useStored<LibrarySeed | null>(`${prefix}.source`, null)
  const [draftHistory, setDraftHistory] = useState<{ id: string; prompt: string; saved: boolean }[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [stock, setStock] = useState('600000.SH')
  const [filters, setFilters] = useState<Filter[]>([])
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [patterns, setPatterns] = useState<Pattern[]>([])
  const [strategies, setStrategies] = useState<Strategy[]>([])
  const [pools, setPools] = useState<Pool[]>([])
  const [search, setSearch] = useState('')
  const [library, setLibrary] = useState<string>(scope ?? 'all')
  const [conditionSort, setConditionSort] = useState('recent')
  const [conditionLimit, setConditionLimit] = useState(12)
  const [selected, setSelected] = useState<Filter | null>(null)
  const [selectedEdit, setSelectedEdit] = useState<Edit>({})
  const [tree, setTree] = useStored<Node>('workbench.tree', emptyTree())
  const [rankingTree, setRankingTree] = useState<Node | null>(null)
  const [referencePath, setReferencePath] = useState<number[] | null>(null)
  const [strategyName, setStrategyName] = useStored('workbench.strategyName', '我的选股组合')
  const [strategyId, setStrategyId] = useStored('workbench.strategyId', '')
  const [topNInput, setTopNInput] = useStored('workbench.topNInput', (() => { try { return String(JSON.parse(localStorage.getItem('workbench.topN') || '30')) } catch { return '30' } })())
  const topN = topNInput.trim() ? Number(topNInput) : NaN
  const setTopN = (value: number) => setTopNInput(String(value))
  const [asOf, setAsOf] = useStored('workbench.asOf', '')
  const [poolId, setPoolId] = useStored('workbench.poolId', '')
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [resumeConversation, setResumeConversation] = useState<RunSummary | null>(null)
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false)
  const [runId, setRunId] = useStored('workbench.runId', '')
  const historyConversation = runs.find(item => item.id === runId && item.kind === 'conversation')
  const [run, setRun] = useState<Run | null>(null)
  const [runLoadError, setRunLoadError] = useState('')
  const [runReload, setRunReload] = useState(0)
  const [resultState, setResultState] = useState('true')
  const [resultQuery, setResultQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [total, setTotal] = useState(0)
  const [historyChart, setHistoryChart] = useState('')
  const [resultError, setResultError] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [resultLoading, setResultLoading] = useState(false)
  const [resourceWarnings, setResourceWarnings] = useState<string[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [savedComposition, setSavedComposition] = useStored<{ strategy: Strategy; fingerprint: string } | null>('workbench.savedComposition', null)
  const [previousComposition, setPreviousComposition] = useStored<{ tree: Node; name: string; id: string; topN: number } | null>('workbench.previousComposition', null)
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyStatus, setHistoryStatus] = useState('')
  const [historyLimit, setHistoryLimit] = useState(15)
  const actionLock = useRef(false)
  const submissionRequests = useRef<Record<string, string>>((() => { try { return JSON.parse(localStorage.getItem('workbench.submissionRequests') || '{}') } catch { return {} } })())
  function submissionRequest(key: string) {
    const id = submissionRequests.current[key] ?? crypto.randomUUID()
    submissionRequests.current[key] = id
    persistSubmissionRequests()
    return id
  }
  function finishSubmission(key: string) {
    delete submissionRequests.current[key]
    persistSubmissionRequests()
  }
  function persistSubmissionRequests() {
    try { localStorage.setItem('workbench.submissionRequests', JSON.stringify(submissionRequests.current)) } catch { /* Current-session retry remains available. */ }
  }
  const resultRef = useRef<HTMLElement>(null)
  const historyResultRef = useRef<HTMLElement>(null)
  const shouldScroll = useRef(false)
  const shouldFocusHistoryResult = useRef(false)

  async function refresh() {
    setCatalogLoading(true)
    const results = await Promise.allSettled([
      api<{ items: Filter[] }>(`/filters?include_history=true${scope ? `&library=${scope}` : ''}`),
      api<{ items: Pattern[] }>('/patterns?include_history=true'),
      api<{ items: Strategy[] }>('/strategies?include_history=true'),
      api<{ items: Pool[] }>('/watchlists'),
      api<{ items: RunSummary[] }>(screeningOnly || workflowOnly ? '/screening-history' : '/screening-runs'),
      api<{ items: typeof draftHistory }>(`/condition-drafts${scope ? `?library=${scope}` : ''}`),
    ])
    const [f,p,s,w,r,d] = results
    if(f.status === 'fulfilled') setFilters(f.value.items)
    if(p.status === 'fulfilled') setPatterns(p.value.items)
    if(s.status === 'fulfilled') setStrategies(s.value.items)
    if(w.status === 'fulfilled') setPools(w.value.items)
    if(r.status === 'fulfilled') setRuns(r.value.items)
    if(d.status === 'fulfilled') setDraftHistory(d.value.items)
    setCatalogLoaded(f.status === 'fulfilled' || p.status === 'fulfilled')
    const labels = ['条件目录','形态目录','组合版本','股票池','筛选记录','历史描述']
    setResourceWarnings(results.flatMap((result,index) => result.status === 'rejected' ? [labels[index] + '：' + (result.reason as Error).message] : []))
    setCatalogLoading(false)
  }
  useEffect(() => { void refresh().catch(e => setError(e.message)) }, [])
  useEffect(() => {
    if (!seed) return
    setDraft(null); setDraftId(''); setEdits({}); setPreview(null); setPrompt(seed.prompt ?? '')
    setSourceDocument(seed.source_document_id ? seed : null); setSection('create'); onSeedConsumed?.()
  }, [seed?.id])
  useEffect(() => { if (shouldScroll.current && draft) { resultRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); shouldScroll.current = false } }, [draft?.id])
  useEffect(() => {
    if (!shouldFocusHistoryResult.current || (historyConversation?.id !== runId && (!run || run.id !== runId))) return
    historyResultRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    historyResultRef.current?.focus({ preventScroll: true })
    shouldFocusHistoryResult.current = false
  }, [run?.id, runId, historyConversation?.id, runReload])
  useEffect(() => { if (!asOf && data?.last_date) setAsOf(data.last_date) }, [data?.last_date, asOf])
  useEffect(() => {
    let active = true
    if (!seed && draftId) api<Draft>(`/condition-drafts/${draftId}`).then(value => { if (active) { setDraft(value); if (value.saved?.confirmation) setEdits(value.saved.confirmation.edits) } }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [draftId])
  useEffect(() => {
    setRunLoadError('')
    if (!runId || !catalogLoaded || historyConversation) { setRun(null); return }
    let active = true, pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const next = await api<Run>(`/screening-runs/${runId}`)
        if (active) {
          setRun(next)
          setRuns(items => items.map(item => item.id === next.id && item.status !== next.status ? { ...item, status: next.status } : item))
          if (!['queued', 'running'].includes(next.status)) globalThis.clearInterval(timer)
        }
      } catch (e) { if (active) { setRun(null); setRunLoadError((e as Error).message); globalThis.clearInterval(timer) } }
      finally { pending = false }
    }
    const timer = globalThis.setInterval(load, 1500)
    void load()
    return () => { active = false; globalThis.clearInterval(timer) }
  }, [runId, runReload, catalogLoaded, historyConversation?.id])
  useEffect(() => {
    let active = true
    setResultError(''); setDecisions([]); setTotal(0)
    if (!run || run.id !== runId || ['queued', 'running'].includes(run.status)) return
    setResultLoading(true)
    const timer = globalThis.setTimeout(() => {
      api<{ items: Decision[]; total: number }>(`/screening-runs/${runId}/decisions?state=${resultState}&query=${encodeURIComponent(resultQuery)}&offset=${offset}`)
        .then(value => {
          if (!active) return
          if (!run.result.trace_version) {
            const old = [...(run.result.results ?? []), ...(run.result.unknown_sample ?? [])].filter(item => (!resultState || item.state === resultState) && item.stock_code.includes(resultQuery))
            setDecisions(old.slice(offset, offset + 50)); setTotal(old.length)
          } else { setDecisions(value.items); setTotal(value.total) }
        }).catch(e => { if (active) setResultError(e.message) }).finally(() => { if (active) setResultLoading(false) })
    }, 180)
    return () => { active = false; globalThis.clearTimeout(timer) }
  }, [runId, run?.id, run?.status, resultState, resultQuery, offset, runReload])

  const latest = useMemo(() => filters.filter(item => !filters.some(other => other.id === item.id && other.version > item.version)), [filters])
  const compositionKeys = useMemo(() => referencedConditionKeys(tree), [tree])
  const catalog = useMemo<Asset[]>(() => [
    ...filters.map(filter => ({ key: `filter:${filter.id}@${filter.version}`, label: `${filter.name} · v${filter.version}`, filter })),
    ...patterns.map(pattern => ({ key: `pattern:${pattern.id}@${pattern.version}`, label: `${pattern.name} · v${pattern.version} · 形态`, pattern })),
  ], [filters, patterns])
  const ready = draft?.status === 'ready' && prompt.trim() === draft.prompt
  const filtered = latest.filter(item => (library === 'all' || item.library === library) && `${item.name} ${item.description} ${item.contract?.summary ?? ''} ${item.provenance?.prompt ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => conditionSort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : b.created_at.localeCompare(a.created_at))
  useEffect(() => { setConditionLimit(12) }, [search, library, conditionSort])
  useEffect(() => { setHistoryLimit(15) }, [historyQuery, historyStatus])
  const selectedExpression = selected ? applyConditionParameters(selected.expression, selectedEdit.parameters) : {}
  const selectedSummary = selected ? conditionText(selected.library, selectedExpression, selected.contract?.summary ?? selected.description) : ''
  const selectedDirty = !!Object.keys(selectedEdit).length
  const reviewedConditions = (draft?.conditions ?? []).map(item => {
    const expression = applyConditionParameters(item.expression, edits[item.key]?.parameters)
    const naturalFormula = item.library === 'technical' && item.expression.op === 'timeseries_filter'
    if (naturalFormula && !expression.summary) expression.summary = item.source_quote
    const notes = item.contract.notes.map(note => note.startsWith('涨幅 =') ? `涨幅 =（最新收盘价 ÷ ${expression.window} 个交易日前收盘价 − 1）× 100%。` : note)
    return { ...item, name: naturalFormula ? item.source_quote : item.name, contract: { ...item.contract, notes, summary: conditionText(item.library, expression, naturalFormula ? item.source_quote : item.contract.summary) } }
  })

  const draftEditIssues = (draft?.conditions ?? []).flatMap(condition => {
    const edit = edits[condition.key]
    if(!edit) return []
    const issues: string[] = []
    if(edit.name != null && (!edit.name.trim() || edit.name.trim().length > 100)) issues.push('条件名称应为 1–100 个字。')
    Object.entries(edit.parameters ?? {}).forEach(([key,value]) => {
      const spec = condition.parameters?.[key]
      if(!spec) { issues.push('请核对当前条件支持的参数。'); return }
      if(spec.type === 'enum') { if(!Object.hasOwn(spec.options ?? {},String(value))) issues.push(spec.label + '选项无效。'); return }
      const number = Number(value)
      if(value === '' || !Number.isFinite(number) || (spec.type === 'integer' && !Number.isInteger(number)) || (spec.min != null && number < spec.min) || (spec.max != null && number > spec.max)) issues.push('请核对“' + spec.label + '”的允许范围。')
    })
    return issues
  })
  async function action(label: string, task: () => Promise<void>) {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(label); setNotice(''); setError('')
    try { await task() } catch (e) { setError((e as Error).message) } finally { actionLock.current = false; setBusy('') }
  }
  async function generate() {
    await action('generate', async () => {
      const next = await api<Draft>('/condition-drafts', { method: 'POST', body: JSON.stringify({ prompt, previous_draft_id: draft?.id, library: scope, source_document_id: sourceDocument?.source_document_id, source_page: sourceDocument?.source_page, start_date: scope === 'news' ? newsStart || undefined : undefined, end_date: scope === 'news' ? newsEnd || undefined : undefined }) })
      shouldScroll.current = true; setDraft(next); setDraftId(next.id); setEdits({}); setPreview(null); await refresh()
    })
  }
  function newDescription(text = '') {
    setDraft(null); setDraftId(''); setEdits({}); setPreview(null); setPrompt(text); setSection('create'); setNotice(''); setError('')
    setSourceDocument(null)
  }
  async function loadDraft(id: string) {
    await action('load-draft', async () => {
      const next = await api<Draft>(`/condition-drafts/${id}`)
      setDraft(next); setDraftId(next.id); setPrompt(next.prompt)
      if (next.news_matches) { setNewsStart(next.news_matches.start_date ?? ''); setNewsEnd(next.news_matches.end_date ?? '') }
      setEdits(next.saved?.confirmation?.edits ?? {}); setPreview(null)
      setSourceDocument(next.source_document ? { id: next.id, source_document_id: next.source_document.document_id, title: next.source_document.title, source_page: next.source_document.page } : null)
    })
  }
  function selectRun(id: string) {
    setHistoryPickerOpen(false); setHistoryChart('')
    shouldFocusHistoryResult.current = true
    setError('')
    if (id === runId) { setRunReload(value => value + 1); return }
    setRun(null); setRunId(id); setOffset(0); setResultError('')
  }
  function onIntentKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing && !busy && prompt.trim() && (scope !== 'news' || (newsStart && newsEnd && newsStart <= newsEnd))) {
      event.preventDefault()
      void generate()
    }
  }
  async function refreshHistory() {
    await refresh()
    setRunReload(value => value + 1)
  }
  async function confirm() {
    if (!draft || !ready || draftEditIssues.length) return
    await action('confirm', async () => {
      const result = await api<SavedDraft>(`/condition-drafts/${draft.id}/confirm`, { method: 'POST', body: JSON.stringify({ edits }) })
      setDraft({ ...draft, saved: result }); setNotice(`已保存 ${result.filters.length} 个独立条件。`); await refresh()
    })
  }
  function rememberComposition() {
    const previous = { tree: structuredClone(tree), name: strategyName, id: strategyId, topN: Number.isFinite(topN) ? topN : 30 }
    setPreviousComposition(previous)
    try { localStorage.setItem('workbench.previousComposition',JSON.stringify(previous)) } catch { /* Current editing remains available. */ }
  }
  function changeTree(next: Node) { if (busy || next === tree) return; rememberComposition(); setTree(next) }
  function usePlan(replaceExisting = false) {
    if (!draft?.saved || busy) return
    rememberComposition()
    const incoming = draft.saved.tree
    const next = replaceExisting ? (incoming.op.endsWith('_ref') ? { op: 'all', children: [incoming] } : incoming) : appendConditionPlan(tree, incoming)
    const name = replaceExisting || !countRefs(tree) ? '我的选股组合' : strategyName
    writeCombination(next, name)
    setTree(next); setStrategyId(''); setStrategyName(name)
    if(scope && onCompose) { onCompose(); return }
    setSection('compose'); setNotice(replaceExisting ? '已用本次条件新建组合，可撤销恢复上一份草稿。' : '已加入组合并保留原有分组关系。')
  }
  function addCondition(filter: Filter) {
    if(busy) return
    rememberComposition()
    const child: Node = { op: 'filter_ref', filter_id: filter.id, version: filter.version, score_weight: 1 }
    setTree(previous => appendConditionPlan(previous, child))
    setNotice(`已把“${filter.name}”加入组合。`)
  }
  function undoComposition() {
    if(!previousComposition || busy) return
    setTree(previousComposition.tree); setStrategyId(previousComposition.id); setStrategyName(previousComposition.name); setTopN(previousComposition.topN)
    setPreviousComposition(null); setNotice('已恢复上一份组合草稿。')
  }
  function resetComposition() {
    if(busy) return
    rememberComposition(); setTree(emptyTree()); setStrategyId(''); setStrategyName('我的选股组合')
    setNotice('已新建空组合。')
  }
  const fingerprint = compositionFingerprint(strategyName, tree, topN)
  const treeIssues = catalogLoaded ? compositionIssues(tree,catalog) : []
  const numericIssue = !Number.isInteger(topN) || topN < 1 || topN > 500 ? '保留数量必须是 1–500 的整数。' : ''
  const nameIssue = !strategyName.trim() ? '请填写组合名称。' : strategyName.trim().length > 100 ? '组合名称不能超过 100 个字。' : ''
  const dateIssue = executionDateIssue(asOf, data?.last_date)
  const poolIssue = poolId ? !pools.some(pool => pool.id === poolId) ? '当前股票池未载入，请刷新目录或改为全部 A 股。' : !pools.find(pool => pool.id === poolId)!.items.length ? '当前股票池为空，请添加股票或改为全部 A 股。' : '' : ''
  const editorIssues = [...treeIssues,...[nameIssue].filter(Boolean)]
  const saveIssues = [...treeIssues, ...[numericIssue,nameIssue].filter(Boolean)]
  const runIssues = [...saveIssues, ...[dateIssue,poolIssue,!data?.available ? '本地行情尚未就绪，请先查看数据与服务。' : ''].filter(Boolean)]
  const currentSaved = savedComposition?.strategy.id === strategyId && savedComposition.fingerprint === fingerprint ? savedComposition.strategy : null
  useEffect(() => { if(Number.isInteger(topN) && topN >= 1 && topN <= 500) { try { localStorage.setItem('workbench.topN',JSON.stringify(topN)) } catch { /* Keep editing available. */ } } }, [topN])
  async function saveStrategy(execute: boolean) {
    if(!catalogLoaded || (execute ? runIssues : saveIssues).length) return
    await action(execute ? 'run' : 'strategy', async () => {
      const saveBody = { id: strategyId || undefined, name: strategyName.trim(), tree, top_n: topN }
      const saveKey = 'save:' + JSON.stringify(saveBody)
      let saved = currentSaved
      if (!saved) {
        try {
          saved = await api<Strategy>('/strategies', { method: 'POST', body: JSON.stringify({ ...saveBody, request_id: submissionRequest(saveKey) }) })
        } catch (reason) {
          throw new Error(`组合保存尚未确认：${(reason as Error).message}。内容保持不变时，再次保存会核对同一次提交。`)
        }
      }
      try {
        localStorage.setItem('workbench.savedComposition', JSON.stringify({ strategy: saved, fingerprint }))
        localStorage.setItem('workbench.strategyId', JSON.stringify(saved.id))
        localStorage.setItem('workbench.previousComposition', 'null')
        finishSubmission(saveKey)
      } catch { /* Retain the request number if browser persistence is unavailable. */ }
      setStrategyId(saved.id); setSavedComposition({ strategy: saved, fingerprint }); setPreviousComposition(null)
      setNotice(`“${saved.name}”第 ${saved.version} 版已保存。`)
      if(execute) {
        try {
          const runBody = { strategy_id: saved.id, strategy_version: saved.version, as_of: asOf, mode: 'exploratory', watchlist_id: poolId || undefined }
          const runKey = 'run:' + JSON.stringify(runBody)
          const next = await api<{ id: string }>('/screening-runs', { method: 'POST', body: JSON.stringify({ ...runBody, request_id: submissionRequest(runKey) }) })
          try {
            localStorage.setItem('workbench.runId', JSON.stringify(next.id))
            localStorage.setItem('workbench.section', JSON.stringify('history'))
            finishSubmission(runKey)
          } catch { /* Retain the request number so a later retry finds this run. */ }
          shouldFocusHistoryResult.current = true
          setRun(null); setRunId(next.id); setResultState('true'); setOffset(0); setSection('history')
          setNotice(`筛选已提交，采用组合第 ${saved.version} 版。结果与依据将保留在本次记录。`)
        } catch(reason) {
          setError(`组合第 ${saved.version} 版已保存，但本次筛选提交未能确认：${(reason as Error).message}。可以查看筛选记录；保持参数再次提交会核对同一次筛选。`)
        }
      }
      await refresh()
    })
  }
  function loadStrategy(value: string) {
    const item = strategies.find(s => `${s.id}@${s.version}` === value)
    if (!item) return
    setTree(structuredClone(item.tree) as Node); setStrategyId(item.id); setStrategyName(item.name); setTopN(item.top_n)
    setPreviousComposition(null); setSavedComposition({ strategy: item, fingerprint: compositionFingerprint(item.name, item.tree as Node, item.top_n) })
    setNotice(`已载入“${item.name}”第 ${item.version} 版。`)
  }
  async function revise() {
    if (!selected) return
    await action('revise', async () => {
      const expression = applyConditionParameters(selected.expression, selectedEdit.parameters)
      const summary = conditionText(selected.library, expression, selected.description)
      const result = await api<Filter>('/filters', { method: 'POST', body: JSON.stringify({ id: selected.id, base_version: selected.version, library: selected.library, name: selectedEdit.name ?? (selectedEdit.parameters ? summary.slice(0, 100) : selected.name), description: summary, expression }) })
      setSelected(result); setSelectedEdit({}); await refresh(); setNotice('已创建新版本。已有组合继续使用原先选定的版本。')
    })
  }

  useEffect(() => { setSelected(null); setRankingTree(null); setReferencePath(null) }, [section])
  const inspectedReference = referencePath ? compositionNode(tree, referencePath) : undefined
  const conditionCreator = <div className={'intent-layout ' + (!draftHistory.length ? 'no-draft-history' : '')}><div className="intent-main">
      <section className="intent-prompt-card"><div className="section-title-row"><h2><Sparkles size={18} />{copy?.promptTitle ?? '你想找什么样的股票？'}</h2></div>

        {sourceDocument?.source_document_id && <div className="source-context"><strong>来源：{sourceDocument.title} · 第 {sourceDocument.source_page} 页</strong><div className="source-context-actions"><button className="text-button workspace-button" disabled={!!busy} onClick={() => { setSourceDocument(null); setDraft(null); setDraftId('') }}>清除来源</button>{scope === 'report' && sourceDocument.source_page && <button className="secondary-button compact workspace-button" disabled={!!busy} onClick={() => onConversation?.(scope, { reference: { kind: 'report_page', source_id: sourceDocument.source_document_id!, page_number: sourceDocument.source_page }, label: `${sourceDocument.title} · 第 ${sourceDocument.source_page} 页` })}><MessageCircle size={14} />在对话中讨论此页</button>}</div></div>}<label className="sr-only" htmlFor="stock-intent">选股条件描述</label><textarea id="stock-intent" className="intent-textarea workspace-field" value={prompt} disabled={!!busy} maxLength={4000} aria-keyshortcuts="Control+Enter Meta+Enter" onChange={e => { setPrompt(e.target.value); setPreview(null) }} onKeyDown={onIntentKeyDown} />
        {scope === 'news' && <div className="news-match-dates"><label className="workspace-field-label">开始日期<input aria-label="匹配资讯开始日期" type="date" value={newsStart} max={newsEnd || undefined} disabled={!!busy} onInput={event => setNewsStart(event.currentTarget.value)} onChange={event => setNewsStart(event.target.value)} className="workspace-field" /></label><label className="workspace-field-label">结束日期<input aria-label="匹配资讯结束日期" type="date" value={newsEnd} min={newsStart || undefined} disabled={!!busy} onInput={event => setNewsEnd(event.currentTarget.value)} onChange={event => setNewsEnd(event.target.value)} className="workspace-field" /></label></div>}
        <div className="prompt-bottom"><span>{prompt.length}/4000</span><button className="primary-button workspace-button" disabled={!!busy || !prompt.trim() || (scope === 'news' && (!newsStart || !newsEnd || newsStart > newsEnd))} onClick={generate}><Sparkles size={16} />{busy === 'generate' ? (scope === 'news' ? '正在匹配资讯…' : '正在理解完整描述…') : scope === 'news' ? '匹配资讯' : draft && prompt.trim() !== draft.prompt ? '按补充后的描述重新生成' : '生成条件'}</button></div>

        {!draft && (workflowOnly ? <div className="condition-starter-examples"><div>{[
          { title: '趋势向上', text: '价格与短期涨幅', icon: TrendingUp, prompt: '收盘价高于20日均线，且近5个交易日涨幅超过3%' },
          { title: '寻找超跌', text: 'RSI 与均线位置', icon: SlidersHorizontal, prompt: 'RSI14小于30，且收盘价低于10日均线' },
          { title: '均线共振', text: '多周期趋势确认', icon: GitBranch, prompt: '收盘价高于10日均线且高于20日均线' },
        ].map(({ title, text, icon: Icon, prompt: example }) => <button key={title} type="button" disabled={!!busy} onClick={() => { setPrompt(example); setPreview(null); document.getElementById('stock-intent')?.focus() }} className="workspace-button"><Icon size={19} /><strong>{title}</strong><span>{text}</span><ArrowRight size={14} /></button>)}</div></div> : <div className="prompt-examples">{(copy?.examples ?? ['收盘价高于20日均线，且近5个交易日涨幅超过3%', 'RSI14小于30', '收盘价高于10日均线且高于20日均线']).map(example => <button key={example} type="button" disabled={!!busy} onClick={() => { setPrompt(example); setPreview(null) }} className="workspace-button">{example}<ArrowRight size={12} /></button>)}</div>)}
      </section>
      {draft?.news_matches && <section ref={resultRef} className="news-match-results"><div className="section-title-row"><h2>匹配资讯</h2><span>{draft.news_matches.start_date} 至 {draft.news_matches.end_date} · {draft.news_matches.matched_count} / {draft.news_matches.candidate_count} 条</span></div>{(prompt.trim() !== draft.prompt || newsStart !== (draft.news_matches.start_date ?? '') || newsEnd !== (draft.news_matches.end_date ?? '')) && <p className="notice-amber workspace-feedback workspace-feedback-warning">描述或日期已修改，请重新匹配。下方保留上次结果。</p>}{!draft.news_matches.items.length && <p className="workbench-help">所选日期范围内没有匹配的资讯。</p>}{draft.news_matches.items.map(item => <article key={item.id}><h3>{item.title}</h3><small>{item.source}</small><p>{item.reason}</p><blockquote>{item.quote}</blockquote><details><summary>阅读正文</summary><p style={{ whiteSpace: 'pre-wrap' }}>{item.body}</p></details><button className="secondary-button compact workspace-button" onClick={() => onConversation?.('news', { reference: { kind: 'news_item', source_id: item.id }, label: item.title }, undefined, 'screening')}>基于这条资讯对话筛选</button></article>)}</section>}
      {draft && scope !== 'news' && !draft.news_matches && <section className="intent-result" ref={resultRef}><div className="section-title-row"><h2>{draft.status === 'ready' ? <Check size={18} /> : <CircleHelp size={18} />}{draft.status === 'ready' ? `拆成了 ${draft.conditions.length} 个独立条件` : '还需要把要求说清楚'}</h2><span>{draft.source === 'local_parser' ? '本地规则解析' : '模型辅助解析'}</span></div>
        {prompt.trim() !== draft.prompt && <p className="notice-amber workspace-feedback workspace-feedback-warning">描述已修改，请重新生成。下方仍是上一份描述的结果。</p>}
        {draft.issues.map((issue, i) => <div key={i} className="clarification-card"><strong>{issue.kind === 'unsupported' ? '当前数据暂不支持' : '需要补充'} · {issue.text}</strong><p>{issue.suggestion}</p></div>)}
        {reviewedConditions.map((item, i) => <article className="condition-review" key={item.key}><div className="condition-number">{String(i + 1).padStart(2, '0')}</div><div><div className="condition-card-title"><h3>{item.contract.summary}</h3><span className={`availability ${item.contract.availability}`}>{item.contract.availability_label}</span></div><p className="condition-quote">你的原话：“{item.source_quote}”</p><ul className="contract-notes">{item.contract.notes.map(note => <li key={note}>{note}</li>)}</ul>
          {item.library === 'report' && <ReportCriterionReview expression={item.expression} />}<details className="condition-adjustments"><summary>修改名称或参数</summary><ParameterEditor name={edits[item.key]?.name ?? item.name} parameters={item.parameters} expression={item.expression} edit={edits[item.key] ?? {}} disabled={!!busy || !!draft.saved} onChange={edit => { setEdits({ ...edits, [item.key]: edit }); setPreview(null) }} /></details></div></article>)}
        {draft.tree && <div className="logic-sentence"><GitBranch size={16} /><div><strong>这句话的组合关系</strong><p>{planText(draft.tree, reviewedConditions)}</p></div></div>}
        {!!draft.assumptions.length && <div className="assumption-note"><strong>计算口径</strong><ul>{draft.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
        {!!draftEditIssues.length && <div className="composition-validation workspace-error" role="alert">{[...new Set(draftEditIssues)].map(issue => <p key={issue}>{issue}</p>)}</div>}{ready && <>{(!scope || scope === 'technical') && <div className="trial-row"><label className="workspace-field-label">试算股票<StockSearch disabled={!!busy} label="试算股票" value={stock} onChange={code => { setStock(code); setPreview(null) }} /></label><label className="workspace-field-label">截止日期<input disabled={!!busy} aria-label="试算截止日期" type="date" value={asOf} max={data?.last_date} onChange={e => { setAsOf(e.target.value); setPreview(null) }} className="workspace-field" /></label><button className="secondary-button workspace-button" disabled={!!busy || !!draftEditIssues.length || !/^\d{6}\.(SH|SZ|BJ)$/.test(stock) || !!executionDateIssue(asOf,data?.last_date)} onClick={() => action('preview', async () => setPreview(await api<Preview>(`/condition-drafts/${draft.id}/preview`, { method: 'POST', body: JSON.stringify({ edits, stock_code: stock, as_of: asOf }) })))}><Play size={14} />{busy === 'preview' ? '计算中…' : '试算看看'}</button></div>}
          {preview && <div className="trial-result"><div className="section-title-row"><strong>{preview.stock_code} · 实际行情 {preview.actual_date ?? '无'}</strong><StateBadge state={preview.state} /></div>{preview.details.map((detail, i) => <DecisionDetail detail={detail} key={i} />)}</div>}
          <div className="intent-confirm">{draft.saved ? <><span><Check size={16} />条件已保存</span><button className="primary-button workspace-button" disabled={!!busy} onClick={() => usePlan()}>用这些条件组合选股<ArrowRight size={16} /></button>{countRefs(tree) > 0 && <button className="secondary-button workspace-button" disabled={!!busy} onClick={() => usePlan(true)}>以这些条件新建组合</button>}</> : <><button className="primary-button workspace-button" disabled={!!busy || !!draftEditIssues.length} onClick={confirm}><Save size={16} />{busy === 'confirm' ? '保存中…' : `确认并保存 ${draft.conditions.length} 个条件`}</button></>}</div></>}
      </section>}
    </div>{draftHistory.length > 0 && <aside className="intent-guide"><section className="draft-history"><h3>最近的描述</h3>{draftHistory.filter((item, index, all) => all.findIndex(other => other.prompt === item.prompt) === index).slice(0, 8).map(item => <button key={item.id} disabled={!!busy} onClick={() => loadDraft(item.id)} className="workspace-button"><span>{item.prompt}</span></button>)}</section></aside>}</div>
  const conditionInspector = selected ? <div className="condition-inspector">{!conditionTools && <div className="section-title-row"><h2>{selected.name}</h2><button className="icon-button workspace-button" aria-label="关闭条件详情" onClick={() => setSelected(null)}><X size={17} /></button></div>}<label className="history-version workspace-field-label">查看历史版本<select value={selected.version} onChange={e => { const item = filters.find(f => f.id === selected.id && f.version === Number(e.target.value)); if (item) { setSelected(item); setSelectedEdit({}) } }} className="workspace-field workspace-select">{filters.filter(f => f.id === selected.id).map(f => <option value={f.version} key={f.version}>第 {f.version} 版 · {dateText(f.created_at)}</option>)}</select></label><p>{selectedDirty ? '修改后：' : ''}{selectedSummary}</p><ul className="contract-notes">{selected.contract?.notes.map(item => <li key={item}>{item.startsWith('涨幅 =') ? `涨幅 =（最新收盘价 ÷ ${selectedExpression.window} 个交易日前收盘价 − 1）× 100%。` : item}</li>)}</ul><Provenance value={selected.provenance} />
        <ParameterEditor name={selectedEdit.name ?? selected.name} parameters={selected.parameters} expression={selected.expression} edit={selectedEdit} disabled={!!busy} onChange={setSelectedEdit} />
        <div className="card-actions"><button className="secondary-button workspace-button" disabled={selectedDirty || !!busy || compositionKeys.has(`filter:${selected.id}@${selected.version}`)} onClick={() => addCondition(selected)}>{selectedDirty ? '先保存修改再加入组合' : compositionKeys.has(`filter:${selected.id}@${selected.version}`) ? '已加入当前组合' : '将此版本加入组合'}</button>{selectedDirty && <button className="text-button workspace-button" disabled={!!busy} onClick={() => setSelectedEdit({})}>撤销修改</button>}{selected.library === 'report' && <button className="secondary-button workspace-button" disabled={!!busy} onClick={() => { setEvaluationFilter(selected); if (conditionTools) setSelected(null) }}>核验研报证据</button>}<button className="primary-button workspace-button" disabled={!!busy || !Object.keys(selectedEdit).length} onClick={revise}><Save size={15} />保存为新版本</button></div><details className="technical-details"><summary>查看原始执行规则</summary><pre>{JSON.stringify(selectedExpression, null, 2)}</pre></details></div> : null

  const visibleRuns = runs.filter(item => (!historyStatus || (historyStatus === 'running' ? ['queued','running'].includes(item.status) : item.status === historyStatus)) && [item.name, item.as_of, strategies.find(value => value.id === item.strategy_id && value.version === item.strategy_version)?.name].join(' ').toLowerCase().includes(historyQuery.trim().toLowerCase())).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const screeningHeading = workflowOnly ? '条件选股' : section === 'conversation' ? '对话筛选' : section === 'history' ? '筛选记录' : '组合选股'
  const historyCatalog = <div className="screening-history-catalog">
    <div className="screening-history-filters"><label className="workspace-search history-search workspace-field-shell"><Search size={14} /><input aria-label="搜索筛选记录" placeholder="组合名称、方案或日期" value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} className="workspace-field" /></label><select aria-label="筛选记录状态" value={historyStatus} onChange={event => setHistoryStatus(event.target.value)} className="workspace-field workspace-select"><option value="">全部状态</option><option value="running">运行中</option><option value="succeeded">已完成</option><option value="partial">部分数据不足</option><option value="failed">执行失败</option><option value="cancelled">已取消</option></select></div>
    <div className="screening-history-rows">{visibleRuns.slice(0, historyLimit).map(item => <button type="button" key={item.id} className={'screening-history-row workspace-button' + (item.id === runId ? ' selected' : '')} aria-current={item.id === runId ? 'true' : undefined} onClick={() => selectRun(item.id)}>
      <span><strong>{item.name || strategies.find(value => value.id === item.strategy_id && value.version === item.strategy_version)?.name || '选股方案'}</strong><small>{item.kind === 'conversation' ? '对话选股' : '条件组合'} · 截止 {item.as_of} · v{item.strategy_version}</small></span><span><StateBadge state={item.id === run?.id ? run.status : item.status} /><small>{dateText(item.created_at)}</small></span>
    </button>)}</div>
    {visibleRuns.length > historyLimit && <button className="text-button workspace-button" onClick={() => setHistoryLimit(value => value + 15)}>显示更多记录<ChevronDown size={14} /></button>}
    {catalogLoading && !runs.length ? <LoadingState compact label="正在读取筛选记录…" /> : !visibleRuns.length && <Empty icon={Clock3} title={runs.length ? '没有符合当前筛选的记录' : '暂无筛选记录'} action={runs.length ? <button className="text-button workspace-button" onClick={() => { setHistoryQuery(''); setHistoryStatus('') }}>查看全部记录</button> : <button className="primary-button workspace-button" onClick={() => setSection(workflowOnly ? 'conversation' : 'compose')}>开始一次选股</button>} />}
  </div>

  return <StockText><div className={`page-content workbench ${workflowOnly && section !== 'conversation' ? 'workspace-tool-page screening-tool-page' : ''} ${section !== 'conversation' ? 'screening-workflow' : ''} ${workflowOnly && section !== 'conversation' ? 'condition-studio' : ''} ${section === 'conversation' ? 'workbench-conversation' : ''} ${section === 'compose' ? 'workbench-composing' : ''}`}>
    {workflowOnly && shellNavigation && ['library', 'create', 'compose'].includes(section) && <nav className="condition-studio-nav" aria-label="条件与组合">
      <button className={`workspace-button${section === 'library' ? ' active' : ''}`} aria-current={section === 'library' ? 'page' : undefined} onClick={() => setSection('library')}><Library size={16} />条件库</button>
      <button className={`workspace-button${section === 'compose' ? ' active' : ''}`} aria-current={section === 'compose' ? 'page' : undefined} onClick={() => setSection('compose')}><GitBranch size={16} />组合</button>
    </nav>}
    {evaluationFilter && (conditionTools ? <ConditionWorkspaceDrawer title={"核验“" + evaluationFilter.name + "”的研报证据"} closeLabel="收起核验" onClose={() => setEvaluationFilter(null)}><ReportEvaluations key={evaluationFilter.id + "@" + evaluationFilter.version} selected={evaluationFilter} /></ConditionWorkspaceDrawer> : <section className="condition-evidence-panel" aria-label="研报条件证据核验"><div className="section-title-row"><h2>核验“{evaluationFilter.name}”的研报证据</h2><button className="text-button workspace-button" onClick={() => setEvaluationFilter(null)}>收起核验</button></div><ReportEvaluations key={`${evaluationFilter.id}-${evaluationFilter.version}`} selected={evaluationFilter} /></section>)}
    {section !== 'history' && !(conditionTools && ['library', 'compose'].includes(section)) && !scope && (!shellNavigation || section !== 'conversation') && (workflowOnly || section !== 'conversation') && <header className="workbench-heading"><div><h1>{screeningOnly || workflowOnly ? screeningHeading : '选股工作台'}</h1></div><div className="condition-studio-heading-meta"><span className="workbench-data-status"><Database size={14} />{data?.last_date ? <>行情截至 <time>{data.last_date}</time></> : data ? '待添加行情数据' : '正在读取数据状态…'}</span></div></header>}
    {!scope && !workflowOnly && !screeningOnly && <nav className="workbench-tabs" aria-label="选股流程">{sections.filter(item => !screeningOnly || ['conversation', 'compose', 'history'].includes(item.id)).map(({ id, title, icon: Icon }) => <button key={id} className={["workspace-button", section === id ? 'active' : ''].filter(Boolean).join(' ')} aria-current={section === id ? 'page' : undefined} onClick={() => { if(screeningOnly && id === 'compose' && onConditions) { onConditions(); return } setSection(id); setError(''); setNotice(''); if (id === 'history') void refresh().catch(e => setError(e.message)) }}><Icon size={17} />{screeningOnly && id === 'compose' ? '条件选股' : title}{id === 'library' && latest.length > 0 && <span>{latest.length}</span>}{id === 'compose' && countRefs(tree) > 0 && <span>{countRefs(tree)}</span>}</button>)}</nav>}
    {workflowOnly && !shellNavigation && <nav className="condition-studio-nav" id="condition-advanced-tools" aria-label="条件选股流程">{[
      { id: 'conversation' as const, label: '对话选股', icon: MessageCircle },
      { id: 'compose' as const, label: '条件编排', icon: GitBranch, count: countRefs(tree) },
      { id: 'history' as const, label: '筛选结果', icon: Clock3, count: runs.length },
      { id: 'library' as const, label: '我的条件', icon: Library, count: latest.length },
    ].filter(item => advancedToolsVisible || ['conversation','history'].includes(item.id)).map(({ id, label, icon: Icon }) => <button key={id} className={["workspace-button", section === id || (id === 'library' && section === 'create') ? 'active' : ''].filter(Boolean).join(' ')} aria-current={section === id || (id === 'library' && section === 'create') ? 'page' : undefined} disabled={!!busy} onClick={() => { setSection(id); setError(''); setNotice(''); if (id === 'history') void action('refresh', refreshHistory) }}><Icon size={16} /><span>{label}</span></button>)}<button type="button" disabled={!!busy} aria-expanded={advancedToolsVisible} aria-controls="condition-advanced-tools" onClick={() => { if (advancedToolsVisible) { setAdvancedToolsOpen(false); if (['create','library','compose'].includes(section)) setSection('conversation') } else setAdvancedToolsOpen(true) }} className="workspace-button"><SlidersHorizontal size={16} /><span>{advancedToolsVisible ? '收起高级工具' : '高级工具'}</span></button></nav>}
    {!!resourceWarnings.length && <div className="screening-resource-warning workspace-feedback workspace-feedback-warning" role="status"><span>部分资料未能更新：{resourceWarnings.join('；')}</span><button className="text-button workspace-button" disabled={!!busy} onClick={() => void action('refresh',refresh)}>刷新目录</button></div>}
    {error && !creationOpen && !selected && <div className="workbench-alert workspace-error" role="alert">{error}<button className="icon-button workspace-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={14} /></button></div>}
    {notice && !creationOpen && !selected && <div className="workbench-notice workspace-feedback workspace-feedback-success" role="status"><Check size={16} /><span>{notice}</span>{workflowOnly && section === 'library' && countRefs(tree) > 0 && <button className="text-button workspace-button" onClick={() => setSection('compose')}>继续编排<ArrowRight size={14} /></button>}</div>}

    {section === 'conversation' && !scope && <ConversationWorkspace onStartScreening={onConversation ? () => onConversation('technical', undefined, undefined, 'screening') : undefined} onOpenReports={onReports} initialCommonIndicators={initialCommonIndicators} conversationUpdate={conversationUpdate} onHistoryChange={onHistoryChange} shellNavigation={shellNavigation} onOpenDataServices={onOpenDataServices} newResearchKey={newResearchKey} onNewResearchConsumed={onNewResearchConsumed} initialPrompt={conversationPrompt} initialNewDraft={conversationNewDraft} onPromptConsumed={onPromptConsumed} data={data} initialConversationId={resumeConversation?.conversation_id ?? conversationId} initialScope={resumeConversation?.entry_scope ?? conversationScope} initialWorkflowType={workflowOnly ? 'screening' : conversationWorkflowType} onLocationChange={onLocationChange} initialSource={conversationSource} onScopeChange={onConversationScopeChange} onSourceChange={onConversationSourceChange} onOpenProject={onOpenProject} onOpenConversation={onResumeConversation} />}

    {!conditionTools && section === 'create' && conditionCreator}
    {conditionTools && creationOpen && <ConditionWorkspaceDrawer title="新增可复用条件" closeLabel="关闭新增条件" description="描述、核对并保存条件，当前组合会保留。" className="condition-creator-drawer" onClose={() => { setCreationOpen(false); if (requestedSection === 'create') setSection(creationOrigin) }}>
      <div className="condition-creator-tools"><span>关闭后保留未完成的描述</span><button className="text-button workspace-button" disabled={!!busy} onClick={() => newDescription()}>新建描述</button></div>
      {error && <div className="condition-creator-feedback workspace-error" role="alert">{error}</div>}
      {notice && <div className="condition-creator-feedback workspace-feedback workspace-feedback-success" role="status">{notice}</div>}
      {conditionCreator}
    </ConditionWorkspaceDrawer>}
    {conditionTools && selected && <ConditionWorkspaceDrawer title={selected.name} description={libraryNames[selected.library]} onClose={() => setSelected(null)}>
      {error && <div className="condition-creator-feedback workspace-error" role="alert">{error}</div>}
      {notice && <div className="condition-creator-feedback workspace-feedback workspace-feedback-success" role="status">{notice}</div>}
      {conditionInspector}
    </ConditionWorkspaceDrawer>}

    {section === 'library' && <section className="library-workspace"><div className="section-title-row"><div><h1>条件库</h1></div><button className="primary-button workspace-button" disabled={!!busy} onClick={() => conditionTools ? setSection('create') : newDescription()}><Plus size={16} />新增可复用条件</button></div>
      <div className="library-filters workspace-filters"><label className="search-input workspace-field-shell"><Search size={16} /><input aria-label="搜索我的条件" placeholder="搜索条件名称、判断口径或描述" value={search} onChange={e => setSearch(e.target.value)} className="workspace-field" />{search && <button className="icon-button workspace-button" aria-label="清除条件搜索" onClick={() => setSearch('')}><X size={14} /></button>}</label><select disabled={!!scope} aria-label="条件类型" value={library} onChange={e => setLibrary(e.target.value)} className="workspace-field workspace-select"><option value="all">全部条件</option><option value="technical">行情条件</option><option value="report">研报条件</option><option value="news">资讯条件</option></select><select aria-label="条件排序" value={conditionSort} onChange={event => setConditionSort(event.target.value)} className="workspace-field workspace-select"><option value="recent">最近保存优先</option><option value="name">按名称排序</option></select><button className="secondary-button workspace-button" disabled={!!busy} onClick={() => setSection('compose')}>查看组合 · {countRefs(tree)} 项<ArrowRight size={15} /></button></div>
      {workflowOnly && <div className="condition-library-overview"><span>{filtered.length === latest.length ? `共 ${latest.length} 个条件` : `找到 ${filtered.length} / ${latest.length} 个条件`}</span>{(search || library !== (scope ?? 'all')) && <button className="text-button workspace-button" onClick={() => { setSearch(''); setLibrary(scope ?? 'all') }}>重置筛选</button>}</div>}
      {catalogLoading && <p className="workbench-help">正在载入本库条件…</p>}{catalogLoaded && !filtered.length && <Empty icon={Library} title={latest.length ? '没有找到匹配的条件' : '还没有保存的条件'} action={!latest.length ? <button className="primary-button workspace-button" onClick={() => newDescription()}><Plus size={15} />描述一个条件</button> : undefined} />}
      <div className="condition-library-grid">{filtered.slice(0, conditionLimit).map(item => {
        const summary = distinctConditionDescription(item.name, item.contract?.summary ?? item.description)
        const inComposition = compositionKeys.has(`filter:${item.id}@${item.version}`)
        return <article className="saved-condition-card" key={item.id}>
          <button className="condition-library-open workspace-button" aria-label={`查看与调整 ${item.name}`} onClick={() => { setSelected(item); setSelectedEdit({}); setNotice(''); setError('') }}><h3>{item.name}</h3>{summary && <p>{summary}</p>}</button>
          <span className="condition-library-kind">{libraryNames[item.library]}</span>
          <span className={`availability ${item.contract?.availability}`}>{item.contract?.availability_label}</span>
          <div className="card-actions"><button className="secondary-button workspace-button" disabled={!!busy || inComposition} onClick={() => addCondition(item)}>{inComposition ? <><Check size={14} />已加入组合</> : <><Plus size={14} />加入组合</>}</button></div>
        </article>
      })}</div>
      {filtered.length > conditionLimit && <div className="condition-load-more"><span>已显示 {conditionLimit} / {filtered.length} 个条件</span><button className="secondary-button workspace-button" onClick={() => setConditionLimit(value => value + 12)}>显示更多条件<ChevronDown size={14} /></button></div>}
      {!conditionTools && conditionInspector}
    </section>}


    {rankingTree === tree && <CompositionRankingSettings tree={tree} catalog={catalog} disabled={!!busy} onApply={next => { changeTree(next); setRankingTree(null) }} onClose={() => setRankingTree(null)} />}
    {referencePath && inspectedReference?.op.endsWith('_ref') && <ConditionReferenceDetails node={inspectedReference} catalog={catalog} disabled={!!busy} onClose={() => setReferencePath(null)} onUpdate={next => { changeTree(replaceCompositionNode(tree, referencePath, next)); setNotice('已更新本组合的条件引用，保存组合后生效。') }} />}
    {section === 'compose' && <>
      <header className="advanced-composition-heading"><h1>组合编辑</h1><div className="composition-heading-actions">
        <CompositionPicker strategies={strategies} currentId={strategyId} currentVersion={currentSaved?.version} disabled={!!busy} onSelect={loadStrategy} />
        <button className="secondary-button workspace-button" disabled={!!busy} onClick={resetComposition}><Plus size={15} />新建组合</button>
      </div></header>
      <div className="compose-workspace condition-compose-workspace">
        <section className="compose-main" aria-label="构建选股组合">
          <fieldset disabled={!!busy} className="screening-editor-fields composition-editor-fields">
            <div className="composition-overview">
              <label className="workspace-field-label">组合名称<input aria-label="组合名称" value={strategyName} maxLength={100} aria-invalid={!!nameIssue || undefined} onChange={event => { setStrategyName(event.target.value); setPreviousComposition(null) }} className="workspace-field" /></label>
              <div className="composition-status"><span className={currentSaved ? 'saved' : 'draft'}><span className="composition-status-dot" />{currentSaved ? '已保存 · v' + currentSaved.version : strategyId ? '有未保存修改' : '草稿自动保留'}</span>{previousComposition && <button className="text-button workspace-button" disabled={!!busy} onClick={undoComposition}>撤销上次组合更改</button>}</div>
            </div>
            {catalogLoading ? <LoadingState compact label="正在载入条件目录…" /> : <ConditionTransferEditor tree={tree} catalog={catalog} logicSummary={countRefs(tree) ? treeText(tree, catalog) : undefined} disabled={!!busy || !catalogLoaded} onChange={changeTree} onCreateCondition={() => setSection('create')} onInspectReference={setReferencePath} />}
          </fieldset>
          {!!editorIssues.length && countRefs(tree) > 0 && <div className="composition-validation workspace-error" role="alert">{editorIssues.map(issue => <p key={issue}>{issue}</p>)}</div>}
        </section>
        <footer className="compose-execution" aria-label="筛选设置与执行">
          <fieldset disabled={!!busy} className="screening-editor-fields composition-execution-fields">
            <label className="workspace-field-label">股票范围<select aria-label="筛选股票范围" aria-invalid={!!poolIssue || undefined} value={poolId} onChange={event => setPoolId(event.target.value)} className="workspace-field workspace-select"><option value="">全部 A 股</option>{pools.map(pool => <option key={pool.id} value={pool.id}>{pool.name} · {pool.items.length} 只</option>)}</select>{poolIssue && <span className="screening-field-error">{poolIssue}</span>}</label>
            <label className="workspace-field-label">截止日期<input type="date" aria-label="筛选截止日期" aria-invalid={!!dateIssue || undefined} value={asOf} max={data?.last_date} onChange={event => setAsOf(event.target.value)} className="workspace-field" />{dateIssue && <span className="screening-field-error">{dateIssue}</span>}</label>
            <label className="workspace-field-label">优先保留数量<div className="composition-quantity-field"><input aria-label="优先保留数量" type="number" min={1} max={500} value={topNInput} aria-invalid={!!numericIssue || undefined} onChange={event => setTopNInput(event.target.value)} className="workspace-field" /><span>只</span></div>{numericIssue && <span className="screening-field-error">{numericIssue}</span>}</label>
          </fieldset>
          <div className="compose-execution-actions">
            <button type="button" className="text-button composition-ranking-launch workspace-button" disabled={!!busy || !catalogLoaded || !countRefs(tree)} onClick={() => setRankingTree(tree)}><ListOrdered size={15} />排序设置</button>
            <button className="secondary-button workspace-button" disabled={!!busy || !catalogLoaded || !!saveIssues.length || !!currentSaved} onClick={() => saveStrategy(false)}><Save size={15} />{busy === 'strategy' ? '保存中…' : '保存组合'}</button>
            <button className="primary-button run-button workspace-button" disabled={!catalogLoaded || !!busy || !!runIssues.length} onClick={() => saveStrategy(true)}><Play size={16} />{busy === 'run' ? '正在提交…' : '开始筛选'}</button>
          </div>
          <div className="composition-execution-status" role="status"><span className={!runIssues.length && catalogLoaded ? 'ready' : ''}>{catalogLoading ? '正在读取条件目录' : !catalogLoaded ? '条件目录未就绪' : !countRefs(tree) ? '先从条件库加入条件' : !data?.available ? '本地行情尚未就绪' : runIssues.length ? '请修正标记的设置或组合条件' : `条件检查通过 · ${countRefs(tree)} 项条件`}</span>{data?.available && data.last_date && <span>行情截至 {data.last_date}</span>}{!data?.available && onOpenDataServices && <button className="text-button workspace-button" onClick={onOpenDataServices}>查看数据与服务</button>}<span className="composition-version-note">{currentSaved ? `采用 v${currentSaved.version}` : '开始筛选时保存为新版本'}</span></div>
        </footer>
      </div>
    </>}


    {section === 'history' && <div className="history-workspace history-workspace-unified">
      <header className="history-page-toolbar"><div><h1>筛选记录</h1><span>{runs.length} 条已保存记录</span></div><div><button type="button" className="secondary-button history-picker-launch workspace-button" disabled={!runs.length} aria-expanded={historyPickerOpen} onClick={() => setHistoryPickerOpen(true)}><Clock3 size={15} />切换筛选记录<ChevronDown size={14} /></button><button className="icon-button workspace-button" aria-label="刷新筛选记录" disabled={!!busy || catalogLoading} onClick={() => action('refresh', refreshHistory)}><RefreshCw size={15} /></button></div></header>
      {historyPickerOpen && <ConditionWorkspaceDrawer title="选择筛选记录" closeLabel="关闭筛选记录选择" className="screening-history-picker" onClose={() => setHistoryPickerOpen(false)}>{historyCatalog}</ConditionWorkspaceDrawer>}
      {!runId ? <section className="screening-history-start" aria-label="筛选记录列表">{historyCatalog}</section> : <section className="run-results" ref={historyResultRef} tabIndex={-1}>
        {historyConversation ? <ConversationRunView key={historyConversation.id} title={historyConversation.name} conversationId={historyConversation.conversation_id!} runId={historyConversation.id} onContinue={() => { if (onResumeConversation) onResumeConversation(historyConversation.conversation_id!, historyConversation.entry_scope ?? 'screening'); else { setResumeConversation(historyConversation); setSection('conversation') } }} />
          : runLoadError ? <Empty icon={CircleHelp} title="暂时无法读取记录" text={runLoadError} action={<button className="secondary-button workspace-button" onClick={() => setRunReload(value => value + 1)}><RefreshCw size={15} />重新读取记录</button>} />
            : !run ? <LoadingState label="正在读取筛选记录" skeleton /> : <>
              <div className="section-title-row history-result-heading"><div><h2>{run.context?.strategy_snapshot?.name ?? strategies.find(item => item.id === run.strategy_id && item.version === run.strategy_version)?.name ?? '筛选结果'}</h2><p className="workbench-help">{run.context?.universe?.name ?? '全部 A 股'} · 截止 {run.as_of}</p></div><button className="text-button workspace-button" onClick={() => setSection('compose')}><GitBranch size={14} />返回组合编辑</button></div>
              <details className="history-run-rules"><summary>本次采用的筛选规则与版本</summary><p>组合第 {run.strategy_version} 版</p>{run.context?.strategy_snapshot?.tree ? <p>{treeText(run.context.strategy_snapshot.tree as Node, catalog)}</p> : <p>本次记录未保存完整的组合快照。</p>}</details>
              {run.result.blockers?.map(item => <p className="notice-amber workspace-feedback workspace-feedback-warning" key={item}>{item}</p>)}
              {!run.result.trace_version && !['queued', 'running'].includes(run.status) && <p className="history-legacy-note workspace-feedback workspace-feedback-info">旧版记录仅保存优先结果与部分数据不足样本，搜索支持股票代码。</p>}
              <ScreeningResultView key={run.id} title={'条件组合 · v' + run.strategy_version} asOf={run.as_of} revision={run.strategy_version} status={run.status} isCurrent={false}
                coverage={run.result.counts ? { target_total: run.result.counts.evaluated ?? 0, true_count: run.result.counts.true ?? 0, false_count: run.result.counts.false ?? 0, unknown_count: run.result.counts.unknown ?? 0 } : undefined}
                progress={{ message: run.job?.message ?? '', percent: run.job?.progress ?? 0 }}
                decisions={decisions.map(item => ({ stock_code: item.stock_code, state: item.state, close: item.close, score: item.score, as_of: item.as_of, conditions: (item.details ?? []).map((detail, index) => ({ reference_id: detail.node_path ?? String(index), name: detail.name, state: detail.state, explanation: detail.reason || detail.summary || '', actual: typeof detail.actual === 'number' || typeof detail.actual === 'string' ? detail.actual : undefined, threshold: detail.threshold })) }))}
                scoreLabel="排序得分" loading={resultLoading} error={resultError} total={total} offset={offset} pageSize={50} stateFilter={resultState} query={resultQuery} searchPlaceholder={run.result.trace_version ? '名称、拼音或代码' : '股票代码'}
                onStateFilterChange={value => { setResultState(value); setOffset(0) }} onQueryChange={value => { setResultQuery(value); setOffset(0) }} onPageChange={setOffset} onReload={() => setRunReload(value => value + 1)}
                onExportUrl={'/api/v1/screening-runs/' + run.id + '/export'} exportLabel="导出优先结果" exportDescription="导出本次记录保存的优先结果。"
                onViewChart={setHistoryChart}
                onCancel={run.job ? () => void action('cancel', async () => { await api('/jobs/' + run.job!.id + '/cancel', { method: 'POST' }); setRun(await api<Run>('/screening-runs/' + run.id)); await refresh() }) : undefined}
                onRetry={run.job && ['failed', 'cancelled'].includes(run.status) ? () => void action('retry', async () => { const result = await api<{ run_id: string }>('/jobs/' + run.job!.id + '/retry', { method: 'POST' }); setRun(null); setRunId(result.run_id); await refresh() }) : undefined}
                renderEvidence={item => { const raw = decisions.find(value => value.stock_code === item.stock_code); return raw && <div className="legacy-decision-evidence">{raw.reason && <p className="workspace-feedback workspace-feedback-warning">{raw.reason}</p>}{raw.logic && <LogicTrace node={raw.logic} />}{raw.details.map((detail, index) => <DecisionDetail key={detail.node_path || index} detail={detail} />)}</div> }} />
              <details className="technical-details history-run-snapshot"><summary>本次筛选的版本与数据记录</summary><p>运行编号：{run.id}</p><p>行情截止：{run.result.data_snapshot?.watermark ?? '未记录'}</p><p>文件校验值：{run.result.data_snapshot?.sha256 ?? '未记录'}</p>{run.context?.universe?.codes && <p>股票池名单：{run.context.universe.codes.join('、')}</p>}<pre>{JSON.stringify(run.context?.strategy_snapshot?.tree, null, 2)}</pre></details>
            </>}
      </section>}
      {historyChart && run && <StockChartDialog code={historyChart} asOf={run.as_of} onClose={() => setHistoryChart('')} />}
    </div>}

  </div></StockText>
}

function ReportCriterionReview({ expression }: { expression: Filter['expression'] }) {
  const criteria = Array.isArray(expression.criteria) ? expression.criteria as { id: string; label: string; question: string; signals?: string[]; counter_signals?: string[] }[] : []
  return <div className="rubric-summary">{criteria.map(item => <div key={item.id}><strong>{item.label}</strong><p>{item.question.replace(/\b(true|false|unknown)\b/g, word => stateLabels[word])}</p><details><summary>支持与反向证据</summary><p>支持信号：{item.signals?.join('；') || '根据原文直接证据判断'}</p><p>反向信号：{item.counter_signals?.join('；') || '需要明确相反事实，无证据保留数据不足'}</p></details></div>)}</div>
}


function ParameterEditor({ name, parameters, expression, edit, onChange, disabled }: { name: string; parameters: Filter['parameters']; expression: Filter['expression']; edit: Edit; onChange: (edit: Edit) => void; disabled: boolean }) {
  function numeric(key: string, value: number | undefined) { const next = { ...edit.parameters }; if(value == null) delete next[key]; else next[key] = value; onChange({ ...edit, parameters: next }) }
  return <div className="form-grid condition-parameter-form"><label className="workspace-field-label">条件名称<input aria-label="条件名称" disabled={disabled} maxLength={100} value={name} onChange={event => onChange({ ...edit,name:event.target.value })} className="workspace-field" /></label>{Object.entries(parameters ?? {}).map(([key,spec]) => spec.type === 'enum' ? <label key={key} className="workspace-field-label">{spec.label}<select disabled={disabled} value={String(edit.parameters?.[key] ?? conditionParameter(expression,key) ?? '')} onChange={event => onChange({ ...edit,parameters:{ ...edit.parameters,[key]:event.target.value } })} className="workspace-field workspace-select">{Object.entries(spec.options ?? {}).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label> : <ParameterNumber key={key} label={spec.label} value={Number(edit.parameters?.[key] ?? conditionParameter(expression,key) ?? 0)} min={spec.min} max={spec.max} integer={spec.type === 'integer'} disabled={disabled} onChange={value => numeric(key,value)} />)}</div>
}

function StateBadge({ state }: { state: string }) { return <span className={`decision-state state-${state}`}>{stateLabels[state] ?? state}</span> }
function Empty({ icon, title, text, action }: { icon: typeof Sparkles; title: string; text?: string; action?: React.ReactNode }) { return <EmptyState icon={icon} title={title} titleAs="h3" description={text} actions={action} /> }
function planText(node: PlanNode, conditions: DraftCondition[]): string {
  if (node.op === 'condition') return conditions.find(item => item.key === node.key)?.contract.summary ?? '未识别条件'
  const children = node.children ?? []
  return node.op === 'not' ? `排除（${children.map(child => planText(child, conditions)).join('')}）` : `（${children.map(child => planText(child, conditions)).join(node.op === 'all' ? '，并且 ' : '，或者 ')}）`
}
function treeText(node: Node, catalog: Asset[]): string {
  if (node.op.endsWith('_ref')) {
    const asset = catalog.find(item => item.key === `${node.op === 'filter_ref' ? 'filter' : 'pattern'}:${node.filter_id ?? node.pattern_id}@${node.version}`)
    return asset?.filter ? conditionText(asset.filter.library, applyConditionParameters(asset.filter.expression,node.parameter_overrides), asset.filter.name) : asset?.label ?? '等待载入条件版本'
  }
  return node.op === 'not' ? `排除（${(node.children ?? []).map(child => treeText(child, catalog)).join('')}）` : `（${(node.children ?? []).map(child => treeText(child, catalog)).join(node.op === 'all' ? '，并且 ' : '，或者 ')}）`
}
function Provenance({ value }: { value?: Filter['provenance'] }) {
  const labels: Record<string, string> = { window: '指标或观察周期', value: '比较阈值', fast_window: '短均线周期', slow_window: '长均线周期', direction: '穿越方向' }
  return <details className="provenance"><summary>查看条件来源</summary>{value?.original_prompt ? <>
    <p>最初描述：{value.original_prompt}</p>{value.prompt !== value.original_prompt && <p>补充后描述：{value.prompt}</p>}
    <p>对应原文：{value.source_quote}</p>{value.source_document && <p>阅读来源：{value.source_document.title} · 第 {value.source_document.page} 页</p>}
    <p>{value.source === 'configured_llm' ? `生成模型：${value.model}` : '生成方式：本地规则解析'} · {value.compiler_version}</p>
    {Object.entries(value.confirmation_edits?.parameters ?? {}).map(([key, parameter]) => <p key={key}>确认时修改：{labels[key] ?? key} {String(value.original_expression?.[key] ?? '未记录')} → {parameter}</p>)}
    {value.confirmation_edits?.name && <p>确认时命名：{value.confirmation_edits.name}</p>}
    <p>确认时间：{value.confirmed_at ? new Date(value.confirmed_at).toLocaleString('zh-CN') : '未记录'}</p>
    {value.based_on_version && <p>当前版本基于第 {value.based_on_version} 版。</p>}
    {value.assumptions?.map((item, i) => <p key={i}>{item}</p>)}
  </> : <p>表单条件，未记录自然语言来源。</p>}</details>
}
function LogicTrace({ node }: { node: Logic }) {
  return <div className="logic-trace"><div><span>{node.name ?? ({ all: '全部满足', any: '任一满足', not: '排除：对以下整体判断取反' }[node.op] ?? node.op)}</span><StateBadge state={node.state} /></div>{node.children?.map((child, i) => <LogicTrace key={i} node={child} />)}</div>
}
function DecisionDetail({ detail }: { detail: Detail }) {
  const symbols: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' }
  return <article className="decision-detail"><div className="section-title-row"><strong>{detail.summary ?? detail.name}{detail.version ? ` · v${detail.version}` : ''}</strong><StateBadge state={detail.state} /></div>
    {detail.reason && <p>{detail.reason}</p>}{detail.similarity !== undefined && <p className="calculation">实际相似度 <b>{numberText(detail.similarity)} 分</b><span>要求至少</span><b>{numberText(detail.threshold)} 分</b></p>}
    {typeof detail.actual === 'number' && <p className="calculation">{actualLabel(detail.effective_expression)} <b>{numberText(detail.actual)}{detail.unit}</b><span>要求 {symbols[detail.operator ?? ''] ?? '对比'} {targetLabel(detail.effective_expression)}</span><b>{numberText(detail.threshold)}{detail.unit}</b></p>}
    {detail.formula_trace && <details className="formula-audit"><summary>查看逐项计算过程</summary><FormulaTraceView node={detail.formula_trace} /></details>}
    {detail.program_trace && <ProgramTraceView trace={detail.program_trace} code={String(detail.effective_expression?.code ?? '')} />}
    {detail.daily_values?.length ? <details className="formula-audit"><summary>查看连续期间每日结果</summary><div className="metric-daily-values">{detail.daily_values.map((day, index) => <div key={index}><span>{day.date ?? '日期未知'}</span><StateBadge state={day.state} /><span>实际 {numberText(day.actual)}{detail.unit}</span><span>基数 {numberText(day.baseline)}</span>{day.reason && <small>{day.reason}</small>}</div>)}</div></details> : null}
    {detail.actual != null && typeof detail.actual === 'object' && <p className="calculation">当日短均线 {numberText(detail.actual.fast)} · 长均线 {numberText(detail.actual.slow)}{detail.previous && <>；前日短均线 {numberText(detail.previous.fast)} · 长均线 {numberText(detail.previous.slow)}</>}</p>}
    {detail.baseline != null && <p>基期数值：{numberText(detail.baseline)} · 观察窗口 {detail.start_date} 至 {detail.end_date}</p>}
    {detail.data_date && <small>行情日期：{detail.data_date}</small>}
    {detail.assessments?.map(report => <div key={report.document_id} className="report-proof"><strong>{report.title}</strong>{report.criteria?.map((criterion, i) => <div key={i}><p>{criterion.label} · {stateLabels[criterion.state]}：{criterion.summary}</p>{criterion.evidence.map((evidence, j) => <blockquote key={j}>第 {evidence.page} 页：“{evidence.quote}”</blockquote>)}</div>)}</div>)}
    {detail.provenance && <Provenance value={detail.provenance} />}
  </article>
}

function ProgramTraceView({ trace, code }: { trace: NonNullable<Detail['program_trace']>; code: string }) {
  const valueText = (value: number | null) => value == null ? '数据不足' : numberText(value)
  return <div className="formula-audit generated-audit"><p>模型生成计算函数 · SHA-256 {trace.code_hash}</p>
    <div className="generated-metrics">{Object.entries(trace.metrics).map(([name, value]) => <span key={name}><strong>{name}</strong>{valueText(value)}</span>)}</div>
    <details><summary>近20个交易日计算过程</summary><div className="generated-daily-values">{trace.daily_values.map((daily, index) => <div key={index}><span>{daily.date ?? '日期未知'}</span><StateBadge state={daily.state} />{Object.entries(daily.metrics).map(([name, value]) => <small key={name}>{name}：{valueText(value)}</small>)}</div>)}</div></details>
    <details><summary>查看生成的计算源码</summary><pre>{code}</pre></details>
  </div>
}

function FormulaTraceView({ node }: { node: FormulaTrace }) {
  const number = (value: number | string | null | undefined) => typeof value === 'number' ? numberText(value) : value === 'true' || value === 'false' || value === 'unknown' ? stateLabels[value] : (value ?? '数据不足')
  const fieldNames: Record<string, string> = { open: '开盘价', high: '最高价', low: '最低价', close: '收盘价', volume: '成交量', amount: '成交额' }
  const label = node.op === 'field' ? fieldNames[String((node as unknown as { field?: string }).field)] ?? node.label : node.label
  return <div className="formula-trace"><div className="formula-trace-heading"><strong>{label}</strong><span>{number(node.value)}</span>{node.state && <StateBadge state={node.state} />}</div>
    {node.left && node.right && <p>{node.operator ? `${node.left.label} ${({ 大于: '>', 不低于: '≥', 小于: '<', 不高于: '≤', 等于: '=' } as Record<string,string>)[node.operator] ?? node.operator} ${node.right.label}` : ''} · {number(node.left.value)} · {number(node.right.value)}</p>}
    {node.previous && <small>前一交易日：{number(node.previous.left)} 与 {number(node.previous.right)}</small>}
    {node.children?.map((child, i) => <FormulaTraceView key={i} node={child} />)}
    {node.input && <FormulaTraceView node={node.input} />}
    {node.daily_values && <div className="formula-daily-values">{node.daily_values.map((daily, i) => <div key={i}><span>{daily.date ?? '日期未知'}</span><StateBadge state={daily.state} /><FormulaTraceView node={daily.formula} /></div>)}</div>}
  </div>
}
