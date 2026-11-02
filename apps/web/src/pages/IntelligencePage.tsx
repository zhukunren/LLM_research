import { useEffect, useId, useRef, useState } from 'react'
import { ArrowRight, BookOpen, Check, ChevronDown, Clock3, Download, ExternalLink, FileSearch, History, RefreshCw, Search, Settings2, Square, X } from 'lucide-react'
import { api, ApiRequestError } from '../api'
import { sessionStorage } from '../authStorage'
import { trapDialogTab } from '../keyboard'
import { useWorkspaceSession } from '../WorkspaceSession'
import LoadingState from '../components/LoadingState'
import ConditionWorkspaceDrawer from '../components/ConditionWorkspaceDrawer'
import { AdvisorSettings, AdvisorResult, EvidenceDimension } from '../components/AdvisorTask'
import { ValidationResult } from '../components/ValidationResult'
import { defaultAdvisorScope, isAdvisorKind, isStockKind, taskNoun, type AdvisorScope } from '../intelligence'
import { briefActive, briefKinds, briefMarkets, briefScopeLabel, briefStates, briefTime, defaultBriefScope,
  type BriefCatalog, type BriefCitation, type BriefDetail, type BriefItem, type BriefKind, type BriefRequest, type BriefRun, type BriefScope, type BriefSource } from '../intelligence'
import './intelligence.css'

type Props = {
  kind?: BriefKind; runId?: string
  onLocation: (kind: BriefKind, id?: string) => void
  onResearch: (id: string, prompt?: string) => void
  onSettings: () => void
}
const pendingKey = (kind: BriefKind) => `intelligence.pending.${kind}`
function pendingRequest(kind: BriefKind): BriefRequest | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey(kind)) || 'null') as BriefRequest | null
    return value && value.kind === kind && typeof value.request_id === 'string' && value.scope && Array.isArray(value.scope.markets) ? value : null
  } catch { return null }
}
const sourceDate = (citation: BriefCitation) => citation.published_at ? citation.publication_precision === 'date' ? citation.published_at : briefTime(citation.published_at) : '发布日期未核实'
const changes = { new: '新增', updated: '有变化', unchanged: '延续' }

function SourceReader({ runId, citation, onClose }: { runId: string; citation: BriefCitation; onClose: () => void }) {
  const [source, setSource] = useState<BriefSource | null>(null)
  const [error, setError] = useState(''), [retry, setRetry] = useState(0), [full, setFull] = useState(false)
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; close.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setSource(null); setError(''); setFull(false)
    api<BriefSource>(`/intelligence/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(citation.source_id)}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setSource(value) })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
    return () => controller.abort()
  }, [runId, citation.source_id, retry])
  const begin = full ? 0 : Math.max(0, citation.quote_start - 160)
  const end = source ? full ? source.text.length : Math.min(source.text.length, citation.quote_end + 900) : 0
  return <div className="workspace-modal-backdrop intelligence-source-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
    <section className="intelligence-source-reader workspace-dialog" role="dialog" aria-modal="true" aria-label="简报原文证据" onKeyDown={event => { if (event.key === 'Escape') onClose(); trapDialogTab(event) }}>
      <header><div><span className="intelligence-eyebrow">本版本保存的原文</span><h2>{citation.title}</h2></div><button ref={close} className="icon-button workspace-button" aria-label="关闭原文证据" onClick={onClose}><X size={20} /></button></header>
      <div className="intelligence-source-meta"><span>发布：{sourceDate(citation)}</span><span>读取：{briefTime(citation.retrieved_at)}</span><a href={citation.url} target="_blank" rel="noreferrer">{citation.source_type === 'market_data' ? '查看行情快照' : '打开来源网站'}<ExternalLink size={14} /></a></div>
      <p className="intelligence-caption">高亮部分已与保存原文核对；引用定位不代表分析结论已获独立证实。</p>
      {error ? <div role="alert" className="workspace-error"><p>{error}</p><button className="secondary-button workspace-button" onClick={() => setRetry(value => value + 1)}>重新读取</button></div>
        : !source ? <LoadingState label="正在读取证据快照…" /> : <>
          <div className="intelligence-source-text">{begin > 0 && <span>…</span>}{source.text.slice(begin, citation.quote_start)}<mark>{source.text.slice(citation.quote_start, citation.quote_end)}</mark>{source.text.slice(citation.quote_end, end)}{end < source.text.length && <span>…</span>}</div>
          <button className="text-button workspace-button" onClick={() => setFull(value => !value)}>{full ? '只看引用上下文' : '展开全部保存原文'}</button>
          <details className="intelligence-source-hash"><summary>快照校验信息</summary><p>SHA-256：{source.sha256}</p></details>
        </>}
    </section>
  </div>
}

function ResultItem({ item, index, hasPrevious, onEvidence, onResearch }: { item: BriefItem; index: number; hasPrevious: boolean; onEvidence: (value: BriefCitation) => void; onResearch?: () => void }) {
  const [expanded, setExpanded] = useState(false)
  return <article className="intelligence-event" id={'brief-item-' + item.event_key}>
    <div className="intelligence-event-number">{String(index + 1).padStart(2, '0')}</div>
    <div className="intelligence-event-body">
      <div className="intelligence-event-heading"><h3>{item.title}</h3>{hasPrevious && <span className={`intelligence-change is-${item.change}`}>{changes[item.change]}</span>}</div>
      <div className="intelligence-event-meta"><span>{item.event_date}</span><EvidenceDimension dimension={item.analysis_dimension} />{item.policy_stage && <span>{item.policy_stage}</span>}{item.industry_dimension && <span>{item.industry_dimension}</span>}{item.verification === 'time_pending' && <span className="intelligence-pending">来源时间待核验</span>}</div>
      <p className="intelligence-facts">{item.facts}</p>
      <div className="intelligence-analysis"><span>影响分析</span><p>{item.analysis}</p></div>
      {item.affected.length > 0 && <div className="intelligence-affected">{item.affected.map(value => <span key={value}>{value}</span>)}</div>}
      <div className="intelligence-citations" aria-label={`${item.title}的证据`}>{item.evidence.map((citation, i) => <button key={`${citation.source_id}-${i}`} className="workspace-button" onClick={() => onEvidence(citation)}><BookOpen size={14} /><span>{citation.title}</span><small>{sourceDate(citation)}</small></button>)}</div>
      <div className="intelligence-event-actions"><button className="text-button workspace-button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ChevronDown size={14} />{expanded ? '收起核验事项' : '排序依据与核验事项'}</button>{onResearch && <button className="text-button workspace-button" onClick={onResearch}>就此研究<ArrowRight size={14} /></button>}</div>
      {expanded && <div className="intelligence-event-checks"><p><strong>排序依据：</strong>{item.ranking_reason}</p><p><strong>接下来验证：</strong>{item.next_check}</p>{item.uncertainties.length > 0 && <ul>{item.uncertainties.map(value => <li key={value}>{value}</li>)}</ul>}</div>}
    </div>
  </article>
}

export default function IntelligencePage({ kind = 'market', runId, onLocation, onResearch, onSettings }: Props) {
  const session = useWorkspaceSession()
  const scopeFormId = useId()
  const kindTabs = useRef<HTMLElement>(null)
  useEffect(() => {
    const nav = kindTabs.current
    if (!nav) return
    const reveal = () => { const current = nav.querySelector<HTMLElement>('[aria-current="page"]'); if (current) nav.scrollLeft = current.offsetLeft - nav.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2 }
    reveal()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reveal) : null
    observer?.observe(nav)
    return () => observer?.disconnect()
  }, [kind, session.active])
  const [catalog, setCatalog] = useState<BriefCatalog | null>(null)
  const [catalogError, setCatalogError] = useState(''), [reload, setReload] = useState(0)
  const [selected, setSelected] = useState<string | undefined>(runId)
  const [detail, setDetail] = useState<BriefDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [scope, setScope] = useState<BriefScope>(defaultBriefScope)
  const [sidePanel, setSidePanel] = useState<'scope' | 'history' | null>(null), [scopeDirty, setScopeDirty] = useState(false)
  const [industries, setIndustries] = useState(''), [cutoff, setCutoff] = useState('')
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState('')
  const [pending, setPending] = useState<BriefRequest | null>(() => pendingRequest(kind))
  const [citation, setCitation] = useState<BriefCitation | null>(null)
  const [query, setQuery] = useState(''), [onlyChanges, setOnlyChanges] = useState(false)
  const [moreBusy, setMoreBusy] = useState(false)
  const sending = useRef(false), selectedRef = useRef(selected), scopeDirtyRef = useRef(false)
  const locationRef = useRef(onLocation); locationRef.current = onLocation
  const generation = useRef(0)
  const name = briefKinds.find(item => item.id === kind)!.name
  const advisor = isAdvisorKind(kind), noun = taskNoun(kind)
  useEffect(() => { session.setTitle?.(name) }, [name, session.setTitle])
  selectedRef.current = selected
  scopeDirtyRef.current = scopeDirty
  useEffect(() => { if (runId !== undefined) setSelected(runId) }, [runId])
  useEffect(() => { if (!session.active) setCitation(null) }, [session.active])
  useEffect(() => () => { generation.current += 1 }, [])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function load() {
      try {
        const data = await api<BriefCatalog>(`/intelligence?kind=${kind}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        setCatalog(data); setCatalogError('')
        if (!scopeDirtyRef.current) { setScope(data.default_scope); setIndustries(data.default_scope.industries.join('、')) }
        if (!selectedRef.current) {
          const id = data.latest_result_id || data.items[0]?.id
          if (id) { selectedRef.current = id; setSelected(id); locationRef.current(kind, id) }
          else if (!pendingRequest(kind)) setSidePanel('scope')
        }
        const savedPending = pendingRequest(kind)
        const recovered = savedPending && data.items.find(item => item.request_id === savedPending.request_id)
        if (recovered) { try { sessionStorage.removeItem(pendingKey(kind)) } catch { /* Memory state still recovers. */ } setPending(null); setSelected(recovered.id); locationRef.current(kind, recovered.id) }
        if (data.items.some(item => briefActive(item.state))) timer = setTimeout(() => void load(), 12000)
      } catch (reason) { if (!controller.signal.aborted) setCatalogError((reason as Error).message) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [kind, reload])

  useEffect(() => {
    if (!selected) { setDetail(null); return }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setDetail(previous => previous?.id === selected ? previous : null); setDetailError(''); setCitation(null)
    async function load() {
      try {
        const data = await api<BriefDetail>(`/intelligence/runs/${encodeURIComponent(selected!)}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        if (data.kind !== kind) { locationRef.current(data.kind, data.id); return }
        setDetail(data); setDetailError('')
        setCatalog(current => current ? { ...current, items: current.items.map(item => item.id === data.id ? data : item) } : current)
        if (briefActive(data.state)) timer = setTimeout(() => void load(), session.active ? 2500 : 12000)
      } catch (reason) {
        if (!controller.signal.aborted) { setDetailError((reason as Error).message); timer = setTimeout(() => void load(), 10000) }
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [selected, kind, reload, session.active])

  function changeAdvisor(values: Partial<AdvisorScope>) { changeScope({ markets: ['CN'], advisor: { ...(scope.advisor || defaultAdvisorScope), ...values } }) }
  function openEvidenceItem(key: string) { setQuery(''); setOnlyChanges(false); requestAnimationFrame(() => document.getElementById('brief-item-' + key)?.scrollIntoView({ block: 'center', behavior: 'smooth' })) }
  function changeScope(values: Partial<BriefScope>) { setScope(current => ({ ...current, ...values })); setScopeDirty(true) }
  function choose(run: BriefRun) {
    setSelected(run.id); setSidePanel(null); setQuery(''); setOnlyChanges(false)
    setScope(run.scope); setIndustries(run.scope.industries.join('、')); setScopeDirty(true)
    onLocation(run.kind, run.id)
  }
  function persistPending(value: BriefRequest | null) {
    setPending(value)
    try { if (value) sessionStorage.setItem(pendingKey(kind), JSON.stringify(value)); else sessionStorage.removeItem(pendingKey(kind)) } catch { /* In-memory retries keep their idempotency key. */ }
  }
  async function submit(retryRun?: BriefDetail) {
    if (sending.current) return
    const inputScope = retryRun?.scope || { ...scope, industries: industries.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean) }
    if (!pending && isStockKind(kind) && !inputScope.advisor?.stock_code) { setActionError('请先从股票目录选择要研究的股票。'); setSidePanel('scope'); return }
    if (!pending && inputScope.advisor?.holding_cost != null && (!Number.isFinite(inputScope.advisor.holding_cost) || inputScope.advisor.holding_cost <= 0)) { setActionError('请填写有效的持仓成本，或留空。'); return }
    if (!pending && (!inputScope.markets.length || inputScope.industries.length > 8 || inputScope.industries.some(value => value.length > 40))) {
      setActionError('至少选择一个市场，行业最多8项，每项不超过40字。'); setSidePanel('scope'); return
    }
    // datetime-local is explicitly interpreted in Shanghai, independent of the device timezone.
    const parsedCutoff = cutoff ? new Date(cutoff + ':00+08:00') : null
    if (!pending && !retryRun && parsedCutoff && (!Number.isFinite(parsedCutoff.valueOf()) || parsedCutoff > new Date())) {
      setActionError('请选择有效且不晚于当前时间的截止时间。'); return
    }
    const request: BriefRequest = pending || { request_id: crypto.randomUUID(), kind, scope: inputScope,
      cutoff_at: retryRun?.cutoff_at || parsedCutoff?.toISOString() || null, ...(retryRun ? { retry_of: retryRun.id } : {}) }
    persistPending(request); sending.current = true; setBusy(true); setActionError('')
    const attempt = generation.current
    try {
      const data = await api<BriefDetail>('/intelligence/runs', { method: 'POST', body: JSON.stringify(request) })
      if (generation.current !== attempt) return
      persistPending(null); setDetail(data); setSelected(data.id); setSidePanel(null)
      onLocation(kind, data.id); setReload(value => value + 1)
    } catch (reason) {
      if (generation.current !== attempt) return
      if (reason instanceof ApiRequestError && [400, 403, 409, 422].includes(reason.status)) persistPending(null)
      setActionError((reason as Error).message)
    } finally { sending.current = false; if (generation.current === attempt) setBusy(false) }
  }
  async function act(action: 'resume' | 'cancel') {
    if (!detail || sending.current) return
    sending.current = true; setBusy(true); setActionError('')
    try {
      const data = await api<BriefDetail>(`/intelligence/runs/${detail.id}/${action}`, { method: 'POST', body: '{}' })
      setDetail(data); setReload(value => value + 1)
    } catch (reason) { setActionError((reason as Error).message) }
    finally { sending.current = false; setBusy(false) }
  }
  async function moreHistory() {
    if (!catalog || catalog.next_offset == null || moreBusy) return
    setMoreBusy(true)
    try {
      const next = await api<BriefCatalog>(`/intelligence?kind=${kind}&offset=${catalog.next_offset}`)
      setCatalog(current => current ? { ...next, items: [...current.items, ...next.items.filter(item => !current.items.some(old => old.id === item.id))], legacy: [...current.legacy, ...next.legacy.filter(item => !current.legacy.some(old => old.conversation_id === item.conversation_id))] } : next)
    } catch (reason) { setCatalogError((reason as Error).message) }
    finally { setMoreBusy(false) }
  }
  const result = detail?.result
  const visibleItems = result?.items.filter(item => (!onlyChanges || item.change !== 'unchanged') &&
    (!query.trim() || `${item.title} ${item.facts} ${item.affected.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))) || []
  const active = detail && briefActive(detail.state)
  const ongoing = catalog?.items.find(item => briefActive(item.state))
  const nextScopeChanged = detail && scopeDirty && JSON.stringify({ ...scope, advisor: scope.advisor || null }) !== JSON.stringify({ ...detail.scope, advisor: detail.scope.advisor || null })
  return <div className="page-content intelligence-page workspace-tool-page">
    <header className="intelligence-heading"><div><span className="intelligence-eyebrow">情报台</span><h1>{name}</h1><p>{briefKinds.find(item => item.id === kind)!.description}</p></div>
      <div className="intelligence-heading-actions"><button className="secondary-button workspace-button" onClick={() => { setCitation(null); setSidePanel('scope') }} aria-haspopup="dialog" aria-expanded={sidePanel === 'scope'}><Settings2 size={15} />{advisor ? '任务设置' : '范围设置'}</button><button className="secondary-button workspace-button" onClick={() => { setCitation(null); setSidePanel('history') }} aria-haspopup="dialog" aria-expanded={sidePanel === 'history'}><History size={15} />历史版本</button><button className="primary-button workspace-button" disabled={busy || !!pending || !catalog || !!active || !!ongoing} onClick={() => void submit()}><RefreshCw size={15} className={busy ? 'spin' : ''} />{busy ? '正在提交…' : active || ongoing ? '正在执行' : result ? '更新' + noun : '生成' + noun}</button></div>
    </header>
    <nav ref={kindTabs} className="intelligence-kind-tabs" aria-label="情报类型">{briefKinds.map(item => <button key={item.id} className="workspace-button" aria-current={kind === item.id ? 'page' : undefined} onClick={() => { if (kind !== item.id) onLocation(item.id) }}>{item.name}</button>)}</nav>
    {(nextScopeChanged || cutoff || !detail || pending) && <div className="intelligence-scope-summary"><span><Settings2 size={14} />下次生成：{briefScopeLabel(scope)}</span><span>{cutoff ? `截止 ${cutoff.replace('T', ' ')}（北京时间）` : '截止提交时刻'} · 最多 {scope.max_items} 项</span></div>}
    {ongoing && ongoing.id !== selected && <div className="intelligence-notice"><span>另有一份{briefKinds.find(item => item.id === kind)!.name}正在执行。</span><button className="secondary-button workspace-button" onClick={() => choose(ongoing)}>查看执行进展</button></div>}
    {sidePanel !== 'scope' && <>
    {pending && !busy && <div className="intelligence-notice" role="status"><span>上次提交尚未确认。继续提交会复用同一请求，不会重复创建任务。</span><button className="secondary-button workspace-button" onClick={() => void submit()}>继续提交</button></div>}
    {actionError && <div role="alert" className="workspace-error intelligence-notice"><span>{actionError}</span><button className="text-button workspace-button" onClick={() => { setSidePanel(null); onSettings() }}>数据与服务</button></div>}
    </>}
    {catalogError && sidePanel !== 'history' && <div role="alert" className="workspace-error intelligence-notice"><span>历史记录读取失败：{catalogError}</span><button className="text-button workspace-button" onClick={() => setReload(value => value + 1)}>重新读取</button></div>}
    {detailError && <div role="alert" className="workspace-error intelligence-notice"><span>结果读取失败：{detailError}</span><button className="text-button workspace-button" onClick={() => setReload(value => value + 1)}>重新读取</button></div>}
    {!catalog && !catalogError && <LoadingState label="正在打开情报台…" skeleton />}
    {selected && !detail && !detailError && <LoadingState label="正在读取成果与执行记录…" skeleton />}
    {detail && <section className="intelligence-run" aria-label="当前情报成果">
      <div className="intelligence-run-meta"><span className={`intelligence-state is-${detail.state}`}>{result ? <Check size={14} /> : <Clock3 size={14} />}{briefStates[detail.state] || detail.state}</span><span>V{detail.version}</span><span>截止 {briefTime(detail.cutoff_at)}（北京时间）</span><span>{briefScopeLabel(detail.scope)}</span></div>
      {!result && <section className="intelligence-progress" aria-label="实际执行进展">
        <div className="intelligence-section-heading"><div><h2>{active ? '正在形成' + noun : briefStates[detail.state]}</h2><p>{active ? '可以离开页面。执行记录和已读取来源会保留。' : detail.error || '已读取的来源与本次范围仍保留。'}</p></div>{active && <button className="secondary-button workspace-button" disabled={busy} onClick={() => void act('cancel')}><Square size={13} />停止</button>}</div>
        <div className="intelligence-progress-counts"><span>已完成网页检索或访问 <strong>{detail.search_count}</strong></span><span>{advisor ? '已固定证据材料' : '已保存原文'} <strong>{detail.source_count}</strong></span></div>
        <ol>{detail.activity.slice(-8).map(event => <li key={event.id}><time>{briefTime(event.created_at)}</time><span>{event.message}</span></li>)}</ol>
        {detail.state === 'blocked' && <button className="primary-button workspace-button" disabled={busy} onClick={() => void act('resume')}>恢复执行</button>}
        {['failed', 'cancelled'].includes(detail.state) && <button className="primary-button workspace-button" disabled={busy || !!pending} onClick={() => void submit(detail)}>按原范围重试</button>}
        {detail.source_count > 0 && <details><summary>本次已读取来源</summary>{detail.sources.map(source => <a key={source.id} href={source.url} target="_blank" rel="noreferrer">{source.title}<ExternalLink size={12} /></a>)}</details>}
      </section>}
      {result && <>
        <div className="intelligence-result-heading"><div><h2>{result.title}</h2><p>{result.summary}</p></div><a className="secondary-button workspace-button" href={`/api/v1/intelligence/runs/${detail.id}/export`} download><Download size={15} />{advisor ? '导出稿件' : '导出简报'}</a></div>
        {advisor && <AdvisorResult key={detail.id} run={detail} onItem={openEvidenceItem} />}
        {advisor && detail.validation_result && (detail.validation_result.errors.length > 0 || detail.validation_result.warnings.length > 0 || detail.validation_result.suggestions.length > 0) && (
          <ValidationResult validation={detail.validation_result} />
        )}
        <div className="intelligence-result-toolbar"><span>{result.items.length} {advisor ? '个证据主题' : '项事件'} · {detail.source_count} {advisor ? '份证据材料' : '份原文'}</span>{detail.previous_id && <><label><input type="checkbox" checked={onlyChanges} onChange={event => setOnlyChanges(event.target.checked)} />只看新增和变化</label><button className="text-button workspace-button" onClick={() => { setSelected(detail.previous_id!); onLocation(kind, detail.previous_id!) }}>查看上期</button></>}<label className="intelligence-result-search"><Search size={15} /><input aria-label="搜索简报事件" placeholder="搜索事件或关联对象" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
        {result.items.length === 0 ? <div className="intelligence-no-updates"><Check size={20} /><h3>{result.outcome === 'evidence_gap' ? '本次未能取得可核验证据' : advisor ? '本次未形成可引用的证据主题' : '本次未发现可靠的实质更新'}</h3><p>{result.no_updates_reason}</p>{result.outcome === 'evidence_gap' && <button className="secondary-button workspace-button" disabled={busy || !!pending || !!ongoing} onClick={() => void submit(detail)}>按原范围重试</button>}</div>
          : visibleItems.length === 0 ? <p className="intelligence-caption">当前筛选下没有事件。<button className="text-button workspace-button" onClick={() => { setQuery(''); setOnlyChanges(false) }}>查看全部</button></p>
            : visibleItems.map(item => <ResultItem key={item.event_key} item={item} index={result.items.indexOf(item)} hasPrevious={!!detail.previous_id} onEvidence={setCitation} onResearch={detail.conversation_id ? () => onResearch(detail.conversation_id!, `请基于本版简报中“${item.title}”的原文证据继续研究，重点核对：${item.next_check}`) : undefined} />)}
        {result.not_in_current.length > 0 && <details className="intelligence-omitted"><summary>上期有 {result.not_in_current.length} 项本期未列入</summary><p className="intelligence-caption">{result.comparison}</p><ul>{result.not_in_current.map(item => <li key={item.event_key}>{item.title}</li>)}</ul></details>}
        <section className="intelligence-coverage"><h3>资料覆盖与核验说明</h3><p>{result.coverage}</p>{result.limitations.length > 0 && <ul>{result.limitations.map(value => <li key={value}>{value}</li>)}</ul>}<p className="intelligence-caption">{result.verification_note}</p>{result.items.some(item => item.verification === 'time_pending') && <p className="intelligence-caption">部分来源只有日期或缺少明确发布时间，无法据此确认精确到时刻的可得性，已逐项标出。</p>}
          <details><summary>本次执行记录</summary><ol className="intelligence-completed-activity">{detail.activity.map(event => <li key={event.id}><time>{briefTime(event.created_at)}</time> {event.message}</li>)}</ol></details>
        </section>
      </>}
    </section>}
    {catalog && !selected && <section className="intelligence-intro"><div><FileSearch size={27} /><h2>{advisor ? '从工作场景开始，形成有依据的投顾稿件' : '从确认范围开始，交付一份有证据的简报'}</h2><p>{advisor ? '固定股票或复盘日期，核对真实资料，形成研判、行动条件与可复制的沟通稿。每个版本保留原文与输入。' : '每项事件包含事实、影响分析、排序依据和原文摘录。每次运行固定截止时间，形成可回看的独立版本。'}</p></div><ol><li><span>01</span>选择市场与时间范围</li><li><span>02</span>查找来源并核对原文</li><li><span>03</span>查看成果、证据与版本变化</li></ol></section>}
    {sidePanel && session.active && <ConditionWorkspaceDrawer title={sidePanel === 'history' ? '历史版本' : advisor ? '任务设置' : '范围设置'} description={sidePanel === 'history' ? `${name} · 查看已保存的成果与原文` : `${name} · 下次生成使用的范围，提交后固定保存`} closeLabel={sidePanel === 'history' ? '关闭历史版本' : '关闭范围设置'} className="intelligence-settings-drawer" onClose={() => setSidePanel(null)} footer={sidePanel === 'scope' ? <><p>范围在提交时固定，可靠资料不足时按实际数量交付。</p><div><button type="button" className="secondary-button workspace-button" onClick={() => setSidePanel(null)}>返回成果</button><button type="submit" form={scopeFormId} className="primary-button workspace-button" disabled={busy || !!pending || !catalog || !!active || !!ongoing}>{advisor ? '按此设置生成' : '按此范围生成'}<ArrowRight size={15} /></button></div></> : undefined}>
      {sidePanel === 'scope' ? <>
    <form id={scopeFormId} className="intelligence-scope-form" aria-label="情报范围设置" onSubmit={event => { event.preventDefault(); void submit() }}>
      {advisor && <AdvisorSettings kind={kind} scope={scope} disabled={busy || !!pending} onChange={changeAdvisor} />}
      {!advisor && <fieldset disabled={busy || !!pending}><legend>市场范围</legend><div className="intelligence-market-options">{Object.entries(briefMarkets).map(([value, label]) => <label key={value}><input type="checkbox" checked={scope.markets.includes(value as keyof typeof briefMarkets)} onChange={event => changeScope({ markets: event.target.checked ? [...scope.markets, value as keyof typeof briefMarkets] : scope.markets.filter(item => item !== value) })} />{label}</label>)}</div></fieldset>}
      <div className="intelligence-form-grid">
        <label className="workspace-field-label">{advisor ? '近期资讯窗口' : '时间窗口'}<select className="workspace-field" value={scope.lookback_hours} disabled={busy || !!pending} onChange={event => changeScope({ lookback_hours: Number(event.target.value) as BriefScope['lookback_hours'] })}><option value={24}>近24小时</option><option value={72}>近3天</option><option value={168}>近7天</option></select></label>
        {!advisor && <label className="workspace-field-label">关注行业<input className="workspace-field" value={industries} maxLength={328} placeholder="不限；多个行业用顿号分隔" disabled={busy || !!pending} onChange={event => { setIndustries(event.target.value); changeScope({ industries: event.target.value.split(/[,，、\n]/).map(value => value.trim()).filter(Boolean) }) }} /></label>}
        <label className="workspace-field-label">来源偏好<select className="workspace-field" value={scope.source_preference} disabled={busy || !!pending} onChange={event => changeScope({ source_preference: event.target.value as BriefScope['source_preference'] })}><option value="primary">优先原始披露与官方来源</option><option value="broad">结合可信报道交叉核对</option></select></label>
        <label className="workspace-field-label">{advisor ? '证据主题上限' : '条目上限'}<select className="workspace-field" value={scope.max_items} disabled={busy || !!pending} onChange={event => changeScope({ max_items: Number(event.target.value) as BriefScope['max_items'] })}><option value={5}>5项</option><option value={10}>10项</option><option value={15}>15项</option></select></label>
      </div>
      <label className="workspace-field-label">{advisor ? '补充研究要求（可选）' : '关注要求（可选）'}<textarea className="workspace-field" rows={2} maxLength={600} value={scope.focus} disabled={busy || !!pending} placeholder="例如：重点看与观察公司相关的订单和政策变化" onChange={event => changeScope({ focus: event.target.value })} /></label>
      <details><summary>指定历史截止时间</summary><label className="workspace-field-label">北京时间；留空使用提交时刻<input type="datetime-local" className="workspace-field" value={cutoff} disabled={busy || !!pending} onChange={event => setCutoff(event.target.value)} /></label></details>

    </form>
    {pending && !busy && <div className="intelligence-notice" role="status"><span>上次提交尚未确认。继续提交会复用同一请求，不会重复创建任务。</span><button className="secondary-button workspace-button" onClick={() => void submit()}>继续提交</button></div>}
    {actionError && <div role="alert" className="workspace-error intelligence-notice"><span>{actionError}</span><button className="text-button workspace-button" onClick={() => { setSidePanel(null); onSettings() }}>数据与服务</button></div>}
      </> : <>
        {catalogError && <div role="alert" className="workspace-error intelligence-notice"><span>历史记录读取失败：{catalogError}</span><button className="text-button workspace-button" onClick={() => setReload(value => value + 1)}>重新读取</button></div>}
        {catalog ? <>
    <section className="intelligence-history" aria-label="情报历史版本"><p className="intelligence-history-count">{catalog.total} 次执行</p><p className="intelligence-caption">版本号按相同范围累计；切换历史只读取已保存的成果和证据。</p>
      {catalog.items.map(run => <button key={run.id} aria-current={selected === run.id ? 'true' : undefined} className={`intelligence-history-row workspace-button${selected === run.id ? ' active' : ''}`} onClick={() => choose(run)}><span><strong>{run.title}</strong><small>{briefScopeLabel(run.scope)}</small></span><span>V{run.version}<small>{briefTime(run.cutoff_at)}</small></span><span>{briefStates[run.state] || run.state}<small>{run.item_count == null ? '尚无成果' : `${run.item_count}项事件`}</small></span></button>)}
      {catalog.next_offset != null && <button className="secondary-button workspace-button" disabled={moreBusy} onClick={() => void moreHistory()}>更早的版本</button>}
      {catalog.legacy.length > 0 && <details className="intelligence-legacy"><summary>升级前的研究记录</summary><p className="intelligence-caption">原对话保留，未自动转换为已核验的结构化成果。</p>{catalog.legacy.map(run => <button key={run.conversation_id} className="text-button workspace-button" onClick={() => { setSidePanel(null); onResearch(run.conversation_id) }}>{run.title || name}<small>{briefTime(run.started_at)}</small><ArrowRight size={14} /></button>)}</details>}
      {!catalog.items.length && !catalog.legacy.length && <p className="intelligence-caption">生成第一份成果后，历史记录会保存在这里。</p>}
    </section>
        </> : !catalogError && <LoadingState compact label="正在读取历史版本…" />}
      </>}
    </ConditionWorkspaceDrawer>}
    {detail && citation && <SourceReader runId={detail.id} citation={citation} onClose={() => setCitation(null)} />}
  </div>
}
