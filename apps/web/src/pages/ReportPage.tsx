import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, RefreshCw, Search, Upload, X } from 'lucide-react'
import { api } from '../api'
import PdfReader from '../components/PdfReader'
import { isText, useSessionState } from '../useSessionState'
import type { LibrarySeed } from '../libraryContext'

type Document = {
  id: string; filename: string; title: string; publication_date: string | null; stock_code: string | null; pages: number
  metadata_status: string; metadata_error?: string; parse_status: string
  metadata?: { fields?: Record<string, { value: string; page: number; quote: string }> }
}
type Hit = { document_id: string; title: string; page_number: number; snippet: string }
const validPositions = (value: unknown): value is Record<string, number> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(n => Number.isInteger(n) && Number(n) >= 1)

export default function ReportPage({ onDescribe }: { contentOnly?: boolean; onDescribe?: (seed?: Omit<LibrarySeed, 'id'>) => void }) {
  const [docs, setDocs] = useState<Document[]>([])
  const [selectedId, setSelectedId] = useSessionState('report.selected', '', isText)
  const [positions, setPositions] = useSessionState<Record<string, number>>('report.pages', {}, validPositions)
  const [query, setQuery] = useSessionState('report.query', '', isText)
  const [pageInput, setPageInput] = useState('1')
  const [hits, setHits] = useState<Hit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchRetry, setSearchRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState('')
  const reader = useRef<HTMLElement>(null)
  const catalog = useRef<HTMLElement>(null)
  const selected = docs.find(item => item.id === selectedId)
  const page = Math.min(positions[selectedId] ?? 1, selected?.pages || 1)
  const pdfUrl = selected ? '/api/v1/documents/' + selected.id + '/pdf#page=' + page : ''
  const normalizedQuery = query.trim().toLowerCase()
  const filteredDocs = useMemo(() => docs.filter(item => {
    if (!normalizedQuery) return true
    const metadata = Object.values(item.metadata?.fields ?? {}).map(field => field.value).join(' ')
    return [item.title, item.filename, item.stock_code, metadata].join(' ').toLowerCase().includes(normalizedQuery) || hits.some(hit => hit.document_id === item.id)
  }), [docs, normalizedQuery, hits])
  const selectedHits = hits.filter(hit => hit.document_id === selectedId)
  const pending = docs.filter(item => ['queued', 'running'].includes(item.metadata_status)).length

  useEffect(() => { setPageInput(String(page)) }, [page, selectedId])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const result = await api<{ items: Document[] }>('/documents', { signal: controller.signal })
        if (controller.signal.aborted) return
        setDocs(result.items); setLoadError('')
        setSelectedId(current => result.items.some(item => item.id === current) ? current : result.items[0]?.id ?? '')
        if (result.items.some(item => ['queued', 'running'].includes(item.metadata_status))) timer = setTimeout(load, 3000)
      } catch (error) { if (!controller.signal.aborted) setLoadError((error as Error).message) }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [refresh])
  useEffect(() => {
    let active = true
    void api<{ queued: number; message?: string }>('/documents/catalog', { method: 'POST' }).then(result => {
      if (!active) return
      if (result.message) setNotice(result.message)
      if (result.queued) setRefresh(value => value + 1)
    }).catch(error => { if (active) setActionError(error.message) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setHits([]); setSearchError('')
    if (!normalizedQuery) { setSearching(false); return }
    setSearching(true)
    const timer = setTimeout(() => {
      void api<{ items: Hit[] }>('/documents/search', { method: 'POST', body: JSON.stringify({ query: query.trim() }), signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) setHits(result.items) })
        .catch(error => { if (!controller.signal.aborted) setSearchError(error.message) })
        .finally(() => { if (!controller.signal.aborted) setSearching(false) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [normalizedQuery, searchRetry])

  async function action(name: string, task: () => Promise<void>) {
    if (busy) return
    setBusy(name); setNotice(''); setActionError('')
    try { await task(); setRefresh(value => value + 1) }
    catch (error) { setActionError((error as Error).message) }
    finally { setBusy('') }
  }
  async function upload(file?: File) {
    if (!file) return
    if (file.size > 50 * 1024 * 1024) { setActionError('单个 PDF 不能超过 50 MB'); return }
    await action('upload', async () => {
      const form = new FormData(); form.append('file', file)
      const result = await api<{ result?: { id?: string; status: string } }>('/documents/upload', { method: 'POST', body: form })
      if (result.result?.id) setSelectedId(result.result.id)
      setNotice(result.result?.status === 'no_text' ? 'PDF 已导入，可直接阅读。此文件没有可提取文字。' : 'PDF 已导入，正在整理研报字典。')
    })
  }
  function setPage(number: number) {
    if (!selected) return
    setPositions(current => ({ ...current, [selected.id]: Math.max(1, Math.min(selected.pages, number)) }))
  }
  function select(id: string, number?: number) {
    setSelectedId(id)
    if (number) setPositions(current => ({ ...current, [id]: number }))
    if (globalThis.matchMedia?.('(max-width: 720px)').matches) reader.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  function commitPage() {
    const next = Math.max(1, Math.min(selected?.pages || 1, Math.floor(Number(pageInput)) || 1))
    setPage(next); setPageInput(String(next))
  }
  return <div className="report-reading-workspace">
    <div className="report-library-toolbar">
      <form onSubmit={event => { event.preventDefault(); setSearchRetry(value => value + 1) }} className="library-search report-search"><Search size={16} /><input aria-label="搜索研报" placeholder="标题、代码、分析师或正文" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" className="icon-button" aria-label="清除研报搜索" onClick={() => setQuery('')}><X size={14} /></button>}<button className="text-button" aria-label="搜索" type="submit" disabled={searching}>{searching ? '检索中…' : '搜索'}</button></form>
      <div className="report-import-actions"><button className="secondary-button" disabled={!!busy} onClick={() => action('index', async () => { const result = await api<{ imported: number; failed: number }>('/documents/import-local', { method: 'POST' }); setNotice('新增 ' + result.imported + ' 份研报' + (result.failed ? '，' + result.failed + ' 份未能读取。' : '。')) })}><RefreshCw size={14} />{busy === 'index' ? '正在索引…' : '索引本地研报'}</button><label className={'upload-label report-upload ' + (busy ? 'disabled' : '')}><Upload size={14} />{busy === 'upload' ? '正在上传…' : '上传 PDF'}<input type="file" accept="application/pdf" disabled={!!busy} aria-label="上传研报 PDF" onChange={event => { void upload(event.target.files?.[0]); event.target.value = '' }} /></label></div>
    </div>
    {notice && <div className="library-feedback" role="status">{notice}<button className="icon-button" aria-label="关闭研报提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {actionError && <div className="library-error" role="alert">{actionError}<button className="icon-button" aria-label="关闭研报错误" onClick={() => setActionError('')}><X size={14} /></button></div>}
    <div className="report-reading-layout">
      <aside className="report-catalog" ref={catalog} aria-label="研报列表">
        <div className="report-catalog-heading"><strong>本地研报</strong><span>{filteredDocs.length} 份</span>{pending > 0 && <small>{pending} 份整理中</small>}</div>
        {loadError && <div className="library-error" role="alert">{loadError}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>重新加载研报</button></div>}
        {searchError && <div className="library-error" role="alert">正文检索失败，当前仅显示字典匹配。<button className="text-button" onClick={() => setSearchRetry(value => value + 1)}>重试搜索</button></div>}
        {filteredDocs.map(item => <button key={item.id} aria-current={selectedId === item.id ? 'true' : undefined} className={selectedId === item.id ? 'selected' : ''} onClick={() => select(item.id, hits.find(hit => hit.document_id === item.id)?.page_number)}>
          <strong>{item.title}</strong><span className="report-security">{item.metadata?.fields?.stock_name?.value || item.stock_code || '行业研究'}{item.metadata?.fields?.stock_name && item.stock_code && <small>{item.stock_code}</small>}</span><small>{item.metadata?.fields?.broker?.value || '券商待识别'} · {item.publication_date ?? '日期待识别'} · {item.pages} 页</small>
        </button>)}
        {(loading || searching) && <div className="library-loading" role="status">{loading ? '正在加载研报…' : '正在检索正文…'}</div>}
        {!loading && !searching && !filteredDocs.length && !loadError && <div className="library-empty">{docs.length ? '没有找到相关研报。' : '暂无研报，索引本地文件或上传 PDF 后即可阅读。'}{query && <button className="text-button" onClick={() => setQuery('')}>查看全部研报</button>}</div>}
      </aside>
      <section className="report-pdf-reader" ref={reader} aria-label="研报阅读">
        {selected ? <>
          <div className="report-reader-heading"><div><button className="text-button reader-back" onClick={() => catalog.current?.scrollIntoView({ behavior: 'smooth' })}><ArrowLeft size={14} />研报列表</button><h2>{selected.title}</h2></div><a className="quiet-button" href={pdfUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={14} />在浏览器中打开</a></div>
          <div className="report-reading-meta"><span>{selected.metadata?.fields?.stock_name?.value} {selected.stock_code}</span><span>{selected.metadata?.fields?.broker?.value || '券商待识别'}</span><span>{selected.publication_date ?? '日期待识别'}</span></div>
          <details className="report-info-details"><summary>研报信息<span>分析师、主题与主要观点</span></summary>
          <dl className="report-dictionary">{[
            ['代码', selected.stock_code], ['股票名称', selected.metadata?.fields?.stock_name?.value],
            ['标题', selected.metadata?.fields?.title?.value ?? selected.title], ['分析师', selected.metadata?.fields?.analysts?.value],
            ['券商名称', selected.metadata?.fields?.broker?.value], ['主题', selected.metadata?.fields?.theme?.value],
            ['主要观点', selected.metadata?.fields?.main_points?.value], ['发布日期', selected.publication_date],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}</dl>
          </details>
          {selected.parse_status === 'indexed' && ['queued', 'running'].includes(selected.metadata_status) && <p className="workbench-help">正在整理研报字典，可先阅读 PDF。</p>}
          {selected.metadata_status === 'failed' && <div className="library-error" role="alert">{selected.metadata_error}<button className="text-button" disabled={!!busy} onClick={() => action('retry', async () => { await api('/documents/catalog?retry_failed=true', { method: 'POST' }) })}>重新整理</button></div>}
          {selected.parse_status === 'no_text' && <p className="workbench-help">此 PDF 没有可提取文字，字典信息暂缺。</p>}
          {!!selectedHits.length && <details className="report-search-hits"><summary>正文命中 {selectedHits.length} 页</summary>{selectedHits.map(hit => <button key={hit.page_number} onClick={() => setPage(hit.page_number)}><strong>第 {hit.page_number} 页</strong><span>{hit.snippet}</span></button>)}</details>}
          <PdfReader key={selected.id} url={'/api/v1/documents/' + selected.id + '/pdf'} page={page} onPageChange={setPage}
            pageControls={<label className="pdf-page-jump"><input aria-label="研报页码" type="number" min={1} max={selected.pages} value={pageInput} onBlur={commitPage} onKeyDown={event => { if (event.key === 'Enter') commitPage() }} onChange={event => { setPageInput(event.target.value); const next = Number(event.target.value); if (Number.isInteger(next) && next >= 1 && next <= selected.pages) setPage(next) }} /><span>/ {selected.pages}</span></label>}
            actions={onDescribe && <button className="quiet-button" onClick={() => onDescribe({ source_document_id: selected.id, source_page: page, title: selected.title })}>基于此页描述需求</button>} />
        </> : <div className="library-empty">{loading ? '正在加载…' : '选择一份研报阅读。'}</div>}
      </section>
    </div>
  </div>
}

