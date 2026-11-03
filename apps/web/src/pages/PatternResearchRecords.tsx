import { useEffect, useRef, useState } from 'react'
import { api, type Pattern } from '../api'
import PatternComparison, { PatternMarketChart, type PatternMatch } from './PatternComparison'

export type SearchRunSummary = { id: string; created_at: string; name: string; requested_as_of?: string | null; as_of?: string | null; selected_key: string; note: string }
type FrozenTemplate = Omit<Pattern, 'id' | 'version' | 'created_at'> & Partial<Pick<Pattern, 'id' | 'version' | 'created_at'>> & { algorithm_version?: string }
export type SearchRun = SearchRunSummary & { template: FrozenTemplate; request: Record<string, unknown>; result: PatternMatch }
export default function PatternResearchRecords({ refreshKey }: { refreshKey?: string }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<SearchRunSummary[]>([])
  const [record, setRecord] = useState<SearchRun | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  useEffect(() => {
    if (!open) return
    let active = true
    api<{ items: SearchRunSummary[] }>('/patterns/search-runs').then(data => { if (active) setItems(Array.isArray(data.items) ? data.items : []) }).catch(reason => { if (active) setError((reason as Error).message) })
    return () => { active = false }
  }, [open, refreshKey])
  useEffect(() => () => { request.current++ }, [])
  async function load(id: string) {
    const sequence = ++request.current
    setBusy(true); setError(''); setRecord(null)
    try { const value = await api<SearchRun>(`/patterns/search-runs/${encodeURIComponent(id)}`); if (sequence === request.current) { setRecord(value); setNote(value.note || '') } }
    catch (reason) { if (sequence === request.current) setError((reason as Error).message) }
    finally { if (sequence === request.current) setBusy(false) }
  }
  async function update(changes: { selected_key?: string; note?: string }) {
    if (!record) return
    const id = record.id, sequence = ++request.current
    setBusy(true); setError('')
    try {
      const value = await api<SearchRun>(`/patterns/search-runs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(changes) })
      if (sequence === request.current) { setRecord(value); setItems(previous => previous.map(item => item.id === id ? { ...item, ...changes } : item)) }
    } catch (reason) { if (sequence === request.current) setError((reason as Error).message) }
    finally { if (sequence === request.current) setBusy(false) }
  }
  const template = record?.template
  const points = template?.points ?? []
  const low = Math.min(...points), span = Math.max(...points) - low || 1
  const target = <section className="pattern-comparison-target" aria-label="记录目标形态"><header className="pattern-comparison-chart-heading"><h2>{template?.name || record?.name || '记录目标'}</h2><span>{template?.target_bars} 根 · {template?.id ? `v${template.version}` : '未保存输入'}</span></header>{template?.market_source?.bars ? <PatternMarketChart bars={template.market_source.bars} /> : <svg viewBox="0 0 600 160" role="img" aria-label={template?.representation === 'ohlc_sequence' ? '冻结目标收盘路径' : '冻结目标走势'}><polyline points={points.map((value, index) => `${10 + index / Math.max(1, points.length - 1) * 580},${150 - (value - low) / span * 140}`).join(' ')} fill="none" stroke="var(--ui-chart-line)" strokeWidth="2.5" /></svg>}{template?.representation === 'ohlc_sequence' && !template.market_source?.bars && <><p>上图仅为模板收盘路径；以下为冻结 OHLC，不附会真实交易日期。</p><details><summary>模板蜡烛明细（按序号）</summary><table><thead><tr><th>序号</th><th>开</th><th>高</th><th>低</th><th>收</th></tr></thead><tbody>{template.candlesticks?.map((candle, index) => <tr key={index}><td>{index + 1}</td><td>{candle.open}</td><td>{candle.high}</td><td>{candle.low}</td><td>{candle.close}</td></tr>)}</tbody></table></details></>}</section>
  return <details className="pattern-research-records" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary tabIndex={0} aria-expanded={open} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(value => !value) } }}>检索研究记录</summary>
    <p>显示最近 100 次检索。保存的是当次请求、目标与结果快照，可复查；未冻结全部原始行情，不保证按当前数据重新计算完全一致。</p>
    {error && <p className="workspace-error" role="alert">{error}</p>}
    {open && <div className="pattern-research-record-list">{items.length ? items.map(item => <button type="button" className="secondary-button workspace-button" key={item.id} disabled={busy} aria-pressed={record?.id === item.id} onClick={() => void load(item.id)}>{item.name || '未命名目标'} · {item.requested_as_of || item.as_of || '最新可得'} · {item.created_at}</button>) : <p>暂无持久化检索记录。</p>}</div>}
    {busy && <p role="status">正在保存或读取研究记录…</p>}
    {record && <section aria-label="冻结检索记录"><p>记录 {record.id} · {record.created_at} · 只读复查，不改变当前编辑模板。</p><details><summary>冻结请求与模板口径</summary><p>请求截止：{record.requested_as_of || '最新可得'}；实际行情截止：{record.as_of || '无可用行情'}；算法：{record.result.algorithm_version || template?.algorithm_version || '未记录'}。</p><p>源指纹：{typeof record.result.source_fingerprint === 'string' ? record.result.source_fingerprint : JSON.stringify(record.result.source_fingerprint ?? '未记录')}</p><p>模板选股参考参数（不筛除本次历史案例）：最低相似度 {String(template?.params?.min_similarity ?? 80)} 分；{template?.params?.match_mode === 'recent' ? `近期 ${String(template.params.recent_bars ?? 20)} 根` : '当前窗口'}。</p><p>模板备注：{template?.note || '无'}</p>{template?.input_type === 'screenshot' && <p>截图研究记录保留提取后目标与质量说明，不保存未入库原图；质量说明：{JSON.stringify(template.params?.screenshot_quality ?? '未记录')}</p>}</details><PatternComparison target={target} matchAction={<span>已保存结果快照</span>} result={record.result} loading={false} error="" selectedKey={record.selected_key} onSelect={key => { if (!busy) void update({ selected_key: key }) }} onRetry={() => void load(record.id)} /><label className="field workspace-field-label"><span>研究记录备注</span><textarea className="workspace-field" value={note} maxLength={4000} onChange={event => setNote(event.target.value)} /></label><button type="button" className="secondary-button workspace-button" disabled={busy || note === record.note} onClick={() => void update({ note })}>保存研究备注</button></section>}
  </details>
}
