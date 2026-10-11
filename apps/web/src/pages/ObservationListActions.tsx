import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { api } from '../api'
import { trapDialogTab } from '../keyboard'
import type { Entry } from './ObservationPage'
import type { ResearchCandidate } from './ResearchCandidatePanel'

export async function updateObservationEntry(entry: Entry, changes: { status?: string; note?: string }, revision?: number) {
  if (entry.kind === 'candidate') {
    const currentRevision = revision ?? (await api<ResearchCandidate>('/observation/research-candidates/' + encodeURIComponent(entry.candidate_id!))).revision
    return api('/observation/research-candidates/' + encodeURIComponent(entry.candidate_id!), { method: 'PATCH', body: JSON.stringify({ revision: currentRevision, ...changes }) })
  }
  return api('/observation/runs/' + encodeURIComponent(entry.run_id!) + '/notes/' + encodeURIComponent(entry.stock_code), {
    method: 'PATCH', body: JSON.stringify({ ...changes, ...('note' in changes ? { expected_note: entry.note } : {}) }),
  })
}

export default function ObservationQuickNote({ entry, onClose, onSaved }: { entry: Entry; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState(entry.note)
  const [revision, setRevision] = useState<number>()
  const [original, setOriginal] = useState(entry.note)
  const [loading, setLoading] = useState(entry.kind === 'candidate')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const locked = useRef(false)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    input.current?.focus()
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    if (entry.kind !== 'candidate') return
    const controller = new AbortController()
    api<ResearchCandidate>('/observation/research-candidates/' + encodeURIComponent(entry.candidate_id!), { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setRevision(value.revision); setOriginal(value.note); setNote(value.note) }
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [entry.kind, entry.candidate_id])
  useEffect(() => { if (!loading) input.current?.focus() }, [loading])
  async function save() {
    if (locked.current || loading || (entry.kind === 'candidate' && revision === undefined)) return
    locked.current = true; setSaving(true); setError('')
    try { await updateObservationEntry({ ...entry, note: original }, { note }, revision); onSaved() }
    catch (reason) { setError((reason as Error).message) }
    finally { locked.current = false; setSaving(false) }
  }
  return createPortal(<div className="observation-quick-note-layer" onMouseDown={event => { if (event.target === event.currentTarget && !locked.current) onClose() }}>
    <section className="observation-quick-note" role="dialog" aria-modal="true" aria-label="快速编辑观察备注" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!locked.current) onClose() }; trapDialogTab(event) }}>
      <header><div><h2>{entry.name || entry.stock_code} · 关注备注</h2><p>{entry.owner_label}</p></div><button type="button" className="icon-button" aria-label="关闭快速备注" disabled={saving} onClick={onClose}><X size={18} /></button></header>
      <form onSubmit={event => { event.preventDefault(); void save() }}><label htmlFor="observation-inline-note">关注备注</label><textarea ref={input} id="observation-inline-note" value={note} maxLength={2000} rows={6} disabled={loading || saving} onChange={event => setNote(event.target.value)} /><small>{note.length} / 2000</small>
        {loading && <p role="status">正在读取最新备注…</p>}{error && <p role="alert">{error}</p>}
        <footer><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={loading || saving || note === original || (entry.kind === 'candidate' && revision === undefined)}>{saving ? '正在保存…' : '保存备注'}</button></footer>
      </form>
    </section>
  </div>, document.body)
}
