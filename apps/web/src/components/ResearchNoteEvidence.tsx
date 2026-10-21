import LoadingState from './LoadingState'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { claimKinds, evidenceStances, type ResearchClaim, type ResearchSource, type SourceChunk } from '../companyResearch'
import type { ResearchNote, ResearchProject } from '../research'
import ResearchSourceReader, { CompanySources } from './ResearchSourceReader'

function ClaimBuilder({ project, note, asOf, onSaved, onClose }: { project: ResearchProject; note: ResearchNote; asOf: string; onSaved: () => void; onClose: () => void }) {
  const [code, setCode] = useState(note.stock_code || project.companies[0]?.stock_code || '')
  const [date, setDate] = useState(asOf)
  const [statement, setStatement] = useState('')
  const [kind, setKind] = useState<keyof typeof claimKinds>('inference')
  const [stance, setStance] = useState<keyof typeof evidenceStances>('supports')
  const [selected, setSelected] = useState<ResearchSource | null>(null)
  const [reference, setReference] = useState<{ quote: string; start_hint: number | null; chunk: SourceChunk } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [numericInput, setNumericInput] = useState('')
  const numericIds = [...new Set(numericInput.match(/[a-f0-9]{64}/g) || [])]
  const numericValid = !numericInput.trim() || numericIds.length >= 1 && numericIds.length <= 8
  const attempt = useRef<{ key: string; id: string } | null>(null)
  async function save() {
    if (!numericValid || !reference && !numericIds.length) return
    const payload = { note_revision: note.revision, stock_code: code, statement, kind, as_of: date,
      evidence: reference ? [{ kind: reference.chunk.source_type, source_id: reference.chunk.source_id, page_number: reference.chunk.page_number, offset: reference.chunk.char_start, quote: reference.quote, start_hint: reference.start_hint, stance }] : [],
      numeric_evidence: numericIds }
    const key = JSON.stringify(payload)
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() }
    setBusy(true); setError('')
    try {
      await api(`/research-projects/${project.id}/notes/${note.id}/claims`, { method: 'POST', body: JSON.stringify({ ...payload, request_id: attempt.current.id }) })
      onSaved()
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="research-claim-builder" aria-label="添加判断与依据">
    <div className="research-editor-fields"><label className="workspace-field-label">关联公司<select aria-label="依据关联公司" value={code} disabled={!!note.stock_code || busy} onChange={event => { setCode(event.target.value); setSelected(null); setReference(null) }} className="workspace-field workspace-select"><option value="">选择公司</option>{project.companies.map(company => <option key={company.stock_code} value={company.stock_code}>{company.name || company.stock_code}</option>)}</select></label><label className="workspace-field-label">研究截至<input aria-label="依据截止日" type="date" required value={date} disabled={busy} onChange={event => { setDate(event.target.value); setSelected(null); setReference(null) }} className="workspace-field" /></label></div>
    <label className="workspace-field-label">需要定位依据的判断<textarea aria-label="判断内容" rows={2} maxLength={2000} required value={statement} onChange={event => setStatement(event.target.value)} className="workspace-field" /></label>
    <label className="workspace-field-label">独立数字依据标识或链接<input className="workspace-field" aria-label="独立数字依据标识或链接" value={numericInput} onChange={event => setNumericInput(event.target.value)} placeholder="粘贴财务数字依据的标识或链接，最多 8 份" /></label>
    {!numericValid && <p role="alert">请提供有效依据标识或链接，最多 8 份；不会自动丢弃多余引用。</p>}
    <div className="research-editor-fields"><label className="workspace-field-label">判断类别<select aria-label="判断类别" value={kind} onChange={event => setKind(event.target.value as keyof typeof claimKinds)} className="workspace-field workspace-select">{Object.entries(claimKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="workspace-field-label">原文与判断的关系<select aria-label="证据关系" value={stance} onChange={event => setStance(event.target.value as keyof typeof evidenceStances)} className="workspace-field workspace-select">{Object.entries(evidenceStances).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {code && date && <CompanySources key={`${code}:${date}`} projectId={project.id} code={code} asOf={date} onChoose={source => { setSelected(source); setReference(null) }} />}
    {selected && <ResearchSourceReader key={selected.source_id} projectId={project.id} code={code} asOf={date} source={selected} onQuote={(quote, start_hint, chunk) => setReference({ quote, start_hint, chunk })} />}
    {reference && <label className="workspace-field-label">引用原文<textarea aria-label="引用原文" rows={3} value={reference.quote} maxLength={3000} onChange={event => setReference({ ...reference, quote: event.target.value, start_hint: null })} className="workspace-field" /></label>}
    {error && <p className="research-error workspace-error" role="alert">{error}</p>}
    <div className="heading-actions"><button className="primary-button workspace-button" type="button" onClick={() => void save()} disabled={busy || !numericValid || (!reference?.quote.trim() && !numericIds.length) || !statement.trim()}>{busy ? '正在保存…' : '保存判断与依据'}</button><button className="secondary-button workspace-button" type="button" disabled={busy} onClick={onClose}>关闭依据编辑</button></div>
  </section>
}

export default function ResearchNoteEvidence({ project, note, asOf }: { project: ResearchProject; note: ResearchNote; asOf: string }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [claims, setClaims] = useState<ResearchClaim[]>([])
  const [offset, setOffset] = useState(0)
  const [next, setNext] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<SourceChunk | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const snapshotRequest = useRef(0)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setError(''); setLoading(true)
    api<{ items: ResearchClaim[]; next_offset: number | null }>(`/research-projects/${project.id}/notes/${note.id}/claims?offset=${offset}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setClaims(result.items); setNext(result.next_offset) } }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [open, project.id, note.id, offset, reload])
  async function readSnapshot(claimId: string, index: number) {
    const request = ++snapshotRequest.current
    setError(''); setSnapshot(null)
    try { const result = await api<SourceChunk>(`/research-projects/${project.id}/claims/${claimId}/evidence/${index}`); if (request === snapshotRequest.current) setSnapshot(result) }
    catch (reason) { if (request === snapshotRequest.current) setError((reason as Error).message) }
  }
  return <details className="research-note-evidence" onToggle={event => { if (event.currentTarget === event.target) setOpen(event.currentTarget.open) }}><summary>判断与原文依据</summary>
    {open && <>{project.status === 'active' && !editing && <div className="research-section-heading"><button className="secondary-button workspace-button" onClick={() => setEditing(true)}>添加判断与依据</button></div>}
      {editing && <ClaimBuilder project={project} note={note} asOf={asOf} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setOffset(0); setReload(value => value + 1) }} />}
      {error && <p className="research-error workspace-error" role="alert">{error}<button className="text-button workspace-button" onClick={() => setReload(value => value + 1)}>重试依据加载</button></p>}
      {claims.map(claim => <article className="research-claim" key={claim.id}><div className="research-note-meta"><span>{claimKinds[claim.kind]}</span><span>关联第 {claim.note_revision} 版笔记</span><span>研究截至 {claim.as_of}</span></div><h4>{claim.statement}</h4>{claim.evidence.map((evidence, index) => <div className="research-citation" key={`${evidence.source_id}:${index}`}><span className="research-secondary">{evidenceStances[evidence.stance]} · {evidence.title}{evidence.source_type === 'report' ? ` · 第 ${evidence.page_number} 页` : ` · 第 ${evidence.source_version} 版`}</span><blockquote>{evidence.quote}</blockquote><button className="text-button workspace-button" onClick={() => void readSnapshot(claim.id, index)}>定位原文</button></div>)}</article>)}
      {claims.flatMap(claim => (claim.numeric_evidence || []).map(reference => <article className="research-citation" key={claim.id + reference.source_id}><h4>{claim.statement} · 独立数字依据</h4><a href={reference.url} target="_blank" rel="noopener noreferrer">{reference.title}</a><details><summary>已保存的数值与公式</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reference.excerpt}</pre></details></article>))}
      {loading && <LoadingState compact label="正在读取已保存的依据…" />}
      {!loading && !claims.length && !editing && !error && <p className="research-secondary">暂无原文依据。</p>}
      {(offset > 0 || next !== null) && <div className="heading-actions"><button className="text-button workspace-button" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页判断</button><button className="text-button workspace-button" disabled={next === null} onClick={() => setOffset(next!)}>下一页判断</button></div>}
      {snapshot && <><button className="text-button workspace-button" onClick={() => { snapshotRequest.current++; setSnapshot(null) }}>收起原文</button><ResearchSourceReader projectId={project.id} snapshot={snapshot} /></>}
    </>}
  </details>
}
