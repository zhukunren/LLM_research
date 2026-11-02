import LoadingState from './LoadingState'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../api'
import { evidenceStances, sourceTime, type ResearchSource, type SourceChunk } from '../companyResearch'
import type { ResearchProject } from '../research'
import { cellStatuses, type MatrixCell, type MatrixDefinition, type MatrixRun } from '../researchWorkbench'
import { useRemoteResource } from '../useRemoteResource'
import { useSessionState } from '../useSessionState'
import ResearchSourceReader, { CompanySources } from './ResearchSourceReader'

type EvidenceInput = { kind: SourceChunk['source_type']; source_id: string; page_number: number; offset: number; quote: string; start_hint: number | null; stance: keyof typeof evidenceStances }
type RunList = { matrix: MatrixDefinition; items: MatrixRun[] }
const runLabels: Record<string, string> = { queued: '排队中', running: '生成中', succeeded: '已完成', partial: '部分完成', failed: '生成失败', cancelled: '已停止' }
type CellDraft = { answer: string; status: MatrixCell['status']; comment: string; evidence: EvidenceInput[]; base_revision: number; attempt?: { key: string; id: string } }
function validCellDrafts(value: unknown): value is Record<string, CellDraft> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item && typeof item.answer === 'string' && typeof item.comment === 'string'
    && Object.prototype.hasOwnProperty.call(cellStatuses, item.status) && Number.isInteger(item.base_revision) && item.base_revision >= 0
    && Array.isArray(item.evidence) && item.evidence.length <= 4 && item.evidence.every((reference: EvidenceInput) => reference && ['news', 'report', 'disclosure'].includes(reference.kind) && typeof reference.source_id === 'string' && typeof reference.quote === 'string')
    && (item.attempt === undefined || (typeof item.attempt.key === 'string' && typeof item.attempt.id === 'string')))
}

function useRuns(path: string | null) {
  const [revision, refresh] = useState(0)
  const [state, setState] = useState<{ path: string | null; data: RunList | null; error: string; loading: boolean }>({ path, data: null, error: '', loading: !!path })
  useEffect(() => {
    if (!path) { setState({ path, data: null, error: '', loading: false }); return }
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    setState(previous => previous.path === path ? { ...previous, loading: true, error: '' } : { path, data: null, error: '', loading: true })
    const read = async () => {
      try {
        const data = await api<RunList>(path, { signal: controller.signal })
        if (!active) return
        setState({ path, data, error: '', loading: false })
        if (data.items.some(item => ['queued', 'running'].includes(item.status))) timer = setTimeout(() => void read(), 1800)
      } catch (reason) { if (active) setState(previous => ({ ...previous, path, loading: false, error: (reason as Error).message })) }
    }
    void read()
    return () => { active = false; controller.abort(); if (timer) clearTimeout(timer) }
  }, [path, revision])
  return { ...(state.path === path ? state : { data: null, error: '', loading: !!path }), retry: () => refresh(value => value + 1) }
}

function CellEditor({ projectId, matrix, run, cell, onSaved, onClose }: { projectId: string; matrix: MatrixDefinition; run: MatrixRun; cell: MatrixCell; onSaved: () => void; onClose: () => void }) {
  const draftKey = `${projectId}:${matrix.id}:${run.id}:${cell.stock_code}:${cell.question_id}`
  const initial = useRef<CellDraft>({ answer: cell.answer, status: cell.status, comment: cell.comment || '', base_revision: cell.review_revision,
    evidence: cell.evidence.map(item => ({ kind: item.source_type, source_id: item.source_id, page_number: item.page_number, offset: item.char_start, quote: item.quote, start_hint: item.quote_start ?? null, stance: item.stance })) })
  const [drafts, setDrafts] = useSessionState<Record<string, CellDraft>>('research.matrixCellDrafts', {}, validCellDrafts)
  const draft = drafts[draftKey] || initial.current
  const { answer, status, comment, evidence: references } = draft
  const change = (values: Partial<CellDraft>) => setDrafts(current => ({ ...current, [draftKey]: { ...(current[draftKey] || initial.current), ...values, attempt: undefined } }))
  const setAnswer = (value: string) => change({ answer: value })
  const setStatus = (value: MatrixCell['status']) => change({ status: value })
  const setComment = (value: string) => change({ comment: value })
  const setReferences = (update: (value: EvidenceInput[]) => EvidenceInput[]) => setDrafts(current => { const value = current[draftKey] || initial.current; return { ...current, [draftKey]: { ...value, evidence: update(value.evidence), attempt: undefined } } })
  const [source, setSource] = useState<ResearchSource | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const payload = { stock_code: cell.stock_code, question_id: cell.question_id, base_revision: draft.base_revision, answer, status, comment, evidence: references }
    const key = JSON.stringify(payload)
    const attempt = draft.attempt?.key === key ? draft.attempt : { key, id: crypto.randomUUID() }
    setDrafts(current => ({ ...current, [draftKey]: { ...(current[draftKey] || initial.current), attempt } }))
    setBusy(true); setError('')
    try {
      await api(`/research-projects/${projectId}/matrices/${matrix.id}/runs/${run.id}/review`, { method: 'POST', body: JSON.stringify({ ...payload, request_id: attempt.id }) })
      if (active.current) { setDrafts(current => { const next = { ...current }; delete next[draftKey]; return next }); onSaved() }
    } catch (reason) { if (active.current) setError((reason as Error).message) }
    finally { if (active.current) setBusy(false) }
  }
  return <section className="research-matrix-editor" aria-label="核对对比单元格">
    <h4>{cell.stock_code} · {matrix.questions.find(item => item.id === cell.question_id)?.label}</h4>
    <form className="research-workbench-form workspace-form" onSubmit={event => void save(event)}>
      <label className="workspace-field-label">结论<textarea aria-label="单元格结论" value={answer} maxLength={5000} rows={3} disabled={busy} onChange={event => setAnswer(event.target.value)} className="workspace-field" /></label>
      <label className="workspace-field-label">核对状态<select aria-label="单元格核对状态" value={status} disabled={busy} onChange={event => setStatus(event.target.value as MatrixCell['status'])} className="workspace-field workspace-select">{Object.entries(cellStatuses).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label className="workspace-field-label">修订说明<textarea aria-label="单元格修订说明" value={comment} maxLength={2000} disabled={busy} onChange={event => setComment(event.target.value)} className="workspace-field" /></label>
      {references.map((reference, index) => <div className="research-citation" key={`${reference.source_id}:${index}`}><blockquote>{reference.quote}</blockquote><label className="workspace-field-label">证据关系<select aria-label={`第 ${index + 1} 条证据关系`} value={reference.stance} disabled={busy} onChange={event => setReferences(values => values.map((value, position) => position === index ? { ...value, stance: event.target.value as EvidenceInput['stance'] } : value))} className="workspace-field workspace-select">{Object.entries(evidenceStances).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button type="button" className="text-button workspace-button" disabled={busy} onClick={() => setReferences(values => values.filter((_, position) => position !== index))}>移除此条引用</button></div>)}
      {error && <p role="alert" className="research-error workspace-error">{error}</p>}
      {(run.cells.find(item => item.stock_code === cell.stock_code && item.question_id === cell.question_id)?.review_revision ?? 0) !== draft.base_revision && <p className="research-secondary">原单元格已有新修订，当前草稿仍保留。<button type="button" className="text-button workspace-button" disabled={busy} onClick={() => change({ base_revision: run.cells.find(item => item.stock_code === cell.stock_code && item.question_id === cell.question_id)!.review_revision })}>按最新版本继续核对草稿</button></p>}
      <div className="heading-actions"><button className="primary-button workspace-button" type="submit" disabled={busy}>{busy ? '保存中…' : '保存单元格修订'}</button><button type="button" className="secondary-button workspace-button" disabled={busy} onClick={onClose}>关闭核对</button></div>
    </form>
    {references.length < 4 && <details><summary>从本公司资料补充引用</summary><CompanySources projectId={projectId} code={cell.stock_code} asOf={run.as_of} onChoose={setSource} />
      {source && <ResearchSourceReader key={source.source_id} projectId={projectId} code={cell.stock_code} asOf={run.as_of} source={source} onQuote={(quote, hint, chunk) => setReferences(values => [...values.slice(0, 3), { kind: chunk.source_type, source_id: chunk.source_id, page_number: chunk.page_number, offset: chunk.char_start, quote, start_hint: hint, stance: 'supports' }])} />}
    </details>}
  </section>
}

export default function ResearchMatrixPanel({ project, asOf, onDateChange, initialMatrixId = '', initialRunId = '' }: { project: ResearchProject; asOf: string; onDateChange: (value: string) => void; initialMatrixId?: string; initialRunId?: string }) {
  const root = `/research-projects/${project.id}/matrices`
  const catalog = useRemoteResource<{ items: MatrixDefinition[] }>(`${root}${initialMatrixId ? `?include_matrix=${encodeURIComponent(initialMatrixId)}` : ''}`)
  const [selected, setSelected] = useState(initialMatrixId)
  const [selectedRun, setSelectedRun] = useState(initialRunId)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('同业资料对比')
  const [codes, setCodes] = useState(project.companies.slice(0, 10).map(item => item.stock_code))
  const [questions, setQuestions] = useState('订单和收入兑现的原文证据是什么？\n盈利变化的原因及报告期是什么？\n主要风险和反方证据是什么？')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<MatrixCell | null>(null)
  const [questionChoice, setQuestionChoice] = useState<{ matrix: string; question: string } | null>(null)
  const [snapshot, setSnapshot] = useState<SourceChunk | null>(null)
  const active = useRef(true)
  const request = useRef(0)
  const createAttempt = useRef<{ key: string; id: string } | null>(null)
  const runAttempt = useRef<{ key: string; id: string } | null>(null)
  const definitions = catalog.data?.items || []
  const matrix = definitions.find(item => item.id === selected) || definitions[0]
  const readingQuestion = (questionChoice?.matrix === matrix?.id && matrix?.questions.find(item => item.id === questionChoice?.question)?.id) || matrix?.questions[0]?.id || ''
  const resource = useRuns(matrix ? `${root}/${matrix.id}/runs${selectedRun ? `?include_run=${encodeURIComponent(selectedRun)}` : ''}` : null)
  const run = resource.data?.items.find(item => item.id === selectedRun) || resource.data?.items[0]
  const generating = !!run && ['queued', 'running'].includes(run.status)
  const writable = project.status === 'active'
  useEffect(() => { setCodes(values => values.filter(code => project.companies.some(company => company.stock_code === code))) }, [project.companies])
  useEffect(() => { active.current = true; return () => { active.current = false; request.current += 1 } }, [])
  useEffect(() => { setEditing(null); setSnapshot(null); request.current += 1 }, [matrix?.id, run?.id])
  async function create(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const lines = questions.split('\n').map(item => item.trim()).filter(Boolean)
    if (!lines.length || lines.length > 6 || !codes.length || codes.length > 10) { setError('请选择 1–10 家公司并填写 1–6 项研究问题。'); return }
    const payload = { name, stock_codes: codes, questions: lines.map((prompt, index) => ({ id: `q${index + 1}`, label: prompt.slice(0, 60), prompt })) }
    const key = JSON.stringify(payload)
    if (createAttempt.current?.key !== key) createAttempt.current = { key, id: crypto.randomUUID() }
    setBusy(true); setError('')
    try {
      const created = await api<MatrixDefinition>(root, { method: 'POST', body: JSON.stringify({ ...payload, request_id: createAttempt.current.id }) })
      if (active.current) { setSelected(created.id); setSelectedRun(''); setCreating(false); catalog.retry() }
    } catch (reason) { if (active.current) setError((reason as Error).message) }
    finally { if (active.current) setBusy(false) }
  }
  async function start(mode: 'manual' | 'assisted') {
    if (!matrix || busy) return
    const key = JSON.stringify([matrix.id, asOf, mode])
    if (runAttempt.current?.key !== key) runAttempt.current = { key, id: crypto.randomUUID() }
    setBusy(true); setError('')
    try {
      const started = await api<MatrixRun>(`${root}/${matrix.id}/runs`, { method: 'POST', body: JSON.stringify({ as_of: asOf, mode, request_id: runAttempt.current.id }) })
      if (active.current) { setSelectedRun(started.id); setEditing(null); setSnapshot(null); runAttempt.current = null; resource.retry() }
    } catch (reason) { if (active.current) setError((reason as Error).message) }
    finally { if (active.current) setBusy(false) }
  }
  async function stop() {
    if (!matrix || !run || busy) return
    setBusy(true); setError('')
    try { await api(`${root}/${matrix.id}/runs/${run.id}/cancel`, { method: 'POST' }); if (active.current) resource.retry() }
    catch (reason) { if (active.current) setError((reason as Error).message) }
    finally { if (active.current) setBusy(false) }
  }
  async function readEvidence(cell: MatrixCell, index: number) {
    if (!matrix || !run) return
    const current = ++request.current
    setError(''); setSnapshot(null)
    try {
      const params = new URLSearchParams({ stock_code: cell.stock_code, question_id: cell.question_id, index: String(index) })
      const result = await api<SourceChunk>(`${root}/${matrix.id}/runs/${run.id}/evidence?${params}`)
      if (active.current && current === request.current) setSnapshot(result)
    } catch (reason) { if (active.current && current === request.current) setError((reason as Error).message) }
  }
  return <section className="research-matrix-panel" aria-label="同业对比矩阵">
    <div className="research-section-heading"><h3>同业对比</h3><button className="secondary-button workspace-button" disabled={!writable || busy || !project.companies.length} onClick={() => setCreating(true)}>新建对比矩阵</button></div>
    {!project.companies.length && <p>先在项目中关联公司，再建立对比。</p>}
    {(error || catalog.error || resource.error) && <p role="alert" className="research-error workspace-error">{error || catalog.error || resource.error}<button className="text-button workspace-button" onClick={() => { catalog.retry(); resource.retry() }}>重新加载对比</button></p>}
    {creating && <form className="research-workbench-form workspace-form" aria-label="新建对比矩阵" onSubmit={event => void create(event)}>
      <label className="workspace-field-label">对比名称<input aria-label="对比名称" value={name} maxLength={100} required disabled={busy} onChange={event => setName(event.target.value)} className="workspace-field" /></label>
      <fieldset><legend>选择公司（最多 10 家）</legend><div className="research-matrix-company-options">{project.companies.map(company => <label key={company.stock_code} className="workspace-check-label"><input type="checkbox" checked={codes.includes(company.stock_code)} disabled={busy || !codes.includes(company.stock_code) && codes.length >= 10} onChange={event => setCodes(values => event.target.checked ? [...values, company.stock_code] : values.filter(code => code !== company.stock_code))} className="workspace-check" />{company.name || company.stock_code}</label>)}</div></fieldset>
      <label className="workspace-field-label">研究问题（每行一项，最多 6 项）<textarea aria-label="对比研究问题" rows={5} value={questions} maxLength={6000} disabled={busy} onChange={event => setQuestions(event.target.value)} className="workspace-field" /></label>
      <div className="heading-actions"><button className="primary-button workspace-button" type="submit" disabled={busy || !name.trim()}>保存对比模板</button><button type="button" className="secondary-button workspace-button" disabled={busy} onClick={() => setCreating(false)}>关闭新建</button></div>
    </form>}
    {definitions.length > 0 && <label className="company-research-date workspace-field-label">已保存模板<select aria-label="已保存对比模板" disabled={busy} value={matrix?.id || ''} onChange={event => { setSelected(event.target.value); setSelectedRun('') }} className="workspace-field workspace-select">{definitions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {matrix && <>
      <p className="research-secondary">{matrix.stock_codes.length} 家公司 · {matrix.questions.length} 个问题。自动生成每家公司最多调用一次模型，仅使用有界本地资料摘录；结果需要核对。</p>
      <div className="heading-actions"><label className="company-research-date workspace-field-label">资料截至<input aria-label="对比资料截止日" type="date" disabled={busy} value={asOf} onChange={event => { if (event.target.value) onDateChange(event.target.value) }} className="workspace-field" /></label><button className="secondary-button workspace-button" disabled={busy || !writable || generating} onClick={() => void start('manual')}>创建空白对比</button><button className="primary-button workspace-button" disabled={busy || !writable || generating} onClick={() => void start('assisted')}>根据本地资料生成</button>{generating && <button className="secondary-button workspace-button" disabled={busy} onClick={() => void stop()}>停止本次生成</button>}</div>
      {run ? <>
        <div className="heading-actions"><label className="workspace-field-label">运行版本<select aria-label="对比运行版本" disabled={busy} value={run.id} onChange={event => setSelectedRun(event.target.value)} className="workspace-field workspace-select">{resource.data?.items.map(item => <option key={item.id} value={item.id}>{sourceTime(item.created_at)} · {item.as_of} · {item.mode === 'manual' ? '手动' : '辅助生成'} · {runLabels[item.status] || item.status}</option>)}</select></label><a className="secondary-button workspace-button" href={`/api/v1${root}/${matrix.id}/runs/${run.id}/export`}>导出 Excel</a><button className="text-button workspace-button" onClick={resource.retry}>刷新对比结果</button></div>
        <p role={generating ? 'status' : undefined}>本次资料截至 {run.as_of} · {run.summary.located}/{run.summary.total} 格有原文依据 · {run.summary.reviewed} 格留有人工修订{generating ? ' · 后台正在生成，可以离开页面后返回。' : ''}</p>
        {['failed', 'partial'].includes(run.status) && <p className="research-secondary">部分生成未完成，已保存的结果仍可核对和修订；也可重新生成新版本。</p>}
        <label className="research-matrix-question-picker workspace-field-label">按问题阅读<select aria-label="按问题阅读" value={readingQuestion} onChange={event => { setQuestionChoice({ matrix: matrix.id, question: event.target.value }); setSnapshot(null); request.current += 1 }} className="workspace-field workspace-select">{matrix.questions.map(question => <option key={question.id} value={question.id}>{question.label}</option>)}</select></label>
        <div className="research-matrix-scroll workspace-table-scroll" tabIndex={0} role="region" aria-label="公司研究对比表"><table className="research-matrix-table workspace-data-table"><caption>{matrix.name} · 资料截至 {run.as_of}</caption><thead><tr><th scope="col">公司</th>{matrix.questions.map(question => <th scope="col" key={question.id} data-active-question={question.id === readingQuestion}>{question.label}</th>)}</tr></thead><tbody>{matrix.stock_codes.map(code => <tr key={code}><th scope="row">{project.companies.find(item => item.stock_code === code)?.name || code}<small>{code}</small></th>{matrix.questions.map(question => {
          const cell = run.cells.find(item => item.stock_code === code && item.question_id === question.id)
          return <td key={question.id} data-active-question={question.id === readingQuestion}>{cell ? <><span className={["workspace-status", `research-cell-status ${cell.status}`].filter(Boolean).join(' ')}>{cellStatuses[cell.status]}</span><p>{cell.answer || '尚无结论'}</p>{cell.validation_note && <small>{cell.validation_note}</small>}<div className="heading-actions">{cell.evidence.map((_, index) => <button key={index} className="text-button workspace-button" onClick={() => void readEvidence(cell, index)}>依据 {index + 1}</button>)}{writable && !generating && <button className="text-button workspace-button" aria-label={`核对 ${code} · ${question.label}`} onClick={() => { setEditing(cell); setSnapshot(null) }}>核对与修订</button>}</div></> : '待处理'}</td>
        })}</tr>)}</tbody></table></div>
        {snapshot && <ResearchSourceReader projectId={project.id} snapshot={snapshot} />}
        {editing && <CellEditor key={`${run.id}:${editing.stock_code}:${editing.question_id}`} projectId={project.id} matrix={matrix} run={run} cell={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); resource.retry() }} />}
        {run.previous_run_id && <details><summary>与上次已完成运行的差异（{run.changes.length} 格）</summary>{run.changes.length ? run.changes.map(change => <div className="research-matrix-diff" key={`${change.stock_code}:${change.question_id}`}><strong>{change.stock_code} · {matrix.questions.find(question => question.id === change.question_id)?.label}</strong><p>上次：{change.previous_answer || cellStatuses[change.previous_status as MatrixCell['status']]}</p><p>本次：{change.answer || cellStatuses[change.status as MatrixCell['status']]}</p></div>) : <p>结论、状态和引用未发现变化。</p>}</details>}
        <details><summary>资料读取范围</summary>{Object.entries(run.coverage).map(([code, coverage]) => <p key={code}>{code} · {coverage.reports} 份研报、{coverage.news} 份资讯 · 本次使用 {coverage.read_chunks} 个摘录。{coverage.note}</p>)}</details>
        {Object.keys(run.measurements || {}).length > 0 && <details><summary>生成耗时与用量</summary>{Object.entries(run.measurements!).map(([code, metric]) => <p key={code}>{code} · {metric.seconds} 秒 · {metric.model || (metric.model_called ? '模型未返回记录' : '未调用模型')}{Object.keys(metric.tokens || {}).length ? ` · ${Object.entries(metric.tokens!).map(([name, count]) => `${name}: ${count}`).join('，')}` : ' · 无供应商用量记录'}</p>)}<p className="research-secondary">用量来自供应商响应；费用需按实际账户价格核对。</p></details>}
        <p className="research-secondary">{run.note}</p>
      </> : resource.loading ? <LoadingState compact label="正在读取对比运行…" /> : <p>模板已保存。可创建空白对比，或根据本地资料生成一版结果。</p>}
    </>}
    {catalog.loading && <LoadingState compact label="正在读取对比模板…" />}
  </section>
}
