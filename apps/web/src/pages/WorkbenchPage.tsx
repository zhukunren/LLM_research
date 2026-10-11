import { StockText } from '../components/StockMentions'
import ConversationRunView from '../components/ConversationRunView'
import StockSearch, { StockName } from '../components/StockSearch'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowRight, Check, ChevronDown, CircleHelp, Clock3, Database, GitBranch, Library, MessageCircle, Play, Plus, RefreshCw, Save, Search, ShieldCheck, SlidersHorizontal, Sparkles, TrendingUp, X } from 'lucide-react'
import { api, type ConversationScope, type ConversationSourceReference, type DataStatus, type Filter, type Pattern, type Strategy, type WorkflowType } from '../api'
import { ParameterNumber, type Asset, type Node } from './StrategyPage'
import { actualLabel, applyConditionParameters, conditionParameter, conditionText, distinctConditionDescription, targetLabel } from '../conditionText'
import { libraryCopy, writeCombination, type LibraryScope, type LibrarySeed } from '../libraryContext'
import ConversationWorkspace from '../components/conversation/ConversationWorkspace'
import type { ConversationHistoryChange } from '../components/ConversationHistoryItem'
import { appendConditionPlan, compositionFingerprint, compositionIssues, executionDateIssue } from '../screeningWorkflow'
import ConditionTransferEditor from '../components/ConditionTransferEditor'

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

export default function WorkbenchPage({ conversationUpdate, onHistoryChange, shellNavigation = false, workflowOnly = false, onOpenDataServices, onConditions, onResumeConversation, newResearchKey, onNewResearchConsumed, conversationId, onOpenProject, conversationPrompt, conversationNewDraft = false, onPromptConsumed, data, onReports, scope, view, onViewChange, onCompose, seed, screeningOnly = false, onCreateCondition, onSeedConsumed, conversationScope = 'screening', conversationWorkflowType = 'research', onLocationChange, onConversationScopeChange, onConversation, conversationSource, onConversationSourceChange }: { conversationUpdate?: { id: string } & ConversationHistoryChange; onHistoryChange?: () => void; shellNavigation?: boolean; workflowOnly?: boolean; onOpenDataServices?: () => void; onConditions?: () => void; onResumeConversation?: (id: string, scope: ConversationScope, workflow?: WorkflowType, prompt?: string) => void; newResearchKey?: number; onNewResearchConsumed?: () => void; conversationId?: string; onOpenProject?: (id: string) => void; conversationPrompt?: string; conversationNewDraft?: boolean; onPromptConsumed?: () => void; data: DataStatus | null; onReports: (filter?: Filter) => void; scope?: LibraryScope; view?: Section; onViewChange?: (section: Section) => void; onCompose?: () => void; seed?: LibrarySeed; screeningOnly?: boolean; onCreateCondition?: () => void; onSeedConsumed?: () => void; conversationScope?: ConversationScope; conversationWorkflowType?: WorkflowType; onLocationChange?: (id: string, scope: ConversationScope, workflow: WorkflowType) => void; onConversationScopeChange?: (scope: ConversationScope) => void; onConversation?: (scope: LibraryScope, source?: { reference: ConversationSourceReference; label: string }, prompt?: string, workflow?: WorkflowType) => void; conversationSource?: { reference: ConversationSourceReference; label: string } | null; onConversationSourceChange?: (source: { reference: ConversationSourceReference; label: string } | null) => void }) {
  const prefix = scope ? `library.${scope}` : 'workbench'
  const copy = scope ? libraryCopy[scope] : null
  const [storedSection, setStoredSection] = useStored<Section>(`${prefix}.section`, screeningOnly || workflowOnly ? 'conversation' : 'create')
  const section = view ?? (screeningOnly && !['conversation', 'compose', 'history'].includes(storedSection) ? 'conversation' : storedSection)
  const [advancedToolsOpen, setAdvancedToolsOpen] = useState(false)
  const advancedToolsVisible = advancedToolsOpen || ['create', 'library', 'compose'].includes(section)
  function setSection(next: Section) {
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
  const [strategyName, setStrategyName] = useStored('workbench.strategyName', '我的选股组合')
  const [strategyId, setStrategyId] = useStored('workbench.strategyId', '')
  const [topNInput, setTopNInput] = useStored('workbench.topNInput', (() => { try { return String(JSON.parse(localStorage.getItem('workbench.topN') || '30')) } catch { return '30' } })())
  const topN = topNInput.trim() ? Number(topNInput) : NaN
  const setTopN = (value: number) => setTopNInput(String(value))
  const [asOf, setAsOf] = useStored('workbench.asOf', '')
  const [poolId, setPoolId] = useStored('workbench.poolId', '')
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [resumeConversation, setResumeConversation] = useState<RunSummary | null>(null)
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false)
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
  const [expanded, setExpanded] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [resultLoading, setResultLoading] = useState(false)
  const [resourceWarnings, setResourceWarnings] = useState<string[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [strategyValidation, setStrategyValidation] = useState<{ fingerprint: string; errors: string[] } | null>(null)
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
    setExpanded(''); setDecisions([]); setTotal(0)
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
        }).catch(e => { if (active) setError(e.message) }).finally(() => { if (active) setResultLoading(false) })
    }, 180)
    return () => { active = false; globalThis.clearTimeout(timer) }
  }, [runId, run?.id, run?.status, resultState, resultQuery, offset])

  const latest = useMemo(() => filters.filter(item => !filters.some(other => other.id === item.id && other.version > item.version)), [filters])
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
    setMobileHistoryOpen(false)
    shouldFocusHistoryResult.current = true
    setError('')
    if (id === runId) { setRunReload(value => value + 1); return }
    setRun(null); setRunId(id); setOffset(0); setExpanded('')
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
  function changeTree(next: Node) { if (busy || next === tree) return; rememberComposition(); setTree(next); setStrategyValidation(null) }
  function usePlan(replaceExisting = false) {
    if (!draft?.saved || busy) return
    rememberComposition()
    const incoming = draft.saved.tree
    const next = replaceExisting ? (incoming.op.endsWith('_ref') ? { op: 'all', children: [incoming] } : incoming) : appendConditionPlan(tree, incoming)
    const name = replaceExisting || !countRefs(tree) ? '我的选股组合' : strategyName
    writeCombination(next, name)
    setTree(next); setStrategyId(''); setStrategyName(name); setStrategyValidation(null)
    if(scope && onCompose) { onCompose(); return }
    setSection('compose'); setNotice(replaceExisting ? '已用本次条件新建组合，可撤销恢复上一份草稿。' : '已加入组合并保留原有分组关系。')
  }
  function addCondition(filter: Filter) {
    if(busy) return
    rememberComposition()
    const child: Node = { op: 'filter_ref', filter_id: filter.id, version: filter.version, score_weight: 1 }
    setTree(previous => appendConditionPlan(previous, child)); setStrategyValidation(null)
    setNotice(`已把“${filter.name}”加入组合。`)
  }
  function undoComposition() {
    if(!previousComposition || busy) return
    setTree(previousComposition.tree); setStrategyId(previousComposition.id); setStrategyName(previousComposition.name); setTopN(previousComposition.topN)
    setPreviousComposition(null); setStrategyValidation(null); setNotice('已恢复上一份组合草稿。')
  }
  function resetComposition() {
    if(busy) return
    rememberComposition(); setTree(emptyTree()); setStrategyId(''); setStrategyName('我的选股组合'); setStrategyValidation(null)
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
  const readinessIssues = [treeIssues.length ? '请先补齐并核对组合中的条件。' : '', nameIssue, poolIssue, !data?.available ? '本地行情尚未就绪，请先查看数据与服务。' : ''].filter(Boolean)
  const currentSaved = savedComposition?.strategy.id === strategyId && savedComposition.fingerprint === fingerprint ? savedComposition.strategy : null
  const validation = strategyValidation?.fingerprint === fingerprint ? strategyValidation : null
  useEffect(() => { if(Number.isInteger(topN) && topN >= 1 && topN <= 500) { try { localStorage.setItem('workbench.topN',JSON.stringify(topN)) } catch { /* Keep editing available. */ } } }, [topN])
  async function validateComposition() {
    if(saveIssues.length || !catalogLoaded) return
    await action('validate', async () => {
      const result = await api<{ valid: boolean; errors: string[] }>('/strategies/validate', { method: 'POST', body: JSON.stringify({ tree }) })
      setStrategyValidation({ fingerprint, errors: result.errors })
      setNotice(result.valid ? '组合校验通过。' : '请修正组合校验问题。')
    })
  }
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
    setPreviousComposition(null); setStrategyValidation(null); setSavedComposition({ strategy: item, fingerprint: compositionFingerprint(item.name, item.tree as Node, item.top_n) })
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

  const visibleRuns = runs.filter(item => (!historyStatus || (historyStatus === 'running' ? ['queued','running'].includes(item.status) : item.status === historyStatus)) && [item.name, item.as_of, strategies.find(value => value.id === item.strategy_id && value.version === item.strategy_version)?.name].join(' ').toLowerCase().includes(historyQuery.trim().toLowerCase())).sort((a, b) => b.created_at.localeCompare(a.created_at))
  const screeningHeading = workflowOnly ? '条件选股' : section === 'conversation' ? '对话筛选' : section === 'history' ? '筛选记录' : '组合选股'
  return <StockText><div className={`page-content workbench ${workflowOnly || section !== 'conversation' ? 'screening-workflow' : ''} ${workflowOnly ? 'condition-studio' : ''} ${section === 'conversation' ? 'workbench-conversation' : ''} ${section === 'compose' ? 'workbench-composing' : ''}`}>
    {!scope && (!shellNavigation || section !== 'conversation') && (workflowOnly || section !== 'conversation') && <header className="workbench-heading"><div><h1>{screeningOnly || workflowOnly ? screeningHeading : '选股工作台'}</h1></div><div className="condition-studio-heading-meta"><span className="workbench-data-status"><Database size={14} />{data?.last_date ? <>行情截至 <time>{data.last_date}</time></> : data ? '待添加行情数据' : '正在读取数据状态…'}</span></div></header>}
    {!scope && !workflowOnly && !screeningOnly && <nav className="workbench-tabs" aria-label="选股流程">{sections.filter(item => !screeningOnly || ['conversation', 'compose', 'history'].includes(item.id)).map(({ id, title, icon: Icon }) => <button key={id} className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => { if(screeningOnly && id === 'compose' && onConditions) { onConditions(); return } setSection(id); setError(''); setNotice(''); if (id === 'history') void refresh().catch(e => setError(e.message)) }}><Icon size={17} />{screeningOnly && id === 'compose' ? '条件选股' : title}{id === 'library' && latest.length > 0 && <span>{latest.length}</span>}{id === 'compose' && countRefs(tree) > 0 && <span>{countRefs(tree)}</span>}</button>)}</nav>}
    {workflowOnly && !shellNavigation && <nav className="condition-studio-nav" id="condition-advanced-tools" aria-label="条件选股流程">{[
      { id: 'conversation' as const, label: '对话选股', icon: MessageCircle },
      { id: 'compose' as const, label: '条件编排', icon: GitBranch, count: countRefs(tree) },
      { id: 'history' as const, label: '筛选结果', icon: Clock3, count: runs.length },
      { id: 'library' as const, label: '我的条件', icon: Library, count: latest.length },
    ].filter(item => advancedToolsVisible || ['conversation','history'].includes(item.id)).map(({ id, label, icon: Icon }) => <button key={id} className={section === id || (id === 'library' && section === 'create') ? 'active' : ''} aria-current={section === id || (id === 'library' && section === 'create') ? 'page' : undefined} disabled={!!busy} onClick={() => { setSection(id); setError(''); setNotice(''); if (id === 'history') void action('refresh', refreshHistory) }}><Icon size={16} /><span>{label}</span></button>)}<button type="button" disabled={!!busy} aria-expanded={advancedToolsVisible} aria-controls="condition-advanced-tools" onClick={() => { if (advancedToolsVisible) { setAdvancedToolsOpen(false); if (['create','library','compose'].includes(section)) setSection('conversation') } else setAdvancedToolsOpen(true) }}><SlidersHorizontal size={16} /><span>{advancedToolsVisible ? '收起高级工具' : '高级工具'}</span></button></nav>}
    {!!resourceWarnings.length && <div className="screening-resource-warning" role="status"><span>部分资料未能更新：{resourceWarnings.join('；')}</span><button className="text-button" disabled={!!busy} onClick={() => void action('refresh',refresh)}>刷新目录</button></div>}
    {error && <div className="workbench-alert" role="alert">{error}<button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={14} /></button></div>}
    {notice && <div className="workbench-notice" role="status"><Check size={16} /><span>{notice}</span>{workflowOnly && section === 'library' && countRefs(tree) > 0 && <button className="text-button" onClick={() => setSection('compose')}>继续编排<ArrowRight size={14} /></button>}</div>}

    {section === 'conversation' && !scope && <ConversationWorkspace conversationUpdate={conversationUpdate} onHistoryChange={onHistoryChange} shellNavigation={shellNavigation} onOpenDataServices={onOpenDataServices} newResearchKey={newResearchKey} onNewResearchConsumed={onNewResearchConsumed} initialPrompt={conversationPrompt} initialNewDraft={conversationNewDraft} onPromptConsumed={onPromptConsumed} data={data} initialConversationId={resumeConversation?.conversation_id ?? conversationId} initialScope={resumeConversation?.entry_scope ?? conversationScope} initialWorkflowType={workflowOnly ? 'screening' : conversationWorkflowType} onLocationChange={onLocationChange} initialSource={conversationSource} onScopeChange={onConversationScopeChange} onSourceChange={onConversationSourceChange} onOpenProject={onOpenProject} onOpenConversation={onResumeConversation} />}

    {workflowOnly && section === 'create' && <header className="condition-create-heading"><button className="text-button" disabled={!!busy} onClick={() => setSection('library')}>返回我的条件</button><h2>新增可复用条件</h2></header>}
    {section === 'create' && <div className={'intent-layout ' + (!draftHistory.length ? 'no-draft-history' : '')}><div className="intent-main">
      <section className="intent-prompt-card"><div className="section-title-row"><h2><Sparkles size={18} />{copy?.promptTitle ?? '你想找什么样的股票？'}</h2></div>

        {sourceDocument?.source_document_id && <div className="source-context"><strong>来源：{sourceDocument.title} · 第 {sourceDocument.source_page} 页</strong><div className="source-context-actions"><button className="text-button" disabled={!!busy} onClick={() => { setSourceDocument(null); setDraft(null); setDraftId('') }}>清除来源</button>{scope === 'report' && sourceDocument.source_page && <button className="secondary-button compact" disabled={!!busy} onClick={() => onConversation?.(scope, { reference: { kind: 'report_page', source_id: sourceDocument.source_document_id!, page_number: sourceDocument.source_page }, label: `${sourceDocument.title} · 第 ${sourceDocument.source_page} 页` })}><MessageCircle size={14} />在对话中讨论此页</button>}</div></div>}<label className="sr-only" htmlFor="stock-intent">选股条件描述</label><textarea id="stock-intent" className="intent-textarea" value={prompt} disabled={!!busy} maxLength={4000} aria-keyshortcuts="Control+Enter Meta+Enter" onChange={e => { setPrompt(e.target.value); setPreview(null) }} onKeyDown={onIntentKeyDown} />
        {scope === 'news' && <div className="news-match-dates"><label>开始日期<input aria-label="匹配资讯开始日期" type="date" value={newsStart} max={newsEnd || undefined} disabled={!!busy} onInput={event => setNewsStart(event.currentTarget.value)} onChange={event => setNewsStart(event.target.value)} /></label><label>结束日期<input aria-label="匹配资讯结束日期" type="date" value={newsEnd} min={newsStart || undefined} disabled={!!busy} onInput={event => setNewsEnd(event.currentTarget.value)} onChange={event => setNewsEnd(event.target.value)} /></label></div>}
        <div className="prompt-bottom"><span>{prompt.length}/4000</span><button className="primary-button" disabled={!!busy || !prompt.trim() || (scope === 'news' && (!newsStart || !newsEnd || newsStart > newsEnd))} onClick={generate}><Sparkles size={16} />{busy === 'generate' ? (scope === 'news' ? '正在匹配资讯…' : '正在理解完整描述…') : scope === 'news' ? '匹配资讯' : draft && prompt.trim() !== draft.prompt ? '按补充后的描述重新生成' : '生成条件'}</button></div>

        {!draft && (workflowOnly ? <div className="condition-starter-examples"><div>{[
          { title: '趋势向上', text: '价格与短期涨幅', icon: TrendingUp, prompt: '收盘价高于20日均线，且近5个交易日涨幅超过3%' },
          { title: '寻找超跌', text: 'RSI 与均线位置', icon: SlidersHorizontal, prompt: 'RSI14小于30，且收盘价低于10日均线' },
          { title: '均线共振', text: '多周期趋势确认', icon: GitBranch, prompt: '收盘价高于10日均线且高于20日均线' },
        ].map(({ title, text, icon: Icon, prompt: example }) => <button key={title} type="button" disabled={!!busy} onClick={() => { setPrompt(example); setPreview(null); document.getElementById('stock-intent')?.focus() }}><Icon size={19} /><strong>{title}</strong><span>{text}</span><ArrowRight size={14} /></button>)}</div></div> : <div className="prompt-examples">{(copy?.examples ?? ['收盘价高于20日均线，且近5个交易日涨幅超过3%', 'RSI14小于30', '收盘价高于10日均线且高于20日均线']).map(example => <button key={example} type="button" disabled={!!busy} onClick={() => { setPrompt(example); setPreview(null) }}>{example}<ArrowRight size={12} /></button>)}</div>)}
      </section>
      {draft?.news_matches && <section ref={resultRef} className="news-match-results"><div className="section-title-row"><h2>匹配资讯</h2><span>{draft.news_matches.start_date} 至 {draft.news_matches.end_date} · {draft.news_matches.matched_count} / {draft.news_matches.candidate_count} 条</span></div>{(prompt.trim() !== draft.prompt || newsStart !== (draft.news_matches.start_date ?? '') || newsEnd !== (draft.news_matches.end_date ?? '')) && <p className="notice-amber">描述或日期已修改，请重新匹配。下方保留上次结果。</p>}{!draft.news_matches.items.length && <p className="workbench-help">所选日期范围内没有匹配的资讯。</p>}{draft.news_matches.items.map(item => <article key={item.id}><h3>{item.title}</h3><small>{item.source}</small><p>{item.reason}</p><blockquote>{item.quote}</blockquote><details><summary>阅读正文</summary><p style={{ whiteSpace: 'pre-wrap' }}>{item.body}</p></details><button className="secondary-button compact" onClick={() => onConversation?.('news', { reference: { kind: 'news_item', source_id: item.id }, label: item.title }, undefined, 'screening')}>基于这条资讯对话筛选</button></article>)}</section>}
      {draft && scope !== 'news' && !draft.news_matches && <section className="intent-result" ref={resultRef}><div className="section-title-row"><h2>{draft.status === 'ready' ? <Check size={18} /> : <CircleHelp size={18} />}{draft.status === 'ready' ? `拆成了 ${draft.conditions.length} 个独立条件` : '还需要把要求说清楚'}</h2><span>{draft.source === 'local_parser' ? '本地规则解析' : '模型辅助解析'}</span></div>
        {prompt.trim() !== draft.prompt && <p className="notice-amber">描述已修改，请重新生成。下方仍是上一份描述的结果。</p>}
        {draft.issues.map((issue, i) => <div key={i} className="clarification-card"><strong>{issue.kind === 'unsupported' ? '当前数据暂不支持' : '需要补充'} · {issue.text}</strong><p>{issue.suggestion}</p></div>)}
        {reviewedConditions.map((item, i) => <article className="condition-review" key={item.key}><div className="condition-number">{String(i + 1).padStart(2, '0')}</div><div><div className="condition-card-title"><h3>{item.contract.summary}</h3><span className={`availability ${item.contract.availability}`}>{item.contract.availability_label}</span></div><p className="condition-quote">你的原话：“{item.source_quote}”</p><ul className="contract-notes">{item.contract.notes.map(note => <li key={note}>{note}</li>)}</ul>
          {item.library === 'report' && <ReportCriterionReview expression={item.expression} />}<details className="condition-adjustments"><summary>修改名称或参数</summary><ParameterEditor name={edits[item.key]?.name ?? item.name} parameters={item.parameters} expression={item.expression} edit={edits[item.key] ?? {}} disabled={!!busy || !!draft.saved} onChange={edit => { setEdits({ ...edits, [item.key]: edit }); setPreview(null) }} /></details></div></article>)}
        {draft.tree && <div className="logic-sentence"><GitBranch size={16} /><div><strong>这句话的组合关系</strong><p>{planText(draft.tree, reviewedConditions)}</p></div></div>}
        {!!draft.assumptions.length && <div className="assumption-note"><strong>计算口径</strong><ul>{draft.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
        {!!draftEditIssues.length && <div className="composition-validation" role="alert">{[...new Set(draftEditIssues)].map(issue => <p key={issue}>{issue}</p>)}</div>}{ready && <>{(!scope || scope === 'technical') && <div className="trial-row"><label>试算股票<StockSearch disabled={!!busy} label="试算股票" value={stock} onChange={code => { setStock(code); setPreview(null) }} /></label><label>截止日期<input disabled={!!busy} aria-label="试算截止日期" type="date" value={asOf} max={data?.last_date} onChange={e => { setAsOf(e.target.value); setPreview(null) }} /></label><button className="secondary-button" disabled={!!busy || !!draftEditIssues.length || !/^\d{6}\.(SH|SZ|BJ)$/.test(stock) || !!executionDateIssue(asOf,data?.last_date)} onClick={() => action('preview', async () => setPreview(await api<Preview>(`/condition-drafts/${draft.id}/preview`, { method: 'POST', body: JSON.stringify({ edits, stock_code: stock, as_of: asOf }) })))}><Play size={14} />{busy === 'preview' ? '计算中…' : '试算看看'}</button></div>}
          {preview && <div className="trial-result"><div className="section-title-row"><strong>{preview.stock_code} · 实际行情 {preview.actual_date ?? '无'}</strong><StateBadge state={preview.state} /></div>{preview.details.map((detail, i) => <DecisionDetail detail={detail} key={i} />)}</div>}
          <div className="intent-confirm">{draft.saved ? <><span><Check size={16} />条件已保存</span><button className="primary-button" disabled={!!busy} onClick={() => usePlan()}>用这些条件组合选股<ArrowRight size={16} /></button>{countRefs(tree) > 0 && <button className="secondary-button" disabled={!!busy} onClick={() => usePlan(true)}>以这些条件新建组合</button>}</> : <><button className="primary-button" disabled={!!busy || !!draftEditIssues.length} onClick={confirm}><Save size={16} />{busy === 'confirm' ? '保存中…' : `确认并保存 ${draft.conditions.length} 个条件`}</button></>}</div></>}
      </section>}
    </div>{draftHistory.length > 0 && <aside className="intent-guide"><section className="draft-history"><h3>最近的描述</h3>{draftHistory.filter((item, index, all) => all.findIndex(other => other.prompt === item.prompt) === index).slice(0, 8).map(item => <button key={item.id} disabled={!!busy} onClick={() => loadDraft(item.id)}><span>{item.prompt}</span></button>)}</section></aside>}</div>}

    {section === 'library' && <section className="library-workspace"><div className="section-title-row"><div><h2>积累你的选股条件</h2></div><button className="primary-button" disabled={!!busy} onClick={() => newDescription()}><Plus size={16} />新增可复用条件</button></div>
      <div className="library-filters"><label className="search-input"><Search size={16} /><input aria-label="搜索我的条件" placeholder="搜索条件名称、判断口径或描述" value={search} onChange={e => setSearch(e.target.value)} />{search && <button className="icon-button" aria-label="清除条件搜索" onClick={() => setSearch('')}><X size={14} /></button>}</label><select disabled={!!scope} aria-label="条件类型" value={library} onChange={e => setLibrary(e.target.value)}><option value="all">全部条件</option><option value="technical">行情条件</option><option value="report">研报条件</option><option value="news">资讯条件</option></select><select aria-label="条件排序" value={conditionSort} onChange={event => setConditionSort(event.target.value)}><option value="recent">最近保存优先</option><option value="name">按名称排序</option></select><button className="secondary-button" disabled={!!busy} onClick={() => setSection('compose')}>查看组合 · {countRefs(tree)} 项<ArrowRight size={15} /></button></div>
      {workflowOnly && <div className="condition-library-overview"><span>共 <strong>{filtered.length}</strong> 个条件</span><div>{Object.entries(libraryNames).map(([kind, name]) => <button key={kind} aria-pressed={library === kind} onClick={() => setLibrary(library === kind ? 'all' : kind)}>{name}<b>{latest.filter(item => item.library === kind).length}</b></button>)}</div>{(search || library !== (scope ?? 'all')) && <button className="text-button" onClick={() => { setSearch(''); setLibrary(scope ?? 'all') }}>重置筛选</button>}</div>}
      {catalogLoading && <p className="workbench-help">正在载入本库条件…</p>}{catalogLoaded && !filtered.length && <Empty icon={Library} title={latest.length ? '没有找到匹配的条件' : '还没有保存的条件'} />}
      <div className="condition-library-grid">{filtered.slice(0, conditionLimit).map(item => { const summary = distinctConditionDescription(item.name, item.contract?.summary ?? item.description); return <article className="saved-condition-card" key={item.id}><div className="condition-card-title"><h3>{item.name}</h3><span className={`availability ${item.contract?.availability}`}>{item.contract?.availability_label}</span></div>{summary && <p>{summary}</p>}<div className="card-actions"><button className="secondary-button" disabled={!!busy} onClick={() => { setSelected(item); setSelectedEdit({}); requestAnimationFrame(() => document.querySelector('.condition-inspector')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })) }}>查看与调整</button><button className="primary-button" disabled={!!busy} onClick={() => addCondition(item)}><Plus size={14} />加入组合</button></div></article> })}</div>
      {filtered.length > conditionLimit && <div className="condition-load-more"><span>已显示 {conditionLimit} / {filtered.length} 个条件</span><button className="secondary-button" onClick={() => setConditionLimit(value => value + 12)}>显示更多条件<ChevronDown size={14} /></button></div>}
      {selected && <div className="condition-inspector"><div className="section-title-row"><h2>{selected.name}</h2><button className="icon-button" aria-label="关闭条件详情" onClick={() => setSelected(null)}><X size={17} /></button></div><label className="history-version">查看历史版本<select value={selected.version} onChange={e => { const item = filters.find(f => f.id === selected.id && f.version === Number(e.target.value)); if (item) { setSelected(item); setSelectedEdit({}) } }}>{filters.filter(f => f.id === selected.id).map(f => <option value={f.version} key={f.version}>第 {f.version} 版 · {dateText(f.created_at)}</option>)}</select></label><p>{selectedDirty ? '修改后：' : ''}{selectedSummary}</p><ul className="contract-notes">{selected.contract?.notes.map(item => <li key={item}>{item.startsWith('涨幅 =') ? `涨幅 =（最新收盘价 ÷ ${selectedExpression.window} 个交易日前收盘价 − 1）× 100%。` : item}</li>)}</ul><Provenance value={selected.provenance} />
        <ParameterEditor name={selectedEdit.name ?? selected.name} parameters={selected.parameters} expression={selected.expression} edit={selectedEdit} disabled={!!busy} onChange={setSelectedEdit} />
        <div className="card-actions"><button className="secondary-button" disabled={selectedDirty || !!busy} onClick={() => addCondition(selected)}>{selectedDirty ? '先保存修改再加入组合' : '将此版本加入组合'}</button>{selectedDirty && <button className="text-button" disabled={!!busy} onClick={() => setSelectedEdit({})}>撤销修改</button>}{selected.library === 'report' && <button className="secondary-button" onClick={() => onReports(selected)}>前往研报评估</button>}<button className="primary-button" disabled={!!busy || !Object.keys(selectedEdit).length} onClick={revise}><Save size={15} />保存为新版本</button></div><details className="technical-details"><summary>查看原始执行规则</summary><pre>{JSON.stringify(selectedExpression, null, 2)}</pre></details></div>}
    </section>}


    {section === 'compose' && <>
      <header className="advanced-composition-heading"><div><div className="advanced-composition-eyebrow"><GitBranch size={14} />自定义选股工作区</div><h1>高级组合</h1><p>把你的判断组合起来，构建可复用的选股逻辑。</p></div><button className="secondary-button" disabled={!!busy} onClick={resetComposition}><Plus size={15} />新建组合</button></header>
      <div className="compose-workspace condition-compose-workspace">
      <section className="compose-main" aria-label="构建选股组合">
        <fieldset disabled={!!busy} className="screening-editor-fields composition-editor-fields"><div className="form-grid"><label>组合名称<input aria-label="组合名称" value={strategyName} maxLength={100} onChange={event => { setStrategyName(event.target.value); setPreviousComposition(null) }} /></label><label>载入已保存组合<select aria-label="载入组合版本" value="" onChange={event => loadStrategy(event.target.value)}><option value="">选择组合与版本</option>{strategies.map(item => <option key={item.id + '@' + item.version} value={item.id + '@' + item.version}>{item.name} · v{item.version}</option>)}</select></label></div>
        <div className="composition-status"><span className={currentSaved ? 'saved' : 'draft'}><span className="composition-status-dot" />{currentSaved ? '已保存 · v' + currentSaved.version : strategyId ? '已修改，保存将创建新版本' : '尚未保存的组合草稿'}</span><span>{countRefs(tree)} 项条件</span>{previousComposition && <button className="text-button" onClick={undoComposition}>撤销上次组合更改</button>}</div>
        {catalogLoading ? <p role="status" className="workbench-help">正在载入条件目录…</p> : <ConditionTransferEditor tree={tree} catalog={catalog} logicSummary={countRefs(tree) ? treeText(tree,catalog) : undefined} disabled={!!busy || !catalogLoaded} onChange={changeTree} onCreateCondition={() => setSection('create')} />}
        </fieldset>
        {!!editorIssues.length && countRefs(tree) > 0 && <div className="composition-validation" role="alert">{editorIssues.map(issue => <p key={issue}>{issue}</p>)}</div>}
        {validation && <div className={'composition-validation ' + (validation.errors.length ? '' : 'valid')} role="status">{validation.errors.length ? validation.errors.map(issue => <p key={issue}>{issue}</p>) : '组合校验通过。'}</div>}
        <div className="card-actions composition-editor-footer"><span><ShieldCheck size={14} />{currentSaved ? '当前版本已保存，可随时复用' : '草稿自动保留在当前浏览器'}</span><button className="secondary-button" disabled={!!busy || !catalogLoaded || !!saveIssues.length} onClick={validateComposition}><Check size={15} />{busy === 'validate' ? '正在校验…' : '校验组合'}</button><button className="secondary-button" disabled={!!busy || !catalogLoaded || !!saveIssues.length} onClick={() => saveStrategy(false)}><Save size={15} />{currentSaved ? '组合已保存' : '保存组合'}</button></div>
      </section>
      <aside className="run-setup compose-execution"><div className="run-setup-heading"><div><span className="composition-step">03</span><h2>执行设置</h2></div><p>核对范围与日期，再开始筛选</p></div><fieldset disabled={!!busy} className="screening-editor-fields"><label>股票范围<select aria-label="筛选股票范围" value={poolId} onChange={event => setPoolId(event.target.value)}><option value="">全部 A 股</option>{pools.map(pool => <option key={pool.id} value={pool.id}>{pool.name} · {pool.items.length} 只</option>)}</select></label><label>行情截止日期<input type="date" aria-label="筛选截止日期" aria-invalid={!!dateIssue || undefined} value={asOf} max={data?.last_date} onChange={event => setAsOf(event.target.value)} />{dateIssue && <span className="screening-field-error">{dateIssue}</span>}</label><label>优先保留数量<div className="composition-quantity-field"><input aria-label="优先保留数量" type="number" min={1} max={500} value={topNInput} aria-invalid={!!numericIssue || undefined} onChange={event => setTopNInput(event.target.value)} /><span>只</span></div><small className="composition-field-help">按组合评分优先保留，最多 500 只</small>{numericIssue && <span className="screening-field-error">{numericIssue}</span>}</label></fieldset>
      <div className="composition-data-summary"><Database size={15} /><div><strong>本地行情{data?.available ? '已就绪' : '待就绪'}</strong><span>数据截至 {data?.last_date ?? '尚未载入'}</span></div>{data?.available && <Check size={14} />}</div>
      {!!readinessIssues.length && <div className="screening-readiness">{readinessIssues.slice(0,3).map(issue => <p key={issue}>{issue}</p>)}</div>}
      <div className="compose-execution-actions">
      <div className={'composition-run-status ' + (!runIssues.length && catalogLoaded ? 'ready' : '')}><span className="composition-status-dot" />{catalogLoading ? '正在读取条件目录' : !catalogLoaded ? '条件目录未就绪' : runIssues.length ? '请完成设置后执行' : '已具备筛选条件'}</div>
      <button className="primary-button run-button" disabled={!catalogLoaded || !!busy || !!runIssues.length} onClick={() => saveStrategy(true)}><Play size={17} />{busy === 'run' ? '正在提交…' : currentSaved ? '按此版本开始筛选' : '保存并开始筛选'}</button>
      <p className="composition-execution-note">{currentSaved ? `采用组合第 ${currentSaved.version} 版` : '执行时将保存为新的组合版本'}<br />结果与判断依据保留在筛选记录中</p>
      <button className="text-button" disabled={!!busy} onClick={() => { setSection('history'); void refreshHistory() }}>查看筛选记录</button>
      </div>
      </aside>
    </div></>}

    {section === 'history' && <div className={`history-workspace${mobileHistoryOpen ? ' history-show-catalog' : ''}`}><button type="button" className="text-button history-mobile-toggle" aria-expanded={mobileHistoryOpen} onClick={() => setMobileHistoryOpen(value => !value)}>{mobileHistoryOpen ? '返回筛选结果' : '切换筛选记录'}</button><aside className="run-history"><div className="section-title-row"><h2>筛选记录</h2><button className="icon-button" aria-label="刷新筛选记录" disabled={!!busy} onClick={() => action('refresh', refreshHistory)}><RefreshCw size={15} /></button></div><label className="workspace-search history-search"><Search size={14} /><input aria-label="搜索筛选记录" placeholder="组合名称或日期" value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} /></label><select aria-label="筛选记录状态" value={historyStatus} onChange={event => setHistoryStatus(event.target.value)}><option value="">全部状态</option><option value="running">运行中</option><option value="succeeded">已完成</option><option value="partial">部分数据不足</option><option value="failed">执行失败</option><option value="cancelled">已取消</option></select>{!runs.length && <p className="workbench-help">暂无筛选记录</p>}{visibleRuns.slice(0, historyLimit).map(item => <button key={item.id} className={item.id === runId ? 'selected' : ''} aria-current={item.id === runId ? 'true' : undefined} onClick={() => selectRun(item.id)}><strong>{item.name || strategies.find(s => s.id === item.strategy_id && s.version === item.strategy_version)?.name || '选股方案'}</strong><span>截止 {item.as_of} · v{item.strategy_version}</span><small><span className={'history-status-dot '+(item.id === run?.id ? run.status : item.status)} />{stateLabels[item.id === run?.id ? run.status : item.status] ?? item.status} · {dateText(item.created_at)}</small></button>)}{visibleRuns.length > historyLimit && <button className="history-show-more" onClick={() => setHistoryLimit(value => value + 15)}>显示更多记录<ChevronDown size={14} /></button>}{runs.length > 0 && !visibleRuns.length && <div className="history-no-matches"><p>没有符合当前筛选的记录。</p><button className="text-button" onClick={() => { setHistoryQuery(''); setHistoryStatus('') }}>查看全部记录</button></div>}</aside>
      <section className="run-results" ref={historyResultRef} tabIndex={-1}>{historyConversation ? <ConversationRunView key={historyConversation.id} conversationId={historyConversation.conversation_id!} runId={historyConversation.id} onContinue={() => { if(onResumeConversation) onResumeConversation(historyConversation.conversation_id!,historyConversation.entry_scope ?? 'screening'); else { setResumeConversation(historyConversation); setSection('conversation') } }} /> : runLoadError ? <Empty icon={CircleHelp} title="暂时无法读取记录" text={runLoadError} action={<button className="secondary-button" onClick={() => setRunReload(value => value + 1)}><RefreshCw size={15} />重新读取记录</button>} /> : !run ? <Empty icon={Clock3} title={runId ? '正在读取筛选记录' : '未选择筛选记录'} action={!runId ? <button className="primary-button" onClick={() => setSection(workflowOnly ? 'conversation' : 'compose')}><Plus size={15} />开始一次选股</button> : undefined} /> : <><div className="section-title-row"><div><h2>{run.context?.strategy_snapshot?.name ?? strategies.find(s => s.id === run.strategy_id)?.name ?? '筛选结果'}</h2><p className="workbench-help">{run.context?.universe?.name ?? '全部 A 股'} · 截止 {run.as_of} · 组合第 {run.strategy_version} 版</p></div><StateBadge state={run.status} /></div>
        {run.job && ['queued', 'running'].includes(run.status) && <div className="run-progress"><p>{run.job.message}</p><progress max={1} value={run.job.progress} /><button className="text-button" disabled={!!busy} onClick={() => action('cancel', async () => { await api(`/jobs/${run.job!.id}/cancel`, { method: 'POST' }); setRun(await api<Run>(`/screening-runs/${run.id}`)); await refresh() })}>取消本次筛选</button></div>}
        {['failed', 'cancelled'].includes(run.status) && <div className="clarification-card"><strong>{run.job?.message ?? stateLabels[run.status]}</strong>{run.job && <button className="secondary-button" disabled={!!busy} onClick={() => action('retry', async () => { const result = await api<{ run_id: string }>(`/jobs/${run.job!.id}/retry`, { method: 'POST' }); setRun(null); setRunId(result.run_id); await refresh() })}>使用原快照重试</button>}</div>}
        {run.result.blockers?.map(item => <p className="notice-amber" key={item}>{item}</p>)}
        {run.result.counts && <><div className="result-counts"><div><span>共检查</span><strong>{numberText(run.result.counts.evaluated)}</strong></div>{['true', 'false', 'unknown'].map(state => <button key={state} aria-pressed={resultState === state} className={resultState === state ? 'selected' : ''} onClick={() => { setResultState(state); setOffset(0) }}><span>{stateLabels[state]}</span><strong>{numberText(run.result.counts?.[state])}</strong></button>)}</div>
          <div className="result-toolbar"><label className="search-input"><Search size={15} /><input aria-label="搜索筛选结果股票" placeholder="股票名称、拼音或代码" value={resultQuery} onChange={e => { setResultQuery(e.target.value); setOffset(0) }} /></label><select aria-label="筛选结果状态" value={resultState} onChange={e => { setResultState(e.target.value); setOffset(0) }}><option value="true">符合条件</option><option value="false">不符合条件</option><option value="unknown">数据不足</option><option value="">全部判断</option></select><a className="secondary-button" href={`/api/v1/screening-runs/${run.id}/export`}>导出优先结果</a></div>
          {!run.result.trace_version && <p className="notice-amber">旧版记录：优先结果及部分数据不足样本。</p>}
          {resultLoading ? <p className="workbench-help">正在读取判断依据…</p> : !decisions.length ? <Empty icon={Search} title={resultQuery ? '没有找到这只股票的记录' : '此分类没有股票'} /> : <div className="decision-list"><div className="decision-table-head"><span>股票代码</span><span>收盘价</span><span>得分</span><span>判断</span><span>依据</span></div>{decisions.map(item => <div className="decision-row" key={item.stock_code}><button aria-expanded={expanded === item.stock_code} aria-label={`查看 ${item.stock_code} 判断依据`} className="decision-summary" onClick={() => setExpanded(expanded === item.stock_code ? '' : item.stock_code)}><strong><StockName code={item.stock_code}  embedded /><small>{item.as_of ?? '无行情'}</small></strong><span>{numberText(item.close)}</span><span>{numberText(item.score)}</span><StateBadge state={item.state} /><ChevronDown size={17} /></button>{expanded === item.stock_code && <div className="decision-evidence">{item.reason && <p className="notice-amber">{item.reason}</p>}{item.logic && <LogicTrace node={item.logic} />}{item.details.map((detail, i) => <DecisionDetail key={i} detail={detail} />)}</div>}</div>)}</div>}
          <div className="pagination"><span>共 {total} 条{total > 0 ? ` · ${offset + 1}–${Math.min(offset + 50, total)}` : ''}</span><button className="secondary-button" disabled={offset === 0 || resultLoading} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><button className="secondary-button" disabled={offset + 50 >= total || resultLoading} onClick={() => setOffset(offset + 50)}>下一页</button></div>
          <details className="technical-details"><summary>本次筛选的版本与数据记录</summary><p>运行编号：{run.id}</p><p>行情截止：{run.result.data_snapshot?.watermark ?? '未记录'}</p><p>文件校验值：{run.result.data_snapshot?.sha256 ?? '未记录'}</p>{run.context?.universe?.codes && <p>股票池名单：{run.context.universe.codes.join('、')}</p>}<pre>{JSON.stringify(run.context?.strategy_snapshot?.tree, null, 2)}</pre></details>
        </>}
      </>}</section></div>}
  </div></StockText>
}

function ReportCriterionReview({ expression }: { expression: Filter['expression'] }) {
  const criteria = Array.isArray(expression.criteria) ? expression.criteria as { id: string; label: string; question: string; signals?: string[]; counter_signals?: string[] }[] : []
  return <div className="rubric-summary">{criteria.map(item => <div key={item.id}><strong>{item.label}</strong><p>{item.question.replace(/\b(true|false|unknown)\b/g, word => stateLabels[word])}</p><details><summary>支持与反向证据</summary><p>支持信号：{item.signals?.join('；') || '根据原文直接证据判断'}</p><p>反向信号：{item.counter_signals?.join('；') || '需要明确相反事实，无证据保留数据不足'}</p></details></div>)}</div>
}


function ParameterEditor({ name, parameters, expression, edit, onChange, disabled }: { name: string; parameters: Filter['parameters']; expression: Filter['expression']; edit: Edit; onChange: (edit: Edit) => void; disabled: boolean }) {
  function numeric(key: string, value: number | undefined) { const next = { ...edit.parameters }; if(value == null) delete next[key]; else next[key] = value; onChange({ ...edit, parameters: next }) }
  return <div className="form-grid condition-parameter-form"><label>条件名称<input aria-label="条件名称" disabled={disabled} maxLength={100} value={name} onChange={event => onChange({ ...edit,name:event.target.value })} /></label>{Object.entries(parameters ?? {}).map(([key,spec]) => spec.type === 'enum' ? <label key={key}>{spec.label}<select disabled={disabled} value={String(edit.parameters?.[key] ?? conditionParameter(expression,key) ?? '')} onChange={event => onChange({ ...edit,parameters:{ ...edit.parameters,[key]:event.target.value } })}>{Object.entries(spec.options ?? {}).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label> : <ParameterNumber key={key} label={spec.label} value={Number(edit.parameters?.[key] ?? conditionParameter(expression,key) ?? 0)} min={spec.min} max={spec.max} integer={spec.type === 'integer'} disabled={disabled} onChange={value => numeric(key,value)} />)}</div>
}

function StateBadge({ state }: { state: string }) { return <span className={`decision-state state-${state}`}>{stateLabels[state] ?? state}</span> }
function Empty({ icon: Icon, title, text, action }: { icon: typeof Sparkles; title: string; text?: string; action?: React.ReactNode }) { return <div className="workbench-empty"><Icon size={28} strokeWidth={1.4} /><h3>{title}</h3>{text && <p>{text}</p>}{action}</div> }
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
    {typeof detail.actual === 'object' && <p className="calculation">当日短均线 {numberText(detail.actual.fast)} · 长均线 {numberText(detail.actual.slow)}{detail.previous && <>；前日短均线 {numberText(detail.previous.fast)} · 长均线 {numberText(detail.previous.slow)}</>}</p>}
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
