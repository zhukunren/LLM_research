import { StockText } from '../components/StockMentions'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ClipboardList, Download, Loader2, RefreshCw, Search, Telescope } from 'lucide-react'
import { api, type DataStatus, type ScreeningTaskRevision } from '../api'
import { TaskLogic } from '../components/conversation/TaskBrief'
import ObservationChart from '../components/ObservationChart'
import { CandidateDetail, type ResearchCandidate } from './ResearchCandidatePanel'
import { useSessionState } from '../useSessionState'
import '../observation.css'
import './observation-unified.css'

type OwnerType = 'research' | 'manual' | 'screening'
type Entry = {
  kind: 'candidate' | 'screening'; entry_id: string; candidate_id: string | null; run_id: string | null
  stock_code: string; name: string; status: string; note: string; verification: string; updated_at: string
  owner_type: OwnerType; owner_key: string; owner_label: string
}
type Owner = { value: string; label: string; group: 'research' | 'screening'; count: number }
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
  onStartResearch?: () => void; initialRunId?: string; initialCandidateId?: string; initialTab?: SourceTab
  onLocationChange?: (tab: SourceTab | null, id: string, userNavigation?: boolean) => void
}
const watchLabels: Record<string, string> = { watching: '观察中', priority: '重点关注', ended: '结束观察' }
const runLabels: Record<string, string> = { queued: '排队中', running: '执行中', succeeded: '已完成', partial: '部分数据不足', failed: '执行失败', cancelled: '已取消' }
const keyOf = (item: Entry) => item.kind === 'candidate' ? 'candidate:' + item.candidate_id : 'screening:' + item.run_id + ':' + item.stock_code
const shortDate = (value: string) => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
const timestamp = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
export const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
export const percent = (value: number | null | undefined) => value == null ? '—' : (value > 0 ? '+' : '') + value.toFixed(2) + '%'
const returnClass = (value: number | null | undefined) => value == null || value === 0 ? 'observation-neutral' : value > 0 ? 'observation-up' : 'observation-down'

export default function ObservationPage({ data, onNavigateScreening, onOpenResearch, onStartResearch, initialRunId, initialCandidateId, initialTab, onLocationChange }: Props) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [owner, setOwner] = useState(initialRunId ? 'run:' + initialRunId : initialCandidateId ? '' : initialTab === 'batches' ? 'screening' : initialTab === 'candidates' ? 'research' : '')
  const [sort, setSort] = useState('updated')
  const [offset, setOffset] = useState(0)
  const [items, setItems] = useState<Entry[]>([])
  const [total, setTotal] = useState(0)
  const [owners, setOwners] = useState<Owner[]>([])
  const [selectedKey, setSelectedKey] = useState(initialCandidateId ? 'candidate:' + initialCandidateId : '')
  const [mobileView, setMobileView] = useState<'catalog' | 'reader'>(initialCandidateId ? 'reader' : 'catalog')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [detailView, setDetailView] = useState<'chart' | 'note'>('chart')
  const listRef = useRef<HTMLElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const runDetailCache = useRef(new Map<string, { refresh: number; run: Run; performance: Performance }>())
  const locationCallback = useRef(onLocationChange)
  locationCallback.current = onLocationChange
  const routeRef = useRef({ candidate: initialCandidateId, run: initialRunId, tab: initialTab })

  useEffect(() => {
    const changed = () => setRefresh(value => value + 1)
    window.addEventListener('observation:changed', changed)
    return () => window.removeEventListener('observation:changed', changed)
  }, [])
  useEffect(() => {
    if (routeRef.current.candidate === initialCandidateId && routeRef.current.run === initialRunId && routeRef.current.tab === initialTab) return
    routeRef.current = { candidate: initialCandidateId, run: initialRunId, tab: initialTab }
    if (initialCandidateId) { setOwner(''); setSelectedKey('candidate:' + initialCandidateId); setMobileView('reader') }
    else if (initialRunId) { setOwner('run:' + initialRunId); setSelectedKey(''); setMobileView('reader') }
    else if (initialTab) { setOwner(initialTab === 'batches' ? 'screening' : 'research'); setSelectedKey('') }
  }, [initialCandidateId, initialRunId, initialTab])
  useEffect(() => {
    const controller = new AbortController()
    api<{ items: Owner[] }>('/observation/owners', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setOwners(result.items) })
      .catch(() => { /* The list remains usable when owner suggestions are unavailable. */ })
    return () => controller.abort()
  }, [refresh])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ offset: String(offset), limit: '30', sort })
      if (query.trim()) params.set('query', query.trim())
      if (status) params.set('status', status)
      if (owner) params.set('owner', owner)
      api<{ items: Entry[]; total: number }>('/observation/entries?' + params, { signal: controller.signal })
        .then(result => {
          if (controller.signal.aborted) return
          if (offset && !result.items.length && result.total) { setOffset(Math.floor((result.total - 1) / 30) * 30); return }
          setItems(result.items); setTotal(result.total)
        })
        .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, status, owner, sort, offset, refresh])
  useEffect(() => {
    if (loading || error) return
    const bookmark = routeRef.current.candidate
    if (bookmark) {
      const key = 'candidate:' + bookmark
      if (selectedKey !== key) setSelectedKey(key)
      return
    }
    if (items.some(item => keyOf(item) === selectedKey)) return
    setSelectedKey(items[0] ? keyOf(items[0]) : '')
  }, [items, loading, error, selectedKey])
  const selected = items.find(item => keyOf(item) === selectedKey)
  useEffect(() => {
    if (!selectedKey) { setDetail(null); setDetailError(''); return }
    const controller = new AbortController()
    setDetail(null); setDetailError(''); setDetailLoading(true)
    async function load() {
      try {
        if (selectedKey.startsWith('candidate:')) {
          const item = await api<ResearchCandidate>('/observation/research-candidates/' + encodeURIComponent(selectedKey.slice('candidate:'.length)), { signal: controller.signal })
          if (!controller.signal.aborted) setDetail({ kind: 'candidate', item })
        } else if (selected?.run_id) {
          const cached = runDetailCache.current.get(selected.run_id)
          if (cached?.refresh === refresh) {
            const item = cached.performance.items.find(value => value.stock_code === selected.stock_code)
            if (item) { setDetail({ kind: 'screening', run: cached.run, performance: cached.performance, item }); return }
          }
          const id = encodeURIComponent(selected.run_id)
          const [run, performance] = await Promise.all([
            api<Run>('/observation/runs/' + id, { signal: controller.signal }),
            api<Performance>('/observation/runs/' + id + '/performance', { signal: controller.signal }),
          ])
          if (!controller.signal.aborted) {
            const item = performance.items.find(value => value.stock_code === selected.stock_code)
            if (!item) throw new Error('这只股票不在当前观察记录中。')
            runDetailCache.current.set(selected.run_id, { refresh, run, performance })
            setDetail({ kind: 'screening', run, performance, item })
          }
        }
      } catch (reason) { if (!controller.signal.aborted) setDetailError((reason as Error).message) }
      finally { if (!controller.signal.aborted) setDetailLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [selectedKey, selected?.run_id, selected?.stock_code, refresh])

  function clearRoute() {
    if (routeRef.current.candidate || routeRef.current.run || routeRef.current.tab) {
      routeRef.current = { candidate: undefined, run: undefined, tab: undefined }
      locationCallback.current?.(null, '', true)
    }
  }
  function changeFilter(update: () => void) {
    clearRoute(); update(); setOffset(0); setSelectedKey(''); setMobileView('catalog'); setNotice('')
  }
  function clearFilters() { changeFilter(() => { setQuery(''); setStatus(''); setOwner('') }) }
  function choose(item: Entry) {
    setSelectedKey(keyOf(item)); setMobileView('reader'); setDetailView('chart'); setNotice('')
    routeRef.current = item.kind === 'candidate'
      ? { candidate: item.candidate_id || undefined, run: undefined, tab: 'candidates' }
      : { candidate: undefined, run: item.run_id || undefined, tab: 'batches' }
    locationCallback.current?.(item.kind === 'candidate' ? 'candidates' : 'batches', item.kind === 'candidate' ? item.candidate_id || '' : item.run_id || '', true)
    if (globalThis.matchMedia?.('(max-width: 1100px)').matches) {
      detailRef.current?.focus({ preventScroll: true })
      detailRef.current?.scrollIntoView({ behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })
    }
  }
  const filtered = !!(query || status || owner)
  const selectedOwner = owners.find(item => item.value === owner)
  return <StockText><div className="page-content observation-page observation-redesigned observation-unified" data-mobile-view={mobileView}>
    <header className="page-heading observation-page-heading">
      <div><h1>观察池</h1><p className="page-description">研究、手动关注和选股入选记录集中跟踪</p></div>
      <div className="observation-heading-actions">
        {onStartResearch && <button className="secondary-button" onClick={onStartResearch}>开始研究<ArrowRight size={15} /></button>}
        {onNavigateScreening && <button className="primary-button" onClick={onNavigateScreening}>去条件选股<ArrowRight size={15} /></button>}
        <button className="secondary-button" onClick={() => { setNotice(''); setRefresh(value => value + 1) }}><RefreshCw size={15} />刷新</button>
      </div>
    </header>
    <div className="observation-unified-toolbar">
      <label className="observation-search"><Search size={17} /><input aria-label="搜索观察记录" placeholder="搜索股票、备注或所属" value={query} onChange={event => changeFilter(() => setQuery(event.target.value))} /></label>
      <select aria-label="按所属筛选" value={owner} onChange={event => changeFilter(() => setOwner(event.target.value))}>
        <option value="">全部所属</option>
        <optgroup label="来源类型"><option value="research">全部研究记录</option><option value="manual">手动关注</option><option value="screening">全部筛选批次</option></optgroup>
        {!!owners.filter(item => item.group === 'research' && item.value !== 'manual').length && <optgroup label="研究所属">{owners.filter(item => item.group === 'research' && item.value !== 'manual').map(item => <option key={item.value} value={item.value}>{item.label}（{item.count}）</option>)}</optgroup>}
        {!!owners.filter(item => item.group === 'screening').length && <optgroup label="筛选批次">{owners.filter(item => item.group === 'screening').map(item => <option key={item.value} value={item.value}>{item.label}（{item.count}）</option>)}</optgroup>}
        {owner.startsWith('run:') && !selectedOwner && <option value={owner}>当前筛选批次</option>}
      </select>
      <select aria-label="观察状态筛选" value={status} onChange={event => changeFilter(() => setStatus(event.target.value))}><option value="">全部状态</option>{Object.entries(watchLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="观察记录排序" value={sort} onChange={event => { setSort(event.target.value); setOffset(0) }}><option value="updated">最近更新</option><option value="priority">重点优先</option><option value="name">股票名称</option></select>
    </div>
    <div className="observation-unified-meta"><span>{loading ? '正在读取观察记录…' : '共 ' + total + ' 条观察记录'}{data?.last_date && ' · 行情截至 ' + data.last_date}</span>{filtered && <button className="text-button" onClick={clearFilters}>清除筛选</button>}</div>
    {error && <div className="library-error" role="alert">{error}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>重新加载</button></div>}
    {notice && <p className="observation-save-message" role="status">{notice}</p>}
    <nav className="workspace-pane-switch" aria-label="观察列表与详情切换"><button type="button" aria-pressed={mobileView === 'catalog'} onClick={() => setMobileView('catalog')}>观察列表</button><button type="button" aria-pressed={mobileView === 'reader'} disabled={!selectedKey} onClick={() => setMobileView('reader')}>观察详情</button></nav>
    <div className="observation-workspace observation-unified-workspace" data-mobile-view={mobileView}>
      <section ref={listRef} tabIndex={-1} className="observation-card observation-results" aria-label="观察记录列表" aria-busy={loading}>
        {loading && !items.length ? <div className="observation-loading" role="status"><Loader2 size={18} />正在读取观察记录…</div> : <>
          <div className="observation-table-scroll"><table><thead><tr><th>股票 / 状态</th><th>所属</th><th>关注备注 / 更新</th></tr></thead><tbody>{items.map(item => <tr key={keyOf(item)} className={selectedKey === keyOf(item) ? 'selected' : ''} onClick={() => choose(item)}><td data-label="股票"><button className="stock-link" aria-pressed={selectedKey === keyOf(item)} onClick={event => { event.stopPropagation(); choose(item) }}>{item.name || item.stock_code}{item.name && <small>{item.stock_code}</small>}</button><small className={'observation-status ' + item.status}>{watchLabels[item.status] || item.status}</small><small className="observation-mobile-note">{item.note || item.verification || '待补充备注'}</small></td><td data-label="所属"><span className="observation-owner-label">{item.owner_label}</span>{item.owner_type !== 'manual' && <small>{item.owner_type === 'screening' ? '筛选批次' : '研究记录'}</small>}<small className="observation-mobile-date">更新 {shortDate(item.updated_at)}</small></td><td data-label="关注备注" className="observation-reason"><span>{item.note || item.verification || '待补充备注'}</span><small title={timestamp(item.updated_at)}>更新 {shortDate(item.updated_at)}</small></td></tr>)}</tbody></table></div>
          {!items.length && <div className="observation-empty observation-start"><Telescope size={25} /><strong>{filtered ? '没有匹配的观察记录' : '还没有观察记录'}</strong>{filtered && <button className="secondary-button" onClick={clearFilters}>显示全部观察</button>}</div>}
          <Pagination offset={offset} total={total} onChange={setOffset} />
        </>}
      </section>
      <div ref={detailRef} tabIndex={-1} className="observation-detail observation-unified-detail">
        <button className="secondary-button observation-back" onClick={() => { setMobileView('catalog'); listRef.current?.focus({ preventScroll: true }) }}><ArrowLeft size={14} />返回观察列表</button>
        {detailLoading ? <div className="observation-loading" role="status"><Loader2 size={18} />正在读取观察详情…</div>
          : detailError ? <div className="library-error" role="alert">{detailError}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>重新读取</button></div>
            : detail?.kind === 'candidate' ? <CandidateDetail key={detail.item.id + ':' + detail.item.revision} item={detail.item} onOpenResearch={onOpenResearch} onReload={() => setRefresh(value => value + 1)} onSaved={value => { setDetail({ kind: 'candidate', item: value }); setNotice('观察记录已保存'); setRefresh(current => current + 1) }} />
              : detail?.kind === 'screening' ? <>
                <div className="observation-run-context"><div><span className="observation-owner-kind">所属筛选批次</span><h2>{detail.run.name}</h2><p>{detail.run.signal_date} · v{detail.run.version} · {runLabels[detail.run.status] || detail.run.status}</p></div><a className="secondary-button" href={'/api/v1/observation/runs/' + detail.run.id + '/snapshot'}><Download size={14} />导出结果字典</a></div>
                <details className="observation-rules"><summary>查看本批次筛选条件</summary><TaskLogic task={detail.run.task} /></details>
                <div className="observation-detail-switch" role="group" aria-label="个股详情视图"><button type="button" aria-pressed={detailView === 'chart'} onClick={() => setDetailView('chart')}>走势与依据</button><button type="button" aria-pressed={detailView === 'note'} onClick={() => setDetailView('note')}>观察备注</button></div>
                <div className="observation-detail-pane" hidden={detailView !== 'chart'}><ObservationChart key={detail.run.id + ':' + detail.item.stock_code} runId={detail.run.id} code={detail.item.stock_code} view="observation" task={detail.run.task} refresh={refresh} /></div>
                <div className="observation-detail-pane" hidden={detailView !== 'note'}><ObservationNote key={detail.run.id + ':' + detail.item.stock_code} runId={detail.run.id} item={detail.item} onSaved={() => { setNotice('观察记录已保存'); setRefresh(current => current + 1) }} /></div>
              </> : <div className="observation-empty"><ClipboardList size={24} /><strong>选择一条观察记录查看详情</strong></div>}
      </div>
    </div>
  </div></StockText>
}

function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (value: number) => void }) {
  return <div className="observation-pagination"><span>{total ? String(offset + 1) + '–' + String(Math.min(offset + 30, total)) + ' / ' + total + ' 条' : '0 条'}</span><button disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - 30))}>上一页</button><button disabled={offset + 30 >= total} onClick={() => onChange(offset + 30)}>下一页</button></div>
}

function ObservationNote({ runId, item, onSaved }: { runId: string; item: ObservationItem; onSaved: () => void }) {
  type Draft = { note: string; status: string }
  const key = runId + ':' + item.stock_code
  const [drafts, setDrafts] = useSessionState<Record<string, Draft>>('observation.noteDrafts', {}, (value): value is Record<string, Draft> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(row => !!row && typeof row === 'object' && 'note' in row && typeof row.note === 'string' && 'status' in row && typeof row.status === 'string' && Object.hasOwn(watchLabels, row.status)))
  const draft = drafts[key] || { note: item.note, status: item.status }
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
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
    <div className="observation-detail-metrics observation-stock-metrics"><span>入选参考价<strong>{number(item.reference_close)}</strong><small>{item.reference_date || '未记录参考价'}</small></span><span>最新价<strong>{number(item.latest_close)}</strong><small>{item.latest_date || '无行情'}</small></span><span>至今涨跌幅<strong className={returnClass(item.return_latest)}>{percent(item.return_latest)}</strong></span><span>期间最高涨幅<strong className={returnClass(item.peak_return)}>{percent(item.peak_return)}</strong></span><span>期间最低涨幅<strong className={returnClass(item.trough_return)}>{percent(item.trough_return)}</strong></span><span>观察天数<strong>{item.days} 日</strong></span></div>
    {item.invalid_bars > 0 && <p className="observation-disclosure">期间有 {item.invalid_bars} 根异常行情，区间最高／最低涨幅暂不可用。</p>}
    <label>观察状态<select aria-label="个股观察状态" value={draft.status} disabled={busy} onChange={event => setDrafts(current => ({ ...current, [key]: { ...draft, status: event.target.value } }))}>{Object.entries(watchLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>观察备注<textarea aria-label="观察备注" value={draft.note} disabled={busy} maxLength={2000} rows={4} onChange={event => setDrafts(current => ({ ...current, [key]: { ...draft, note: event.target.value } }))} /><span className="observation-field-hint">{draft.note.length} / 2000</span></label>
    <div className="observation-save-footer"><small>{item.updated_at ? '更新于 ' + timestamp(item.updated_at) : '尚未编辑'}</small><div>{changed && <button className="text-button" disabled={busy} onClick={() => { clear(); setMessage('') }}>恢复已保存记录</button>}<button className="primary-button" disabled={busy || !changed} onClick={() => void save()}>{busy ? '保存中…' : '保存观察记录'}</button></div></div>
    {message && <p className="observation-save-message" role="alert">{message}</p>}
  </section>
}
