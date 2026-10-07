import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ResearchFile } from '../research'
import { reportPending } from './ResearchFileList'

export default function ResearchNotePDF({ projectId, noteId, revision, pdf }: { projectId: string; noteId: string; revision: number; pdf?: ResearchFile | null }) {
  const [current, setCurrent] = useState(pdf)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setCurrent(pdf); setError('') }, [pdf, projectId, noteId, revision])
  useEffect(() => {
    if (!reportPending(current?.status)) return
    const controller = new AbortController()
    let reading = false
    const timer = globalThis.setInterval(() => {
      if (reading || controller.signal.aborted) return
      reading = true
      api<{ pdf: ResearchFile | null }>(`/research-projects/${projectId}/notes/${noteId}/pdf-status?revision=${revision}`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) { setCurrent(result.pdf); setError('') } })
        .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
        .finally(() => { reading = false })
    }, 1500)
    return () => { controller.abort(); globalThis.clearInterval(timer) }
  }, [projectId, noteId, revision, current?.status])
  async function generate() {
    setBusy(true); setError('')
    try {
      const retry = current && ['failed', 'cancelled', 'partial'].includes(current.status || '') && current.retry_url
      setCurrent(await api<ResearchFile>(retry ? retry.replace(/^\/api\/v1/, '') : `/research-projects/${projectId}/notes/${noteId}/pdf-jobs`, { method: 'POST', ...(retry ? {} : { body: JSON.stringify({ revision }) }) }))
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  // Old clients and cached fixtures retain the explicit download route.
  if (current === undefined || current?.url) return <a className="text-button" href={current?.url || `/api/v1/research-projects/${projectId}/notes/${noteId}/pdf?revision=${revision}`} download>下载第 {revision} 版 PDF</a>
  return <span className="research-note-pdf">{reportPending(current?.status) ? <small role="status">PDF 后台生成中 · 正文已保存</small> : <button className="text-button" disabled={busy} onClick={() => void generate()}>{busy ? '正在提交…' : current ? '重试报告' : `生成第 ${revision} 版 PDF`}</button>}{error && <small role="alert">{error}</small>}</span>
}
