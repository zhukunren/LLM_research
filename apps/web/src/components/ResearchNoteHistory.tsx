import { useEffect, useState } from 'react'
import { api } from '../api'
import { noteStatuses, type ResearchNote } from '../research'
import ResearchAnswer from './conversation/ResearchAnswer'
import ResearchNotePDF from './ResearchNotePDF'

export default function ResearchNoteHistory({ projectId, noteId }: { projectId: string; noteId: string }) {
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<ResearchNote[]>([])
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setError('')
    api<{ items: ResearchNote[] }>(`/research-projects/${projectId}/notes/${noteId}/history`, { signal: controller.signal })
      .then(result => setVersions(result.items)).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
    return () => controller.abort()
  }, [open, projectId, noteId, reload])
  return <details className="research-note-history" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>历史版本</summary>
    {open && (error ? <p role="alert">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>重试</button></p> : versions.length ? versions.map(version => <details key={version.revision}>
      <summary>第 {version.revision} 版 · {new Date(version.updated_at).toLocaleString('zh-CN')} · {noteStatuses[version.status]}</summary>
      <h4>{version.title}</h4><ResearchAnswer content={version.body} conversationId={version.source_conversation_id || ''} />
      <ResearchNotePDF projectId={projectId} noteId={noteId} revision={version.revision} pdf={version.pdf} />
      {version.validation_plan && <p>验证事项：{version.validation_plan}</p>}
      {version.invalidation_condition && <p>判断失效条件：{version.invalidation_condition}</p>}
    </details>) : <p role="status">正在读取历史版本…</p>)}
  </details>
}
