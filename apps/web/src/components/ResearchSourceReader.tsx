import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useRemoteResource } from '../useRemoteResource'
import { sourceTime, type ResearchSource, type SourceChunk, type SourceListing } from '../companyResearch'

const PdfReader = lazy(() => import('./PdfReader'))

export function CompanySources({ projectId, code, asOf, onChoose }: {
  projectId: string; code: string; asOf: string; onChoose: (source: ResearchSource) => void
}) {
  const [kind, setKind] = useState<'news' | 'report'>('news')
  const [offset, setOffset] = useState(0)
  const params = new URLSearchParams({ kind, as_of: asOf, offset: String(offset), limit: '20' })
  const { data: listing, error, retry } = useRemoteResource<SourceListing>(`/research-projects/${projectId}/companies/${code}/sources?${params}`)
  return <div className="company-sources">
    <div className="heading-actions" role="group" aria-label="公司资料类型"><button className="secondary-button" aria-pressed={kind === 'news'} onClick={() => { setKind('news'); setOffset(0) }}>资讯</button><button className="secondary-button" aria-pressed={kind === 'report'} onClick={() => { setKind('report'); setOffset(0) }}>研报</button>{listing && <span className="research-secondary">{listing.total} 份可用资料</span>}</div>
    {error ? <p className="research-error" role="alert">{error}<button className="text-button" onClick={retry}>重试</button></p> : listing ? listing.items.length ? <><div className="company-source-list">{listing.items.map(source => <button key={source.source_id} className="company-source-row" onClick={() => onChoose(source)}><strong>{source.title}</strong><span>首次可得 {sourceTime(source.available_at)}{source.source_type === 'report' ? ` · ${source.page_count} 页` : ''}</span></button>)}</div><div className="heading-actions"><button className="text-button" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页</button><span className="research-secondary">第 {Math.floor(offset / 20) + 1} 页</span><button className="text-button" disabled={listing.next_offset === null} onClick={() => setOffset(listing.next_offset!)}>下一页</button></div></> : <p className="research-secondary">该截止日前没有符合公司、日期与版本范围的本地资料。</p> : <p role="status">正在读取公司资料…</p>}
  </div>
}

export default function ResearchSourceReader({ projectId, code, asOf, source, snapshot, onQuote }: {
  projectId: string; code?: string; asOf?: string; source?: ResearchSource; snapshot?: SourceChunk
  onQuote?: (quote: string, startHint: number, chunk: SourceChunk) => void
}) {
  const [page, setPage] = useState(1)
  const [offset, setOffset] = useState(0)
  const [selectionError, setSelectionError] = useState('')
  const [pdfOpen, setPdfOpen] = useState(false)
  const original = useRef<HTMLPreElement>(null)
  const params = new URLSearchParams({ kind: source?.source_type || 'news', source_id: source?.source_id || '', page: String(page), offset: String(offset), as_of: asOf || '' })
  const path = !snapshot && source && code && asOf ? `/research-projects/${projectId}/companies/${code}/source?${params}` : null
  const resource = useRemoteResource<SourceChunk>(path)
  const chunk = snapshot || resource.data
  const error = resource.error || selectionError
  useEffect(() => setSelectionError(''), [path])
  function quoteSelection() {
    const selection = window.getSelection()
    if (!selection?.rangeCount || !original.current?.contains(selection.anchorNode) || !original.current.contains(selection.focusNode) || !chunk) {
      setSelectionError('请先在下方原文中选中需要引用的文字。'); return
    }
    const selected = selection.toString(), quote = selected.trim()
    if (Array.from(quote).length < 3 || Array.from(quote).length > 3000) { setSelectionError('请选择 3 至 3000 字的原文。'); return }
    const range = selection.getRangeAt(0), before = range.cloneRange()
    before.selectNodeContents(original.current); before.setEnd(range.startContainer, range.startOffset)
    const leading = Array.from(selected.match(/^\s*/)?.[0] || '').length
    onQuote?.(quote, chunk.char_start + Array.from(before.toString()).length + leading, chunk)
    setSelectionError('')
  }
  const characters = Array.from(chunk?.text || '')
  const start = chunk?.quote_start === undefined ? 0 : chunk.quote_start - chunk.char_start
  const end = chunk?.quote_end === undefined ? 0 : chunk.quote_end - chunk.char_start
  return <section className="research-source-reader" aria-label="原文阅读">
    {error && <p role="alert" className="research-error">{error}{!chunk && <button className="text-button" onClick={resource.retry}>重试原文</button>}</p>}
    {chunk ? <><div className="research-section-heading"><h4>{chunk.title}</h4>{onQuote && <button type="button" className="secondary-button" onClick={quoteSelection}>引用所选原文</button>}</div><p className="research-secondary">{snapshot ? '保存时的原文摘录' : '原文'} · 首次可得 {sourceTime(chunk.available_at)} · 研究截至 {chunk.as_of}{chunk.source_type === 'report' ? ` · 第 ${chunk.page_number} 页` : ` · 资讯第 ${chunk.source_version} 版`}</p>
      <pre ref={original} className="research-source-text">{snapshot && chunk.quote_start !== undefined ? <>{characters.slice(0, start).join('')}<mark>{characters.slice(start, end).join('')}</mark>{characters.slice(end).join('')}</> : chunk.text}</pre>
      {!snapshot && <div className="heading-actions">{source?.source_type === 'report' && <><button className="secondary-button" disabled={page <= 1} onClick={() => { setPage(value => value - 1); setOffset(0) }}>上一原文页</button><span>第 {page} / {source.page_count} 页</span><button className="secondary-button" disabled={page >= source.page_count} onClick={() => { setPage(value => value + 1); setOffset(0) }}>下一原文页</button></>}{(chunk.next_offset !== null || offset > 0) && <><button className="secondary-button" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 12000))}>上一段</button><span className="research-secondary">已读位置 {chunk.char_start}–{chunk.char_end} / {chunk.original_characters}</span><button className="secondary-button" disabled={chunk.next_offset === null} onClick={() => setOffset(chunk.next_offset!)}>下一段</button></>}</div>}
      {!snapshot && source?.source_type === 'report' && <details onToggle={event => setPdfOpen(event.currentTarget.open)}><summary>阅读 PDF 原件</summary>{pdfOpen && <Suspense fallback={<p>正在打开 PDF…</p>}><PdfReader url={`/api/v1/documents/${encodeURIComponent(source.source_id)}/pdf`} page={page} onPageChange={value => { setPage(value); setOffset(0) }} /></Suspense>}</details>}
    </> : !error && <p role="status">正在读取原文…</p>}
  </section>
}
