import { StockText } from '../components/StockMentions'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, CheckCircle2, ClipboardList, Download, Loader2, RefreshCw, Search, Telescope } from 'lucide-react'
import { api, type DataStatus, type ScreeningTaskRevision } from '../api'
import { StockName } from '../components/StockSearch'
import { TaskLogic } from '../components/conversation/TaskBrief'
import ObservationChart from '../components/ObservationChart'
import ResearchCandidatePanel from './ResearchCandidatePanel'
import { navigateTabs } from '../keyboard'
import { isText, useSessionState } from '../useSessionState'
import '../observation.css'

type Counts = { target_total?: number; true_count?: number; false_count?: number; unknown_count?: number }
type Batch = { id: string; name: string; version: number; signal_date: string; as_of: string; created_at: string; status: string; counts: Counts }
type Run = Batch & { historical_replay?: boolean; conversation_id: string; task: ScreeningTaskRevision; result: { coverage?: Counts }; job_id: string; job: { progress: number; message: string }; reference_prices: Record<string, { trade_date: string; close: number | null }> }
type Stat = { count: number; average: number | null; median: number | null; positive_rate: number | null }
export type ObservationItem = {
  stock_code: string; name: string; status: string; note: string; updated_at: string | null
  reference_close: number | null; reference_date: string | null; calculation_base: number | null
  latest_close: number | null; latest_date: string | null; days: number; observed_days: number
  return_latest: number | null; returns: Record<string, number | null>; peak_return: number | null; trough_return: number | null; reason: string; invalid_bars: number
}
type Performance = { items: ObservationItem[]; latest_date: string | null; warning: string; summary: { selected: number; latest: Stat; '5': Stat; '10': Stat; '20': Stat } }
const stateLabels: Record<string, string> = { queued: '排队中', running: '执行中', succeeded: '已完成', partial: '部分数据不足', failed: '执行失败', cancelled: '已取消' }
const watchLabels: Record<string, string> = { watching: '观察中', priority: '重点关注', ended: '结束观察' }
const active = (status?: string) => status === 'queued' || status === 'running'
export const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
export const percent = (value: number | null | undefined) => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
const returnClass = (value: number | null | undefined) => value == null || value === 0 ? 'observation-neutral' : value > 0 ? 'observation-up' : 'observation-down'
const timestamp = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })

type Props = { data: DataStatus | null; onNavigateScreening?: () => void; onOpenResearch?: (conversationId: string) => void; onStartResearch?: () => void; initialRunId?: string; initialCandidateId?: string; initialTab?: 'candidates' | 'batches'; onLocationChange?: (tab: 'candidates' | 'batches', id: string, userNavigation?: boolean) => void }
export default function ObservationPage({ data, onNavigateScreening, onOpenResearch, onStartResearch, initialRunId, initialCandidateId, initialTab, onLocationChange }: Props) {
  const [runId, setRunId] = useSessionState('observation.run', '', isText)
  const [tab, setTab] = useState<'candidates' | 'batches'>(() => initialTab || (initialRunId || runId ? 'batches' : 'candidates'))
  const [batchView, setBatchView] = useState<'catalog' | 'reader'>('catalog')
  const [stockDetailView, setStockDetailView] = useState<'chart' | 'note'>('chart')
  const locationCallback = useRef(onLocationChange)
  locationCallback.current = onLocationChange
  useEffect(() => {
    if (initialRunId) { setRunId(initialRunId); setTab('batches') }
    else if (initialCandidateId) { setRunId(''); setTab('candidates') }
    else if (initialTab) { setTab(initialTab); if (initialTab === 'candidates') setRunId('') }
  }, [initialRunId, initialCandidateId, initialTab])
  function changeTab(next: 'candidates' | 'batches') { setTab(next); locationCallback.current?.(next, next === 'batches' ? runId : '', true) }
  const [batches, setBatches] = useState<Batch[]>([]), [historyQuery, setHistoryQuery] = useState('')
  const [historyOffset, setHistoryOffset] = useState(0), [historyTotal, setHistoryTotal] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [run, setRun] = useState<Run | null>(null), [performance, setPerformance] = useState<Performance | null>(null)
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0)
  const [selectedCode, setSelectedCode] = useSessionState('observation.code', '', isText)
  const [horizon, setHorizon] = useState<'latest' | '5' | '10' | '20'>('latest')
  const [sort, setSort] = useState('priority'), [watchStatus, setWatchStatus] = useState('')
  const [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [resultsLoading, setResultsLoading] = useState(false)
  const [error, setError] = useState(''), [resultError, setResultError] = useState('')
  const resultsRef = useRef<HTMLElement>(null), detailRef = useRef<HTMLElement>(null)
  function readStock(code: string) {
    setSelectedCode(code); setBatchView('reader'); setStockDetailView('chart')
    if (globalThis.matchMedia?.('(max-width: 1100px)').matches) {
      detailRef.current?.focus({ preventScroll: true })
      detailRef.current?.scrollIntoView({ behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })
    }
  }
  useEffect(() => {
    if (tab !== 'batches') return
    const controller = new AbortController()
    setHistoryLoading(true); setError('')
    const timer = setTimeout(() => {
      api<{ items: Batch[]; total: number }>(`/observation/runs?limit=50&offset=${historyOffset}&query=${encodeURIComponent(historyQuery)}`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) { setBatches(result.items); setHistoryTotal(result.total); setRunId(current => current || result.items[0]?.id || '') } })
        .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
        .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false) })
    }, 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [tab, refresh, historyQuery, historyOffset])
  useEffect(() => {
    if (tab !== 'batches' || !runId) { setRun(null); return }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    setRun(null); setSelectedCode(''); setPerformance(null); setOffset(0); setQuery(''); setResultError('')
    async function load() {
      try {
        const value = await api<Run>(`/observation/runs/${runId}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        setRun(value)
        locationCallback.current?.('batches', value.id, false)
        setBatches(items => items.map(item => item.id === value.id ? { ...item, status: value.status, counts: value.result.coverage ?? {} } : item))
        if (active(value.status)) timer = setTimeout(load, 1500)
      } catch (reason) { if (!controller.signal.aborted) setResultError((reason as Error).message) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [tab, runId, refresh])
  useEffect(() => {
    const controller = new AbortController()
    setPerformance(null); setResultsLoading(false)
    if (tab !== 'batches' || !run || run.id !== runId || active(run.status)) return
    setResultsLoading(true); setResultError('')
    const timer = setTimeout(() => {
      api<Performance>(`/observation/runs/${runId}/performance`, { signal: controller.signal }).then(value => {
        if (!controller.signal.aborted) { setPerformance(value); setSelectedCode(current => value.items.some(item => item.stock_code === current) ? current : '') }
      }).catch(reason => { if (!controller.signal.aborted) setResultError(reason.message) })
        .finally(() => { if (!controller.signal.aborted) setResultsLoading(false) })
    }, 180)
    return () => { clearTimeout(timer); controller.abort() }
  }, [tab, run?.id, run?.status, runId, refresh])
  async function cancel() {
    if (!run || busy) return
    setBusy(true)
    try { await api(`/jobs/${run.job_id}/cancel`, { method: 'POST' }); setRefresh(value => value + 1) }
    catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  const observed = useMemo(() => {
    const matching = (performance?.items ?? []).filter(item => (!watchStatus || item.status === watchStatus) && `${item.name} ${item.stock_code}`.toLowerCase().includes(query.toLowerCase().trim()))
    return matching.sort((a, b) => {
      if (sort === 'priority') return Number(b.status === 'priority') - Number(a.status === 'priority') || a.stock_code.localeCompare(b.stock_code)
      if (sort === 'return' || sort === 'return-asc') {
        const av = horizon === 'latest' ? a.return_latest : a.returns[horizon], bv = horizon === 'latest' ? b.return_latest : b.returns[horizon]
        if (av == null || bv == null) return av == null && bv == null ? a.stock_code.localeCompare(b.stock_code) : av == null ? 1 : -1
        return (sort === 'return-asc' ? av - bv : bv - av) || a.stock_code.localeCompare(b.stock_code)
      }
      return a.stock_code.localeCompare(b.stock_code)
    })
  }, [performance, query, watchStatus, sort, horizon])
  useEffect(() => {
    if (tab !== 'batches' || !performance) return
    const page = observed.slice(offset, offset + 30)
    if (offset > 0 && !page.length) { setOffset(0); return }
    setSelectedCode(current => page.some(item => item.stock_code === current) ? current : page[0]?.stock_code ?? '')
  }, [observed, offset, tab, performance])
  const selectedObservation = performance?.items.find(item => item.stock_code === selectedCode)
  const stat = performance?.summary[horizon], counts = run?.result.coverage

  return <StockText><div className="page-content observation-page observation-redesigned" data-batch-view={batchView}>
    <header className="page-heading observation-page-heading">
      <div><h1>观察池</h1></div>
      <div className="observation-heading-actions">{tab === 'candidates' && onStartResearch ? <button className="primary-button" onClick={onStartResearch}>开始研究<ArrowRight size={15} /></button> : onNavigateScreening && <button className="primary-button" onClick={onNavigateScreening}>去条件选股<ArrowRight size={15} /></button>}<button className="secondary-button" onClick={() => { setError(''); setRefresh(value => value + 1) }}><RefreshCw size={15} />刷新</button></div>
    </header>
    <div className="observation-source-nav">
      <div className="observation-tabs" role="tablist" aria-label="观察来源分类" onKeyDown={event => navigateTabs(event, ['candidates', 'batches'] as const, tab, changeTab)}>
        <button role="tab" aria-label="研究候选" tabIndex={tab === 'candidates' ? 0 : -1} id="candidates-tab" aria-controls="observation-panel" aria-selected={tab === 'candidates'} onClick={() => changeTab('candidates')}><Telescope size={17} /><span>研究候选</span></button>
        <button role="tab" aria-label="筛选批次" tabIndex={tab === 'batches' ? 0 : -1} id="batches-tab" aria-controls="observation-panel" aria-selected={tab === 'batches'} onClick={() => changeTab('batches')}><ClipboardList size={17} /><span>筛选批次</span></button>
      </div>
      <span className="observation-data-status"><span />{data?.last_date ? `行情截至 ${data.last_date}` : '未记录行情日期'}</span>
    </div>
    {error && <div className="library-error" role="alert">{error}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>重新加载</button></div>}
    <section id="observation-panel" role="tabpanel" aria-labelledby={`${tab}-tab`}>
      {tab === 'candidates' ? <ResearchCandidatePanel initialCandidateId={initialCandidateId} onLocationChange={(id, userNavigation) => locationCallback.current?.('candidates', id, userNavigation)} onStartResearch={onStartResearch} refresh={refresh} onOpenResearch={onOpenResearch} /> : <>
        <section className="observation-batch-controls" aria-label="批次记录导航" aria-busy={historyLoading}>
          <div className="observation-batch-fields">
            <label className="observation-batch-main">当前筛选批次<select aria-label="选择选股批次" value={runId} onChange={event => { setRunId(event.target.value); locationCallback.current?.('batches', event.target.value, true) }}><option value="">选择记录</option>{run && !batches.some(item => item.id === run.id) && <option value={run.id}>{run.signal_date} · {run.name}</option>}{batches.map(item => <option key={item.id} value={item.id}>{item.signal_date} · {item.name} · v{item.version} · {stateLabels[item.status]}{item.counts.true_count != null ? ` · ${item.counts.true_count}只` : ''}</option>)}</select></label>
            <label>查找历史<div className="observation-search"><Search size={16} /><input aria-label="查找历史" placeholder="搜索方案名称或条件" value={historyQuery} onChange={event => { setHistoryQuery(event.target.value); setHistoryOffset(0) }} /></div></label>
            {(historyTotal > 50 || historyOffset > 0) && <div className="observation-pagination"><span>{historyOffset + 1}–{Math.min(historyOffset + 50, historyTotal)} / {historyTotal}</span><button disabled={!historyOffset || historyLoading} onClick={() => setHistoryOffset(value => Math.max(0, value - 50))}>上一页批次</button><button disabled={historyOffset + 50 >= historyTotal || historyLoading} onClick={() => setHistoryOffset(value => value + 50)}>下一页批次</button></div>}
          </div>
          {!historyLoading && historyQuery && !batches.length && <p className="observation-muted">没有匹配的批次。<button className="text-button" onClick={() => { setHistoryQuery(''); setHistoryOffset(0) }}>清除搜索</button></p>}
        </section>
        {run && <section className="observation-run-header">
          <div className="observation-run-title"><div className="observation-run-name"><h2>{run.name}</h2><span className="observation-version">v{run.version}</span><span className={`observation-run-state ${run.status}`}>{!active(run.status) && run.status === 'succeeded' && <CheckCircle2 size={13} />}{stateLabels[run.status] ?? run.status}</span>{run.historical_replay && <span className="observation-version">历史补算</span>}</div><p>信号日期 <strong>{run.signal_date}</strong><span>·</span>实际执行 {timestamp(run.created_at)}</p></div>
          {!active(run.status) && <a className="secondary-button" href={`/api/v1/observation/runs/${run.id}/snapshot`}><Download size={14} />导出结果字典</a>}
          <div className="observation-coverage"><span>扫描范围 <strong>{counts?.target_total ?? '—'}</strong> 只</span><span>入选 <strong>{counts?.true_count ?? '—'}</strong></span><span>未入选 <strong>{counts?.false_count ?? '—'}</strong></span><span>数据不足 <strong>{counts?.unknown_count ?? '—'}</strong></span><details className="observation-rules"><summary>查看筛选条件</summary><TaskLogic task={run.task} /></details></div>
        </section>}
        {run && active(run.status) && <div className="observation-card observation-running" role="status"><Loader2 size={22} /><div><strong>{stateLabels[run.status]}</strong><p>{run.job.message || '正在评估筛选条件…'}</p><progress aria-label="本次选股进度" value={run.job.progress} max={1} /></div><button className="secondary-button" disabled={busy} onClick={() => void cancel()}>取消本次选股</button></div>}
        {performance && <section className="observation-performance" aria-label="批次表现概览">
          <div className="observation-summary-toolbar"><div><h2>批次表现</h2><span>行情截至 {performance.latest_date ?? data?.last_date ?? '暂无数据'}</span></div><label>统计周期<select aria-label="统计周期" value={horizon} onChange={event => setHorizon(event.target.value as typeof horizon)}><option value="latest">入选至最新</option><option value="5">入选后 5 个交易日</option><option value="10">入选后 10 个交易日</option><option value="20">入选后 20 个交易日</option></select></label></div>
          <div className="observation-stats"><StatCard label="本批次入选" value={`${performance.summary.selected} 只`} /><StatCard label="有效统计样本" value={`${stat?.count ?? 0} 只`} /><StatCard label="平均涨跌幅" value={percent(stat?.average)} tone={returnClass(stat?.average)} /><StatCard label="中位数涨跌幅" value={percent(stat?.median)} tone={returnClass(stat?.median)} /><StatCard label="上涨占比" value={stat?.positive_rate == null ? '—' : `${stat.positive_rate.toFixed(1)}%`} /></div>
          {performance.warning && <p className="observation-methodology">{performance.warning}</p>}
        </section>}
        {resultError && <div className="library-error" role="alert">{resultError}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>重新加载</button></div>}
        {run && !active(run.status) && !resultError && <nav className="workspace-pane-switch" aria-label="股票列表与详情切换"><button type="button" aria-pressed={batchView === 'catalog'} onClick={() => setBatchView('catalog')}>股票列表</button><button type="button" aria-pressed={batchView === 'reader'} disabled={!selectedCode} onClick={() => setBatchView('reader')}>股票详情</button></nav>}
        {!runId ? !error && <div className="observation-empty observation-start"><span className="observation-empty-icon"><ClipboardList size={26} /></span><strong>{historyLoading ? '正在查找筛选批次…' : '暂无筛选批次'}</strong>{onNavigateScreening && !historyLoading && <button className="secondary-button" onClick={onNavigateScreening}>创建筛选批次<ArrowRight size={14} /></button>}</div> : !run ? !resultError && <div className="observation-loading" role="status"><Loader2 size={18} />正在读取选股记录…</div> : !active(run.status) && !resultError && <div className="observation-workspace">
          <section ref={resultsRef} tabIndex={-1} aria-label="股票结果列表" className="observation-card observation-results" aria-busy={resultsLoading}>
            <div className="observation-list-heading"><div><h2>本批次观察<span>{performance?.items.length ?? '—'}</span></h2></div></div>
            <div className="observation-table-toolbar"><label className="observation-search"><Search size={16} /><input aria-label="搜索结果股票" placeholder="搜索股票名称或代码" value={query} onChange={event => { setQuery(event.target.value); setOffset(0) }} /></label><select aria-label="观察状态筛选" value={watchStatus} onChange={event => { setWatchStatus(event.target.value); setOffset(0) }}><option value="">全部观察状态</option>{Object.entries(watchLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select><select aria-label="观察排序" value={sort} onChange={event => { setSort(event.target.value); setOffset(0) }}><option value="priority">重点关注优先</option><option value="code">按股票代码</option><option value="return">涨跌幅从高到低</option><option value="return-asc">涨跌幅从低到高</option></select></div>
            {(query || watchStatus) && <div className="observation-filter-feedback"><span>匹配 {observed.length} / {performance?.items.length ?? 0} 只股票</span><button className="text-button" onClick={() => { setQuery(''); setWatchStatus(''); setOffset(0) }}>清除筛选</button></div>}
            {resultsLoading ? <div className="observation-loading" role="status"><Loader2 size={18} />正在加载观察统计…</div> : <><div className="observation-table-scroll"><table><thead><tr><th>股票 / 状态</th><th>最新价</th><th>{horizon === 'latest' ? '至今涨跌幅' : `${horizon}日涨跌幅`}</th><th>观察天数</th></tr></thead><tbody>{observed.slice(offset, offset + 30).map(item => <tr key={item.stock_code} className={selectedCode === item.stock_code ? 'selected' : ''} onClick={() => readStock(item.stock_code)}><td data-label="股票"><button className="stock-link" aria-pressed={selectedCode === item.stock_code} onClick={event => { event.stopPropagation(); readStock(item.stock_code) }}><StockName code={item.stock_code} embedded /></button><small className={`observation-status ${item.status}`}>{watchLabels[item.status] ?? item.status}{item.note && <span title={item.note}> · 已记备注</span>}</small></td><td data-label="最新价">{number(item.latest_close)}<small>{item.latest_date ?? '无行情'}</small></td><td data-label={horizon === 'latest' ? '至今涨跌幅' : `${horizon}日涨跌幅`} className={returnClass(horizon === 'latest' ? item.return_latest : item.returns[horizon])}>{percent(horizon === 'latest' ? item.return_latest : item.returns[horizon])}<small>{horizon !== 'latest' && item.days < Number(horizon) ? '未满期' : item.reason || ((horizon === 'latest' ? item.return_latest : item.returns[horizon]) == null ? '数据不足' : '')}</small></td><td data-label="观察天数">{item.days} 个交易日<small>有效行情 {item.observed_days} 日</small></td></tr>)}</tbody></table></div>{!observed.length && <div className="observation-empty"><Telescope size={25} /><strong>{performance?.items.length ? '没有匹配的股票' : '本批次暂无入选股票'}</strong>{(query || watchStatus) && <button className="secondary-button" onClick={() => { setQuery(''); setWatchStatus(''); setOffset(0) }}>显示全部股票</button>}</div>}<Pagination offset={offset} total={observed.length} onChange={setOffset} /></>}
          </section>
          <aside ref={detailRef} tabIndex={-1} aria-label="股票观察详情" className="observation-detail observation-stock-detail">
            {selectedCode && <button className="secondary-button observation-back" onClick={() => { setBatchView('catalog'); resultsRef.current?.focus({ preventScroll: true }); resultsRef.current?.scrollIntoView({ behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }) }}><ArrowLeft size={14} />返回股票列表</button>}
            {selectedCode && !resultsLoading ? <>
              <div className="observation-detail-switch" role="group" aria-label="个股详情视图"><button type="button" aria-pressed={stockDetailView === 'chart'} onClick={() => setStockDetailView('chart')}>走势与依据</button><button type="button" aria-pressed={stockDetailView === 'note'} onClick={() => setStockDetailView('note')}>观察备注</button></div>
              <div className="observation-detail-pane" hidden={stockDetailView !== 'chart'}><ObservationChart key={`chart:${runId}:${selectedCode}`} runId={runId} code={selectedCode} view="observation" task={run.task} refresh={refresh} /></div>
              <div className="observation-detail-pane" hidden={stockDetailView !== 'note'}>{selectedObservation && <ObservationNote key={`note:${runId}:${selectedCode}`} runId={runId} item={selectedObservation} onSaved={value => setPerformance(current => current ? { ...current, items: current.items.map(item => item.stock_code === selectedCode ? { ...item, ...value } : item) } : current)} />}</div>
            </> : <div className="observation-card observation-empty"><Telescope size={25} /><strong>未选择股票</strong></div>}
          </aside>
        </div>}
      </>}
    </section>
  </div></StockText>
}
function StatCard({ label, value, tone = '' }: { label: string; value: string; tone?: string }) { return <div className="observation-stat"><span>{label}</span><strong className={tone}>{value}</strong></div> }
function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (value: number) => void }) { return <div className="observation-pagination"><span>{total ? `${offset + 1}–${Math.min(offset + 30, total)} / ${total} 只` : '0 只'}</span><button disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - 30))}>上一页</button><button disabled={offset + 30 >= total} onClick={() => onChange(offset + 30)}>下一页</button></div> }
function ObservationNote({ runId, item, onSaved }: { runId: string; item: ObservationItem; onSaved: (value: { status: string; note: string; updated_at: string }) => void }) {
  type Draft = { note: string; status: string }
  const key = `${runId}:${item.stock_code}`
  const [drafts, setDrafts] = useSessionState<Record<string, Draft>>('observation.noteDrafts', {}, (value): value is Record<string, Draft> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item && typeof item.note === 'string' && Object.hasOwn(watchLabels, item.status)))
  const draft = drafts[key] || { note: item.note, status: item.status }
  const { note, status } = draft
  const setNote = (note: string) => setDrafts(current => ({ ...current, [key]: { ...draft, note } }))
  const setStatus = (status: string) => setDrafts(current => ({ ...current, [key]: { ...draft, status } }))
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function save() {
    setBusy(true); setMessage('')
    try { const result = await api<{ status: string; note: string; updated_at: string }>(`/observation/runs/${runId}/notes/${encodeURIComponent(item.stock_code)}`, { method: 'PUT', body: JSON.stringify({ status, note }) }); if (mounted.current) { setDrafts(current => { const next = { ...current }; delete next[key]; return next }); onSaved(result); setMessage('观察记录已保存') } }
    catch (reason) { if (mounted.current) setMessage((reason as Error).message) }
    finally { if (mounted.current) setBusy(false) }
  }
  const changed = note !== item.note || status !== item.status
  function resetDraft() { setDrafts(current => { const next = { ...current }; delete next[key]; return next }); setMessage('') }
  return <StockText><section className="observation-card observation-note">
    <div className="observation-section-heading"><div><h2>观察记录</h2><span className={`observation-status ${item.status}`}>{watchLabels[item.status]}</span></div><span>{changed ? '有未保存的修改' : ''}</span></div>
    <div className="observation-detail-metrics observation-stock-metrics"><span>入选参考价<strong>{number(item.reference_close)}</strong><small>{item.reference_date ?? '旧记录未保存参考价'}</small></span><span>期间最高涨幅<strong className={returnClass(item.peak_return)}>{percent(item.peak_return)}</strong></span><span>期间最低涨幅<strong className={returnClass(item.trough_return)}>{percent(item.trough_return)}</strong></span>{['5', '10', '20'].map(n => <span key={n}>{n} 日涨跌幅<strong className={item.days < Number(n) ? 'observation-neutral' : returnClass(item.returns[n])}>{item.days < Number(n) ? '未满期' : percent(item.returns[n])}</strong></span>)}</div>
    {item.invalid_bars > 0 && <p className="observation-disclosure">期间有 {item.invalid_bars} 根异常行情，区间最高／最低涨幅暂不可用。</p>}
    <label>观察状态<select aria-label="个股观察状态" value={status} disabled={busy} onChange={e => setStatus(e.target.value)}>{Object.entries(watchLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label>观察备注<textarea aria-label="观察备注" value={note} disabled={busy} maxLength={2000} rows={4} onChange={e => setNote(e.target.value)} /><span className="observation-field-hint">{note.length} / 2000</span></label>
    <div className="observation-save-footer">{item.updated_at && <div><small>更新于 {timestamp(item.updated_at)}</small></div>}<div>{changed && <button className="text-button" disabled={busy} onClick={resetDraft}>恢复已保存记录</button>}<button className="primary-button" disabled={busy || !changed} onClick={() => void save()}>{busy ? '保存中…' : '保存观察记录'}</button></div></div>
    {message && <p className="observation-save-message" role="status">{message}</p>}
  </section></StockText>
}
