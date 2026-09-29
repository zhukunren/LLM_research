import ConversationRunView from '../components/ConversationRunView'
import StockSearch, { StockName } from '../components/StockSearch'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowRight, Check, ChevronDown, CircleHelp, Clock3, GitBranch, Library, MessageCircle, Play, Plus, Save, Search, Sparkles, X } from 'lucide-react'
import { api, type ConversationScope, type ConversationSourceReference, type DataStatus, type Filter, type Pattern, type Strategy } from '../api'
import { NodeEditor, type Asset, type Node } from './StrategyPage'
import { actualLabel, applyConditionParameters, conditionParameter, conditionText, targetLabel } from '../conditionText'
import { libraryCopy, writeCombination, type LibraryScope, type LibrarySeed } from '../libraryContext'
import ConversationWorkspace from '../components/conversation/ConversationWorkspace'

export type Section = 'conversation' | 'create' | 'library' | 'compose' | 'history'
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

const sections: { id: Section; title: string; icon: typeof Sparkles }[] = [{ id: 'conversation', title: '对话筛选', icon: MessageCircle }, { id: 'create', title: '描述条件', icon: Sparkles }, { id: 'library', title: '我的条件', icon: Library }, { id: 'compose', title: '高级组合', icon: GitBranch }, { id: 'history', title: '筛选记录', icon: Clock3 }]

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

export default function WorkbenchPage({ conversationPrompt, onPromptConsumed, data, onReports, scope, view, onViewChange, onCompose, seed, screeningOnly = false, onCreateCondition, onSeedConsumed, conversationScope = 'screening', onConversationScopeChange, onConversation, conversationSource, onConversationSourceChange }: { conversationPrompt?: string; onPromptConsumed?: () => void; data: DataStatus | null; onReports: (filter?: Filter) => void; scope?: LibraryScope; view?: Section; onViewChange?: (section: Section) => void; onCompose?: () => void; seed?: LibrarySeed; screeningOnly?: boolean; onCreateCondition?: () => void; onSeedConsumed?: () => void; conversationScope?: ConversationScope; onConversationScopeChange?: (scope: ConversationScope) => void; onConversation?: (scope: LibraryScope, source?: { reference: ConversationSourceReference; label: string }) => void; conversationSource?: { reference: ConversationSourceReference; label: string } | null; onConversationSourceChange?: (source: { reference: ConversationSourceReference; label: string } | null) => void }) {
  const prefix = scope ? `library.${scope}` : 'workbench'
  const copy = scope ? libraryCopy[scope] : null
  const [storedSection, setStoredSection] = useStored<Section>(`${prefix}.section`, screeningOnly ? 'conversation' : 'create')
  const section = view ?? (screeningOnly && !['conversation', 'compose', 'history'].includes(storedSection) ? 'conversation' : storedSection)
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
  const [selected, setSelected] = useState<Filter | null>(null)
  const [selectedEdit, setSelectedEdit] = useState<Edit>({})
  const [tree, setTree] = useStored<Node>('workbench.tree', emptyTree())
  const [strategyName, setStrategyName] = useStored('workbench.strategyName', '我的选股组合')
  const [strategyId, setStrategyId] = useStored('workbench.strategyId', '')
  const [topN, setTopN] = useStored('workbench.topN', 30)
  const [asOf, setAsOf] = useStored('workbench.asOf', '')
  const [poolId, setPoolId] = useStored('workbench.poolId', '')
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [resumeConversation, setResumeConversation] = useState<RunSummary | null>(null)
  const [runId, setRunId] = useStored('workbench.runId', '')
  const historyConversation = runs.find(item => item.id === runId && item.kind === 'conversation')
  const [run, setRun] = useState<Run | null>(null)
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
  const resultRef = useRef<HTMLElement>(null)
  const historyResultRef = useRef<HTMLElement>(null)
  const shouldScroll = useRef(false)
  const shouldFocusHistoryResult = useRef(false)

  async function refresh() {
    const [f, p, s, w, r, d] = await Promise.all([
      api<{ items: Filter[] }>(`/filters?include_history=true${scope ? `&library=${scope}` : ''}`), api<{ items: Pattern[] }>('/patterns?include_history=true'),
      api<{ items: Strategy[] }>('/strategies?include_history=true'), api<{ items: Pool[] }>('/watchlists'),
      api<{ items: RunSummary[] }>(screeningOnly ? '/screening-history' : '/screening-runs'), api<{ items: typeof draftHistory }>(`/condition-drafts${scope ? `?library=${scope}` : ''}`),
    ])
    setFilters(f.items); setPatterns(p.items); setStrategies(s.items); setPools(w.items); setRuns(r.items); setDraftHistory(d.items); setCatalogLoaded(true)
  }
  useEffect(() => { void refresh().catch(e => setError(e.message)) }, [])
  useEffect(() => {
    if (!seed) return
    setDraft(null); setDraftId(''); setEdits({}); setPreview(null); setPrompt(seed.prompt ?? '')
    setSourceDocument(seed.source_document_id ? seed : null); setSection('create'); onSeedConsumed?.()
  }, [seed?.id])
  useEffect(() => { if (shouldScroll.current && draft) { resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); shouldScroll.current = false } }, [draft?.id])
  useEffect(() => {
    if (!shouldFocusHistoryResult.current || !run || run.id !== runId) return
    historyResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    historyResultRef.current?.focus({ preventScroll: true })
    shouldFocusHistoryResult.current = false
  }, [run?.id, runId])
  useEffect(() => { if (!asOf && data?.last_date) setAsOf(data.last_date) }, [data?.last_date, asOf])
  useEffect(() => {
    let active = true
    if (!seed && draftId) api<Draft>(`/condition-drafts/${draftId}`).then(value => { if (active) { setDraft(value); if (value.saved?.confirmation) setEdits(value.saved.confirmation.edits) } }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [draftId])
  useEffect(() => {
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
      } catch (e) { if (active) setError((e as Error).message) }
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
  const filtered = latest.filter(item => (library === 'all' || item.library === library) && `${item.name} ${item.description} ${item.provenance?.prompt ?? ''}`.includes(search))
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

  async function action(label: string, task: () => Promise<void>) {
    setBusy(label); setNotice(''); setError('')
    try { await task() } catch (e) { setError((e as Error).message) } finally { setBusy('') }
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
    if (!draft || !ready) return
    await action('confirm', async () => {
      const result = await api<SavedDraft>(`/condition-drafts/${draft.id}/confirm`, { method: 'POST', body: JSON.stringify({ edits }) })
      setDraft({ ...draft, saved: result }); await refresh(); setNotice(`已保存 ${result.filters.length} 个独立条件，后续可以自由组合。`)
    })
  }
  function usePlan() {
    if (!draft?.saved) return
    if (scope && onCompose) { writeCombination(draft.saved.tree); onCompose(); return }
    setTree(draft.saved.tree.op.endsWith('_ref') ? { op: 'all', children: [draft.saved.tree] } : draft.saved.tree); setStrategyId(''); setStrategyName('我的选股组合'); setSection('compose'); setNotice('已保留原描述中的组合关系。可以继续添加、分组或排除条件。')
  }
  function addCondition(filter: Filter) {
    const child: Node = { op: 'filter_ref', filter_id: filter.id, version: filter.version, score_weight: 1 }
    setTree(previous => previous.op === 'all' ? { ...previous, children: [...(previous.children ?? []), child] } : { op: 'all', children: [previous, child] })
    setNotice(`已把“${filter.name}”加入组合。`)
  }
  async function saveStrategy(execute: boolean) {
    await action(execute ? 'run' : 'strategy', async () => {
      const saved = await api<Strategy>('/strategies', { method: 'POST', body: JSON.stringify({ id: strategyId || undefined, name: strategyName, tree, top_n: topN }) })
      setStrategyId(saved.id)
      if (execute) {
        const next = await api<{ id: string }>('/screening-runs', { method: 'POST', body: JSON.stringify({ strategy_id: saved.id, strategy_version: saved.version, as_of: asOf, mode: 'exploratory', watchlist_id: poolId || undefined }) })
        setRun(null); setRunId(next.id); setResultState('true'); setOffset(0); setSection('history')
      } else setNotice(`已保存“${saved.name}”第 ${saved.version} 版。`)
      await refresh()
    })
  }
  function loadStrategy(value: string) {
    const item = strategies.find(s => `${s.id}@${s.version}` === value)
    if (!item) return
    setTree(structuredClone(item.tree) as Node); setStrategyId(item.id); setStrategyName(item.name); setTopN(item.top_n)
    setNotice(`已载入“${item.name}”第 ${item.version} 版。编辑后会保存为新版本。`)
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

  const screeningHeading = section === 'conversation' ? '对话筛选' : section === 'history' ? '筛选记录' : '组合选股'
  return <div className="page-content workbench">
    {!scope && section !== 'conversation' && <div className="workbench-heading"><div><p className="eyebrow">把选股想法，变成可以反复使用的条件</p><h1>{screeningOnly ? screeningHeading : '选股工作台'}</h1></div><span className="workbench-data-status">{data?.last_date ? <>行情截至 <time>{data.last_date}</time></> : data ? '待添加行情数据' : '正在读取数据状态…'}</span></div>}
    {!scope && <nav className="workbench-tabs" aria-label="选股流程">{sections.filter(item => !screeningOnly || ['conversation', 'compose', 'history'].includes(item.id)).map(({ id, title, icon: Icon }) => <button key={id} className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => { setSection(id); setError(''); setNotice(''); if (id === 'history') void refresh().catch(e => setError(e.message)) }}><Icon size={17} />{title}{id === 'library' && latest.length > 0 && <span>{latest.length}</span>}{id === 'compose' && countRefs(tree) > 0 && <span>{countRefs(tree)}</span>}</button>)}</nav>}
    {error && <div className="workbench-alert" role="alert">{error}<button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={14} /></button></div>}
    {notice && <div className="workbench-notice" role="status"><Check size={16} />{notice}</div>}

    {section === 'conversation' && screeningOnly && <ConversationWorkspace initialPrompt={conversationPrompt} onPromptConsumed={onPromptConsumed} data={data} initialConversationId={resumeConversation?.conversation_id} initialScope={resumeConversation?.entry_scope ?? conversationScope} initialSource={conversationSource} onScopeChange={onConversationScopeChange} onSourceChange={onConversationSourceChange} />}

    {section === 'create' && <div className="intent-layout"><div className="intent-main">
      <section className="intent-prompt-card"><div className="section-title-row"><h2><Sparkles size={18} />{copy?.promptTitle ?? '你想找什么样的股票？'}</h2></div>
        
        {sourceDocument?.source_document_id && <div className="source-context"><strong>来源：{sourceDocument.title} · 第 {sourceDocument.source_page} 页</strong><div className="source-context-actions"><button className="text-button" disabled={!!busy} onClick={() => { setSourceDocument(null); setDraft(null); setDraftId('') }}>清除来源</button>{scope === 'report' && sourceDocument.source_page && <button className="secondary-button compact" disabled={!!busy} onClick={() => onConversation?.(scope, { reference: { kind: 'report_page', source_id: sourceDocument.source_document_id!, page_number: sourceDocument.source_page }, label: `${sourceDocument.title} · 第 ${sourceDocument.source_page} 页` })}><MessageCircle size={14} />在对话中讨论此页</button>}</div></div>}<label className="sr-only" htmlFor="stock-intent">选股条件描述</label><textarea id="stock-intent" className="intent-textarea" value={prompt} disabled={!!busy} maxLength={4000} aria-keyshortcuts="Control+Enter Meta+Enter" placeholder={copy?.placeholder ?? '例如：收盘价高于20日均线，且近5个交易日涨幅大于3%'} onChange={e => { setPrompt(e.target.value); setPreview(null) }} onKeyDown={onIntentKeyDown} />
        {scope === 'news' && <div className="news-match-dates"><label>开始日期<input aria-label="匹配资讯开始日期" type="date" value={newsStart} max={newsEnd || undefined} disabled={!!busy} onInput={event => setNewsStart(event.currentTarget.value)} onChange={event => setNewsStart(event.target.value)} /></label><label>结束日期<input aria-label="匹配资讯结束日期" type="date" value={newsEnd} min={newsStart || undefined} disabled={!!busy} onInput={event => setNewsEnd(event.currentTarget.value)} onChange={event => setNewsEnd(event.target.value)} /></label></div>}
        <div className="prompt-bottom"><span>{prompt.length}/4000</span><button className="primary-button" disabled={!!busy || !prompt.trim() || (scope === 'news' && (!newsStart || !newsEnd || newsStart > newsEnd))} onClick={generate}><Sparkles size={16} />{busy === 'generate' ? (scope === 'news' ? '正在匹配资讯…' : '正在理解完整描述…') : scope === 'news' ? '匹配资讯' : draft && prompt.trim() !== draft.prompt ? '按补充后的描述重新生成' : '生成条件'}</button></div>

      </section>
      {draft?.news_matches && <section ref={resultRef} className="news-match-results"><div className="section-title-row"><h2>匹配资讯</h2><span>{draft.news_matches.start_date} 至 {draft.news_matches.end_date} · {draft.news_matches.matched_count} / {draft.news_matches.candidate_count} 条</span></div>{(prompt.trim() !== draft.prompt || newsStart !== (draft.news_matches.start_date ?? '') || newsEnd !== (draft.news_matches.end_date ?? '')) && <p className="notice-amber">描述或日期已修改，请重新匹配。下方保留上次结果。</p>}{!draft.news_matches.items.length && <p className="workbench-help">所选日期范围内没有匹配的资讯。</p>}{draft.news_matches.items.map(item => <article key={item.id}><h3>{item.title}</h3><small>{item.source}</small><p>{item.reason}</p><blockquote>{item.quote}</blockquote><details><summary>阅读正文</summary><p style={{ whiteSpace: 'pre-wrap' }}>{item.body}</p></details><button className="secondary-button compact" onClick={() => onConversation?.('news', { reference: { kind: 'news_item', source_id: item.id }, label: item.title })}>基于这条资讯对话筛选</button></article>)}</section>}
      {draft && scope !== 'news' && !draft.news_matches && <section className="intent-result" ref={resultRef}><div className="section-title-row"><h2>{draft.status === 'ready' ? <Check size={18} /> : <CircleHelp size={18} />}{draft.status === 'ready' ? `拆成了 ${draft.conditions.length} 个独立条件` : '还需要把要求说清楚'}</h2><span>{draft.source === 'local_parser' ? '本地规则解析' : '模型辅助解析'}</span></div>
        {prompt.trim() !== draft.prompt && <p className="notice-amber">描述已修改，请重新生成。下方仍是上一份描述的结果。</p>}
        {draft.issues.map((issue, i) => <div key={i} className="clarification-card"><strong>{issue.kind === 'unsupported' ? '当前数据暂不支持' : '需要补充'} · {issue.text}</strong><p>{issue.suggestion}</p></div>)}
        {reviewedConditions.map((item, i) => <article className="condition-review" key={item.key}><div className="condition-number">{String(i + 1).padStart(2, '0')}</div><div><div className="condition-card-title"><h3>{item.contract.summary}</h3><span className={`availability ${item.contract.availability}`}>{item.contract.availability_label}</span></div><p className="condition-quote">你的原话：“{item.source_quote}”</p><ul className="contract-notes">{item.contract.notes.map(note => <li key={note}>{note}</li>)}</ul>
          {item.library === 'report' && <ReportCriterionReview expression={item.expression} />}<details className="condition-adjustments"><summary>修改名称或参数</summary><ParameterEditor name={edits[item.key]?.name ?? item.name} parameters={item.parameters} expression={item.expression} edit={edits[item.key] ?? {}} disabled={!!busy || !!draft.saved} onChange={edit => { setEdits({ ...edits, [item.key]: edit }); setPreview(null) }} /></details></div></article>)}
        {draft.tree && <div className="logic-sentence"><GitBranch size={16} /><div><strong>这句话的组合关系</strong><p>{planText(draft.tree, reviewedConditions)}</p></div></div>}
        {!!draft.assumptions.length && <div className="assumption-note"><strong>采用的计算口径，请一起确认</strong><ul>{draft.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
        {ready && <>{(!scope || scope === 'technical') && <div className="trial-row"><label>先看一只股票如何判断<StockSearch disabled={!!busy} label="试算股票" value={stock} onChange={code => { setStock(code); setPreview(null) }} /></label><label>截止日期<input disabled={!!busy} aria-label="试算截止日期" type="date" value={asOf} max={data?.last_date} onChange={e => { setAsOf(e.target.value); setPreview(null) }} /></label><button className="secondary-button" disabled={!!busy || !stock || !asOf} onClick={() => action('preview', async () => setPreview(await api<Preview>(`/condition-drafts/${draft.id}/preview`, { method: 'POST', body: JSON.stringify({ edits, stock_code: stock, as_of: asOf }) })))}><Play size={14} />{busy === 'preview' ? '计算中…' : '试算看看'}</button></div>}
          {preview && <div className="trial-result"><div className="section-title-row"><strong>{preview.stock_code} · 实际行情 {preview.actual_date ?? '无'}</strong><StateBadge state={preview.state} /></div>{preview.details.map((detail, i) => <DecisionDetail detail={detail} key={i} />)}</div>}
          <div className="intent-confirm">{draft.saved ? <><span><Check size={16} />条件已保存，可随时在“我的条件”中复用</span><button className="primary-button" disabled={!!busy} onClick={usePlan}>用这些条件组合选股<ArrowRight size={16} /></button></> : <><p>确认上面的判断口径符合你的原意，再保存为独立条件。</p><button className="primary-button" disabled={!!busy} onClick={confirm}><Save size={16} />{busy === 'confirm' ? '保存中…' : `确认并保存 ${draft.conditions.length} 个条件`}</button></>}</div></>}
      </section>}
    </div><aside className="intent-guide"><section className="draft-history"><h3>最近的描述</h3>{draftHistory.filter((item, index, all) => all.findIndex(other => other.prompt === item.prompt) === index).slice(0, 8).map(item => <button key={item.id} disabled={!!busy} onClick={() => loadDraft(item.id)}><span>{item.prompt}</span></button>)}</section></aside></div>}

    {section === 'library' && <section className="library-workspace"><div className="section-title-row"><div><h2>积累你的选股条件</h2><p className="workbench-help">每个条件独立保存。修改会生成新版本，历史组合保留原有判断方式。</p></div><button className="primary-button" disabled={!!busy} onClick={() => newDescription()}><Plus size={16} />描述新条件</button></div>
      <div className="library-filters"><label className="search-input"><Search size={16} /><input aria-label="搜索我的条件" placeholder="搜索条件名称或原始描述" value={search} onChange={e => setSearch(e.target.value)} /></label><select disabled={!!scope} aria-label="条件类型" value={library} onChange={e => setLibrary(e.target.value)}><option value="all">全部条件</option><option value="technical">行情条件</option><option value="report">研报条件</option><option value="news">资讯条件</option></select><button className="secondary-button" onClick={() => setSection('compose')}>查看组合 · {countRefs(tree)} 项<ArrowRight size={15} /></button></div>
      {!catalogLoaded && <p className="workbench-help">正在载入本库条件…</p>}{catalogLoaded && !filtered.length && <Empty icon={Library} title={latest.length ? '没有找到匹配的条件' : '还没有保存的条件'} text={latest.length ? '换个关键词或条件类型试试。' : '先用一句话描述你的选股要求，确认后会出现在这里。'} />}
      <div className="condition-library-grid">{filtered.map(item => <article className="saved-condition-card" key={item.id}><div className="condition-card-title"><span className="condition-category">{libraryNames[item.library]} · v{item.version}</span><span className={`availability ${item.contract?.availability}`}>{item.contract?.availability_label}</span></div><h3>{item.name}</h3><p>{item.contract?.summary ?? item.description}</p><small>{item.provenance?.source === 'configured_llm' ? '来自你的自然语言描述' : item.provenance?.original_prompt ? '来自你的描述' : '已保存的条件'} · {dateText(item.created_at)}</small><div className="card-actions"><button className="secondary-button" onClick={() => { setSelected(item); setSelectedEdit({}) }}>查看与调整</button><button className="primary-button" onClick={() => addCondition(item)}><Plus size={14} />加入组合</button></div></article>)}</div>
      {selected && <div className="condition-inspector"><div className="section-title-row"><h2>{selected.name}</h2><button className="icon-button" aria-label="关闭条件详情" onClick={() => setSelected(null)}><X size={17} /></button></div><label className="history-version">查看历史版本<select value={selected.version} onChange={e => { const item = filters.find(f => f.id === selected.id && f.version === Number(e.target.value)); if (item) { setSelected(item); setSelectedEdit({}) } }}>{filters.filter(f => f.id === selected.id).map(f => <option value={f.version} key={f.version}>第 {f.version} 版 · {dateText(f.created_at)}</option>)}</select></label><p>{selectedDirty ? '修改后：' : ''}{selectedSummary}</p><ul className="contract-notes">{selected.contract?.notes.map(item => <li key={item}>{item.startsWith('涨幅 =') ? `涨幅 =（最新收盘价 ÷ ${selectedExpression.window} 个交易日前收盘价 − 1）× 100%。` : item}</li>)}</ul><Provenance value={selected.provenance} />
        <ParameterEditor name={selectedEdit.name ?? selected.name} parameters={selected.parameters} expression={selected.expression} edit={selectedEdit} disabled={!!busy} onChange={setSelectedEdit} />
        <div className="card-actions"><button className="secondary-button" disabled={selectedDirty || !!busy} onClick={() => addCondition(selected)}>{selectedDirty ? '先保存修改再加入组合' : '将此版本加入组合'}</button>{selectedDirty && <button className="text-button" disabled={!!busy} onClick={() => setSelectedEdit({})}>撤销修改</button>}{selected.library === 'report' && <button className="secondary-button" onClick={() => onReports(selected)}>前往研报评估</button>}<button className="primary-button" disabled={!!busy || !Object.keys(selectedEdit).length} onClick={revise}><Save size={15} />保存为新版本</button></div><details className="technical-details"><summary>查看原始执行规则</summary><pre>{JSON.stringify(selectedExpression, null, 2)}</pre></details></div>}
    </section>}

    {section === 'compose' && <div className="compose-workspace"><section className="compose-main"><div className="section-title-row"><div><h2>组合你的选股条件</h2><p className="workbench-help">用“添加分组”表达复杂关系，例如：趋势向上，并且满足超跌或放量中的任一个。</p></div><button className="secondary-button" onClick={() => { setTree(emptyTree()); setStrategyId(''); setStrategyName('我的选股组合') }}><Plus size={14} />新建组合</button></div>
      <div className="form-grid"><label>组合名称<input value={strategyName} maxLength={100} onChange={e => setStrategyName(e.target.value)} /></label><label>载入已保存的组合<select value="" onChange={e => loadStrategy(e.target.value)}><option value="">选择组合及版本</option>{strategies.map(s => <option key={`${s.id}@${s.version}`} value={`${s.id}@${s.version}`}>{s.name} · v{s.version}</option>)}</select></label></div>
      {!catalogLoaded ? <p className="workbench-help">正在载入已保存的条件与形态…</p> : !catalog.length ? <Empty icon={GitBranch} title="先保存一个条件" text="描述条件并确认后，就可以在这里组合筛选。" action={<button className="primary-button" onClick={() => setSection('create')}>去描述条件<ArrowRight size={15} /></button>} /> : <NodeEditor node={tree} catalog={catalog} onChange={setTree} depth={0} />}
      {countRefs(tree) > 0 && <div className="logic-sentence"><GitBranch size={16} /><div><strong>最终选股要求</strong><p>{treeText(tree, catalog)}</p></div></div>}
      <div className="card-actions"><button className="secondary-button" disabled={!catalogLoaded || !!busy || !countRefs(tree) || !strategyName.trim()} onClick={() => saveStrategy(false)}><Save size={15} />保存组合</button><button className="text-button" onClick={() => setSection('library')}>前往资料库挑选条件</button></div>
    </section><aside className="run-setup"><h2>在哪些股票中筛选？</h2><label>股票池<select value={poolId} onChange={e => setPoolId(e.target.value)}><option value="">全部 A 股</option>{pools.map(pool => <option key={pool.id} value={pool.id}>{pool.name} · {pool.items.length} 只</option>)}</select></label><label>按哪一天的数据判断<input type="date" aria-label="筛选截止日期" value={asOf} max={data?.last_date} onChange={e => setAsOf(e.target.value)} /></label><label>优先保留数量<input type="number" min={1} max={500} value={topN} onChange={e => setTopN(Number(e.target.value))} /></label><p className="workbench-help">按符合条件的权重排序；同分按股票代码排序。记录中可以查看每只股票的判断，导出保留前 {topN || '—'} 只。</p>
      <button className="primary-button run-button" disabled={!catalogLoaded || !!busy || !countRefs(tree) || !strategyName.trim() || !asOf || !data?.available} onClick={() => saveStrategy(true)}><Play size={17} />{busy === 'run' ? '正在提交…' : '保存组合并开始筛选'}</button><small>本次条件版本、股票池名单和截止日将一起保留。</small>
    </aside></div>}

    {section === 'history' && <div className="history-workspace"><aside className="run-history"><div className="section-title-row"><h2>历史记录</h2><button className="text-button" onClick={() => action('refresh', refreshHistory)}>刷新</button></div>{!runs.length && <p className="workbench-help">完成第一次筛选后，结果和依据会保留在这里。</p>}{runs.map(item => <button key={item.id} className={item.id === runId ? 'selected' : ''} aria-current={item.id === runId ? 'true' : undefined} onClick={() => selectRun(item.id)}><strong>{item.name || strategies.find(s => s.id === item.strategy_id && s.version === item.strategy_version)?.name || '选股方案'}</strong><span>截止 {item.as_of} · v{item.strategy_version}</span><small>{stateLabels[item.id === run?.id ? run.status : item.status] ?? item.status} · {dateText(item.created_at)}</small></button>)}</aside>
      <section className="run-results" ref={historyResultRef} tabIndex={-1}>{historyConversation ? <ConversationRunView key={historyConversation.id} conversationId={historyConversation.conversation_id!} runId={historyConversation.id} onContinue={() => { setResumeConversation(historyConversation); setSection('conversation') }} /> : !run ? <Empty icon={Clock3} title={runId ? '正在读取筛选记录' : '每次筛选都有独立记录'} text="可以回看当时的组合、股票池和每项条件的判断依据。" /> : <><div className="section-title-row"><div><h2>{run.context?.strategy_snapshot?.name ?? strategies.find(s => s.id === run.strategy_id)?.name ?? '筛选结果'}</h2><p className="workbench-help">{run.context?.universe?.name ?? '全部 A 股'} · 截止 {run.as_of} · 组合第 {run.strategy_version} 版</p></div><StateBadge state={run.status} /></div>
        {run.job && ['queued', 'running'].includes(run.status) && <div className="run-progress"><p>{run.job.message}</p><progress max={1} value={run.job.progress} /><button className="text-button" disabled={!!busy} onClick={() => action('cancel', async () => { await api(`/jobs/${run.job!.id}/cancel`, { method: 'POST' }); setRun(await api<Run>(`/screening-runs/${run.id}`)); await refresh() })}>取消本次筛选</button></div>}
        {['failed', 'cancelled'].includes(run.status) && <div className="clarification-card"><strong>{run.job?.message ?? stateLabels[run.status]}</strong>{run.job && <button className="secondary-button" disabled={!!busy} onClick={() => action('retry', async () => { const result = await api<{ run_id: string }>(`/jobs/${run.job!.id}/retry`, { method: 'POST' }); setRun(null); setRunId(result.run_id); await refresh() })}>使用原快照重试</button>}</div>}
        {run.result.blockers?.map(item => <p className="notice-amber" key={item}>{item}</p>)}
        {run.result.counts && <><div className="result-counts"><div><span>共检查</span><strong>{numberText(run.result.counts.evaluated)}</strong></div>{['true', 'false', 'unknown'].map(state => <button key={state} className={resultState === state ? 'selected' : ''} onClick={() => { setResultState(state); setOffset(0) }}><span>{stateLabels[state]}</span><strong>{numberText(run.result.counts?.[state])}</strong></button>)}</div>
          <div className="result-toolbar"><label className="search-input"><Search size={15} /><input aria-label="搜索筛选结果股票" placeholder="股票名称、拼音或代码" value={resultQuery} onChange={e => { setResultQuery(e.target.value); setOffset(0) }} /></label><select aria-label="筛选结果状态" value={resultState} onChange={e => { setResultState(e.target.value); setOffset(0) }}><option value="true">符合条件</option><option value="false">不符合条件</option><option value="unknown">数据不足</option><option value="">全部判断</option></select><a className="secondary-button" href={`/api/v1/screening-runs/${run.id}/export`}>导出优先结果</a></div>
          {!run.result.trace_version && <p className="notice-amber">这是一份旧版记录，仅保留了优先结果和部分数据不足样本。新筛选会记录每只股票的判断。</p>}
          {resultLoading ? <p className="workbench-help">正在读取判断依据…</p> : !decisions.length ? <Empty icon={Search} title={resultQuery ? '没有找到这只股票的记录' : '此分类没有股票'} text={resultState === 'unknown' ? '数据不足不代表符合，也不代表不符合。' : '可以切换结果状态，查看其他股票的判断。'} /> : <div className="decision-list"><div className="decision-table-head"><span>股票代码</span><span>收盘价</span><span>得分</span><span>判断</span><span>依据</span></div>{decisions.map(item => <div className="decision-row" key={item.stock_code}><button aria-expanded={expanded === item.stock_code} aria-label={`查看 ${item.stock_code} 判断依据`} className="decision-summary" onClick={() => setExpanded(expanded === item.stock_code ? '' : item.stock_code)}><strong><StockName code={item.stock_code} /><small>{item.as_of ?? '无行情'}</small></strong><span>{numberText(item.close)}</span><span>{numberText(item.score)}</span><StateBadge state={item.state} /><ChevronDown size={17} /></button>{expanded === item.stock_code && <div className="decision-evidence">{item.reason && <p className="notice-amber">{item.reason}</p>}{item.logic && <LogicTrace node={item.logic} />}{item.details.map((detail, i) => <DecisionDetail key={i} detail={detail} />)}</div>}</div>)}</div>}
          <div className="pagination"><span>共 {total} 条{total > 0 ? ` · ${offset + 1}–${Math.min(offset + 50, total)}` : ''}</span><button className="secondary-button" disabled={offset === 0 || resultLoading} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><button className="secondary-button" disabled={offset + 50 >= total || resultLoading} onClick={() => setOffset(offset + 50)}>下一页</button></div>
          <details className="technical-details"><summary>本次筛选的版本与数据记录</summary><p>运行编号：{run.id}</p><p>行情截止：{run.result.data_snapshot?.watermark ?? '未记录'} · 条件固定版本，股票池在提交时留存。</p><p>文件校验值：{run.result.data_snapshot?.sha256 ?? '未记录'}</p>{run.context?.universe?.codes && <p>股票池名单：{run.context.universe.codes.join('、')}</p>}<pre>{JSON.stringify(run.context?.strategy_snapshot?.tree, null, 2)}</pre></details>
        </>}
      </>}</section></div>}
  </div>
}

function ReportCriterionReview({ expression }: { expression: Filter['expression'] }) {
  const criteria = Array.isArray(expression.criteria) ? expression.criteria as { id: string; label: string; question: string; signals?: string[]; counter_signals?: string[] }[] : []
  return <div className="rubric-summary">{criteria.map(item => <div key={item.id}><strong>{item.label}</strong><p>{item.question.replace(/\b(true|false|unknown)\b/g, word => stateLabels[word])}</p><details><summary>支持与反向证据</summary><p>支持信号：{item.signals?.join('；') || '根据原文直接证据判断'}</p><p>反向信号：{item.counter_signals?.join('；') || '需要明确相反事实，无证据保留数据不足'}</p></details></div>)}</div>
}

function ParameterEditor({ name, parameters, expression, edit, onChange, disabled }: { name: string; parameters: Filter['parameters']; expression: Filter['expression']; edit: Edit; onChange: (edit: Edit) => void; disabled: boolean }) {
  return <div className="form-grid condition-parameter-form"><label>条件名称<input disabled={disabled} maxLength={100} value={name} onChange={e => onChange({ ...edit, name: e.target.value })} /></label>{Object.entries(parameters ?? {}).map(([key, spec]) => <label key={key}>{spec.label}{spec.type === 'enum' ? <select disabled={disabled} value={String(edit.parameters?.[key] ?? conditionParameter(expression, key) ?? '')} onChange={e => onChange({ ...edit, parameters: { ...edit.parameters, [key]: e.target.value } })}>{Object.entries(spec.options ?? {}).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <input disabled={disabled} type="number" min={spec.min} max={spec.max} step={spec.type === 'integer' ? 1 : 'any'} value={String(edit.parameters?.[key] ?? conditionParameter(expression, key) ?? '')} onChange={e => onChange({ ...edit, parameters: { ...edit.parameters, [key]: e.target.value === '' ? '' : Number(e.target.value) } })} />}</label>)}</div>
}

function StateBadge({ state }: { state: string }) { return <span className={`decision-state state-${state}`}>{stateLabels[state] ?? state}</span> }
function Empty({ icon: Icon, title, text, action }: { icon: typeof Sparkles; title: string; text: string; action?: React.ReactNode }) { return <div className="workbench-empty"><Icon size={28} strokeWidth={1.4} /><h3>{title}</h3><p>{text}</p>{action}</div> }
function planText(node: PlanNode, conditions: DraftCondition[]): string {
  if (node.op === 'condition') return conditions.find(item => item.key === node.key)?.contract.summary ?? '未识别条件'
  const children = node.children ?? []
  return node.op === 'not' ? `排除（${children.map(child => planText(child, conditions)).join('')}）` : `（${children.map(child => planText(child, conditions)).join(node.op === 'all' ? '，并且 ' : '，或者 ')}）`
}
function treeText(node: Node, catalog: Asset[]): string {
  if (node.op.endsWith('_ref')) {
    const asset = catalog.find(item => item.key === `${node.op === 'filter_ref' ? 'filter' : 'pattern'}:${node.filter_id ?? node.pattern_id}@${node.version}`)
    return asset?.filter ? conditionText(asset.filter.library, { ...asset.filter.expression, ...node.parameter_overrides }, asset.filter.name) : asset?.label ?? '等待载入条件版本'
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
    {value.based_on_version && <p>当前版本在第 {value.based_on_version} 版基础上修订；可在条件库切换历史版本核对。</p>}
    {value.assumptions?.map((item, i) => <p key={i}>{item}</p>)}
  </> : <p>此条件通过表单创建，未记录自然语言来源。可从当前固定版本开始追溯。</p>}</details>
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
