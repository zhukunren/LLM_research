import LoadingState from './LoadingState'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { sourceTime, type ResearchSource } from '../companyResearch'
import type { TrackingCheck, TrackingChange } from '../researchWorkbench'
import { useRemoteResource } from '../useRemoteResource'
import ResearchSourceReader from './ResearchSourceReader'

export default function ResearchChangesPanel({ projectId, code, asOf, writable, onOpenNote }: { projectId: string; code: string; asOf: string; writable: boolean; onOpenNote?: (id: string) => void }) {
  const path = `/research-projects/${projectId}/companies/${code}/changes`
  const resource = useRemoteResource<{ items: TrackingCheck[] }>(path)
  const [current, setCurrent] = useState<TrackingCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<(ResearchSource & { change_key: string }) | null>(null)
  const [reviewing, setReviewing] = useState<TrackingChange | null>(null)
  const [comment, setComment] = useState('')
  const attempt = useRef<{ date: string; id: string } | null>(null)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const history = Array.isArray(resource.data?.items) ? resource.data.items : []
  const check = history.find(item => item.id === current?.id) || current || history[0]
  async function runCheck() {
    if (busy) return
    if (attempt.current?.date !== asOf) attempt.current = { date: asOf, id: crypto.randomUUID() }
    setBusy(true); setError(''); setSelected(null)
    try {
      const result = await api<TrackingCheck>(path, { method: 'POST', body: JSON.stringify({ as_of: asOf, request_id: attempt.current.id }) })
      if (active.current) { setCurrent(result); setReviewing(null); setComment(''); attempt.current = null; resource.retry() }
    } catch (reason) { if (active.current) setError((reason as Error).message) }
    finally { if (active.current) setBusy(false) }
  }
  async function review() {
    if (!check || !reviewing || busy) return
    setBusy(true); setError('')
    try {
      const result = await api<TrackingCheck>(`/research-projects/${projectId}/change-checks/${check.id}/review`, { method: 'POST', body: JSON.stringify({ change_key: reviewing.key, comment }) })
      if (active.current) { setCurrent(result); setReviewing(null); setComment(''); resource.retry() }
    } catch (reason) { if (active.current) setError((reason as Error).message) }
    finally { if (active.current) setBusy(false) }
  }
  return <section className="research-changes-panel" aria-label="公司资料变化">
    <div className="research-section-heading"><h4>资料与研究变化</h4><button className="secondary-button workspace-button" disabled={busy || !writable} onClick={() => void runCheck()}>{busy ? '正在处理…' : check ? '检查资料变化' : '建立跟踪基线'}</button></div>
    {(error || resource.error) && <p role="alert" className="research-error workspace-error">{error || resource.error}<button className="text-button workspace-button" onClick={resource.retry}>重新加载变化记录</button></p>}
    {check ? <>
      <p className="research-secondary">上次检查 {sourceTime(check.created_at)} · 资料截至 {check.as_of} · {check.unreviewed_count} 项未复核</p>
      <p>{check.baseline ? `已建立基线：${check.coverage.reports} 份研报、${check.coverage.news} 份资讯。下次检查将与此版本比较。` : check.changes.length ? `发现 ${check.changes.length} 项变化，需核对对原有判断的影响。` : '本次未发现已接入资料或保存研究的变化。'}</p>
      {check.coverage.inventory_complete === false && <p className="research-secondary">资料数量达到本次清单上限，未据此判定旧资料消失。</p>}
      {check.changes.map(change => <article className="research-change-row" key={change.key}><div><strong>{change.title}</strong><small>{change.category === 'material' ? '资料' : change.category === 'financial' ? '财务数据' : change.category === 'financial_evidence' ? '原文核对' : '保存的研究'} · {change.type === 'added' ? '新增' : change.type === 'updated' ? '修订' : '当前范围不可用'} · {change.review ? '已留复核记录' : '待复核'}</small></div>
        {change.source_id && change.source_type && change.type !== 'unavailable' && <button className="text-button workspace-button" onClick={() => setSelected({ change_key: change.key, source_id: change.source_id!, source_type: change.source_type!, title: change.title, available_at: change.available_at, publication_at: null, page_count: change.page_count || 1 })}>阅读变化原文</button>}
        {change.event && <p>{({ original_value_conflict: '原文数值冲突', original_classification_changed: '原文分类变化，需重新核对', original_check_changed: '原文核对状态变化', new_disclosure: '新披露', source_value_revision: '源数值修订', derived_metric_change: '派生指标变化', contract_change: '字段合同变化，需核对口径', formula_change: '公式版本变化' } as Record<string, string>)[change.event] || '来源变化'}</p>}
        {change.point && <><p>原值 {change.previous?.point?.value ?? '空值'} → 当前值 {change.point.value ?? '空值'} {change.point.unit} · {change.point.reason}</p><details><summary>保存的前后计算与输入</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ before: change.previous?.point, after: change.point }, null, 2)}</pre></details></>}
        {!!change.affected_notes?.length && <div><strong>可能受影响的已保存判断</strong>{change.affected_notes.map(note => <p key={note.note_id}>{note.title}{onOpenNote && <button type="button" className="text-button workspace-button" onClick={() => onOpenNote(note.note_id)}>查看受影响笔记</button>}{note.url && <a href={note.url} target="_blank" rel="noopener noreferrer">旧数字依据</a>}</p>)}</div>}
        {!change.review && writable && <button className="text-button workspace-button" disabled={busy} onClick={() => { setReviewing(change); setComment('') }}>记录复核</button>}
        {change.original_check !== undefined && <details><summary>原文核对记录</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(change.original_check, null, 2)}</pre></details>}{change.review?.comment && <p>{change.review.comment}</p>}
      </article>)}
      {reviewing && <div className="research-workbench-form"><label className="workspace-field-label">复核记录<textarea aria-label="变化复核记录" disabled={busy} value={comment} maxLength={4000} onChange={event => setComment(event.target.value)} placeholder="说明这项变化对原有论点的影响，或还需核对什么。" className="workspace-field" /></label><div className="heading-actions"><button className="primary-button workspace-button" disabled={busy} onClick={() => void review()}>保存复核记录</button><button className="secondary-button workspace-button" disabled={busy} onClick={() => setReviewing(null)}>关闭复核</button></div></div>}
      {check.review_questions.length > 0 && <details><summary>本公司的待验证问题</summary>{check.review_questions.map(question => <div className="research-review-question" key={question.note_id}><strong>{question.title} · 第 {question.revision} 版</strong><p>验证计划：{question.validation_plan || '尚未填写'}</p><p>失效条件：{question.invalidation_condition || '尚未填写'}</p></div>)}</details>}
      {selected && <ResearchSourceReader key={`${check.id}:${selected.source_id}`} projectId={projectId} code={code} asOf={check.as_of} source={selected} sourcePath={`/research-projects/${projectId}/change-checks/${check.id}/sources/${encodeURIComponent(selected.change_key)}`} />}
      <p className="research-secondary">{check.note}</p>
      {history.length > 1 && <details><summary>检查历史</summary>{history.map(item => <button className="text-button workspace-button" key={item.id} disabled={busy} onClick={() => { setCurrent(item); setSelected(null); setReviewing(null) }}>{sourceTime(item.created_at)} · {item.changes.length} 项变化</button>)}</details>}
    </> : !resource.loading && !resource.error ? <p className="research-secondary">首次检查会保存当前资料与研究的基线，此后按变化复核已有判断。</p> : <LoadingState compact label="正在读取变化记录…" />}
  </section>
}
