import EmptyState from './EmptyState'
import LoadingState from './LoadingState'
import { useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronDown, Search, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { api } from '../api'

type Reference = { id: string; title: string; kind: string; sha256: string; sources: string[]; runtime_verified: boolean }
type SearchResult = { items: Reference[]; total: number; next_offset: number | null; version: string; verified_at: string; compatibility: string }
type ReadResult = { document: Reference; text: string; char_start: number; next_offset: number | null; version: string }
const kindLabels: Record<string, string> = { official_reference: '官方接口参考', manual: '项目手册', example: '项目示例' }

function focusInReadingPane(element: HTMLElement | null) {
  if (!element) return
  const pane = element.closest<HTMLElement>('.qmt-scripts-page')
  if (pane) pane.scrollTop += element.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12
  else element.scrollIntoView?.({ block: 'start', behavior: 'instant' })
  element.focus({ preventScroll: true })
}

export default function QmtReferenceLibrary() {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(''), [query, setQuery] = useState(''), [offset, setOffset] = useState(0)
  const [result, setResult] = useState<SearchResult | null>(null), [loading, setLoading] = useState(false)
  const [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState<Reference | null>(null), [docOffset, setDocOffset] = useState(0)
  const [document, setDocument] = useState<ReadResult | null>(null), [reading, setReading] = useState(false)
  const [readError, setReadError] = useState(''), [readRetry, setReadRetry] = useState(0)
  const reader = useRef<HTMLElement>(null), sourceButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!open || !selected) return
    focusInReadingPane(reader.current)
  }, [open, selected, document?.document.id])
  function closeReader() { setSelected(null); setDocument(null); focusInReadingPane(sourceButton.current) }

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true); setError('')
    const params = new URLSearchParams({ query, offset: String(offset), limit: '12' })
    api<SearchResult>(`/qmt-docs?${params}`, { signal: controller.signal }).then(value => {
      if (!Array.isArray(value.items) || !value.version) throw new Error('参考资料目录暂不可用。')
      if (!controller.signal.aborted) setResult(previous => ({ ...value, items: offset ? [...new Map([...(previous?.items || []), ...value.items].map(item => [item.id, item])).values()] : value.items }))
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [open, query, offset, retry])

  useEffect(() => {
    if (!open || !selected) return
    const controller = new AbortController()
    setReading(true); setReadError('')
    const params = new URLSearchParams({ offset: String(docOffset), expected_sha256: selected.sha256 })
    api<ReadResult>(`/qmt-docs/${encodeURIComponent(selected.id)}?${params}`, { signal: controller.signal }).then(value => {
      if (value.document?.id !== selected.id || typeof value.text !== 'string') throw new Error('资料正文暂不可用。')
      if (!controller.signal.aborted) setDocument(previous => ({ ...value, text: docOffset ? Array.from(previous?.text || '').slice(0, docOffset).join('') + value.text : value.text }))
    }).catch(reason => { if (!controller.signal.aborted) setReadError((reason as Error).message) })
      .finally(() => { if (!controller.signal.aborted) setReading(false) })
    return () => controller.abort()
  }, [open, selected, docOffset, readRetry])

  return <details className="qmt-reference-library" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><BookOpen size={17} aria-hidden="true" />参考资料 · 官方接口、编写手册与示例<ChevronDown className="qmt-reference-chevron" size={16} aria-hidden="true" /></summary>
    {open && <div className="qmt-reference-content">
      <p>生成脚本前，助手会查阅相关资料。官方接口参考保留原文入口；手册与源码示例由项目编写。</p>
      <form className="qmt-reference-search workspace-form" onSubmit={event => { event.preventDefault(); setResult(null); setOffset(0); setQuery(draft.trim()); setRetry(value => value + 1) }}>
        <label className="sr-only" htmlFor="qmt-reference-query">搜索 QMT 参考资料</label><input id="qmt-reference-query" value={draft} maxLength={300} onChange={event => setDraft(event.target.value)} placeholder="搜索接口或主题，如 get_market_data_ex、回测、均线" className="workspace-field" />
        <button type="submit" className="secondary-button workspace-button"><Search size={15} />查找</button>
      </form>
      {error && <div role="alert" className="workspace-error">{error}<button type="button" className="text-button workspace-button" onClick={() => setRetry(value => value + 1)}>重试目录</button></div>}
      {loading && <LoadingState compact label="正在读取参考资料…" />}
      {result && <><p className="qmt-reference-version">{result.total} 个条目 · 资料版本 {result.version} · 核对日期 {result.verified_at}</p>
        <ul className="qmt-reference-items">{result.items.map(item => <li key={item.id}><button type="button" className="text-button workspace-button" onClick={event => { sourceButton.current = event.currentTarget; setSelected({ ...item }); setDocOffset(0); setDocument(null) }}>{item.title}</button><small>{kindLabels[item.kind] || item.kind}</small></li>)}</ul>
        {!result.total && <EmptyState compact icon={BookOpen} title="未找到匹配资料" description="可换用接口名或其他关键词。" />}
        {result.next_offset !== null && <button type="button" className="text-button workspace-button" disabled={loading} onClick={() => setOffset(result.next_offset!)}>更多资料</button>}
      </>}
      {selected && <article ref={reader} tabIndex={-1} className="qmt-reference-reader" aria-label="QMT 资料正文" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeReader() } }}><header><h3>{selected.title}</h3><button type="button" className="icon-button workspace-button" aria-label="关闭资料" onClick={closeReader}><X size={16} /></button></header>
        {reading && <LoadingState compact label="正在读取正文…" />}
        {readError && <p role="alert" className="workspace-error">{readError}<button type="button" className="text-button workspace-button" onClick={() => setReadRetry(value => value + 1)}>重试正文</button></p>}
        {document && <>{document.document.kind === 'example' ? <pre><code>{document.text}</code></pre> : <ReactMarkdown components={{ h1: ({ children }) => <h4>{children}</h4>, h2: ({ children }) => <h4>{children}</h4>, a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{document.text}</ReactMarkdown>}
          <small>版本 {document.version} · SHA-256 {document.document.sha256.slice(0, 12)}… · 未在券商客户端验证</small>
          {document.next_offset !== null && <p><button type="button" className="text-button workspace-button" disabled={reading} onClick={() => setDocOffset(document.next_offset!)}>继续读取正文</button></p>}
        </>}
        {!!selected.sources.length && <p>{selected.sources.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">{index ? ' · ' : ''}官方原文 {index + 1}</a>)}</p>}
      </article>}
      {result && <p className="qmt-script-note">{result.compatibility}</p>}
    </div>}
  </details>
}
