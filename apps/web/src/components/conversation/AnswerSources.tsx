import LoadingState from '../LoadingState'
import { StockText } from '../StockMentions'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { FileSearch, X } from 'lucide-react'
import { useRemoteResource } from '../../useRemoteResource'
import { trapDialogTab } from '../../keyboard'

const PdfReader = lazy(() => import('../PdfReader'))
type Reference = Record<string, unknown>
const citedPage = (ref: Reference) => Math.max(1, Math.floor(Number(ref.page_number) || 1))
const reportUrl = (ref: Reference) => `/api/v1/documents/${encodeURIComponent(String(ref.source_id))}/pdf`
const sourceDomain = (url: string) => { try { return new URL(url).hostname } catch { return '网页来源' } }
const sourceTypeLabels: Record<string, string> = {
  public_web: '外部网页', web: '外部网页', local_report: '本地研报', report_page: '本地研报',
  local_news: '本地资讯', news_item: '本地资讯', financial_record: '财务依据', financial: '财务依据',
  disclosure_record: '披露依据', disclosure: '披露依据', security_reference: '证券资料',
}
const evidenceLabels: Record<string, string> = {
  original_text: '原文摘录', frozen_financial: '冻结数字依据', search_snippet: '检索摘要',
  excerpt: '资料摘录', citation_only: '仅有引用链接',
}
function shortDate(value: unknown) {
  if (typeof value !== 'string' || !value) return ''
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  return date?.[1] || value
}

function ReferenceMeta({ reference }: { reference: Reference }) {
  const domain = typeof reference.domain === 'string' ? reference.domain
    : typeof reference.url === 'string' && /^https?:\/\//i.test(reference.url) ? sourceDomain(reference.url) : ''
  const sourceType = sourceTypeLabels[String(reference.source_type)] || (typeof reference.kind === 'string' ? reference.kind : '资料来源')
  const sourceName = typeof reference.publisher === 'string' && reference.publisher ? reference.publisher : sourceType
  const relation = reference.relation === 'consulted' ? '研究中查阅' : '回答引用'
  const evidence = evidenceLabels[String(reference.evidence_status || reference.excerpt_kind)]
  const published = shortDate(reference.published_at || reference.publication_date || reference.published_date || reference.publisher_declared_date)
  const available = shortDate(reference.available_at)
  const retrieved = shortDate(reference.retrieved_at)
  const recorded = shortDate(reference.recorded_at)
  const parts = [sourceName, domain, relation, evidence,
    published ? `发布 ${published}` : available ? `入库 ${available}` : '',
    retrieved ? `抓取 ${retrieved}` : recorded ? `记录 ${recorded}` : ''].filter(Boolean)
  return <small className="research-source-domain">{parts.join(' · ')}</small>
}

export default function AnswerSources({ references, expanded = false }: { references: Reference[]; expanded?: boolean }) {
  const [selected, setSelected] = useState<Reference | null>(null)
  const [page, setPage] = useState(1)
  const closeButton = useRef<HTMLButtonElement>(null)
  const isReport = selected?.kind === 'report_page'
  const resource = useRemoteResource<{ title: string; body: string; source: string; published_at: string | null }>(selected?.kind === 'news_item' ? `/news/${encodeURIComponent(String(selected.source_id))}` : null)
  const citedCount = references.filter(ref => ref.relation !== 'consulted').length
  const consultedCount = references.length - citedCount
  const originalCount = references.filter(ref => ['original_text', 'frozen_financial'].includes(String(ref.evidence_status || ref.excerpt_kind))).length
  const snippetCount = references.filter(ref => (ref.evidence_status || ref.excerpt_kind) === 'search_snippet').length
  useEffect(() => {
    if (!selected) return
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; closeButton.current?.focus()
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus() }
  }, [selected])
  return <StockText><><details open={expanded || undefined} className={`studio-message-sources${expanded ? ' research-source-list' : ''}`}><summary><FileSearch size={14} />资料来源 · {references.length}</summary>{expanded && <small className="research-source-domain">回答引用 {citedCount} · 研究中查阅 {consultedCount} · 原文或冻结数字依据 {originalCount} · 检索摘要 {snippetCount}</small>}<div className="conversation-source-refs" data-stock-ignore={expanded || undefined}>{references.map((ref, index) => {
    const title = String(ref.title ?? ref.source_id ?? '资料来源')
    if ((ref.kind === 'financial' || ref.kind === 'disclosure') && typeof ref.source_id === 'string' && /^[a-f0-9]{64}$/.test(ref.source_id)) return <article key={index} className="research-source-card"><ReferenceMeta reference={ref} /><a className="text-button workspace-button" href={'/api/v1/research-evidence/' + ref.source_id + '/view'} target="_blank" rel="noopener noreferrer">{title} · {ref.kind === 'financial' ? '独立数字依据' : '披露物理页依据'}</a>{typeof ref.excerpt === 'string' && <details className="research-source-excerpt"><summary>查看保存的依据</summary><p style={{ whiteSpace: 'pre-wrap' }}>{ref.excerpt}</p></details>}</article>
    if (ref.kind === 'report_page' && ref.source_id) {
      const link = <a key={index} className="text-button workspace-button" href={`${reportUrl(ref)}#page=${citedPage(ref)}`} target="_blank" rel="noopener noreferrer" onClick={event => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); setPage(citedPage(ref)); setSelected(ref) }}>{title} · 第 {citedPage(ref)} 页</a>
      return expanded ? <article key={index} className="research-source-card"><ReferenceMeta reference={ref} />{link}</article> : link
    }
    if (ref.kind === 'news_item' && ref.source_id) {
      const button = <button key={index} type="button" className="text-button workspace-button" onClick={() => setSelected(ref)}>{title} · 查看原文</button>
      return expanded ? <article key={index} className="research-source-card"><ReferenceMeta reference={ref} />{button}</article> : button
    }
    if (typeof ref.url === 'string' && /^https?:\/\//i.test(ref.url)) return expanded ? <article key={index} className="research-source-card"><ReferenceMeta reference={ref} /><a aria-label={title} href={ref.url} target="_blank" rel="noopener noreferrer"><strong>{title}</strong></a>{typeof ref.excerpt === 'string' && ref.excerpt && <details className="research-source-excerpt"><summary>{ref.excerpt_kind === 'original_text' ? '查看原文摘录' : ref.excerpt_kind === 'search_snippet' ? '查看检索摘要' : '查看资料摘要'}</summary><p>{ref.excerpt}</p></details>}</article> : <a className="text-button workspace-button" aria-label={title} key={index} href={ref.url} target="_blank" rel="noopener noreferrer">{title}</a>
    return <span key={index}>{title}</span>
  })}</div></details>{selected && <div className="workspace-modal-backdrop source-reader-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setSelected(null) }}><section className={`answer-source-reader workspace-tool-dialog workspace-drawer ${isReport ? 'source-pdf-reader' : ''}`} role="dialog" aria-modal="true" aria-label={isReport ? '引用研报原文' : '引用资讯原文'} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSelected(null) }; trapDialogTab(event) }}><header><h2>{isReport ? String(selected.title || '研报原文') : resource.data?.title || String(selected.title || '资讯原文')}</h2><button ref={closeButton} type="button" className="icon-button workspace-button" aria-label="关闭引用原文" onClick={() => setSelected(null)}><X size={18} /></button></header>
    {isReport ? <><a className="text-button source-external-link workspace-button" href={`${reportUrl(selected)}#page=${page}`} target="_blank" rel="noopener noreferrer">在新窗口打开</a><Suspense fallback={<LoadingState compact label="正在打开研报…" />}><PdfReader url={reportUrl(selected)} page={page} onPageChange={setPage} /></Suspense></> : resource.error ? <div role="alert" className="workspace-error"><p>{resource.error}</p><button className="secondary-button workspace-button" onClick={resource.retry}>重试读取</button></div> : resource.data ? <><p className="answer-source-meta">{resource.data.source}{resource.data.published_at && ` · ${new Date(resource.data.published_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`}</p><div className="answer-source-body">{resource.data.body}</div></> : <LoadingState compact label="正在读取引用原文…" />}
  </section></div>}</></StockText>
}
