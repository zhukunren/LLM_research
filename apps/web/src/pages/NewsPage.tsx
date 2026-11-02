import Pagination from '../components/Pagination'
import LoadingState from '../components/LoadingState'
import { StockText } from '../components/StockMentions'
import EmptyState from '../components/EmptyState'
import { localStorage } from '../authStorage'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, CalendarRange, Clock3, RefreshCw, Search, Upload, X } from 'lucide-react'
import { api, type ConversationSourceReference } from '../api'
import { isPageOffset, isText, useSessionState } from '../useSessionState'
import NewsCompanyChart, { type NewsChartCompany } from '../components/NewsCompanyChart'
import LibraryManagementMenu from '../components/LibraryManagementMenu'
import LibraryReadingActions from '../components/LibraryReadingActions'
import ConditionWorkspaceDrawer from '../components/ConditionWorkspaceDrawer'
import '../news.css'

type NewsRecord = {
  id: string; root_id: string; version: number; title: string; body: string; snippet?: string
  source: string; published_at: string | null; available_at: string | null; stock_codes: string[]; event_key: string | null
  chart_companies?: NewsChartCompany[]
}
type NewsList = { items: NewsRecord[]; total: number; next_offset: number | null }
const emptyList: NewsList = { items: [], total: 0, next_offset: null }
const sourceNames: Record<string, string> = { eastmoney: '东方财富', wallstreetcn: '华尔街见闻', sina: '新浪财经', '10jqka': '同花顺', yuncaijing: '云财经', fenghuang: '凤凰财经', jinrongjie: '金融界' }
const sourceLabel = (source: string) => sourceNames[source.replace(/^Tushare news\//, '')] ?? source.split(' · ')[0]
const chinaTime = (value: string | null) => value ? new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '日期未提供'

export default function NewsPage({ onDiscuss, onDefineCondition, onSourceChange, importOpen = false, onImportClose }: { onDiscuss?: (item: NewsRecord) => void; onDefineCondition?: (item: NewsRecord) => void; onSourceChange?: (source: { reference: ConversationSourceReference; label: string } | null) => void; importOpen?: boolean; onImportClose?: () => void }) {
  const [list, setList] = useState<NewsList>(emptyList)
  const [query, setQuery] = useSessionState('news.query', '', isText)
  const [startDate, setStartDate] = useSessionState('news.start', '', isText)
  const [endDate, setEndDate] = useSessionState('news.end', '', isText)
  const [offset, setOffset] = useSessionState('news.offset', 0, isPageOffset)
  const [selectedId, setSelectedId] = useSessionState('news.selected', '', isText)
  const [refresh, setRefresh] = useState(0)
  const [readRetry, setReadRetry] = useState(0)
  const [selected, setSelected] = useState<NewsRecord | null>(null)
  useEffect(() => {
    onSourceChange?.(selected && selected.id === selectedId ? { reference: { kind: 'news_item', source_id: selected.id }, label: selected.title } : null)
  }, [selected, selectedId, onSourceChange])
  useEffect(() => () => onSourceChange?.(null), [onSourceChange])
  const [fontSize, setFontSize] = useState(() => { try { const value = Number(localStorage.getItem('news.fontSize')); const previousDefault = value === 16 && localStorage.getItem('news.compactFontApplied') !== 'true'; return previousDefault ? 14 : value >= 12 && value <= 24 ? value : 14 } catch { return 14 } })
  const readingFontSize = fontSize
  const [url, setUrl] = useState('')
  const [localImportOpen, setLocalImportOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [listError, setListError] = useState('')
  const [readError, setReadError] = useState('')
  const [importError, setImportError] = useState('')
  const [notice, setNotice] = useState('')
  const [mobileView, setMobileView] = useState<'catalog' | 'reader'>('catalog')
  const request = useRef({ url: '', id: '' })
  const selection = useRef(selectedId)
  const importedId = useRef('')
  const reader = useRef<HTMLElement>(null)
  const catalog = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const catalogScroll = useRef(0)
  function mobileScrollPage() {
    return globalThis.matchMedia?.('(max-width: 620px)').matches ? catalog.current?.closest<HTMLElement>('.workspace-tool-page') : null
  }
  useLayoutEffect(() => {
    if (!globalThis.matchMedia?.('(max-width: 760px)').matches) return
    if (mobileView === 'reader') reader.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
    else {
      const page = mobileScrollPage()
      if (page) page.scrollTo?.({ top: catalogScroll.current, behavior: 'instant' })
      else window.scrollTo({ top: catalogScroll.current, behavior: 'instant' })
    }
  }, [mobileView])
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0 }, [list.items])
  const invalidRange = !!(startDate && endDate && startDate > endDate)

  useEffect(() => { try { localStorage.setItem('news.fontSize', String(fontSize)); localStorage.setItem('news.compactFontApplied', 'true') } catch { /* Keep reading available. */ } }, [fontSize])
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
    if (globalThis.matchMedia?.('(max-width: 760px)').matches && mobileView === 'catalog') catalogScroll.current = mobileScrollPage()?.scrollTop ?? window.scrollY
    selection.current = id; setSelectedId(id)
    setMobileView('reader')
  }
  function returnToCatalog() {
    setMobileView('catalog')
  }
  function clearFilters() { setQuery(''); setStartDate(''); setEndDate(''); setOffset(0) }
  function closeImport() { setLocalImportOpen(false); onImportClose?.() }
  async function importUrl() {
    setBusy(true); setImportError(''); setNotice('')
    try {
      if (request.current.url !== url.trim()) request.current = { url: url.trim(), id: crypto.randomUUID() }
      const result = await api<{ created: number; duplicates: number; items?: NewsRecord[] }>('/news/import-url', {
        method: 'POST', body: JSON.stringify({ request_id: request.current.id, url: url.trim() }),
      })
      setNotice('已保存 ' + result.created + ' 条，跳过重复内容 ' + result.duplicates + ' 条。')
      importedId.current = result.items?.[0]?.id ?? ''
      clearFilters(); setRefresh(value => value + 1); closeImport()
    } catch (reason) { setImportError((reason as Error).message) }
    finally { setBusy(false) }
  }

  return <StockText><div className="local-news library-reading-workspace" data-mobile-view={mobileView} data-catalog-scroll={catalogScroll.current}>
    {notice && <div className="library-feedback workspace-feedback workspace-feedback-success" role="status">{notice}<button className="icon-button workspace-button" aria-label="关闭导入提示" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {(importOpen || localImportOpen) && <ConditionWorkspaceDrawer title="导入资讯" closeLabel="关闭导入" description="从网址保存资讯，导入后可在本地资讯中阅读。" onClose={closeImport}>
      <form onSubmit={event => { event.preventDefault(); void importUrl() }} className="workspace-form library-news-import-form">
        <label className="workspace-field-label">资讯网址<input type="url" required value={url} disabled={busy} placeholder="https://…" onChange={event => setUrl(event.target.value)} className="workspace-field" /></label>
        <button className="primary-button workspace-button" disabled={busy || !url.trim()}>{busy ? '正在读取并整理…' : '导入'}</button>
        {importError && <p role="alert" className="library-error workspace-error">{importError}</p>}
      </form>
    </ConditionWorkspaceDrawer>}
    <nav className="library-mobile-switch" aria-label="资讯列表与阅读切换"><button type="button" aria-pressed={mobileView === 'catalog'} onClick={returnToCatalog} className="workspace-button">资讯列表</button><button type="button" aria-pressed={mobileView === 'reader'} disabled={!selectedId} onClick={() => read(selectedId)} className="workspace-button">阅读资讯</button></nav>
    <div className="local-news-grid">
      <section className="local-news-panel news-catalog library-catalog-pane" ref={catalog} aria-label="资讯列表" aria-busy={loading}>
        <div className="library-catalog-heading"><div className="library-catalog-title"><h2>本地资讯</h2><span>{loading ? '加载中' : list.total + ' 条'}</span></div><LibraryManagementMenu context="news" busy={busy ? '正在导入…' : ''}>{close => <><button type="button" role="menuitem" className="workspace-button" onClick={() => { close(); setLocalImportOpen(true) }}><Upload size={14} />导入资讯</button><button type="button" role="menuitem" className="workspace-button" disabled={loading} onClick={() => { close(); setRefresh(value => value + 1) }}><RefreshCw size={14} />刷新资讯</button></>}</LibraryManagementMenu></div>
        <div className="library-search workspace-field-shell"><Search size={15} /><input aria-label="搜索资讯" placeholder="搜索标题或正文" value={query} onChange={event => { setQuery(event.target.value); setOffset(0) }} className="workspace-field" />{query && <button className="icon-button workspace-button" aria-label="清除资讯搜索" onClick={() => { setQuery(''); setOffset(0) }}><X size={13} /></button>}</div>
        <details className="news-date-filter"><summary><CalendarRange size={13} /><span>{startDate || endDate ? (startDate || '不限') + ' — ' + (endDate || '不限') : '日期筛选'}</span></summary>
        <div className="local-news-date-range">
          <label className="workspace-field-label">从<input aria-label="资讯开始日期" type="date" max={endDate || undefined} value={startDate} onInput={event => { setStartDate(event.currentTarget.value); setOffset(0) }} onChange={event => { setStartDate(event.target.value); setOffset(0) }} className="workspace-field" /></label>
          <label className="workspace-field-label">至<input aria-label="资讯结束日期" type="date" min={startDate || undefined} value={endDate} onInput={event => { setEndDate(event.currentTarget.value); setOffset(0) }} onChange={event => { setEndDate(event.target.value); setOffset(0) }} className="workspace-field" /></label>
        </div></details>
        {(startDate || endDate || query) && <button className="text-button workspace-button" aria-label="重置资讯筛选" onClick={clearFilters}>重置筛选</button>}
        {invalidRange ? <p role="alert" className="library-error workspace-error">开始日期不能晚于结束日期。</p> : listError ? <div role="alert" className="library-error workspace-error">{listError}<button className="text-button workspace-button" onClick={() => setRefresh(value => value + 1)}>重新加载资讯</button></div> : loading ? <LoadingState compact label="正在加载资讯…" /> : !list.items.length ? <EmptyState compact title={query || startDate || endDate ? '没有找到符合筛选条件的资讯。' : '暂无资讯。'} description={query || startDate || endDate ? '调整关键词或日期范围，查看其他资讯。' : '导入资讯后，可以在这里阅读原文并发起研究。'} actions={(query || startDate || endDate) && <button className="secondary-button workspace-button" onClick={clearFilters}>查看全部资讯</button>} /> :
          <div className="local-news-list" ref={listRef}>{list.items.map(item => <button key={item.id} onClick={() => read(item.id)} aria-current={selectedId === item.id ? 'true' : undefined} className={["workspace-button", selectedId === item.id ? 'selected' : ''].filter(Boolean).join(' ')}>
            <strong>{item.title}</strong>{item.snippet && <p className="news-item-snippet">{item.snippet}</p>}<div className="news-item-meta"><span>{sourceLabel(item.source)}</span><small>{chinaTime(item.available_at ?? item.published_at)}</small></div>
          </button>)}</div>}
        <Pagination offset={offset} total={list.total} pageSize={20} nextOffset={list.next_offset} disabled={loading || invalidRange || !!listError} onChange={setOffset} label="资讯列表分页" summary={invalidRange ? '请先修正日期范围' : listError ? '暂时无法读取资讯列表' : undefined} />
      </section>
      <section className="local-news-panel news-reading-panel library-reader-pane" ref={reader} aria-label="资讯阅读" aria-busy={reading}>
        <div className="news-reader-tools"><div><span className="library-reader-eyebrow">资讯正文</span><button className="text-button reader-back workspace-button" aria-label="返回资讯列表" onClick={returnToCatalog}><ArrowLeft size={14} />返回列表</button></div><div><button className="secondary-button compact workspace-button" aria-label="缩小资讯字体" disabled={fontSize <= 12} onClick={() => setFontSize(value => value - 1)}>A-</button><span className="font-size-value" aria-label="当前资讯字号">{readingFontSize}</span><button className="secondary-button compact workspace-button" aria-label="放大资讯字体" disabled={fontSize >= 24} onClick={() => setFontSize(value => value + 1)}>A+</button></div></div>
        <LibraryReadingActions disabled={reading || !selected || selected.id !== selectedId} onResearch={onDiscuss ? () => { if (selected && selected.id === selectedId) onDiscuss(selected) } : undefined} onScreening={onDefineCondition ? () => { if (selected && selected.id === selectedId) onDefineCondition(selected) } : undefined} />
        {reading ? <LoadingState skeleton label="正在读取正文…" /> : readError ? <div className="library-error workspace-error" role="alert">{readError}<button className="text-button workspace-button" onClick={() => setReadRetry(value => value + 1)}>重试读取</button></div> : selected ? <><div className="news-reading-content" role="region" aria-label="资讯正文与行情" tabIndex={0} key={selected.id}><article className="local-news-reader" style={{ fontSize: readingFontSize }}>
          <h3>{selected.title}</h3><p className="news-metadata"><span className="news-source-badge workspace-status">{sourceLabel(selected.source)}</span><span className="news-publication-time"><Clock3 size={12} aria-hidden="true" /><time dateTime={selected.published_at ?? selected.available_at ?? undefined}>{chinaTime(selected.published_at ?? selected.available_at)}</time></span>{selected.stock_codes.map(code => <span className="news-security-tag workspace-status" key={code}>{code}</span>)}</p><div className="news-body">{selected.body}</div>
        </article><NewsCompanyChart companies={selected.chart_companies ?? selected.stock_codes.map(stock_code => ({ stock_code, name: stock_code }))} publishedAt={selected.published_at ?? selected.available_at} /></div></> : <EmptyState title="未选择资讯" description="从资讯列表选择一条，阅读正文和关联公司的行情。" />}
      </section>
    </div>
  </div></StockText>
}
