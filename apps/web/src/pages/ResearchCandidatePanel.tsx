import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, CheckCheck, ClipboardCheck, ExternalLink, Loader2, Search, Telescope } from 'lucide-react'
import { api } from '../api'
import { isText, useSessionState } from '../useSessionState'

export type ResearchCandidate = {
  id: string; revision: number; source_kind: 'research_candidate'; stock_code: string; name: string
  status: 'watching' | 'priority' | 'ended'; note: string; verification: string; invalidation: string
  conversation_id: string; source_message_id: string; source_text: string; project_id: string | null
  scope: Record<string, unknown> | null; as_of: string | null; source_scope_status: 'frozen' | 'unknown'
  source_scope_revision: number | null; created_at: string; updated_at: string
}
const labels = { watching: '观察中', priority: '重点关注', ended: '结束观察' }
const shortDate = (value: string) => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
const fullDate = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
function scrollToPanel(panel: HTMLElement | null) {
  panel?.focus({ preventScroll: true })
  panel?.scrollIntoView({ behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })
}

export default function ResearchCandidatePanel({ refresh, onOpenResearch, onStartResearch, initialCandidateId, onLocationChange }: { refresh: number; onOpenResearch?: (id: string) => void; onStartResearch?: () => void; initialCandidateId?: string; onLocationChange?: (id: string, userNavigation?: boolean) => void }) {
  const [items, setItems] = useState<ResearchCandidate[]>([])
  const [query, setQuery] = useState(''), [status, setStatus] = useState(''), [sort, setSort] = useState('priority')
  const [offset, setOffset] = useState(0), [total, setTotal] = useState(0)
  const [selected, setSelected] = useSessionState('observation.candidate', '', isText), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [reload, setReload] = useState(0), [notice, setNotice] = useState('')
  const listRef = useRef<HTMLElement>(null), detailRef = useRef<HTMLDivElement>(null)
  const [linkedCandidate, setLinkedCandidate] = useState<ResearchCandidate | null>(null)
  const [linkedError, setLinkedError] = useState('')
  const locationCallback = useRef(onLocationChange)
  locationCallback.current = onLocationChange
  const explicitCandidate = useRef(initialCandidateId)
  explicitCandidate.current = initialCandidateId
  useEffect(() => {
    setLinkedError(''); setLinkedCandidate(null)
    if (!initialCandidateId) return
    const controller = new AbortController()
    setSelected(initialCandidateId)
    api<ResearchCandidate>(`/observation/research-candidates/${encodeURIComponent(initialCandidateId)}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setLinkedCandidate(value); locationCallback.current?.(value.id, false) } })
      .catch(reason => { if (!controller.signal.aborted) setLinkedError((reason as Error).message) })
    return () => controller.abort()
  }, [initialCandidateId, refresh, reload])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const timer = setTimeout(() => {
      api<{ items: ResearchCandidate[]; total: number }>(`/observation/research-candidates?offset=${offset}&limit=30&query=${encodeURIComponent(query)}${status ? `&status=${status}` : ''}&sort=${sort}`, { signal: controller.signal })
        .then(value => {
          if (controller.signal.aborted) return
          if (offset > 0 && !value.items.length && value.total > 0) { setOffset(Math.floor((value.total - 1) / 30) * 30); return }
          setItems(value.items); setTotal(value.total); setSelected(current => current === explicitCandidate.current || value.items.some(item => item.id === current) ? current : '')
        })
        .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [refresh, reload, query, status, offset, sort])
  const ordered = items
  useEffect(() => {
    if (!loading && selected !== initialCandidateId && !ordered.some(item => item.id === selected)) setSelected(ordered[0]?.id ?? '')
  }, [ordered, selected, loading])
  const current = items.find(item => item.id === selected) ?? (linkedCandidate?.id === selected ? linkedCandidate : undefined)
  useEffect(() => { if (current) locationCallback.current?.(current.id, false) }, [current?.id])
  function selectCandidate(id: string) {
    setSelected(id); setNotice('')
    locationCallback.current?.(id, true)
    if (globalThis.matchMedia?.('(max-width: 1100px)').matches) scrollToPanel(detailRef.current)
  }
  function clearFilters() { setQuery(''); setStatus(''); setOffset(0) }
  return <div className="research-observation-panel">
    <div className="observation-candidate-controls">
      <label className="observation-search"><Search size={17} /><input aria-label="搜索研究候选" value={query} placeholder="搜索股票名称、代码或备注" onChange={event => { setQuery(event.target.value); setOffset(0) }} /></label>
      <select aria-label="研究候选状态筛选" value={status} onChange={event => { setStatus(event.target.value); setOffset(0) }}><option value="">全部观察状态</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="研究候选排序" value={sort} onChange={event => setSort(event.target.value)}><option value="priority">重点优先</option><option value="updated">最近更新</option><option value="name">股票名称</option><option value="verification">待补计划优先</option></select>
      {(query || status) && <button className="text-button" onClick={clearFilters}>清除筛选</button>}
    </div>
    {error && <div className="library-error" role="alert">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>重新加载</button></div>}
    {linkedError && <div className="library-error" role="alert">{linkedError}<button className="text-button" onClick={() => setReload(value => value + 1)}>重新读取观察记录</button></div>}
    {notice && <p className="observation-save-message" role="status"><CheckCheck size={15} />{notice}</p>}
    {loading ? <div className="observation-loading" role="status"><Loader2 size={18} />正在读取研究候选…</div> : error ? null : !items.length && !current ? <div className="observation-empty observation-start"><span className="observation-empty-icon"><Telescope size={27} /></span><strong>{query || status ? '没有匹配的研究候选' : '还没有研究候选'}</strong>{query || status ? <button className="secondary-button" onClick={clearFilters}>显示全部研究候选</button> : null}{!query && !status && onStartResearch && <button className="primary-button" onClick={onStartResearch}>开始研究<ArrowRight size={15} /></button>}</div> : <>
      <div className="observation-candidate-overview"><span>{query || status ? '匹配候选' : '研究候选'} <strong>{total}</strong> 条</span><span>当前页 <strong>{items.filter(item => item.status === 'priority').length}</strong> 条重点关注</span><span>当前页 <strong>{items.filter(item => item.status !== 'ended' && !item.verification.trim()).length}</strong> 条待补充验证计划</span></div>
      <div className="observation-workspace research-candidate-workspace">
        <section ref={listRef} tabIndex={-1} className="observation-card observation-results" aria-label="研究候选列表">
          <div className="observation-list-heading"><div><span className="observation-kicker">RESEARCH WATCHLIST</span><h2>研究候选<span>{total}</span></h2></div></div>
          <div className="observation-table-scroll"><table><thead><tr><th>股票 / 状态</th><th>关注理由与验证</th><th>更新</th></tr></thead><tbody>{ordered.map(item => <tr key={item.id} className={selected === item.id ? 'selected' : ''} onClick={() => selectCandidate(item.id)}><td data-label="股票"><button className="stock-link" aria-pressed={selected === item.id} onClick={event => { event.stopPropagation(); selectCandidate(item.id) }}>{item.name || item.stock_code}{item.name && <small>{item.stock_code}</small>}</button><small className={`observation-status ${item.status}`}>{labels[item.status]}</small></td><td className="observation-reason" data-label="关注理由"><span>{item.note || '待补充关注理由'}</span><small className={`observation-verification ${item.verification.trim() ? 'ready' : ''}`}>{item.verification.trim() ? `接下来验证：${item.verification}` : '未记录验证事项'}</small></td><td data-label="更新" className="observation-date"><span title={fullDate(item.updated_at)}>{shortDate(item.updated_at)}</span></td></tr>)}</tbody></table></div>
          <div className="observation-pagination"><span>{offset + 1}–{Math.min(offset + 30, total)} / {total} 条</span><button disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 30))}>上一页候选</button><button disabled={offset + 30 >= total} onClick={() => setOffset(value => value + 30)}>下一页候选</button></div>
        </section>
        {current && <div ref={detailRef} className="observation-detail research-candidate-detail" tabIndex={-1}><button className="secondary-button observation-back" onClick={() => scrollToPanel(listRef.current)}><ArrowLeft size={14} />返回候选列表</button><CandidateDetail key={`${current.id}:${current.revision}`} item={current} onOpenResearch={onOpenResearch} onReload={() => setReload(value => value + 1)} onSaved={value => { setItems(list => list.map(item => item.id === value.id ? value : item)); setLinkedCandidate(current => current?.id === value.id ? value : current); setNotice('研究观察记录已保存'); setReload(current => current + 1) }} /></div>}
      </div>
    </>}
  </div>
}

type CandidateDraft = Pick<ResearchCandidate, 'status' | 'note' | 'verification' | 'invalidation'>
function isCandidateDrafts(value: unknown): value is Record<string, CandidateDraft> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item && typeof item.note === 'string' && typeof item.verification === 'string' && typeof item.invalidation === 'string' && Object.hasOwn(labels, item.status))
}
function CandidateDetail({ item, onSaved, onReload, onOpenResearch }: { item: ResearchCandidate; onSaved: (item: ResearchCandidate) => void; onReload: () => void; onOpenResearch?: (id: string) => void }) {
  const key = `${item.id}:${item.revision}`
  const [drafts, setDrafts] = useSessionState<Record<string, CandidateDraft>>('observation.candidateDrafts', {}, isCandidateDrafts)
  const draft = drafts[key] ?? { status: item.status, note: item.note, verification: item.verification, invalidation: item.invalidation }
  const { status, note, verification, invalidation } = draft
  const updateDraft = (change: Partial<CandidateDraft>) => setDrafts(current => ({ ...current, [key]: { ...draft, ...change } }))
  const clearDraft = () => setDrafts(current => { const next = { ...current }; delete next[key]; return next })
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [conflict, setConflict] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function save() {
    setBusy(true); setMessage(''); setConflict(false)
    try {
      const value = await api<ResearchCandidate>(`/observation/research-candidates/${item.id}`, { method: 'PATCH', body: JSON.stringify({ revision: item.revision, status, note, verification, invalidation }) })
      if (mounted.current) { clearDraft(); onSaved(value) }
    } catch (reason) { if (mounted.current) { const error = reason as Error & { status?: number }; setMessage(error.message); setConflict(error.status === 409 || error.message.includes('重新加载')) } }
    finally { if (mounted.current) setBusy(false) }
  }
  const changed = status !== item.status || note !== item.note || verification !== item.verification || invalidation !== item.invalidation
  return <aside className="observation-card observation-note research-candidate-editor" aria-label="研究候选详情">
    <div className="observation-candidate-identity"><span className="observation-kicker">RESEARCH NOTES</span><h2>{item.name || item.stock_code} · 研究候选</h2><div><span>{item.stock_code}</span><span className={`observation-status ${item.status}`}>{labels[item.status]}</span><span>记录 v{item.revision}</span></div></div>
    <p className="observation-muted">加入于 {fullDate(item.created_at)} · 更新于 {fullDate(item.updated_at)}</p>
    <div className="candidate-next-step"><strong>下一步验证</strong><p>{item.verification.trim() || '未记录验证事项'}</p><small>最近更新 {fullDate(item.updated_at)}</small></div>
    <label>研究候选观察状态<select aria-label="研究候选观察状态" value={status} disabled={busy} onChange={event => updateDraft({ status: event.target.value as typeof status })}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label><span className="observation-field-title"><BookOpen size={15} />关注备注</span><textarea aria-label="研究候选备注" rows={3} maxLength={2000} disabled={busy} value={note} onChange={event => updateDraft({ note: event.target.value })} /></label>
    <div className="observation-verification-plan"><div className="observation-section-heading"><div><ClipboardCheck size={16} /><h3>验证计划</h3></div></div><label>后续验证事项<textarea aria-label="后续验证事项" rows={3} maxLength={2000} disabled={busy} value={verification} onChange={event => updateDraft({ verification: event.target.value })} /></label><label>失效条件<textarea aria-label="失效条件" rows={2} maxLength={2000} disabled={busy} value={invalidation} onChange={event => updateDraft({ invalidation: event.target.value })} /></label></div>
    <div className="observation-save-footer"><small>{changed ? '草稿已暂存' : '记录已保存'}</small><div>{changed && !conflict && <button className="text-button" disabled={busy} onClick={() => { clearDraft(); setMessage('') }}>恢复已保存记录</button>}<button className="primary-button" disabled={busy || !changed || conflict} onClick={() => void save()}>{busy ? '保存中…' : '保存研究观察'}</button></div></div>
    {message && <p className="observation-save-message" role="status">{message}</p>}{conflict && <button className="secondary-button" onClick={() => { clearDraft(); onReload() }}>重新加载较新记录</button>}
    <details className="research-candidate-source"><summary><BookOpen size={15} />研究来源与原答复</summary><p>来源截止日：{item.as_of || '来源未记录截止日'} · {item.source_scope_status === 'frozen' ? `研究范围 v${item.source_scope_revision ?? '—'}` : '旧来源的研究范围未知'}</p><p className="research-candidate-source-text">{item.source_text}</p>{onOpenResearch && <button className="secondary-button" onClick={() => onOpenResearch(item.conversation_id)}><ExternalLink size={14} />打开来源研究对话</button>}</details>
  </aside>
}
