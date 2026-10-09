import { StockText } from '../StockMentions'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { FileSearch, X } from 'lucide-react'
import { useRemoteResource } from '../../useRemoteResource'
import { trapDialogTab } from '../../keyboard'

const PdfReader = lazy(() => import('../PdfReader'))
type Reference = Record<string, unknown>
const citedPage = (ref: Reference) => Math.max(1, Math.floor(Number(ref.page_number) || 1))
const reportUrl = (ref: Reference) => `/api/v1/documents/${encodeURIComponent(String(ref.source_id))}/pdf`

export default function AnswerSources({ references }: { references: Reference[] }) {
  const [selected, setSelected] = useState<Reference | null>(null)
  const [page, setPage] = useState(1)
  const closeButton = useRef<HTMLButtonElement>(null)
  const isReport = selected?.kind === 'report_page'
  const resource = useRemoteResource<{ title: string; body: string; source: string; published_at: string | null }>(selected?.kind === 'news_item' ? `/news/${encodeURIComponent(String(selected.source_id))}` : null)
  useEffect(() => {
    if (!selected) return
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; closeButton.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [selected])
  return <StockText><><details className="studio-message-sources"><summary><FileSearch size={14} />资料来源 · {references.length}</summary><div className="conversation-source-refs">{references.map((ref, index) => {
    const title = String(ref.title ?? ref.source_id ?? '资料来源')
    if (ref.kind === 'report_page' && ref.source_id) return <a className="text-button" key={index} href={`${reportUrl(ref)}#page=${citedPage(ref)}`} target="_blank" rel="noopener noreferrer" onClick={event => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); setPage(citedPage(ref)); setSelected(ref) }}>{title} · 第 {citedPage(ref)} 页</a>
    if (ref.kind === 'news_item' && ref.source_id) return <button type="button" className="text-button" key={index} onClick={() => setSelected(ref)}>{title} · 查看原文</button>
    if (typeof ref.url === 'string' && /^https?:\/\//i.test(ref.url)) return <a className="text-button" key={index} href={ref.url} target="_blank" rel="noopener noreferrer">{title}</a>
    return <span key={index}>{title}</span>
  })}</div></details>{selected && <div className="workspace-modal-backdrop source-reader-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setSelected(null) }}><section className={`answer-source-reader ${isReport ? 'source-pdf-reader' : ''}`} role="dialog" aria-modal="true" aria-label={isReport ? '引用研报原文' : '引用资讯原文'} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSelected(null) }; trapDialogTab(event) }}><header><h2>{isReport ? String(selected.title || '研报原文') : resource.data?.title || String(selected.title || '资讯原文')}</h2><button ref={closeButton} type="button" className="icon-button" aria-label="关闭引用原文" onClick={() => setSelected(null)}><X size={18} /></button></header>
    {isReport ? <><a className="text-button source-external-link" href={`${reportUrl(selected)}#page=${page}`} target="_blank" rel="noopener noreferrer">在新窗口打开</a><Suspense fallback={<p role="status">正在打开研报…</p>}><PdfReader url={reportUrl(selected)} page={page} onPageChange={setPage} /></Suspense></> : resource.error ? <div role="alert"><p>{resource.error}</p><button className="secondary-button" onClick={resource.retry}>重试读取</button></div> : resource.data ? <><p className="answer-source-meta">{resource.data.source}{resource.data.published_at && ` · ${new Date(resource.data.published_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`}</p><div className="answer-source-body">{resource.data.body}</div></> : <p role="status">正在读取引用原文…</p>}
  </section></div>}</></StockText>
}
