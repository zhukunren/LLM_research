import { useEffect, useState } from 'react'
import { Play } from 'lucide-react'
import { api, type Filter } from '../api'

type Evaluation = { id: string; status: string; as_of: string; model: string; job_id?: string; job?: { id: string; progress: number; message: string }; coverage: { message?: string; documents_in_window?: number; evaluated?: number; excluded_unconfirmed_availability_date?: number }; result: { assessments?: { document_id: string; title: string; stock_code?: string; binding_status: string; state: string; criteria: { label: string; state: string; summary: string; evidence: { page: number; quote: string }[] }[] }[] } }
const state = (value: string) => ({ true: '符合', false: '不符合', unknown: '数据不足', queued: '等待评估', running: '正在评估', succeeded: '已完成', partial: '部分资料仍需核验', blocked_dependency: '评估依赖未满足', failed: '评估失败', cancelled: '已取消' }[value] ?? value)

export default function ReportEvaluations({ selected }: { selected?: Filter }) {
  const [filters, setFilters] = useState<Filter[]>([])
  const [key, setKey] = useState(selected ? `${selected.id}@${selected.version}` : '')
  const [asOf, setAsOf] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10))
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api<{ items: Filter[] }>('/filters?library=report&include_history=true').then(value => { const items = value.items.filter(f => f.expression.evaluation_mode === 'rubric'); setFilters(items); setKey(previous => previous || (items[0] ? `${items[0].id}@${items[0].version}` : '')) }).catch(e => setError(e.message)) }, [])
  useEffect(() => {
    if (!key) return
    let active = true
    const [id, version] = key.split('@')
    setEvaluation(null)
    api<{ items: { id: string }[] }>(`/report-evaluations?filter_id=${id}&version=${version}`).then(async result => { if (result.items[0]) { const next = await api<Evaluation>(`/report-evaluations/${result.items[0].id}`); if (active) setEvaluation(next) } }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [key])
  useEffect(() => {
    if (!evaluation || !['queued', 'running'].includes(evaluation.status)) return
    let active = true, pending = false
    const timer = globalThis.setInterval(async () => { if (pending) return; pending = true; try { const result = await api<Evaluation>(`/report-evaluations/${evaluation.id}`); if (active) setEvaluation(result) } catch (e) { if (active) setError((e as Error).message) } finally { pending = false } }, 1500)
    return () => { active = false; globalThis.clearInterval(timer) }
  }, [evaluation?.id, evaluation?.status])
  async function start() {
    setBusy(true); setError('')
    const [id, version] = key.split('@')
    try { setEvaluation(await api<Evaluation>(`/filters/${id}/evaluate-reports?version=${version}`, { method: 'POST', body: JSON.stringify({ as_of: asOf }) })) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const condition = filters.find(f => `${f.id}@${f.version}` === key)
  return <section className="report-assessment-panel"><h2>用保存的条件核对研报证据</h2><div className="indicator-controls"><label>判断条件<select value={key} disabled={busy || ['queued', 'running'].includes(evaluation?.status ?? '')} onChange={e => setKey(e.target.value)}><option value="">选择已保存的研报条件</option>{filters.map(f => <option key={`${f.id}@${f.version}`} value={`${f.id}@${f.version}`}>{f.name} · v{f.version}</option>)}</select></label><label>报告截止日<input disabled={busy || ['queued', 'running'].includes(evaluation?.status ?? '')} type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></label><button className="primary-button" disabled={!condition || !asOf || busy || ['queued', 'running'].includes(evaluation?.status ?? '')} onClick={start}><Play size={15} />评估研报</button></div>
    {condition && <p className="source-context">{condition.contract?.summary}</p>}
    {error && <div className="workbench-alert" role="alert">{error}</div>}
    {!filters.length && <div className="workbench-empty"><h3>暂无已保存研报条件</h3></div>}
    {evaluation && evaluation.as_of !== asOf && <div className="history-date-notice" role="status">下方是 {evaluation.as_of} 的历史结果，尚未按当前日期 {asOf} 重新评估。<button className="text-button" disabled={busy || ['queued', 'running'].includes(evaluation.status)} onClick={start}>按当前日期重新评估</button></div>}{evaluation && <div className="assessment-results"><div className="section-title-row"><h2>{state(evaluation.status)}</h2><span>截止 {evaluation.as_of} · {evaluation.model}</span></div><p className="workbench-help">{evaluation.job?.message ?? evaluation.coverage.message} · 已评估 {evaluation.coverage.evaluated ?? 0} 份 · 可用日期未确认 {evaluation.coverage.excluded_unconfirmed_availability_date ?? 0} 份</p>
      {['queued', 'running'].includes(evaluation.status) && <progress max={1} value={evaluation.job?.progress ?? 0} />}
      {evaluation.job && ['queued', 'running'].includes(evaluation.status) && <button className="secondary-button" onClick={async () => { try { await api(`/jobs/${evaluation.job!.id}/cancel`, { method: 'POST' }); setEvaluation(await api(`/report-evaluations/${evaluation.id}`)) } catch (e) { setError((e as Error).message) } }}>取消评估</button>}
      {evaluation.result.assessments?.map(item => <article className="report-proof" key={item.document_id}><h3>{item.title}</h3><p>{state(item.state)} · {item.stock_code ?? '证券关联待确认'}</p>{item.criteria.map((criterion, i) => <div key={i}><strong>{criterion.label} · {state(criterion.state)}</strong><p>{criterion.summary}</p>{criterion.evidence.map((evidence, j) => <blockquote key={j}>第 {evidence.page} 页：“{evidence.quote}”</blockquote>)}</div>)}</article>)}
    </div>}
  </section>
}
