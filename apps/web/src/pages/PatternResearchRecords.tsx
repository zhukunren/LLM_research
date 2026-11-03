import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { History, X } from 'lucide-react'
import { api, type Pattern } from '../api'
import { trapDialogTab } from '../keyboard'
import PatternComparison, { PatternMarketChart, type PatternMatch } from './PatternComparison'
import './PatternResearch.css'

export type SearchRunSummary = { id: string; created_at: string; name: string; requested_as_of?: string | null; as_of?: string | null; selected_key: string; note: string }
type FrozenTemplate = Omit<Pattern, 'id' | 'version' | 'created_at'> & Partial<Pick<Pattern, 'id' | 'version' | 'created_at'>> & { algorithm_version?: string }
export type SearchRun = SearchRunSummary & { template: FrozenTemplate; request: Record<string, unknown>; result: PatternMatch }
type RecordChanges = { selected_key?: string; note?: string }
const sourceLabels: Record<Pattern['input_type'], string> = { market_window: '行情区间', drawing: '手绘', screenshot: '截图', natural_language: '文字' }

export default function PatternResearchRecords({ refreshKey }: { refreshKey?: string }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<SearchRunSummary[]>([])
  const [record, setRecord] = useState<SearchRun | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [note, setNote] = useState('')
  const [listError, setListError] = useState('')
  const [error, setError] = useState('')
  const [listLoading, setListLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState<Record<string, number>>({})
  const [listRevision, setListRevision] = useState(0)
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const noteInput = useRef<HTMLTextAreaElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const mounted = useRef(true)
  const selectedRecord = useRef('')
  const drafts = useRef(new Map<string, string>())
  const savedSelections = useRef(new Map<string, string>())
  const latestSelections = useRef(new Map<string, number>())
  const mutations = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; request.current++ }
  }, [])

  useEffect(() => {
    if (!open) return
    const overflow = document.body.style.overflow
    // The portal stays interactive while the page behind it leaves the tab order.
    const background = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay.current)
    const previousInert = background.map(element => [element, element.getAttribute('inert')] as const)
    background.forEach(element => element.setAttribute('inert', ''))
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    if (selectedRecord.current) void load(selectedRecord.current)
    return () => {
      previousInert.forEach(([element, value]) => { if (value === null) element.removeAttribute('inert'); else element.setAttribute('inert', value) })
      document.body.style.overflow = overflow
      if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true })
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let active = true
    setListLoading(true); setListError('')
    // Reopening must read after any save already requested by the user.
    mutations.current.then(() => active ? api<{ items: SearchRunSummary[] }>('/patterns/search-runs') : null)
      .then(data => { if (active && data) setItems(Array.isArray(data.items) ? data.items : []) })
      .catch(reason => { if (active) setListError((reason as Error).message) })
      .finally(() => { if (active) setListLoading(false) })
    return () => { active = false }
  }, [open, refreshKey, listRevision])

  function close() {
    request.current++
    setOpen(false); setRecord(null); setLoading(false); setError('')
  }

  async function load(recordId: string) {
    const sequence = ++request.current
    selectedRecord.current = recordId
    setSelectedId(recordId); setLoading(true); setError(''); setRecord(null)
    try {
      await mutations.current
      if (!mounted.current || sequence !== request.current) return
      const value = await api<SearchRun>(`/patterns/search-runs/${encodeURIComponent(recordId)}`)
      if (mounted.current && sequence === request.current) {
        savedSelections.current.set(recordId, value.selected_key)
        setRecord(value); setNote(drafts.current.get(recordId) ?? value.note ?? '')
      }
    } catch (reason) { if (mounted.current && sequence === request.current) setError((reason as Error).message) }
    finally { if (mounted.current && sequence === request.current) setLoading(false) }
  }

  function update(changes: RecordChanges) {
    if (!record) return
    const recordId = record.id, view = request.current
    const selection = (latestSelections.current.get(recordId) ?? 0) + 1
    if (changes.selected_key !== undefined) {
      latestSelections.current.set(recordId, selection)
      setRecord(current => current?.id === recordId ? { ...current, selected_key: changes.selected_key! } : current)
    }
    setPending(current => ({ ...current, [recordId]: (current[recordId] ?? 0) + 1 })); setError('')
    // Serialize mutations so a slower earlier choice cannot overwrite a later one.
    mutations.current = mutations.current.then(async () => {
      try {
        const value = await api<SearchRun>(`/patterns/search-runs/${encodeURIComponent(recordId)}`, { method: 'PATCH', body: JSON.stringify(changes) })
        if (!mounted.current) return
        if (changes.selected_key !== undefined) savedSelections.current.set(recordId, value.selected_key)
        if (changes.note !== undefined && drafts.current.get(recordId) === value.note) drafts.current.delete(recordId)
        setItems(current => current.map(item => item.id === recordId ? { ...item, ...changes } : item))
        if (view === request.current) {
          setRecord(current => {
            if (current?.id !== recordId) return current
            return { ...current,
              note: changes.note !== undefined ? value.note : current.note,
              selected_key: changes.selected_key !== undefined && selection === latestSelections.current.get(recordId) ? value.selected_key : current.selected_key,
            }
          })
        }
      } catch (reason) {
        if (mounted.current && view === request.current && (changes.selected_key === undefined || selection === latestSelections.current.get(recordId))) {
          setError((reason as Error).message)
          if (changes.selected_key !== undefined) setRecord(current => current?.id === recordId ? { ...current, selected_key: savedSelections.current.get(recordId) ?? '' } : current)
        }
      } finally {
        if (mounted.current) setPending(current => ({ ...current, [recordId]: Math.max(0, (current[recordId] ?? 1) - 1) }))
      }
    })
  }

  const template = record?.template
  const derivation = template?.derivation
  const sourceMarket = template?.market_source ?? derivation?.market_source
  const sourcePrompt = template?.provenance?.prompt || derivation?.provenance?.prompt
  const sourceImage = template?.source_image ?? derivation?.source_image
  const points = template?.points ?? []
  const low = Math.min(...points), span = Math.max(...points) - low || 1
  const saving = !!(record && pending[record.id])
  useEffect(() => {
    if (!open) return
    const active = document.activeElement
    // Loading can remove the focused control; disabling Save must not strand focus.
    if (active === document.body || active instanceof HTMLElement && overlay.current?.contains(active) && active.matches(':disabled')) {
      if (saving && noteInput.current) noteInput.current.focus()
      else closeButton.current?.focus()
    }
  }, [open, record, loading, saving])
  const target = <section className="pattern-comparison-target" aria-label="记录目标形态">
    <header className="pattern-comparison-chart-heading"><h2>{template?.name || record?.name || '记录目标'}</h2><span>{template?.target_bars} 根 · {template?.id ? `v${template.version}` : '未保存输入'}</span></header>
    {template?.market_source?.bars ? <PatternMarketChart bars={template.market_source.bars} /> : <svg viewBox="0 0 600 160" role="img" aria-label={template?.representation === 'ohlc_sequence' ? '冻结目标收盘路径' : '冻结目标走势'}><polyline points={points.map((value, index) => `${10 + index / Math.max(1, points.length - 1) * 580},${150 - (value - low) / span * 140}`).join(' ')} fill="none" stroke="var(--ui-chart-line)" strokeWidth="2.5" /></svg>}
    {template?.representation === 'ohlc_sequence' && !template.market_source?.bars && <details><summary>模板蜡烛明细（按序号）</summary><p>上图仅为模板收盘路径；以下为冻结 OHLC，不附会真实交易日期。</p><div className="pattern-research-table"><table><thead><tr><th>序号</th><th>开</th><th>高</th><th>低</th><th>收</th></tr></thead><tbody>{template.candlesticks?.map((candle, index) => <tr key={index}><td>{index + 1}</td><td>{candle.open}</td><td>{candle.high}</td><td>{candle.low}</td><td>{candle.close}</td></tr>)}</tbody></table></div></details>}
  </section>

  return <>
    <button ref={trigger} type="button" className="secondary-button workspace-button pattern-research-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(true)}><History size={16} aria-hidden="true" />研究记录</button>
    {open && createPortal(<div ref={overlay} className="pattern-research-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
      <section id={id} className="pattern-research-records workspace-tool-dialog workspace-drawer" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.target instanceof Element && event.target.closest('[role="dialog"]') !== event.currentTarget) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
        else trapDialogTab(event)
      }}>
        <header className="pattern-research-heading"><div><h2 id={`${id}-title`}>研究记录</h2><span>冻结快照 · 仅复查</span></div><button ref={closeButton} type="button" className="icon-button workspace-button" aria-label="关闭研究记录" onClick={close}><X size={18} /></button></header>
        <div className="pattern-research-body">
          <nav className="pattern-research-record-list" aria-label="最近研究记录" aria-busy={listLoading}>
            {items.map(item => <button type="button" className="secondary-button workspace-button" key={item.id} aria-pressed={selectedId === item.id} onClick={() => void load(item.id)}><strong>{item.name || '未命名目标'}</strong><span> · {item.requested_as_of || item.as_of || '最新可得'} · {item.created_at}</span></button>)}
            {!items.length && !listLoading && !listError && <p>暂无研究记录。</p>}
          </nav>
          {listLoading && <p role="status">正在读取记录列表…</p>}
          {listError && <p className="workspace-error" role="alert">{listError}<button type="button" className="text-button workspace-button" onClick={() => setListRevision(value => value + 1)}>重试记录列表</button></p>}
          {error && <p className="workspace-error" role="alert">{error}{!record && selectedId && <button type="button" className="text-button workspace-button" onClick={() => void load(selectedId)}>重试读取记录</button>}</p>}
          {loading && <p role="status">正在读取研究记录…</p>}
          {!record && !loading && !error && items.length > 0 && <p className="pattern-research-empty">选择记录查看快照。</p>}
          {record && <section className="pattern-research-snapshot" aria-label="冻结检索记录">
            <details className="pattern-research-details"><summary>冻结请求与模板口径</summary>
              <p>记录 {record.id} · {record.created_at} · 只读复查，不改变当前编辑模板。</p>
              <p>显示最近 100 次检索。保存的是当次请求、目标与结果快照；未冻结全部原始行情，不保证按当前数据重新计算完全一致。</p>
              <p>请求截止：{record.requested_as_of || '最新可得'}；实际行情截止：{record.as_of || '无可用行情'}；算法：{record.result.algorithm_version || template?.algorithm_version || '未记录'}。</p>
              <p>源指纹：{typeof record.result.source_fingerprint === 'string' ? record.result.source_fingerprint : JSON.stringify(record.result.source_fingerprint ?? '未记录')}</p>
              <p>模板选股参考参数（不筛除本次历史案例）：最低相似度 {String(template?.params?.min_similarity ?? 80)} 分；{template?.params?.match_mode === 'recent' ? `近期 ${String(template.params.recent_bars ?? 20)} 根` : '当前窗口'}。</p>
              <p>模板备注：{template?.note || '无'}</p>
              <p>来源：{template ? sourceLabels[template.input_type] : '未记录'}{derivation && ` · 派生自${sourceLabels[derivation.origin_type]}`}</p>
              {derivation?.source_pattern_id && <p>来源模板：{derivation.source_pattern_id}{derivation.source_pattern_version !== undefined && ` · v${derivation.source_pattern_version}`}</p>}
              {sourcePrompt && <p>原始文字：{sourcePrompt}</p>}
              {sourceImage && <p>原始截图：{sourceImage.filename}</p>}
              {sourceMarket ? <p>{derivation ? '派生行情来源' : '行情来源'}：{sourceMarket.stock_code} · {sourceMarket.start_date} — {sourceMarket.end_date} · {sourceMarket.price_basis === 'unadjusted' ? '未复权' : sourceMarket.price_basis} · 快照 {sourceMarket.snapshot_id}</p> : derivation?.source_window_id && <p>来源行情快照：{derivation.source_window_id}</p>}
              {derivation?.source_draft_id && <p>来源文字草稿：{derivation.source_draft_id}</p>}
              {(template?.input_type === 'screenshot' || derivation?.origin_type === 'screenshot' || sourceImage) && <p>此记录保存目标与来源元数据，原图不包含在结果快照内；质量说明：{JSON.stringify(template?.params?.screenshot_quality ?? '未记录')}</p>}
            </details>
            <PatternComparison target={target} matchAction={<span>已保存结果快照</span>} result={record.result} loading={false} error="" selectedKey={record.selected_key} onSelect={key => update({ selected_key: key })} onRetry={() => void load(record.id)} />
            <div className="pattern-research-note"><label className="field workspace-field-label"><span>研究记录备注</span><textarea ref={noteInput} className="workspace-field" rows={3} value={note} maxLength={4000} onChange={event => { const value = event.target.value; drafts.current.set(record.id, value); setNote(value) }} /></label><div><button type="button" className="secondary-button workspace-button" disabled={saving || note === (record.note || '')} onClick={() => update({ note })}>保存研究备注</button>{saving ? <span role="status">正在保存…</span> : note !== (record.note || '') && <span>未保存</span>}</div></div>
          </section>}
        </div>
      </section>
    </div>, document.body)}
  </>
}
