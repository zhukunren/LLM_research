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
  const attempt = useRef<{ key: string; id: string } | null>(null)
  async function save() {
    if (!reference) return
    const payload = { note_revision: note.revision, stock_code: code, statement, kind, as_of: date,
      evidence: [{ kind: reference.chunk.source_type, source_id: reference.chunk.source_id, page_number: reference.chunk.page_number, offset: reference.chunk.char_start, quote: reference.quote, start_hint: reference.start_hint, stance }] }
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
    <div className="research-editor-fields"><label>关联公司<select aria-label="依据关联公司" value={code} disabled={!!note.stock_code || busy} onChange={event => { setCode(event.target.value); setSelected(null); setReference(null) }}><option value="">选择公司</option>{project.companies.map(company => <option key={company.stock_code} value={company.stock_code}>{company.name || company.stock_code}</option>)}</select></label><label>研究截至<input aria-label="依据截止日" type="date" required value={date} disabled={busy} onChange={event => { setDate(event.target.value); setSelected(null); setReference(null) }} /></label></div>
    <label>需要定位依据的判断<textarea aria-label="判断内容" rows={2} maxLength={2000} required value={statement} onChange={event => setStatement(event.target.value)} /></label>
    <div className="research-editor-fields"><label>判断类别<select aria-label="判断类别" value={kind} onChange={event => setKind(event.target.value as keyof typeof claimKinds)}>{Object.entries(claimKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>原文与判断的关系<select aria-label="证据关系" value={stance} onChange={event => setStance(event.target.value as keyof typeof evidenceStances)}>{Object.entries(evidenceStances).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {code && date && <CompanySources key={`${code}:${date}`} projectId={project.id} code={code} asOf={date} onChoose={source => { setSelected(source); setReference(null) }} />}
    {selected && <ResearchSourceReader key={selected.source_id} projectId={project.id} code={code} asOf={date} source={selected} onQuote={(quote, start_hint, chunk) => setReference({ quote, start_hint, chunk })} />}
    {reference && <label>引用原文<textarea aria-label="引用原文" rows={3} value={reference.quote} maxLength={3000} onChange={event => setReference({ ...reference, quote: event.target.value, start_hint: null })} /></label>}
    <p className="research-secondary">保存时核对公司、日期和原文位置；是否支持判断由你核对。判断将关联本次编辑所见的笔记版本。</p>
    {error && <p className="research-error" role="alert">{error}</p>}
    <div className="heading-actions"><button className="primary-button" type="button" onClick={() => void save()} disabled={busy || !reference?.quote.trim() || !statement.trim()}>{busy ? '正在保存…' : '保存判断与依据'}</button><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>关闭依据编辑</button></div>
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
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setError('')
    api<{ items: ResearchClaim[]; next_offset: number | null }>(`/research-projects/${project.id}/notes/${note.id}/claims?offset=${offset}`, { signal: controller.signal })
      .then(result => { setClaims(result.items); setNext(result.next_offset) }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
    return () => controller.abort()
  }, [open, project.id, note.id, offset, reload])
  async function readSnapshot(claimId: string, index: number) {
    setError(''); setSnapshot(null)
    try { setSnapshot(await api<SourceChunk>(`/research-projects/${project.id}/claims/${claimId}/evidence/${index}`)) }
    catch (reason) { setError((reason as Error).message) }
  }
  return <details className="research-note-evidence" onToggle={event => { if (event.currentTarget === event.target) setOpen(event.currentTarget.open) }}><summary>判断与原文依据</summary>
    {open && <><div className="research-section-heading"><p className="research-secondary">引用已定位到原文，不代表判断已被证实。</p>{project.status === 'active' && !editing && <button className="secondary-button" onClick={() => setEditing(true)}>添加判断与依据</button>}</div>
      {editing && <ClaimBuilder project={project} note={note} asOf={asOf} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setOffset(0); setReload(value => value + 1) }} />}
      {error && <p className="research-error" role="alert">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>重试依据加载</button></p>}
      {claims.map(claim => <article className="research-claim" key={claim.id}><div className="research-note-meta"><span>{claimKinds[claim.kind]}</span><span>关联第 {claim.note_revision} 版笔记</span><span>研究截至 {claim.as_of}</span></div><h4>{claim.statement}</h4>{claim.evidence.map((evidence, index) => <div className="research-citation" key={`${evidence.source_id}:${index}`}><span className="research-secondary">{evidenceStances[evidence.stance]} · {evidence.title}{evidence.source_type === 'report' ? ` · 第 ${evidence.page_number} 页` : ` · 第 ${evidence.source_version} 版`}</span><blockquote>{evidence.quote}</blockquote><button className="text-button" onClick={() => void readSnapshot(claim.id, index)}>定位原文</button></div>)}</article>)}
      {!claims.length && !editing && !error && <p className="research-secondary">还没有保存原文依据。可选择公司的资讯或研报，将判断关联到具体段落。</p>}
      {(offset > 0 || next !== null) && <div className="heading-actions"><button className="text-button" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页判断</button><button className="text-button" disabled={next === null} onClick={() => setOffset(next!)}>下一页判断</button></div>}
      {snapshot && <><button className="text-button" onClick={() => setSnapshot(null)}>收起原文</button><ResearchSourceReader projectId={project.id} snapshot={snapshot} /></>}
    </>}
  </details>
}
