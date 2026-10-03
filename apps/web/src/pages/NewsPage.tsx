import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CalendarRange, MessageCircle, RefreshCw, Search, X } from 'lucide-react'
import { api } from '../api'
import { isPageOffset, isText, useSessionState } from '../useSessionState'
import '../news.css'

type NewsRecord = {
  id: string; root_id: string; version: number; title: string; body: string; snippet?: string
  source: string; published_at: string | null; available_at: string | null; stock_codes: string[]; event_key: string | null
}
type NewsList = { items: NewsRecord[]; total: number; next_offset: number | null }
const emptyList: NewsList = { items: [], total: 0, next_offset: null }
const sourceNames: Record<string, string> = { eastmoney: '东方财富', wallstreetcn: '华尔街见闻', sina: '新浪财经', '10jqka': '同花顺', yuncaijing: '云财经', fenghuang: '凤凰财经', jinrongjie: '金融界' }
const sourceLabel = (source: string) => sourceNames[source.replace(/^Tushare news\//, '')] ?? source.split(' · ')[0]
const chinaTime = (value: string | null) => value ? new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '日期未提供'

export default function NewsPage({ onDiscuss, importOpen = false, onImportClose }: { onDiscuss?: (item: NewsRecord) => void; importOpen?: boolean; onImportClose?: () => void }) {
  const [list, setList] = useState<NewsList>(emptyList)
  const [query, setQuery] = useSessionState('news.query', '', isText)
  const [startDate, setStartDate] = useSessionState('news.start', '', isText)
  const [endDate, setEndDate] = useSessionState('news.end', '', isText)
  const [offset, setOffset] = useSessionState('news.offset', 0, isPageOffset)
  const [selectedId, setSelectedId] = useSessionState('news.selected', '', isText)
  const [refresh, setRefresh] = useState(0)
  const [readRetry, setReadRetry] = useState(0)
  const [selected, setSelected] = useState<NewsRecord | null>(null)
  const [fontSize, setFontSize] = useState(() => { try { const value = Number(localStorage.getItem('news.fontSize')); return value >= 12 && value <= 24 ? value : 14 } catch { return 14 } })
  const readingFontSize = fontSize - 1
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [listError, setListError] = useState('')
  const [readError, setReadError] = useState('')
  const [importError, setImportError] = useState('')
  const [notice, setNotice] = useState('')
  const request = useRef({ url: '', id: '' })
  const selection = useRef(selectedId)
  const importedId = useRef('')
  const reader = useRef<HTMLElement>(null)
  const catalog = useRef<HTMLElement>(null)
  const invalidRange = !!(startDate && endDate && startDate > endDate)

  useEffect(() => { try { localStorage.setItem('news.fontSize', String(fontSize)) } catch { /* Keep reading available. */ } }, [fontSize])
  useEffect(() => { selection.current = selectedId }, [selectedId])
  useEffect(() => {
    const controller = new AbortController()
    setListError(''); setLoading(true)
    if (invalidRange) { setLoading(false); return }
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ offset: String(offset), limit: '20' })
      if (query.trim()) params.set('query', query.trim())
      if (startDate) params.set('start_date', startDate)
      if (endDate) params.set('end_date', endDate)
      void api<NewsList>('/news?' + params, { signal: controller.signal }).then(result => {
        if (controller.signal.aborted) return
        if (!result.items.length && result.total > 0 && offset >= result.total) { setOffset(Math.floor((result.total - 1) / 20) * 20); return }
        setList(result)
        const id = importedId.current || (result.items.some(item => item.id === selection.current) ? selection.current : result.items[0]?.id ?? '')
        importedId.current = ''
        setSelectedId(id)
      }).catch(error => { if (!controller.signal.aborted) setListError(error.message) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, query ? 250 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, startDate, endDate, offset, refresh, invalidRange])

  useEffect(() => {
    const controller = new AbortController()
    setReadError(''); setSelected(null)
    if (!selectedId) { setReading(false); return }
    setReading(true)
    void api<NewsRecord>('/news/' + selectedId, { signal: controller.signal }).then(item => {
      if (!controller.signal.aborted) setSelected(item)
    }).catch(error => { if (!controller.signal.aborted) setReadError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setReading(false) })
    return () => controller.abort()
  }, [selectedId, readRetry])

  function read(id: string) {
    selection.current = id; setSelectedId(id)
    if (globalThis.matchMedia?.('(max-width: 960px)').matches) reader.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  function clearFilters() { setQuery(''); setStartDate(''); setEndDate(''); setOffset(0) }
  async function importUrl() {
    setBusy(true); setImportError(''); setNotice('')
    try {
      if (request.current.url !== url.trim()) request.current = { url: url.trim(), id: crypto.randomUUID() }
      const result = await api<{ created: number; duplicates: number; items?: NewsRecord[] }>('/news/import-url', {
        method: 'POST', body: JSON.stringify({ request_id: request.current.id, url: url.trim() }),
      })
      setNotice('已保存 ' + result.created + ' 条，跳过重复内容 ' + result.duplicates + ' 条。')
      importedId.current = result.items?.[0]?.id ?? ''
      clearFilters(); setRefresh(value => value + 1); onImportClose?.()
    } catch (reason) { setImportError((reason as Error).message) }
    finally { setBusy(false) }
  }

  return <div className="local-news">
    {notice && <div className="library-feedback" role="status">{notice}<button className="icon-button" aria-label="关闭导入提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {importOpen && <section className="local-news-panel news-import-panel" aria-label="导入资讯">
      <div className="section-title-row"><h2>从网址导入</h2><button className="icon-button" aria-label="关闭导入" onClick={onImportClose}><X size={16} /></button></div>
      <form onSubmit={event => { event.preventDefault(); void importUrl() }}>
        <label>资讯网址<input type="url" required value={url} disabled={busy} placeholder="https://…" onChange={event => setUrl(event.target.value)} /></label>
        <button className="primary-button" disabled={busy || !url.trim()}>{busy ? '正在读取并整理…' : '导入'}</button>
      </form>
      {importError && <p role="alert" className="library-error">{importError}</p>}
    </section>}
    <div className="local-news-grid">
      <section className="local-news-panel news-catalog" ref={catalog} aria-label="资讯列表" aria-busy={loading}>
        <div className="section-title-row"><h2>本地资讯</h2><span>{loading ? '加载中' : list.total + ' 条'}</span><button className="icon-button" aria-label="刷新资讯" title="刷新资讯" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} /></button></div>
        <div className="library-search"><Search size={15} /><input aria-label="搜索资讯" placeholder="搜索标题或正文" value={query} onChange={event => { setQuery(event.target.value); setOffset(0) }} />{query && <button className="icon-button" aria-label="清除资讯搜索" onClick={() => { setQuery(''); setOffset(0) }}><X size={13} /></button>}</div>
        <details className="news-date-filter"><summary><CalendarRange size={13} /><span>{startDate || endDate ? (startDate || '不限') + ' — ' + (endDate || '不限') : '日期筛选'}</span></summary>
        <div className="local-news-date-range">
          <label>从<input aria-label="资讯开始日期" type="date" max={endDate || undefined} value={startDate} onInput={event => { setStartDate(event.currentTarget.value); setOffset(0) }} onChange={event => { setStartDate(event.target.value); setOffset(0) }} /></label>
          <label>至<input aria-label="资讯结束日期" type="date" min={startDate || undefined} value={endDate} onInput={event => { setEndDate(event.currentTarget.value); setOffset(0) }} onChange={event => { setEndDate(event.target.value); setOffset(0) }} /></label>
        </div></details>
        {(startDate || endDate || query) && <button className="text-button" aria-label="清除日期范围" onClick={clearFilters}>重置筛选</button>}
        {invalidRange ? <p role="alert" className="library-error">开始日期不能晚于结束日期。</p> : listError ? <div role="alert" className="library-error">{listError}<button className="text-button" onClick={() => setRefresh(value => value + 1)}>重新加载资讯</button></div> : loading ? <div className="library-loading" role="status">正在加载资讯…</div> : !list.items.length ? <div className="library-empty">{query || startDate || endDate ? '没有找到符合筛选条件的资讯。' : '暂无资讯，可从右上角导入。'}</div> :
          <div className="local-news-list">{list.items.map(item => <button key={item.id} onClick={() => read(item.id)} aria-current={selectedId === item.id ? 'true' : undefined} className={selectedId === item.id ? 'selected' : ''}>
            <strong>{item.title}</strong><div className="news-item-meta"><span>{sourceLabel(item.source)}</span><small>{chinaTime(item.available_at ?? item.published_at)}</small></div>
          </button>)}</div>}
        <div className="library-pagination"><button className="secondary-button compact" disabled={loading || invalidRange || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span>{list.total ? Math.floor(offset / 20) + 1 : 0} / {Math.ceil(list.total / 20)}</span>
          <button className="secondary-button compact" disabled={loading || invalidRange || list.next_offset === null} onClick={() => setOffset(list.next_offset!)}>下一页</button></div>
      </section>
      <section className="local-news-panel news-reading-panel" ref={reader} aria-label="资讯阅读" aria-busy={reading}>
        <div className="news-reader-tools"><div><button className="text-button reader-back" onClick={() => catalog.current?.scrollIntoView({ behavior: 'smooth' })}><ArrowLeft size={14} />列表</button></div><div><button className="secondary-button compact" aria-label="缩小资讯字体" disabled={fontSize <= 12} onClick={() => setFontSize(value => value - 1)}>A-</button><span className="font-size-value" aria-label="当前资讯字号">{readingFontSize}</span><button className="secondary-button compact" aria-label="放大资讯字体" disabled={fontSize >= 24} onClick={() => setFontSize(value => value + 1)}>A+</button></div></div>
        {reading ? <div className="library-loading" role="status">正在读取正文…</div> : readError ? <div className="library-error" role="alert">{readError}<button className="text-button" onClick={() => setReadRetry(value => value + 1)}>重试读取</button></div> : selected ? <article className="local-news-reader" style={{ fontSize: readingFontSize }}>
          <h3>{selected.title}</h3><p className="news-metadata">{sourceLabel(selected.source)} · {chinaTime(selected.published_at ?? selected.available_at)}{selected.stock_codes.length > 0 && ' · ' + selected.stock_codes.join('、')}</p><div className="news-body">{selected.body}</div>
          {onDiscuss && <button className="quiet-button" onClick={() => onDiscuss(selected)}><MessageCircle size={15} />基于此资讯研究</button>}
        </article> : <div className="library-empty">选择一条资讯阅读。</div>}
      </section>
    </div>
  </div>
}

