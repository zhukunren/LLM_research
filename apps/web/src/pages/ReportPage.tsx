import { StockText } from '../components/StockMentions'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, MessageCircle, RefreshCw, Search, Upload, X } from 'lucide-react'
import { api } from '../api'
import PdfReader from '../components/PdfReader'
import { isText, useSessionState } from '../useSessionState'
import type { LibrarySeed } from '../libraryContext'
import '../report-search.css'

type Document = {
  id: string; filename: string; title: string; publication_date: string | null; stock_code: string | null; pages: number
  metadata_status: string; metadata_error?: string; parse_status: string
  metadata?: { fields?: Record<string, { value: string; page: number; quote: string }> }
}
type SearchMode = 'smart' | 'exact'
type Hit = {
  document_id: string; title: string; page_number: number; snippet: string
  matched_terms?: string[]; match_type?: string; retrieval_method?: string; relevance_score?: number
}
type SearchResult = {
  items: Hit[]; query_terms?: string[]; expanded_terms?: string[]; coverage_note?: string
  total?: number; next_offset?: number | null
}
const validSearchMode = (value: unknown): value is SearchMode => value === 'smart' || value === 'exact'
const validPositions = (value: unknown): value is Record<string, number> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(n => Number.isInteger(n) && Number(n) >= 1)

export default function ReportPage({ onDescribe, onDefineCondition }: { contentOnly?: boolean; onDescribe?: (seed?: Omit<LibrarySeed, 'id'>) => void; onDefineCondition?: (seed?: Omit<LibrarySeed, 'id'>) => void }) {
  const [docs, setDocs] = useState<Document[]>([])
  const [selectedId, setSelectedId] = useSessionState('report.selected', '', isText)
  const [positions, setPositions] = useSessionState<Record<string, number>>('report.pages', {}, validPositions)
  const [query, setQuery] = useSessionState('report.query', '', isText)
  const [searchMode, setSearchMode] = useSessionState<SearchMode>('report.searchMode', 'smart', validSearchMode)
  const [pageInput, setPageInput] = useState('1')
  const [hits, setHits] = useState<Hit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchRetry, setSearchRetry] = useState(0)
  const [searchInfo, setSearchInfo] = useState<SearchResult | null>(null)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState('')
  const [mobileView, setMobileView] = useState<'catalog' | 'reader'>('catalog')
  const reader = useRef<HTMLElement>(null)
  const catalog = useRef<HTMLElement>(null)
  const searchVersion = useRef(0)
  const searchRequest = useRef<AbortController | null>(null)
  const selected = docs.find(item => item.id === selectedId)
  const page = Math.min(positions[selectedId] ?? 1, selected?.pages || 1)
  const pdfUrl = selected ? '/api/v1/documents/' + selected.id + '/pdf#page=' + page : ''
  const normalizedQuery = query.trim().toLowerCase()
  const filteredDocs = useMemo(() => {
    if (!normalizedQuery) return docs
    const hitOrder = new Map<string, number>()
    hits.forEach((hit, index) => { if (!hitOrder.has(hit.document_id)) hitOrder.set(hit.document_id, index) })
    return docs.filter(item => {
      const metadata = Object.values(item.metadata?.fields ?? {}).map(field => field.value).join(' ')
      return [item.title, item.filename, item.stock_code, metadata].join(' ').toLowerCase().includes(normalizedQuery) || hitOrder.has(item.id)
    }).sort((left, right) => (hitOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (hitOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER))
  }, [docs, normalizedQuery, hits])
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
    searchRequest.current?.abort()
    searchRequest.current = controller
    const version = ++searchVersion.current
    setHits([]); setSearchError(''); setSearchInfo(null); setNextOffset(null); setLoadingMore(false); setMoreError('')
    if (!normalizedQuery) { setSearching(false); return }
    setSearching(true)
    const timer = setTimeout(() => {
      void api<SearchResult>('/documents/search', { method: 'POST', body: JSON.stringify({ query: query.trim(), mode: searchMode, limit: 30, offset: 0 }), signal: controller.signal })
        .then(result => {
          if (controller.signal.aborted || version !== searchVersion.current) return
          setHits(result.items); setSearchInfo(result); setNextOffset(result.next_offset ?? null)
        })
        .catch(error => { if (!controller.signal.aborted && version === searchVersion.current) setSearchError(error.message) })
        .finally(() => { if (!controller.signal.aborted && version === searchVersion.current) setSearching(false) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort(); searchRequest.current?.abort() }
  }, [query, searchMode, searchRetry])

  function resetSearch() {
    ++searchVersion.current
    searchRequest.current?.abort()
    setHits([]); setSearchInfo(null); setNextOffset(null); setSearchError(''); setMoreError(''); setLoadingMore(false)
  }
  function changeQuery(value: string) {
    if (value !== query) resetSearch()
    setQuery(value)
  }
  function changeSearchMode(value: SearchMode) {
    if (value === searchMode) return
    resetSearch(); setSearchMode(value)
  }
  function retrySearch() {
    resetSearch(); setSearchRetry(value => value + 1)
  }
  async function loadMore() {
    if (nextOffset === null || searching || loadingMore) return
    const version = searchVersion.current
    const controller = new AbortController()
    searchRequest.current = controller
    setLoadingMore(true); setMoreError('')
    try {
      const result = await api<SearchResult>('/documents/search', { method: 'POST', body: JSON.stringify({ query: query.trim(), mode: searchMode, limit: 30, offset: nextOffset }), signal: controller.signal })
      if (controller.signal.aborted || version !== searchVersion.current) return
      setHits(current => {
        const seen = new Set(current.map(hit => hit.document_id + ':' + hit.page_number))
        return [...current, ...result.items.filter(hit => {
          const key = hit.document_id + ':' + hit.page_number
          if (seen.has(key)) return false
          seen.add(key); return true
        })]
      })
      setSearchInfo(result); setNextOffset(result.next_offset ?? null)
    } catch (error) {
      if (!controller.signal.aborted && version === searchVersion.current) setMoreError((error as Error).message)
    } finally {
      if (!controller.signal.aborted && version === searchVersion.current) setLoadingMore(false)
    }
  }

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
      const result = await api<{ result?: { id?: string; status: string; reason?: string } }>('/documents/upload', { method: 'POST', body: form })
      if (result.result?.status === 'failed') throw new Error('PDF 已保存，正文索引失败：' + (result.result.reason || '请检查文件后重新索引。'))
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
    setMobileView('reader')
  }
  function commitPage() {
    const next = Math.max(1, Math.min(selected?.pages || 1, Math.floor(Number(pageInput)) || 1))
    setPage(next); setPageInput(String(next))
  }
  return <StockText><div className="report-reading-workspace library-reading-workspace" data-mobile-view={mobileView}>
    <div className="report-library-toolbar">

      <div className="report-import-actions"><button className="secondary-button" disabled={!!busy} onClick={() => action('index', async () => { const result = await api<{ imported: number; failed: number }>('/documents/import-local', { method: 'POST' }); setNotice('新增 ' + result.imported + ' 份研报' + (result.failed ? '，' + result.failed + ' 份未能读取。' : '。')) })}><RefreshCw size={14} />{busy === 'index' ? '正在索引…' : '索引本地研报'}</button><label className={'upload-label report-upload ' + (busy ? 'disabled' : '')}><Upload size={14} />{busy === 'upload' ? '正在上传…' : '上传 PDF'}<input type="file" accept="application/pdf" disabled={!!busy} aria-label="上传研报 PDF" onChange={event => { void upload(event.target.files?.[0]); event.target.value = '' }} /></label></div>
    </div>
    {notice && <div className="library-feedback" role="status">{notice}<button className="icon-button" aria-label="关闭研报提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {actionError && <div className="library-error" role="alert">{actionError}<button className="icon-button" aria-label="关闭研报错误" onClick={() => setActionError('')}><X size={14} /></button></div>}
    <nav className="library-mobile-switch" aria-label="研报列表与阅读切换"><button type="button" aria-pressed={mobileView === 'catalog'} onClick={() => setMobileView('catalog')}>研报列表</button><button type="button" aria-pressed={mobileView === 'reader'} disabled={!selected} onClick={() => setMobileView('reader')}>阅读研报</button></nav>
    <div className="report-reading-layout">
      <aside className="report-catalog library-catalog-pane" ref={catalog} aria-label="研报列表">
        <div className="report-catalog-heading"><strong>本地研报</strong><span>{filteredDocs.length} / {docs.length} 份</span>{pending > 0 && <small>{pending} 份整理中</small>}</div>
        <form onSubmit={event => { event.preventDefault(); retrySearch() }} className="library-search report-search"><Search size={16} /><input aria-label="搜索研报" placeholder="标题、代码、分析师或正文" value={query} onChange={event => changeQuery(event.target.value)} />{query && <button type="button" className="icon-button" aria-label="清除研报搜索" onClick={() => changeQuery('')}><X size={14} /></button>}<button className="text-button" aria-label="搜索" type="submit" disabled={searching}>{searching ? '检索中…' : '搜索'}</button></form>
        <div className="segmented compact-segment" role="group" aria-label="研报搜索方式"><button type="button" className={searchMode === 'smart' ? 'selected' : ''} aria-pressed={searchMode === 'smart'} onClick={() => changeSearchMode('smart')}>扩展搜索</button><button type="button" className={searchMode === 'exact' ? 'selected' : ''} aria-pressed={searchMode === 'exact'} onClick={() => changeSearchMode('exact')}>精确匹配</button></div>
        {normalizedQuery && (searchInfo?.coverage_note || !!searchInfo?.expanded_terms?.length) && <p className="workbench-help">{searchInfo?.coverage_note}{!!searchInfo?.expanded_terms?.length && <span> 相关词：{searchInfo.expanded_terms.join('、')}</span>}</p>}
        <div className="library-catalog-rows">
        {loadError && <div className="library-error" role="alert">{loadError}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>重新加载研报</button></div>}
        {searchError && <div className="library-error" role="alert">正文检索失败，当前仅显示字典匹配。<button className="text-button" onClick={retrySearch}>重试搜索</button></div>}
        {filteredDocs.map(item => {
          const documentHits = hits.filter(hit => hit.document_id === item.id)
          const firstHit = documentHits[0]
          return <button key={item.id} aria-current={selectedId === item.id ? 'true' : undefined} className={selectedId === item.id ? 'selected' : ''} onClick={() => select(item.id, firstHit?.page_number)}>
            <strong>{item.title}</strong><span className="report-security">{item.metadata?.fields?.stock_name?.value || item.stock_code || '行业研究'}{item.metadata?.fields?.stock_name && item.stock_code && <small>{item.stock_code}</small>}</span><small>{item.metadata?.fields?.broker?.value || '券商待识别'} · {item.publication_date ?? '日期待识别'} · {item.pages} 页</small>{firstHit && <><span className="report-hit-badge">正文命中 {documentHits.length} 页 · 第 {firstHit.page_number} 页</span><span className="report-result-snippet">{firstHit.snippet}</span>{!!firstHit.matched_terms?.length && <small>命中词：{firstHit.matched_terms.join('、')}</small>}</>}
          </button>
        })}
        {normalizedQuery && searchInfo && !!hits.length && <p className="workbench-help">已显示 {hits.length} / {searchInfo.total ?? hits.length} 处原文命中</p>}
        {moreError && <div className="library-error" role="alert">更多结果加载失败：{moreError}</div>}
        {nextOffset !== null && <button type="button" className="text-button" disabled={searching || loadingMore} onClick={() => void loadMore()}>{loadingMore ? '正在加载更多命中…' : moreError ? '重试加载更多' : '加载更多命中'}</button>}
        {(loading || searching) && <div className="library-loading" role="status">{loading ? '正在加载研报…' : '正在检索正文…'}</div>}
        {!loading && !searching && !filteredDocs.length && !loadError && <div className="library-empty">{docs.length ? '没有找到相关研报。' : '暂无研报。'}{query && <button className="text-button" onClick={() => changeQuery('')}>查看全部研报</button>}</div>}
        </div>
      </aside>
      <section className="report-pdf-reader library-reader-pane" ref={reader} aria-label="研报阅读">
        {selected ? <>
          <div className="report-reader-heading"><div><button className="text-button reader-back" onClick={() => setMobileView('catalog')}><ArrowLeft size={14} />研报列表</button><h2>{selected.title}</h2></div><a className="quiet-button" href={pdfUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={14} />在浏览器中打开</a></div>
          {normalizedQuery && !searching && !filteredDocs.some(item => item.id === selected.id) && <p className="reader-context-note">当前研报不在搜索结果中。</p>}
          <div className="report-reading-meta"><span>{selected.metadata?.fields?.stock_name?.value} {selected.stock_code}</span><span>{selected.metadata?.fields?.broker?.value || '券商待识别'}</span><span>{selected.publication_date ?? '日期待识别'}</span></div>
          <details className="report-info-details"><summary>研报信息</summary>
          <dl className="report-dictionary">{[
            ['代码', selected.stock_code], ['股票名称', selected.metadata?.fields?.stock_name?.value],
            ['标题', selected.metadata?.fields?.title?.value ?? selected.title], ['分析师', selected.metadata?.fields?.analysts?.value],
            ['券商名称', selected.metadata?.fields?.broker?.value], ['主题', selected.metadata?.fields?.theme?.value],
            ['主要观点', selected.metadata?.fields?.main_points?.value], ['发布日期', selected.publication_date],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}</dl>
          </details>
          {selected.parse_status === 'indexed' && ['queued', 'running'].includes(selected.metadata_status) && <p className="workbench-help">正在整理研报字典。</p>}
          {selected.metadata_status === 'failed' && <div className="library-error" role="alert">{selected.metadata_error}<button className="text-button" disabled={!!busy} onClick={() => action('retry', async () => { await api('/documents/catalog?retry_failed=true', { method: 'POST' }) })}>重新整理</button></div>}
          {selected.parse_status === 'no_text' && <p className="workbench-help">此 PDF 没有可提取文字，字典信息暂缺。</p>}
          {!!selectedHits.length && <details className="report-search-hits" open={!!normalizedQuery}><summary>正文命中 {selectedHits.length} 页</summary>{selectedHits.map(hit => <button key={hit.page_number} onClick={() => setPage(hit.page_number)}><strong>第 {hit.page_number} 页</strong><span>{hit.snippet}</span>{!!hit.matched_terms?.length && <small>命中词：{hit.matched_terms.join('、')}</small>}</button>)}</details>}
          <PdfReader key={selected.id} url={'/api/v1/documents/' + selected.id + '/pdf'} page={page} onPageChange={setPage}
            pageControls={<label className="pdf-page-jump"><input aria-label="研报页码" type="number" min={1} max={selected.pages} value={pageInput} onBlur={commitPage} onKeyDown={event => { if (event.key === 'Enter') commitPage() }} onChange={event => { setPageInput(event.target.value); const next = Number(event.target.value); if (Number.isInteger(next) && next >= 1 && next <= selected.pages) setPage(next) }} /><span>/ {selected.pages}</span></label>}
            actions={<>{onDescribe && <button className="quiet-button" aria-label="研究此页" title="基于当前页研究" onClick={() => onDescribe({ source_document_id: selected.id, source_page: page, title: selected.title })}><MessageCircle size={15} /><span className="pdf-study-label">研究此页</span><span className="pdf-study-short">研究</span></button>}{onDefineCondition && <button className="quiet-button" aria-label="据此定义条件" title="用当前页定义选股条件" onClick={() => onDefineCondition({ source_document_id: selected.id, source_page: page, title: selected.title })}>据此定义条件</button>}</>} />
        </> : <div className="library-empty">{loading ? '正在加载…' : '未选择研报'}</div>}
      </section>
    </div>
  </div></StockText>
}
