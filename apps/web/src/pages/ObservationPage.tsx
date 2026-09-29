import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Play, RefreshCw, Search, Telescope } from 'lucide-react'
import { api, type DataStatus, type SavedScreeningTask, type ScreeningTaskDecision, type ScreeningTaskRevision } from '../api'
import { StockName } from '../components/StockSearch'
import { TaskLogic, taskUniverseLabel } from '../components/conversation/TaskBrief'
import ObservationChart from '../components/ObservationChart'
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
const timestamp = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })

export default function ObservationPage({ data }: { data: DataStatus | null }) {
  const [tab, setTab] = useState<'screening' | 'observation'>('screening')
  const [saved, setSaved] = useState<SavedScreeningTask[]>([])
  const [asset, setAsset] = useState('')
  const [assetQuery, setAssetQuery] = useState('')
  const [asOf, setAsOf] = useState(data?.last_date ?? '')
  const [scope, setScope] = useState('saved')
  const [batches, setBatches] = useState<Batch[]>([])
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyOffset, setHistoryOffset] = useState(0)
  const [historyTotal, setHistoryTotal] = useState(0)
  const [runId, setRunId] = useState('')
  const [run, setRun] = useState<Run | null>(null)
  const [decisions, setDecisions] = useState<ScreeningTaskDecision[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [state, setState] = useState('true')
  const [query, setQuery] = useState('')
  const [selectedCode, setSelectedCode] = useState('')
  const [performance, setPerformance] = useState<Performance | null>(null)
  const [horizon, setHorizon] = useState<'latest' | '5' | '10' | '20'>('latest')
  const [sort, setSort] = useState('code')
  const [watchStatus, setWatchStatus] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [resultsLoading, setResultsLoading] = useState(false)
  const [error, setError] = useState('')
  const [resultError, setResultError] = useState('')
  const [notice, setNotice] = useState('')
  const attempt = useRef<{ key: string; id: string } | null>(null)
  const submitLock = useRef(false)
  const chosen = saved.find(item => `${item.id}@${item.version}` === asset)

  useEffect(() => { if (!asOf && data?.last_date) setAsOf(data.last_date) }, [data?.last_date, asOf])
  useEffect(() => {
    const controller = new AbortController()
    setCatalogLoading(true)
    api<{ items: SavedScreeningTask[] }>('/saved-screening-tasks?include_history=true&limit=200', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setSaved(result.items); setAsset(current => current || (result.items[0] ? `${result.items[0].id}@${result.items[0].version}` : '')) } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
      .finally(() => { if (!controller.signal.aborted) setCatalogLoading(false) })
    return () => controller.abort()
  }, [refresh])
  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      api<{ items: Batch[]; total: number }>(`/observation/runs?limit=50&offset=${historyOffset}&query=${encodeURIComponent(historyQuery)}`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) { setBatches(result.items); setHistoryTotal(result.total); setRunId(current => current || result.items[0]?.id || '') } })
        .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    }, 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [refresh, historyQuery, historyOffset])
  useEffect(() => {
    if (!runId) { setRun(null); return }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    setRun(null); setSelectedCode(''); setDecisions([]); setPerformance(null); setOffset(0); setQuery(''); setResultError('')
    async function load() {
      try {
        const value = await api<Run>(`/observation/runs/${runId}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        setRun(value)
        setBatches(items => items.map(item => item.id === value.id ? { ...item, status: value.status, counts: value.result.coverage ?? {} } : item))
        if (active(value.status)) timer = setTimeout(load, 1500)
      } catch (reason) { if (!controller.signal.aborted) setResultError((reason as Error).message) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [runId, refresh])
  useEffect(() => {
    const controller = new AbortController()
    setDecisions([]); setPerformance(null); setResultsLoading(false)
    if (!run || run.id !== runId || active(run.status)) return
    setResultsLoading(true); setResultError('')
    const timer = setTimeout(() => {
      const path = tab === 'screening'
        ? `/observation/runs/${runId}/decisions?state=${state}&query=${encodeURIComponent(query)}&offset=${offset}&limit=30`
        : `/observation/runs/${runId}/performance`
      api<Performance | { items: ScreeningTaskDecision[]; total: number }>(path, { signal: controller.signal }).then(value => {
        if (controller.signal.aborted) return
        if ('summary' in value) { setPerformance(value); setSelectedCode(current => value.items.some(item => item.stock_code === current) ? current : value.items[0]?.stock_code ?? '') }
        else { setDecisions(value.items); setTotal(value.total); setSelectedCode(current => value.items.some(item => item.stock_code === current) ? current : value.items[0]?.stock_code ?? '') }
      }).catch(reason => { if (!controller.signal.aborted) setResultError(reason.message) })
        .finally(() => { if (!controller.signal.aborted) setResultsLoading(false) })
    }, 180)
    return () => { clearTimeout(timer); controller.abort() }
  }, [run?.id, run?.status, runId, tab, state, tab === 'screening' ? query : '', tab === 'screening' ? offset : 0, refresh])

  function switchTab(value: 'screening' | 'observation') { setTab(value); setOffset(0); setQuery(''); setResultError('') }
  async function execute() {
    if (!chosen || submitLock.current) return
    submitLock.current = true; setBusy(true); setError(''); setNotice('')
    const payload = { version: chosen.version, as_of: asOf, ...(scope === 'all' ? { universe: { kind: 'all_a_shares', stock_codes: [] } } : {}) }
    const key = `${chosen.id}:${JSON.stringify(payload)}`
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() }
    try {
      const result = await api<{ run_id: string }>(`/observation/saved-tasks/${chosen.id}/execute`, { method: 'POST', body: JSON.stringify({ ...payload, request_id: attempt.current.id }) })
      attempt.current = null; setRunId(result.run_id); setRefresh(value => value + 1)
      setNotice('选股已提交，本次条件和执行日期已保存。完成后可直接查看本批次观察。')
    } catch (reason) { setError((reason as Error).message) }
    finally { submitLock.current = false; setBusy(false) }
  }
  async function cancel() {
    if (!run) return
    setBusy(true)
    try { await api(`/jobs/${run.job_id}/cancel`, { method: 'POST' }); setRefresh(value => value + 1) }
    catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  const observed = useMemo(() => {
    const matching = (performance?.items ?? []).filter(item => (!watchStatus || item.status === watchStatus) && `${item.name} ${item.stock_code}`.toLowerCase().includes(query.toLowerCase().trim()))
    return matching.sort((a, b) => {
      if (sort === 'priority') return Number(b.status === 'priority') - Number(a.status === 'priority') || a.stock_code.localeCompare(b.stock_code)
      if (sort === 'return') { const av = horizon === 'latest' ? a.return_latest : a.returns[horizon], bv = horizon === 'latest' ? b.return_latest : b.returns[horizon]; return (bv ?? -Infinity) - (av ?? -Infinity) || a.stock_code.localeCompare(b.stock_code) }
      return a.stock_code.localeCompare(b.stock_code)
    })
  }, [performance, query, watchStatus, sort, horizon])
  useEffect(() => {
    if (tab !== 'observation' || !performance) return
    const page = observed.slice(offset, offset + 30)
    if (offset > 0 && !page.length) { setOffset(0); return }
    setSelectedCode(current => page.some(item => item.stock_code === current) ? current : page[0]?.stock_code ?? '')
  }, [observed, offset, tab, performance])
  const selectedObservation = performance?.items.find(item => item.stock_code === selectedCode)
  const stat = performance?.summary[horizon]
  const counts = run?.result.coverage
  const selectedTasks = saved.filter(item => `${item.name} ${item.task.conditions.map(c => c.description).join(' ')}`.toLowerCase().includes(assetQuery.toLowerCase().trim()) || `${item.id}@${item.version}` === asset)

  return <div className="page-content observation-page">
    <div className="page-heading"><div><p className="eyebrow">保存一次判断，持续观察后续表现</p><h1>观察池</h1></div><button className="secondary-button" onClick={() => { setError(''); setRefresh(value => value + 1) }}><RefreshCw size={15} />刷新</button></div>
    <div className="observation-tabs" role="tablist" aria-label="观察池页面"><button role="tab" id="screening-tab" aria-controls="observation-panel" aria-selected={tab === 'screening'} onClick={() => switchTab('screening')}>选股</button><button role="tab" id="observation-tab" aria-controls="observation-panel" aria-selected={tab === 'observation'} onClick={() => switchTab('observation')}>观察池</button></div>
    {error && <div className="library-error" role="alert">{error}</div>}{notice && <div className="inline-notice" role="status">{notice}</div>}
    <section id="observation-panel" role="tabpanel" aria-labelledby={`${tab}-tab`}>
      {tab === 'screening' ? <section className="observation-card selection-controls">
        <div className="observation-form"><label>查找方案<input placeholder="方案名称或条件" value={assetQuery} onChange={e => setAssetQuery(e.target.value)} /></label><label className="wide-field">已保存方案<select aria-label="已保存方案" value={asset} disabled={busy || catalogLoading} onChange={e => { setAsset(e.target.value); setScope('saved') }}><option value="">选择方案</option>{selectedTasks.map(item => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.name} · v{item.version}</option>)}</select></label><label>行情截止日<input aria-label="选股行情截止日" type="date" value={asOf} max={data?.last_date} disabled={busy} onInput={e => setAsOf(e.currentTarget.value)} onChange={e => setAsOf(e.target.value)} /></label><label>股票范围<select aria-label="选股股票范围" value={scope} disabled={busy} onChange={e => setScope(e.target.value)}><option value="saved">{chosen ? `沿用方案 · ${taskUniverseLabel(chosen.task)}` : '沿用方案范围'}</option><option value="all">全部 A 股</option></select></label><button className="primary-button" disabled={busy || !chosen || !asOf || !data?.available || !!(data?.last_date && asOf > data.last_date)} onClick={() => void execute()}><Play size={15} />{busy ? '提交中…' : '执行选股'}</button></div>
        <p className="observation-muted">行情截至 {data?.last_date ?? '尚未加载'}。每次执行自动保存独立批次；重新执行会保留旧结果。</p>
        {chosen && <details className="observation-rules"><summary>查看本次条件 · {chosen.task.conditions.length} 项 · v{chosen.version}</summary><TaskLogic task={chosen.task} /></details>}
        {!catalogLoading && !saved.length && <div className="observation-empty"><Telescope size={25} /><strong>还没有保存的选股方案</strong><p>在“帮我选股”中核对条件并保存方案，然后回到这里执行。</p></div>}
      </section> : <section className="observation-card history-controls"><div className="observation-form"><label>查找历史<input placeholder="方案名称或条件" value={historyQuery} onChange={e => { setHistoryQuery(e.target.value); setHistoryOffset(0) }} /></label><label className="wide-field">选择选股批次<select aria-label="选择选股批次" value={runId} onChange={e => setRunId(e.target.value)}><option value="">选择记录</option>{run && !batches.some(item => item.id === run.id) && <option value={run.id}>{run.signal_date} · {run.name}</option>}{batches.map(item => <option key={item.id} value={item.id}>{item.signal_date} · {item.name} · v{item.version} · {stateLabels[item.status]}{item.counts.true_count != null ? ` · ${item.counts.true_count}只` : ''} · 执行 {timestamp(item.created_at)}</option>)}</select></label></div><div className="observation-pagination"><span>共 {historyTotal} 次执行</span><button disabled={historyOffset === 0} onClick={() => setHistoryOffset(value => Math.max(0, value - 50))}>上一页批次</button><button disabled={historyOffset + 50 >= historyTotal} onClick={() => setHistoryOffset(value => value + 50)}>下一页批次</button></div></section>}
      {run && <section className="observation-run-header"><div><strong>{run.name} · v{run.version}</strong><p>信号日期 {run.signal_date} · 实际执行 {timestamp(run.created_at)} · {stateLabels[run.status]}{run.historical_replay ? ' · 历史补算' : ''}</p><p>目标 {counts?.target_total ?? run.task.scope.universe?.stock_codes.length ?? '—'} 只 · 入选 {counts?.true_count ?? '—'} · 未入选 {counts?.false_count ?? '—'} · 数据不足 {counts?.unknown_count ?? '—'}</p></div>{tab === 'screening' && !active(run.status) && <button className="secondary-button" onClick={() => switchTab('observation')}>查看本批次观察<ArrowRight size={14} /></button>}{!active(run.status) && <a className="secondary-button" href={`/api/v1/observation/runs/${run.id}/snapshot`}>导出结果字典</a>}{tab === 'observation' && <details className="observation-rules"><summary>本批次条件快照</summary><TaskLogic task={run.task} /></details>}</section>}
      {run && active(run.status) && <div className="observation-card" role="status"><p>{run.job.message}</p><progress value={run.job.progress} max={1} /><button className="secondary-button" disabled={busy} onClick={() => void cancel()}>取消本次选股</button></div>}
      {tab === 'observation' && performance && <><div className="observation-summary-toolbar"><label>统计周期<select aria-label="统计周期" value={horizon} onChange={e => setHorizon(e.target.value as typeof horizon)}><option value="latest">入选至最新</option><option value="5">入选后 5 个交易日</option><option value="10">入选后 10 个交易日</option><option value="20">入选后 20 个交易日</option></select></label><span>行情截至 {performance.latest_date ?? '暂无数据'} · 统计覆盖整个批次，包含已结束观察的股票</span></div><div className="observation-stats"><StatCard label="本批次入选" value={`${performance.summary.selected} 只`} /><StatCard label="有效统计样本" value={`${stat?.count ?? 0} 只`} /><StatCard label="平均涨跌幅" value={percent(stat?.average)} /><StatCard label="中位数涨跌幅" value={percent(stat?.median)} /><StatCard label="上涨占比" value={stat?.positive_rate == null ? '—' : `${stat.positive_rate.toFixed(1)}%`} /></div><p className="observation-disclosure">{performance.warning} 未满期、缺失数据不计入该周期的有效样本。</p></>}
      {resultError && <div className="library-error" role="alert">{resultError}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>重新加载</button></div>}
      {!runId ? <div className="observation-empty"><Telescope size={30} /><strong>{tab === 'screening' ? '选择方案，开始第一批选股' : '暂无选股历史'}</strong><p>选股完成后，可在观察池查看入选标记和后续表现。</p></div> : !run ? <p role="status">正在读取选股记录…</p> : !active(run.status) && <div className="observation-workspace">
        <section className="observation-card observation-results" aria-busy={resultsLoading}><div className="observation-table-toolbar"><label className="observation-search"><Search size={15} /><input aria-label="搜索结果股票" placeholder="股票名称或代码" value={query} onChange={e => { setQuery(e.target.value); setOffset(0) }} /></label>{tab === 'screening' ? <select aria-label="结果状态" value={state} onChange={e => { setState(e.target.value); setOffset(0) }}><option value="true">入选股票</option><option value="false">未入选</option><option value="unknown">数据不足</option><option value="">全部判断</option></select> : <><select aria-label="观察状态筛选" value={watchStatus} onChange={e => { setWatchStatus(e.target.value); setOffset(0) }}><option value="">全部观察状态</option>{Object.entries(watchLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select><select aria-label="观察排序" value={sort} onChange={e => setSort(e.target.value)}><option value="code">按代码</option><option value="return">涨跌幅从高到低</option><option value="priority">重点关注优先</option></select></>}</div>
          {resultsLoading ? <p className="observation-empty" role="status">正在加载{tab === 'screening' ? '选股结果' : '观察统计'}…</p> : tab === 'screening' ? <><div className="observation-table-scroll"><table><thead><tr><th>股票</th><th>判断</th><th>入选参考价</th><th>判断依据</th></tr></thead><tbody>{decisions.map(item => <tr key={item.stock_code} className={selectedCode === item.stock_code ? 'selected' : ''} onClick={() => setSelectedCode(item.stock_code)}><td><button className="stock-link" aria-pressed={selectedCode === item.stock_code} onClick={() => setSelectedCode(item.stock_code)}><StockName code={item.stock_code} /></button></td><td>{({ true: '入选', false: '未入选', unknown: '数据不足' })[item.state]}</td><td>{number(run.reference_prices[item.stock_code]?.close)}</td><td className="observation-reason"><span>{item.condition_decisions.map(c => c.explanation).join('；') || item.reason_code}</span></td></tr>)}</tbody></table></div>{!decisions.length && <p className="observation-empty">{query ? '没有匹配的股票，试试清除搜索。' : run.status === 'failed' ? `选股执行失败：${run.job.message}。可重新执行，原记录会保留。` : run.status === 'cancelled' ? '本次选股已取消。可重新执行，原记录会保留。' : state === 'true' ? '本批次没有入选股票。可查看未入选和数据不足的原因。' : '该分类没有股票。'}</p>}<Pagination offset={offset} total={total} onChange={setOffset} /></> : <><div className="observation-table-scroll"><table><thead><tr><th>股票 / 状态</th><th>最新价</th><th>{horizon === 'latest' ? '至今涨跌幅' : `${horizon}日涨跌幅`}</th><th>观察进度</th></tr></thead><tbody>{observed.slice(offset, offset + 30).map(item => <tr key={item.stock_code} className={selectedCode === item.stock_code ? 'selected' : ''} onClick={() => setSelectedCode(item.stock_code)}><td><button className="stock-link" aria-pressed={selectedCode === item.stock_code} onClick={() => setSelectedCode(item.stock_code)}><StockName code={item.stock_code} /></button><small className={`observation-status ${item.status}`}>{watchLabels[item.status]}</small></td><td>{number(item.latest_close)}<small>{item.latest_date ?? '无行情'}</small></td><td className={(horizon === 'latest' ? item.return_latest : item.returns[horizon])! > 0 ? 'observation-up' : 'observation-down'}>{percent(horizon === 'latest' ? item.return_latest : item.returns[horizon])}<small>{horizon !== 'latest' && item.days < Number(horizon) ? '未满期' : item.reason || ((horizon === 'latest' ? item.return_latest : item.returns[horizon]) == null ? '数据不足' : '')}</small></td><td>{item.days} 个交易日<small>有效行情 {item.observed_days} 日</small></td></tr>)}</tbody></table></div>{!observed.length && <p className="observation-empty">{performance?.items.length ? '没有符合当前搜索或状态的股票。' : '本批次暂无入选股票可供观察。'}</p>}<Pagination offset={offset} total={observed.length} onChange={setOffset} /></>}
        </section>
        <aside className="observation-detail">{selectedCode && !resultsLoading ? <><ObservationChart key={`chart:${runId}:${selectedCode}`} runId={runId} code={selectedCode} view={tab === 'screening' ? 'selection' : 'observation'} task={run.task} refresh={refresh} />{tab === 'observation' && selectedObservation && <ObservationNote key={`note:${runId}:${selectedCode}`} runId={runId} item={selectedObservation} onSaved={value => setPerformance(current => current ? { ...current, items: current.items.map(item => item.stock_code === selectedCode ? { ...item, ...value } : item) } : current)} />}</> : <div className="observation-card observation-empty">点击左侧股票查看 K 线与入选依据。</div>}</aside>
      </div>}
    </section>
  </div>
}

function StatCard({ label, value }: { label: string; value: string }) { return <div className="observation-stat"><span>{label}</span><strong>{value}</strong></div> }
function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (value: number) => void }) { return <div className="observation-pagination"><span>{total ? `${offset + 1}–${Math.min(offset + 30, total)} / ${total} 只` : '0 只'}</span><button disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - 30))}>上一页</button><button disabled={offset + 30 >= total} onClick={() => onChange(offset + 30)}>下一页</button></div> }
function ObservationNote({ runId, item, onSaved }: { runId: string; item: ObservationItem; onSaved: (value: { status: string; note: string; updated_at: string }) => void }) {
  const [note, setNote] = useState(item.note), [status, setStatus] = useState(item.status), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function save() {
    setBusy(true); setMessage('')
    try { const result = await api<{ status: string; note: string; updated_at: string }>(`/observation/runs/${runId}/notes/${encodeURIComponent(item.stock_code)}`, { method: 'PUT', body: JSON.stringify({ status, note }) }); if (mounted.current) { onSaved(result); setMessage('观察记录已保存') } }
    catch (reason) { if (mounted.current) setMessage((reason as Error).message) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <section className="observation-card observation-note"><h2>观察记录</h2><div className="observation-detail-metrics"><span>入选参考价<strong>{number(item.reference_close)}</strong><small>{item.reference_date ?? '旧记录未保存参考价'}</small></span><span>期间最高涨幅<strong>{percent(item.peak_return)}</strong></span><span>期间最低涨幅<strong>{percent(item.trough_return)}</strong></span></div><div className="observation-detail-metrics">{['5', '10', '20'].map(n => <span key={n}>{n} 日涨跌幅<strong>{item.days < Number(n) ? '未满期' : percent(item.returns[n])}</strong></span>)}</div>{item.invalid_bars > 0 && <p className="observation-disclosure">期间有 {item.invalid_bars} 根异常行情，区间最高／最低涨幅暂不可用。</p>}<label>观察状态<select aria-label="个股观察状态" value={status} disabled={busy} onChange={e => setStatus(e.target.value)}>{Object.entries(watchLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>观察备注<textarea aria-label="观察备注" value={note} disabled={busy} maxLength={2000} rows={3} placeholder="记录关注理由、后续验证点和变化…" onChange={e => setNote(e.target.value)} /></label><div className="observation-note-actions"><button className="primary-button" disabled={busy || (note === item.note && status === item.status)} onClick={() => void save()}>{busy ? '保存中…' : '保存观察记录'}</button>{item.updated_at && <small>更新于 {timestamp(item.updated_at)}</small>}</div>{message && <p role="status">{message}</p>}</section>
}
