import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, ClipboardList, Download, Loader2, RefreshCw, Search, Telescope, X } from 'lucide-react'
import { api, type DataStatus, type ScreeningTaskRevision } from '../api'
import { TaskLogic } from '../components/conversation/TaskBrief'
import ObservationChart from '../components/ObservationChart'
import { CandidateDetail, type ResearchCandidate } from './ResearchCandidatePanel'
import { trapDialogTab } from '../keyboard'
import { useSessionState } from '../useSessionState'
import '../observation.css'
import './observation-unified.css'
import ObservationQuickNote, { updateObservationEntry } from './ObservationListActions'
import './observation-list-editing.css'

type OwnerType = 'research' | 'manual' | 'screening'
export type Entry = {
  kind: 'candidate' | 'screening'; entry_id: string; candidate_id: string | null; run_id: string | null
  stock_code: string; name: string; status: string; note: string; verification: string; updated_at: string
  owner_type: OwnerType; owner_key: string; owner_label: string; joined_at: string; basis_date: string
  return_latest?: number | null; max_drawdown?: number | null; base_date?: string | null
  price_date?: string | null; metric_reason?: string
}
type Owner = { value: string; label: string; group: 'research' | 'screening'; count: number }
type Summary = { total: number; research_count: number; screening_count: number; priced_count: number; average_return: number | null; worst_drawdown: number | null; positive_rate: number | null }
type Counts = { target_total?: number; true_count?: number; false_count?: number; unknown_count?: number }
type Run = {
  id: string; name: string; version: number; signal_date: string; created_at: string; status: string
  conversation_id: string; task: ScreeningTaskRevision; result: { coverage?: Counts }; job_id: string
}
export type ObservationItem = {
  stock_code: string; name: string; status: string; note: string; updated_at: string | null
  reference_close: number | null; reference_date: string | null; calculation_base: number | null
  latest_close: number | null; latest_date: string | null; days: number; observed_days: number
  return_latest: number | null; returns: Record<string, number | null>; peak_return: number | null
  trough_return: number | null; reason: string; invalid_bars: number
}
type Performance = { items: ObservationItem[]; latest_date: string | null; warning: string }
type Detail = { kind: 'candidate'; item: ResearchCandidate } | { kind: 'screening'; run: Run; item: ObservationItem; performance: Performance }
type SourceTab = 'candidates' | 'batches'
type Props = {
  data: DataStatus | null; onNavigateScreening?: () => void; onOpenResearch?: (conversationId: string) => void
  onStartResearch?: () => void; initialRunId?: string; initialCode?: string; initialCandidateId?: string; initialTab?: SourceTab
  onLocationChange?: (tab: SourceTab | null, id: string, userNavigation?: boolean, code?: string) => void
}
const watchLabels: Record<string, string> = { watching: '观察中', priority: '重点关注', ended: '结束观察' }
const runLabels: Record<string, string> = { queued: '排队中', running: '执行中', succeeded: '已完成', partial: '部分数据不足', failed: '执行失败', cancelled: '已取消' }
const keyOf = (item: Entry) => item.kind === 'candidate' ? 'candidate:' + item.candidate_id : 'screening:' + item.run_id + ':' + item.stock_code
const shortTimestamp = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const timestamp = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
export const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
export const percent = (value: number | null | undefined) => value == null ? '—' : (value > 0 ? '+' : '') + value.toFixed(2) + '%'
const returnClass = (value: number | null | undefined) => value == null || value === 0 ? 'observation-neutral' : value > 0 ? 'observation-up' : 'observation-down'
const metricText = (value: number | null | undefined, loading: boolean) => value === undefined && loading ? '计算中…' : percent(value)
const metricTitle = (item: Entry) => item.metric_reason || ('起算 ' + (item.base_date || item.basis_date) + ' · 行情截至 ' + (item.price_date || '—'))

export default function ObservationPage({ data, onNavigateScreening, onOpenResearch, onStartResearch, initialRunId, initialCode, initialCandidateId, initialTab, onLocationChange }: Props) {
  type SavedView = { id: string; name: string; query: string; status: string; owner: string; sort: string }
  const [density, setDensity] = useSessionState<'compact' | 'comfortable'>('observation.listDensity', 'compact', (value): value is 'compact' | 'comfortable' => value === 'compact' || value === 'comfortable')
  const [checkedKeys, setCheckedKeys] = useState<string[]>([])
  const [savingKeys, setSavingKeys] = useState<string[]>([])
  const [batchBusy, setBatchBusy] = useState(false)
  const [editNote, setEditNote] = useState<Entry | null>(null)
  const [views, setViews] = useState<SavedView[]>(() => {
    try { const stored = JSON.parse(localStorage.getItem('observation.savedViews') || '[]'); return Array.isArray(stored) ? stored.filter(item => item && ['id', 'name', 'query', 'status', 'owner', 'sort'].every(key => typeof item[key] === 'string')).slice(0, 20) : [] }
    catch { return [] }
  })
  const [selectedView, setSelectedView] = useState('')
  const [viewEditing, setViewEditing] = useState(false)
  const [viewName, setViewName] = useState('')
  const viewNameRef = useRef<HTMLInputElement>(null)
  const editLock = useRef(new Set<string>())
  const batchLock = useRef(false)
  useEffect(() => { try { localStorage.setItem('observation.savedViews', JSON.stringify(views)) } catch { /* Filtering remains usable without browser storage. */ } }, [views])
  useEffect(() => { if (viewEditing) viewNameRef.current?.focus() }, [viewEditing])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [owner, setOwner] = useState(initialRunId ? 'run:' + initialRunId : initialCandidateId ? '' : initialTab === 'batches' ? 'screening' : initialTab === 'candidates' ? 'research' : '')
  const [sort, setSort] = useState('updated')
  const [offset, setOffset] = useState(0)
  const [items, setItems] = useState<Entry[]>([])
  const [total, setTotal] = useState(0)
  const [owners, setOwners] = useState<Owner[]>([])
  const [selectedKey, setSelectedKey] = useState(initialCandidateId ? 'candidate:' + initialCandidateId : initialRunId && initialCode ? 'screening:' + initialRunId + ':' + initialCode : '')
  const [detailOpen, setDetailOpen] = useState(!!(initialCandidateId || initialRunId))
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [metricsLoading, setMetricsLoading] = useState(true)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [metricNote, setMetricNote] = useState('')
  const [metricError, setMetricError] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [detailView, setDetailView] = useState<'chart' | 'note'>('chart')
  const detailRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const runDetailCache = useRef(new Map<string, { refresh: number; run: Run; performance: Performance }>())
  const locationCallback = useRef(onLocationChange)
  locationCallback.current = onLocationChange
  const routeRef = useRef({ candidate: initialCandidateId, run: initialRunId, code: initialCode, tab: initialTab })

  useEffect(() => {
    const changed = () => setRefresh(value => value + 1)
    window.addEventListener('observation:changed', changed)
    return () => window.removeEventListener('observation:changed', changed)
  }, [])
  useEffect(() => {
    if (routeRef.current.candidate === initialCandidateId && routeRef.current.run === initialRunId && routeRef.current.code === initialCode && routeRef.current.tab === initialTab) return
    routeRef.current = { candidate: initialCandidateId, run: initialRunId, code: initialCode, tab: initialTab }
    if (initialCandidateId) { setOwner(''); setSelectedKey('candidate:' + initialCandidateId); setDetailOpen(true) }
    else if (initialRunId) { setOwner('run:' + initialRunId); setSelectedKey(initialCode ? 'screening:' + initialRunId + ':' + initialCode : ''); setDetailOpen(true) }
    else if (initialTab) { setOwner(initialTab === 'batches' ? 'screening' : 'research'); setSelectedKey(''); setDetailOpen(false) }
  }, [initialCandidateId, initialRunId, initialCode, initialTab])
  useEffect(() => {
    const controller = new AbortController()
    api<{ items: Owner[] }>('/observation/owners', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setOwners(result.items) })
      .catch(() => { /* The list remains usable when owner suggestions are unavailable. */ })
    return () => controller.abort()
  }, [refresh])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setMetricsLoading(true); setError(''); setMetricError(''); setMetricNote(''); setSummary(null); setItems([])
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ offset: String(offset), limit: '30', sort })
      if (query.trim()) params.set('query', query.trim())
      if (status) params.set('status', status)
      if (owner) params.set('owner', owner)
      const url = '/observation/entries?' + params
      void api<{ items: Entry[]; total: number }>(url + '&include_metrics=false', { signal: controller.signal })
        .then(async result => {
          if (controller.signal.aborted) return
          if (offset && !result.items.length && result.total) { setOffset(Math.floor((result.total - 1) / 30) * 30); return }
          setItems(result.items); setTotal(result.total)
          setLoading(false)
          try {
            const measured = await api<{ items: Entry[]; summary?: Summary; metric_note?: string; latest_date?: string }>(url, { signal: controller.signal })
            if (controller.signal.aborted) return
            setItems(measured.items); setSummary(measured.summary ?? null); setMetricNote(measured.metric_note ?? '')
          } catch (reason) { if (!controller.signal.aborted) setMetricError((reason as Error).message) }
          finally { if (!controller.signal.aborted) setMetricsLoading(false) }
        })
        .catch(reason => { if (!controller.signal.aborted) { setError((reason as Error).message); setLoading(false); setMetricsLoading(false) } })
    }, 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, status, owner, sort, offset, refresh])
  useEffect(() => {
    if (!detailOpen || loading || error) return
    const bookmark = routeRef.current.candidate
    if (bookmark) {
      const key = 'candidate:' + bookmark
      if (selectedKey !== key) setSelectedKey(key)
      return
    }
    if (routeRef.current.run && routeRef.current.code) {
      const key = 'screening:' + routeRef.current.run + ':' + routeRef.current.code
      if (selectedKey !== key) setSelectedKey(key)
      return
    }
    if (items.some(item => keyOf(item) === selectedKey)) return
    setSelectedKey(items[0] ? keyOf(items[0]) : '')
  }, [items, loading, error, selectedKey, detailOpen])
  const selected = items.find(item => keyOf(item) === selectedKey)
  useEffect(() => {
    if (!detailOpen || !selectedKey) { setDetail(null); setDetailError(''); return }
    const controller = new AbortController()
    setDetail(null); setDetailError(''); setDetailLoading(true)
    async function load() {
      try {
        if (selectedKey.startsWith('candidate:')) {
          const item = await api<ResearchCandidate>('/observation/research-candidates/' + encodeURIComponent(selectedKey.slice('candidate:'.length)), { signal: controller.signal })
          if (!controller.signal.aborted) setDetail({ kind: 'candidate', item })
        } else if (selected?.run_id || selectedKey.startsWith('screening:')) {
          const [runId, code] = selected?.run_id
            ? [selected.run_id, selected.stock_code]
            : selectedKey.slice('screening:'.length).split(':')
          const cached = runDetailCache.current.get(runId)
          if (cached?.refresh === refresh) {
            const item = cached.performance.items.find(value => value.stock_code === code)
            if (item) { setDetail({ kind: 'screening', run: cached.run, performance: cached.performance, item }); return }
          }
          const id = encodeURIComponent(runId)
          const [run, performance] = await Promise.all([
            api<Run>('/observation/runs/' + id, { signal: controller.signal }),
            api<Performance>('/observation/runs/' + id + '/performance', { signal: controller.signal }),
          ])
          if (!controller.signal.aborted) {
            const item = performance.items.find(value => value.stock_code === code)
            if (!item) throw new Error('这只股票不在当前观察记录中。')
            runDetailCache.current.set(runId, { refresh, run, performance })
            setDetail({ kind: 'screening', run, performance, item })
          }
        }
      } catch (reason) { if (!controller.signal.aborted) setDetailError((reason as Error).message) }
      finally { if (!controller.signal.aborted) setDetailLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [detailOpen, selectedKey, selected?.run_id, selected?.stock_code, refresh])
  useLayoutEffect(() => {
    if (!detailOpen) return
    const previous = document.activeElement as HTMLElement | null
    // Focus before paint: an immediate Escape must reach the open dialog.
    closeRef.current?.focus({ preventScroll: true })
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [detailOpen])

  function clearRoute() {
    if (routeRef.current.candidate || routeRef.current.run || routeRef.current.tab) {
      routeRef.current = { candidate: undefined, run: undefined, code: undefined, tab: undefined }
      locationCallback.current?.(null, '', true)
    }
  }
  function closeDetail() { clearRoute(); setDetailOpen(false); setSelectedKey('') }
  function changeFilter(update: () => void) {
    if (batchLock.current) return
    closeDetail(); update(); setOffset(0); setNotice(''); setCheckedKeys([]); setSelectedView('')
  }
  function clearFilters() { changeFilter(() => { setQuery(''); setStatus(''); setOwner('') }) }
  function choose(item: Entry) {
    setSelectedKey(keyOf(item)); setDetailOpen(true); setDetailView('chart'); setNotice('')
    routeRef.current = item.kind === 'candidate'
      ? { candidate: item.candidate_id || undefined, run: undefined, code: undefined, tab: 'candidates' }
      : { candidate: undefined, run: item.run_id || undefined, code: item.stock_code, tab: 'batches' }
    locationCallback.current?.(item.kind === 'candidate' ? 'candidates' : 'batches', item.kind === 'candidate' ? item.candidate_id || '' : item.run_id || '', true, item.kind === 'screening' ? item.stock_code : undefined)
  }
  function changePage(next: number) { closeDetail(); setOffset(next); setCheckedKeys([]); tableScrollRef.current?.scrollTo?.({ top: 0 }) }
  function toggleChecked(item: Entry) { const key = keyOf(item); setCheckedKeys(current => current.includes(key) ? current.filter(value => value !== key) : [...current, key]) }
  async function changeEntryStatus(item: Entry, next: string) {
    const key = keyOf(item)
    if (editLock.current.has(key)) return
    editLock.current.add(key); setSavingKeys(current => [...current, key]); setNotice('')
    try { await updateObservationEntry(item, { status: next }); setNotice(`${item.name || item.stock_code}已设为${watchLabels[next]}。`); tableScrollRef.current?.scrollTo?.({ top: 0 }); setRefresh(value => value + 1) }
    catch (reason) { setNotice(`状态未保存：${(reason as Error).message}`) }
    finally { editLock.current.delete(key); setSavingKeys(current => current.filter(value => value !== key)) }
  }
  async function changeSelectedStatus(next: string) {
    if (batchLock.current || savingKeys.length) return
    const selectedItems = items.filter(item => checkedKeys.includes(keyOf(item)))
    if (!selectedItems.length) return
    batchLock.current = true; setBatchBusy(true); setNotice('')
    const failed: string[] = []
    for (const item of selectedItems) {
      try { await updateObservationEntry(item, { status: next }) }
      catch { failed.push(keyOf(item)) }
    }
    setCheckedKeys(failed); setNotice(`已将 ${selectedItems.length - failed.length} 条记录设为${watchLabels[next]}。${failed.length ? ` ${failed.length} 条未完成，保留勾选，可再次处理。` : ''}`)
    tableScrollRef.current?.scrollTo?.({ top: 0 }); setRefresh(value => value + 1); setBatchBusy(false); batchLock.current = false
  }
  function applyView(id: string) {
    const saved = views.find(item => item.id === id)
    if (!saved) { setSelectedView(''); return }
    changeFilter(() => { setQuery(saved.query); setStatus(saved.status); setOwner(saved.owner); setSort(saved.sort) }); setSelectedView(id)
  }
  function saveView() {
    if (!viewName.trim()) return
    const id = crypto.randomUUID()
    setViews(current => [...current, { id, name: viewName.trim(), query, status, owner, sort }].slice(-20)); setSelectedView(id); setViewEditing(false); setViewName(''); setNotice('筛选视图已保存到此浏览器。')
  }
  const filtered = !!(query || status || owner)
  const selectedOwner = owners.find(item => item.value === owner)
  return <div className={`page-content observation-page observation-redesigned observation-unified observation-density-${density}`}>
    <header className="page-heading observation-page-heading">
      <div><h1>观察池</h1><p className="page-description">研究、手动关注和选股入选记录集中跟踪</p></div>
      <div className="observation-heading-actions">
        {onStartResearch && <button className="secondary-button" onClick={onStartResearch}>开始研究<ArrowRight size={15} /></button>}
        {onNavigateScreening && <button className="primary-button" onClick={onNavigateScreening}>去条件选股<ArrowRight size={15} /></button>}
        <button className="secondary-button" onClick={() => { setNotice(''); setRefresh(value => value + 1) }}><RefreshCw size={15} />刷新</button>
      </div>
    </header>
    <div className="observation-unified-toolbar">
      <label className="observation-search"><Search size={17} /><input aria-label="搜索观察记录" disabled={batchBusy} placeholder="搜索股票、备注或所属" value={query} onChange={event => changeFilter(() => setQuery(event.target.value))} /></label>
      <select aria-label="按所属筛选" disabled={batchBusy} value={owner} onChange={event => changeFilter(() => setOwner(event.target.value))}>
        <option value="">全部所属</option>
        <optgroup label="来源类型"><option value="research">全部研究记录</option><option value="manual">手动关注</option><option value="screening">全部筛选批次</option></optgroup>
        {!!owners.filter(item => item.group === 'research' && item.value !== 'manual').length && <optgroup label="研究所属">{owners.filter(item => item.group === 'research' && item.value !== 'manual').map(item => <option key={item.value} value={item.value}>{item.label}（{item.count}）</option>)}</optgroup>}
        {!!owners.filter(item => item.group === 'screening').length && <optgroup label="筛选批次">{owners.filter(item => item.group === 'screening').map(item => <option key={item.value} value={item.value}>{item.label}（{item.count}）</option>)}</optgroup>}
        {owner.startsWith('run:') && !selectedOwner && <option value={owner}>当前筛选批次</option>}
      </select>
      <select aria-label="观察状态筛选" disabled={batchBusy} value={status} onChange={event => changeFilter(() => setStatus(event.target.value))}><option value="">全部状态</option>{Object.entries(watchLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="观察记录排序" disabled={batchBusy} value={sort} onChange={event => changeFilter(() => setSort(event.target.value))}><option value="updated">最近更新</option><option value="priority">重点优先</option><option value="name">股票名称</option></select>
    </div>
    <div className="observation-view-toolbar"><div role="group" aria-label="观察列表密度"><button type="button" aria-pressed={density === 'compact'} onClick={() => setDensity('compact')}>紧凑列表</button><button type="button" aria-pressed={density === 'comfortable'} onClick={() => setDensity('comfortable')}>宽松列表</button></div><select aria-label="已保存观察视图" disabled={batchBusy} value={selectedView} onChange={event => applyView(event.target.value)}><option value="">当前筛选</option>{views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}</select><button type="button" className="text-button" onClick={() => { setViewEditing(value => !value); setViewName(selectedOwner?.label || watchLabels[status] || '我的观察视图') }}>保存当前筛选</button>{selectedView && <button type="button" className="text-button" onClick={() => { setViews(current => current.filter(item => item.id !== selectedView)); setSelectedView('') }}>移除视图</button>}</div>
    {viewEditing && <form className="observation-view-form" aria-label="保存观察筛选视图" onSubmit={event => { event.preventDefault(); saveView() }}><label htmlFor="observation-view-name">视图名称</label><input ref={viewNameRef} id="observation-view-name" value={viewName} maxLength={60} onChange={event => setViewName(event.target.value)} /><button type="submit" className="secondary-button compact" disabled={!viewName.trim()}>保存视图</button><button type="button" className="text-button" onClick={() => setViewEditing(false)}>取消</button></form>}
    {!!checkedKeys.length && <div className="observation-batch-toolbar" role="group" aria-label="批量处理本页观察记录"><strong>本页已选 {checkedKeys.length} 条</strong>{Object.entries(watchLabels).map(([value, label]) => <button key={value} type="button" className="text-button" disabled={batchBusy || !!savingKeys.length || loading} onClick={() => void changeSelectedStatus(value)}>设为{label}</button>)}<button type="button" className="text-button" disabled={batchBusy} onClick={() => setCheckedKeys([])}>清除勾选</button>{batchBusy && <span role="status">正在保存…</span>}</div>}
    <div className="observation-unified-meta"><span>{loading ? '正在读取观察记录…' : '共 ' + total + ' 条观察记录'}{data?.last_date && ' · 行情截至 ' + data.last_date}</span>{filtered && <button className="text-button" onClick={clearFilters}>清除筛选</button>}</div>
    {error && <div className="library-error" role="alert">{error}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>重新加载</button></div>}
    {notice && <p className="observation-save-message observation-list-message" role="status"><span>{notice}</span><button type="button" className="icon-button" aria-label="关闭观察提示" onClick={() => setNotice('')}><X size={14} /></button></p>}
    <section className="observation-overview" aria-label="当前筛选范围汇总">
      <SummaryCard label="观察记录" value={loading ? '—' : total.toLocaleString('zh-CN') + ' 条'} />
      <SummaryCard label="研究 / 手动" value={summary ? summary.research_count.toLocaleString('zh-CN') + ' 条' : '—'} />
      <SummaryCard label="选股" value={summary ? summary.screening_count.toLocaleString('zh-CN') + ' 条' : '—'} />
      <SummaryCard label="平均至今涨跌幅" value={summary ? percent(summary.average_return) : '—'} tone={returnClass(summary?.average_return)} hint={summary ? summary.priced_count + ' 条有可用行情' : undefined} />
      <SummaryCard label="最深回撤" value={summary ? percent(summary.worst_drawdown) : '—'} tone={returnClass(summary?.worst_drawdown)} />
    </section>
    <details className="observation-metric-disclosure"><summary>{metricsLoading && !loading ? '正在计算行情统计…' : metricError ? '行情统计暂不可用，查看原因' : '数据口径与说明'}{summary && <span className="observation-source-counts"> · 研究/手动 {summary.research_count} · 选股 {summary.screening_count}</span>}</summary><p className="observation-metric-note">{metricsLoading && !loading ? '正在计算涨跌幅与回撤…' : metricError ? '行情统计暂不可用：' + metricError : metricNote || '涨跌幅从各记录的起算日计算；选股沿用信号日。'}</p></details>
    <div className="observation-unified-workspace">
      <section className="observation-card observation-results" aria-label="观察记录列表" aria-busy={loading}>
        {loading && !items.length ? <div className="observation-loading" role="status"><Loader2 size={18} />正在读取观察记录…</div> : <>
          <div ref={tableScrollRef} className="observation-table-scroll">
            <table>
              <thead><tr><th className="observation-check-column"><input type="checkbox" aria-label="勾选本页全部观察记录" checked={items.length > 0 && items.every(item => checkedKeys.includes(keyOf(item)))} disabled={batchBusy || !!savingKeys.length} onChange={event => setCheckedKeys(event.target.checked ? items.map(keyOf) : [])} /></th><th>股票 / 状态</th><th>所属</th><th>加入时间</th><th>至今涨跌幅</th><th>最大回撤</th><th>关注备注</th></tr></thead>
              <tbody>{items.map(item => <tr key={keyOf(item)} className={detailOpen && selectedKey === keyOf(item) ? 'selected' : ''} onClick={event => { if (!(event.target as Element).closest('button,select,input,label,textarea,a')) choose(item) }}>
                <td data-label="勾选" className="observation-check-column" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`勾选观察记录 ${item.stock_code} ${item.owner_label}`} checked={checkedKeys.includes(keyOf(item))} disabled={batchBusy || savingKeys.includes(keyOf(item))} onChange={() => toggleChecked(item)} /></td>
                <td data-label="股票"><button className="stock-link" aria-label={'查看' + (item.name || item.stock_code) + '观察详情'} onClick={event => { event.stopPropagation(); choose(item) }}>{item.name || item.stock_code}{item.name && <small>{item.stock_code}</small>}</button><select className="observation-inline-status" aria-label={`修改${item.name || item.stock_code}观察状态`} value={item.status} disabled={batchBusy || savingKeys.includes(keyOf(item))} onClick={event => event.stopPropagation()} onChange={event => void changeEntryStatus(item, event.target.value)}>{Object.entries(watchLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
                <td data-label="所属"><span className={'observation-kind observation-kind-' + item.owner_type}>{item.owner_type === 'screening' ? '选股' : item.owner_type === 'manual' ? '手动' : '研究'}</span><span className="observation-owner-label" title={item.owner_label}>{item.owner_label}</span></td>
                <td data-label="加入时间" title={timestamp(item.joined_at)}><time dateTime={item.joined_at}>{shortTimestamp(item.joined_at)}</time></td>
                <td data-label="至今涨跌幅" className={returnClass(item.return_latest)} title={metricTitle(item)}><strong>{metricText(item.return_latest, metricsLoading)}</strong><small>{item.metric_reason || (item.base_date ? '起算 ' + item.base_date : '')}</small></td>
                <td data-label="最大回撤" className={returnClass(item.max_drawdown)} title={metricTitle(item)}><strong>{metricText(item.max_drawdown, metricsLoading)}</strong></td>
                <td data-label="关注备注" className="observation-reason"><button type="button" className="observation-inline-note" aria-label={`编辑${item.name || item.stock_code}关注备注`} disabled={batchBusy || savingKeys.includes(keyOf(item))} onClick={event => { event.stopPropagation(); setEditNote(item) }}>{item.note || item.verification || '添加备注'}</button></td>
              </tr>)}</tbody>
            </table>
          </div>
          {!items.length && <div className="observation-empty observation-start"><Telescope size={25} /><strong>{filtered ? '没有匹配的观察记录' : '还没有观察记录'}</strong>{filtered && <button className="secondary-button" onClick={clearFilters}>显示全部观察</button>}</div>}
          <Pagination offset={offset} total={total} onChange={changePage} />
        </>}
      </section>
    </div>
    {editNote && <ObservationQuickNote entry={editNote} onClose={() => setEditNote(null)} onSaved={() => { setEditNote(null); setNotice('关注备注已保存。'); tableScrollRef.current?.scrollTo?.({ top: 0 }); setRefresh(value => value + 1) }} />}
    {detailOpen && <div className="observation-drawer-layer">
      <div className="observation-drawer-backdrop" onClick={closeDetail} aria-hidden="true" />
      <section ref={detailRef} className="observation-unified-detail" role="dialog" aria-modal="true" aria-label="观察详情" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeDetail() } else trapDialogTab(event) }}>
        <header className="observation-drawer-header"><h2>观察详情</h2><button ref={closeRef} className="icon-button" aria-label="关闭观察详情" onClick={closeDetail}><X size={19} /></button></header>
        <div className="observation-drawer-body">
          {selected && <div className="observation-entry-context">
            <span className={'observation-kind observation-kind-' + selected.owner_type}>{selected.owner_type === 'screening' ? '选股' : selected.owner_type === 'manual' ? '手动' : '研究'}</span>
            <strong>{selected.owner_label}</strong>
            <span>加入于 {timestamp(selected.joined_at)}</span>
            <div><span>至今涨跌幅 <strong className={returnClass(selected.return_latest)}>{metricText(selected.return_latest, metricsLoading)}</strong></span><span>最大回撤 <strong className={returnClass(selected.max_drawdown)}>{metricText(selected.max_drawdown, metricsLoading)}</strong></span></div>
            <small>{selected.metric_reason || ('起算日 ' + (selected.base_date || selected.basis_date) + ' · 行情截至 ' + (selected.price_date || '—'))}</small>
          </div>}
          {detailLoading ? <div className="observation-loading" role="status"><Loader2 size={18} />正在读取观察详情…</div>
            : detailError ? <div className="library-error" role="alert">{detailError}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>重新读取</button></div>
              : detail?.kind === 'candidate' ? <CandidateDetail key={detail.item.id + ':' + detail.item.revision} item={detail.item} onOpenResearch={onOpenResearch} onReload={() => setRefresh(value => value + 1)} onSaved={value => { setDetail({ kind: 'candidate', item: value }); setNotice('观察记录已保存'); setRefresh(current => current + 1) }} />
                : detail?.kind === 'screening' ? <>
                  <div className="observation-run-context"><div><span className="observation-owner-kind">所属筛选批次</span><h2>{detail.run.name}</h2><p>{detail.run.signal_date} · v{detail.run.version} · {runLabels[detail.run.status] || detail.run.status}</p></div><a className="secondary-button" href={'/api/v1/observation/runs/' + detail.run.id + '/snapshot'}><Download size={14} />导出结果字典</a></div>
                  <details className="observation-rules"><summary>查看本批次筛选条件</summary><TaskLogic task={detail.run.task} /></details>
                  <div className="observation-detail-switch" role="group" aria-label="个股详情视图"><button type="button" aria-pressed={detailView === 'chart'} onClick={() => setDetailView('chart')}>走势与依据</button><button type="button" aria-pressed={detailView === 'note'} onClick={() => setDetailView('note')}>观察备注</button></div>
                  <div className="observation-detail-pane" hidden={detailView !== 'chart'}><ObservationChart key={detail.run.id + ':' + detail.item.stock_code} runId={detail.run.id} code={detail.item.stock_code} view="observation" task={detail.run.task} refresh={refresh} /></div>
                  <div className="observation-detail-pane" hidden={detailView !== 'note'}><ObservationNote key={detail.run.id + ':' + detail.item.stock_code} runId={detail.run.id} item={detail.item} entry={selected} onSaved={() => { setNotice('观察记录已保存'); setRefresh(current => current + 1) }} /></div>
                </> : <div className="observation-empty"><ClipboardList size={24} /><strong>选择一条观察记录查看详情</strong></div>}
        </div>
      </section>
    </div>}
  </div>
}

function SummaryCard({ label, value, tone = '', hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return <div className="observation-overview-card"><span>{label}</span><strong className={tone}>{value}</strong>{hint && <small>{hint}</small>}</div>
}

function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (value: number) => void }) {
  return <div className="observation-pagination"><span>{total ? String(offset + 1) + '–' + String(Math.min(offset + 30, total)) + ' / ' + total + ' 条' : '0 条'}</span><button disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - 30))}>上一页</button><button disabled={offset + 30 >= total} onClick={() => onChange(offset + 30)}>下一页</button></div>
}

function ObservationNote({ runId, item, entry, onSaved }: { runId: string; item: ObservationItem; entry?: Entry; onSaved: () => void }) {
  type Draft = { note: string; status: string }
  const key = runId + ':' + item.stock_code
  const [drafts, setDrafts] = useSessionState<Record<string, Draft>>('observation.noteDrafts', {}, (value): value is Record<string, Draft> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(row => !!row && typeof row === 'object' && 'note' in row && typeof row.note === 'string' && 'status' in row && typeof row.status === 'string' && Object.hasOwn(watchLabels, row.status)))
  const draft = drafts[key] || { note: item.note, status: item.status }
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const currentReturn = entry?.return_latest === undefined ? item.return_latest : entry.return_latest
  const changed = draft.note !== item.note || draft.status !== item.status
  const clear = () => setDrafts(current => { const next = { ...current }; delete next[key]; return next })
  async function save() {
    setBusy(true); setMessage('')
    try {
      await api('/observation/runs/' + encodeURIComponent(runId) + '/notes/' + encodeURIComponent(item.stock_code), { method: 'PUT', body: JSON.stringify(draft) })
      clear(); onSaved()
    } catch (reason) { setMessage((reason as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="observation-card observation-note">
    <div className="observation-section-heading"><div><h2>{item.name || item.stock_code} · 观察记录</h2><span className={'observation-status ' + item.status}>{watchLabels[item.status]}</span></div></div>
    <div className="observation-detail-metrics observation-stock-metrics"><span>入选参考价<strong>{number(item.reference_close)}</strong><small>{item.reference_date || '未记录参考价'}</small></span><span>最新价<strong>{number(item.latest_close)}</strong><small>{item.latest_date || '无行情'}</small></span><span>至今涨跌幅<strong className={returnClass(currentReturn)}>{percent(currentReturn)}</strong></span><span>最大回撤<strong className={returnClass(entry?.max_drawdown)}>{percent(entry?.max_drawdown)}</strong></span><span>期间最高涨幅<strong className={returnClass(item.peak_return)}>{percent(item.peak_return)}</strong></span><span>观察天数<strong>{item.days} 日</strong></span></div>
    {item.invalid_bars > 0 && <p className="observation-disclosure">期间有 {item.invalid_bars} 根异常行情，区间最高／最低涨幅暂不可用。</p>}
    <label>观察状态<select aria-label="个股观察状态" value={draft.status} disabled={busy} onChange={event => setDrafts(current => ({ ...current, [key]: { ...draft, status: event.target.value } }))}>{Object.entries(watchLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>观察备注<textarea aria-label="观察备注" value={draft.note} disabled={busy} maxLength={2000} rows={4} onChange={event => setDrafts(current => ({ ...current, [key]: { ...draft, note: event.target.value } }))} /><span className="observation-field-hint">{draft.note.length} / 2000</span></label>
    <div className="observation-save-footer"><small>{item.updated_at ? '更新于 ' + timestamp(item.updated_at) : '尚未编辑'}</small><div>{changed && <button className="text-button" disabled={busy} onClick={() => { clear(); setMessage('') }}>恢复已保存记录</button>}<button className="primary-button" disabled={busy || !changed} onClick={() => void save()}>{busy ? '保存中…' : '保存观察记录'}</button></div></div>
    {message && <p className="observation-save-message" role="alert">{message}</p>}
  </section>
}
