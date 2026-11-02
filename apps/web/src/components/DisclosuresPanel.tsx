import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import StockSearch, { StockName } from './StockSearch'
import PdfReader from './PdfReader'
import LibraryManagementMenu from './LibraryManagementMenu'
import LibraryReadingActions from './LibraryReadingActions'
import { Check, Plus, RefreshCw, Upload } from 'lucide-react'
import type { LibrarySeed } from '../libraryContext'
import './disclosures.css'

type Metadata = { title: string; stock_code: string | null; report_period: string | null; document_type: string; document_form: string; publication_date: string | null; confirmed: boolean }
type Version = {
  id: string; disclosure_id: string; document_id: string; version: number; pages: number; parse_status: string; sha256: string
  pdf_url: string; source_kind: string; source_url: string | null; created_at: string
  metadata: Metadata & { revision: number; suggestions: Partial<Metadata> }
}
type Detail = Version & { versions: Version[]; related: (Version & { relationship_needs_review?: boolean })[]; metadata_history: { revision: number; created_at: string; metadata: Metadata }[];
  sources?: { import_id: string; filename: string; source_url: string | null; final_url: string | null; created_at: string }[] }
type Import = { id: string; job_id: string; state: string; message: string; stage: string; version_id: string | null; filename: string; progress: number; request: { metadata: Metadata } }
type Page = { text: string; next_offset: number | null; page_number: number }
const types: Record<string, string> = { annual: '年度报告', half_year: '半年度报告', q1: '一季度报告', q3: '三季度报告', audit: '审计报告', correction: '更正或补充公告', other: '其他披露' }
const forms: Record<string, string> = { full: '全文', summary: '摘要', notice: '公告或说明' }
const empty = (code?: string): Metadata => ({ title: '', stock_code: code || null, report_period: null, document_type: 'other', document_form: 'full', publication_date: null, confirmed: false })
function clean(meta: Metadata): Metadata {
  return { title: meta.title, stock_code: meta.stock_code, report_period: meta.report_period, document_type: meta.document_type,
    document_form: meta.document_form, publication_date: meta.publication_date, confirmed: meta.confirmed }
}

export default function DisclosuresPanel({ stockCode, asOf, writable = true, compact = false, onDescribe, onDefineCondition }: { stockCode?: string; asOf?: string; writable?: boolean; compact?: boolean; onDescribe?: (seed: Omit<LibrarySeed, 'id'>) => void; onDefineCondition?: (seed: Omit<LibrarySeed, 'id'>) => void }) {
  const [code, setCode] = useState(stockCode || '')
  const [period, setPeriod] = useState('')
  const [kind, setKind] = useState('')
  const [formFilter, setFormFilter] = useState('')
  const [classification, setClassification] = useState('')
  const [queryInput, setQueryInput] = useState(''), [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0)
  const [detailRevision, setDetailRevision] = useState(0)
  const [listing, setListing] = useState<{ items: Version[]; total: number } | null>(null)
  const [selected, setSelected] = useState(''), [detail, setDetail] = useState<Detail | null>(null)
  const [page, setPage] = useState(1), [pageText, setPageText] = useState<Page | null>(null)
  const [pageQuery, setPageQuery] = useState(''), [hits, setHits] = useState<{ page_number: number; snippet: string }[]>([])
  const [imports, setImports] = useState<Import[]>([]), [importRevision, setImportRevision] = useState(0)
  const [options, setOptions] = useState<{ can_write: boolean } | null>(null)
  const [error, setError] = useState(''), [readError, setReadError] = useState('')
  const [editing, setEditing] = useState<'import' | 'metadata' | null>(null)
  const [draft, setDraft] = useState<Metadata>(() => empty(stockCode))
  const [mode, setMode] = useState<'upload' | 'url'>('upload')
  const [url, setUrl] = useState(''), [file, setFile] = useState<File | null>(null)
  const [relation, setRelation] = useState<'new' | 'revision' | 'supplement'>('new')
  const [target, setTarget] = useState(''), [editBase, setEditBase] = useState(1), [propagate, setPropagate] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const requestKey = useRef('')
  const submittedImport = useRef('')
  const editingState = useRef(editing)
  editingState.current = editing
  const seen = useRef(new Set<string>())
  const readingKey = useRef(''), searchSequence = useRef(0)
  readingKey.current = `${selected}|${asOf || ''}`
  const canWrite = writable && !!options?.can_write
  const scopeSuffix = asOf ? `?as_of=${encodeURIComponent(asOf)}` : ''
  useEffect(() => { setCode(stockCode || ''); setOffset(0); setSelected(''); setEditing(null) }, [stockCode, asOf])
  useEffect(() => { setEditing(null) }, [selected])
  useEffect(() => {
    const controller = new AbortController()
    api<{ can_write: boolean }>('/disclosures/import-options', { signal: controller.signal }).then(setOptions)
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ offset: String(offset), limit: '20' })
    for (const [key, value] of Object.entries({ stock_code: code, report_period: period, document_type: kind, document_form: formFilter, classification, q: query, as_of: asOf })) if (value) params.set(key, value)
    setListing(null)
    api<{ items: Version[]; total: number }>(`/disclosures?${params}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setListing(value) })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [code, period, kind, formFilter, classification, query, asOf, offset, revision])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function load() {
      try {
        const data = await api<{ items: Import[] }>('/disclosure-imports', { signal: controller.signal })
        if (controller.signal.aborted) return
        setImports(data.items)
        let changed = false
        for (const item of data.items) if (item.state === 'succeeded' && !seen.current.has(item.id)) {
          seen.current.add(item.id); changed = true
          if (item.id === submittedImport.current && item.version_id) {
            if (editingState.current === null) setSelected(item.version_id)
            submittedImport.current = ''
          }
        }
        if (changed) setRevision(v => v + 1)
        if (data.items.some(item => ['queued', 'running'].includes(item.state))) timer = setTimeout(() => void load(), 1500)
      } catch (reason) {
        if (!controller.signal.aborted) { setError((reason as Error).message); timer = setTimeout(() => void load(), 5000) }
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [importRevision])
  useEffect(() => {
    setDetail(null); setPage(1); setPageText(null); setHits([]); setPageQuery(''); setReadError('')
    if (!selected) return
    const controller = new AbortController()
    api<Detail>(`/disclosures/versions/${selected}${scopeSuffix}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setDetail(value) })
      .catch(reason => { if (!controller.signal.aborted) setReadError(reason.message) })
    return () => controller.abort()
  }, [selected, asOf, detailRevision])
  useEffect(() => {
    setPageText(null)
    if (!detail || detail.id !== selected) return
    const controller = new AbortController()
    api<Page>(`/disclosures/versions/${selected}/pages/${page}${scopeSuffix}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPageText(value) })
      .catch(reason => { if (!controller.signal.aborted) setReadError(reason.message) })
    return () => controller.abort()
  }, [detail, page, selected, asOf])
  function changeDraft(change: Partial<Metadata>) { requestKey.current = ''; setDraft(old => ({ ...old, ...change })) }
  function beginImport(next: 'new' | 'revision' | 'supplement') {
    setError(''); setRelation(next); setEditing('import'); setUrl(''); setFile(null); requestKey.current = ''
    setTarget(next !== 'new' && detail ? detail.id : '')
    setDraft(next === 'new' || !detail ? empty(stockCode) : { ...clean(detail.metadata), confirmed: false, publication_date: null,
      ...(next === 'supplement' ? { title: '更正或补充材料', document_type: 'correction', document_form: 'notice' } : {}) })
  }
  function beginMetadata() {
    if (!detail) return
    setDraft(clean(detail.metadata)); setEditBase(detail.metadata.revision); setPropagate(false); setEditing('metadata'); setError('')
  }
  async function submit() {
    setSubmitting(true); setError('')
    try {
      if (editing === 'metadata' && detail) {
        await api(`/disclosures/versions/${detail.id}/metadata`, { method: 'PATCH', body: JSON.stringify({ metadata: draft, base_revision: editBase, propagate_identity: propagate }) })
        setRevision(v => v + 1); setDetailRevision(v => v + 1)
      } else {
        requestKey.current ||= crypto.randomUUID()
        const payload = { request_id: requestKey.current, metadata: draft, relation, target_version_id: target || null, ...(mode === 'url' ? { url } : {}) }
        let item: Import
        if (mode === 'upload') {
          if (!file) throw new Error('请选择 PDF 文件')
          const data = new FormData(); data.set('file', file); data.set('payload', JSON.stringify(payload))
          item = await api<Import>('/disclosures/upload', { method: 'POST', body: data })
        } else item = await api<Import>('/disclosures/import-url', { method: 'POST', body: JSON.stringify(payload) })
        submittedImport.current = item.id
        setImports(old => [item, ...old.filter(value => value.id !== item.id)])
        setImportRevision(v => v + 1)
      }
      setEditing(null)
    } catch (reason) { setError((reason as Error).message) }
    finally { setSubmitting(false) }
  }
  async function action(item: Import, stop: boolean) {
    setError('')
    try {
      await api(stop ? `/jobs/${item.job_id}/cancel` : `/disclosure-imports/${item.id}/retry`, { method: 'POST' })
      if (!stop) submittedImport.current = item.id
      setImportRevision(v => v + 1)
    } catch (reason) { setError((reason as Error).message) }
  }
  async function search() {
    if (!selected || !pageQuery.trim()) return
    const wanted = readingKey.current, sequence = ++searchSequence.current
    setReadError('')
    try {
      const params = new URLSearchParams({ q: pageQuery, limit: '100' }); if (asOf) params.set('as_of', asOf)
      const result = await api<{ items: typeof hits }>(`/disclosures/versions/${selected}/search?${params}`)
      if (wanted !== readingKey.current || sequence !== searchSequence.current) return
      setHits(result.items)
      if (!result.items.length) setReadError('当前文字索引未找到匹配；图片页仍可在 PDF 中阅读。')
    } catch (reason) { if (wanted === readingKey.current && sequence === searchSequence.current) setReadError((reason as Error).message) }
  }
  async function moreText() {
    if (pageText?.next_offset == null) return
    const wanted = readingKey.current, physicalPage = page, previous = pageText
    try {
      const params = new URLSearchParams({ offset: String(pageText.next_offset) }); if (asOf) params.set('as_of', asOf)
      const next = await api<Page>(`/disclosures/versions/${selected}/pages/${page}?${params}`)
      setPageText(current => current === previous && wanted === readingKey.current && physicalPage === current.page_number ? { ...next, text: current.text + next.text } : current)
    } catch (reason) { setReadError((reason as Error).message) }
  }
  const relevantImports = imports.filter(item => !stockCode || item.request.metadata.stock_code === stockCode)
  return <section className={`disclosures-panel${compact ? ' compact' : ''}`} aria-label="原始披露归档">
    <div className="disclosure-heading"><h2>原始披露</h2><LibraryManagementMenu context={'disclosure:' + selected} busy={submitting ? '正在提交…' : ''}>{close => <>
      {canWrite && <button type="button" role="menuitem" className="workspace-button" onClick={() => { close(); beginImport('new') }}><Upload size={14} />归档原始披露</button>}
      {canWrite && detail && <button type="button" role="menuitem" className="workspace-button" disabled={detail.id !== selected} onClick={() => { close(); beginMetadata() }}><Check size={14} />核对分类</button>}
      {canWrite && detail?.metadata.confirmed && <><button type="button" role="menuitem" className="workspace-button" disabled={detail.id !== selected} onClick={() => { close(); beginImport('revision') }}><Plus size={14} />添加修订全文</button><button type="button" role="menuitem" className="workspace-button" disabled={detail.id !== selected} onClick={() => { close(); beginImport('supplement') }}><Plus size={14} />关联更正或补充材料</button></>}
      <button type="button" role="menuitem" className="workspace-button" onClick={() => { close(); setRevision(value => value + 1); setImportRevision(value => value + 1) }}><RefreshCw size={14} />刷新归档列表</button>
    </>}</LibraryManagementMenu></div>
    <p className="research-secondary">{asOf ? `资料截至 ${asOf}，仅展示已确认分类和披露日期的版本。` : '上传财报 PDF 或导入官方原文链接，核对分类后按公司与报告期查阅。'}</p>
    {error && <p role="alert" className="workspace-error">{error}<button className="text-button workspace-button" onClick={() => { setError(''); setRevision(v => v + 1); setImportRevision(v => v + 1) }}>刷新归档状态</button></p>}
    {editing && <form className="disclosure-editor" onSubmit={event => { event.preventDefault(); void submit() }}>
      <h3>{editing === 'metadata' ? '核对原文分类' : relation === 'new' ? '导入原始披露' : relation === 'revision' ? '添加修订全文' : '添加相关更正或补充材料'}</h3>
      {editing === 'import' && <>
        <div className="disclosure-actions"><button type="button" className="secondary-button workspace-button" aria-pressed={mode === 'upload'} onClick={() => { setMode('upload'); requestKey.current = '' }}>上传 PDF</button><button type="button" className="secondary-button workspace-button" aria-pressed={mode === 'url'} onClick={() => { setMode('url'); requestKey.current = '' }}>官方链接</button></div>
        {mode === 'upload' ? <label>PDF 文件（最多 50 MB）<input aria-label="原始披露 PDF 文件" type="file" accept=".pdf,application/pdf" onChange={event => { setFile(event.target.files?.[0] || null); requestKey.current = '' }} /></label> :
          <label>官方 PDF 原文链接<input type="url" required value={url} onChange={event => { setUrl(event.target.value); requestKey.current = '' }} placeholder="https://static.cninfo.com.cn/…pdf" /><small>支持巨潮、上交所、深交所和北交所；发行人官网可由维护者登记。</small></label>}
        {relation !== 'new' && <p>关联原版本：{detail?.metadata.title} · 第 {detail?.version} 版。{relation === 'revision' ? '须与原文保持相同公司、报告期及全文/摘要类型。' : '作为独立补充材料保存，完整报告继续保留。'}</p>}
      </>}
      <div className="disclosure-fields">
        <label>标题<input value={draft.title} onChange={e => changeDraft({ title: e.target.value })} maxLength={300} /></label>
        <div className="disclosure-stock-field"><span>归属公司</span><StockSearch label="归属公司" value={draft.stock_code || ''} onChange={value => changeDraft({ stock_code: value || null })} /></div>
        <label>报告期末<input type="date" value={draft.report_period || ''} onChange={e => changeDraft({ report_period: e.target.value || null })} /></label>
        <label>披露类型<select value={draft.document_type} onChange={e => changeDraft({ document_type: e.target.value })}>{Object.entries(types).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
        <label>原文形式<select value={draft.document_form} onChange={e => changeDraft({ document_form: e.target.value })}>{Object.entries(forms).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
        <label>披露日期<input type="date" value={draft.publication_date || ''} onChange={e => changeDraft({ publication_date: e.target.value || null })} /></label>
      </div>
      {editing === 'metadata' && detail?.metadata.suggestions && <button type="button" className="text-button workspace-button" onClick={() => changeDraft({ ...detail.metadata.suggestions, confirmed: false })}>采用识别建议并核对</button>}
      <label className="disclosure-check"><input type="checkbox" checked={draft.confirmed} onChange={e => changeDraft({ confirmed: e.target.checked })} />我已核对公司、报告期、类型和填写的披露日期</label>
      <p className="research-secondary">不确定的分类可以留空，先保存为待核对。报告期不会被当作披露日期。</p>
      {editing === 'metadata' && (detail?.versions.length || 0) > 1 && <label className="disclosure-check"><input type="checkbox" checked={propagate} onChange={e => setPropagate(e.target.checked)} />同步更改同系列的公司、报告期和类型；其他版本重新待核对</label>}
      <div className="disclosure-actions"><button className="primary-button workspace-button" disabled={submitting}>{submitting ? '正在提交…' : editing === 'metadata' ? '保存分类核对' : '提交归档'}</button><button type="button" className="secondary-button workspace-button" disabled={submitting} onClick={() => setEditing(null)}>取消编辑</button></div>
    </form>}
    {!compact && <div className="disclosure-filters">
      <div className="disclosure-stock-field"><span>按公司筛选</span><StockSearch label="按公司筛选披露" value={code} onChange={value => { setCode(value); setOffset(0) }} /></div>
      <label>按报告期筛选<input type="date" value={period} onChange={e => { setPeriod(e.target.value); setOffset(0) }} /></label>
      <label>按类型筛选<select value={kind} onChange={e => { setKind(e.target.value); setOffset(0) }}><option value="">全部类型</option>{Object.entries(types).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      <label>全文或摘要<select value={formFilter} onChange={e => { setFormFilter(e.target.value); setOffset(0) }}><option value="">全部形式</option>{Object.entries(forms).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      <label>核对状态<select value={classification} onChange={e => { setClassification(e.target.value); setOffset(0) }}><option value="">全部状态</option><option value="pending">待核对</option><option value="confirmed">分类已核对</option></select></label>
      <form onSubmit={e => { e.preventDefault(); setQuery(queryInput); setOffset(0) }}><label>标题或原文<input value={queryInput} onChange={e => setQueryInput(e.target.value)} maxLength={300} /></label><button className="secondary-button workspace-button">查找披露</button></form>
    </div>}
    {relevantImports.length > 0 && <details className="disclosure-imports" open={relevantImports.some(item => ['queued', 'running', 'failed'].includes(item.state))}><summary>最近导入与重试</summary>
      {relevantImports.slice(0, 10).map(item => <div className="disclosure-import" key={item.id}><strong>{item.request.metadata.title || item.filename}</strong><p>{item.message}</p>
        {['queued', 'running'].includes(item.state) ? <><progress aria-label="归档进度" max={1} value={item.progress} />{canWrite && <button className="text-button workspace-button" onClick={() => void action(item, true)}>停止导入</button>}</> :
          ['failed', 'cancelled', 'partial'].includes(item.state) && canWrite && <button className="text-button workspace-button" onClick={() => void action(item, false)}>重试归档</button>}
        {item.version_id && <button className="text-button workspace-button" onClick={() => { setSelected(item.version_id!); setEditing(null) }}>打开归档版本</button>}
      </div>)}</details>}
    {!listing ? <p>正在读取披露目录…</p> : <>
      <p className="research-secondary">{listing.total} 组原始披露 · 默认展示当前筛选条件下的最新版本</p>
      {!listing.items.length && <p>{asOf ? '当前截止日前没有已确认的原始披露。待核对资料可在资料库查看。' : '当前筛选范围没有原始披露，可上传 PDF 或导入官方链接。'}</p>}
      <div className="disclosure-list">{listing.items.map(item => <button className="disclosure-row workspace-button" key={item.id} aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setEditing(null) }}>
        <strong>{item.metadata.title}</strong><span>{item.metadata.stock_code ? <StockName code={item.metadata.stock_code} interactive={false} /> : '公司待核对'} · {item.metadata.report_period || '报告期待核对'} · {types[item.metadata.document_type]} · {forms[item.metadata.document_form]}</span>
        <small>第 {item.version} 版 · {item.pages} 页 · {item.metadata.confirmed ? '分类已核对' : '分类待核对'} · {item.metadata.publication_date || '披露日期待核对'}</small>
      </button>)}</div>
      {listing.total > 20 && <div className="disclosure-actions"><button className="secondary-button workspace-button" disabled={!offset} onClick={() => setOffset(v => Math.max(0, v - 20))}>上一批披露</button><button className="secondary-button workspace-button" disabled={offset + 20 >= listing.total} onClick={() => setOffset(v => v + 20)}>下一批披露</button></div>}
    </>}
    {readError && <p role="alert" className="workspace-error">{readError}<button className="text-button workspace-button" onClick={() => setDetailRevision(v => v + 1)}>重新读取原文</button></p>}
    {detail && <section className="disclosure-reader" aria-label="披露版本阅读">
      <div className="disclosure-heading"><h3>{detail.metadata.title}</h3><button className="text-button workspace-button" onClick={() => { setSelected(''); setEditing(null) }}>关闭原文</button></div>
      <div className="disclosure-actions"><label>原文版本<select value={detail.id} onChange={e => { setSelected(e.target.value); setEditing(null) }}>{detail.versions.map(v => <option value={v.id} key={v.id}>第 {v.version} 版 · {v.metadata.publication_date || '披露日期待核对'}</option>)}</select></label>
        <a href={detail.pdf_url + (detail.pdf_url.includes('?') ? '&' : '?') + 'download=1'} target="_blank" rel="noreferrer">打开原 PDF</a>
      </div>
      <p className="research-secondary">{detail.source_kind === 'upload' ? '用户上传原文' : <a href={detail.source_url!} target="_blank" rel="noreferrer">官方原文来源</a>} · 页码为 PDF 物理页 · {detail.metadata.confirmed && detail.metadata.publication_date ? '披露日期经人工核对' : '披露时间待核对'}</p>
      {detail.parse_status === 'no_text' && <p>此 PDF 暂无可提取文字，仍可逐页阅读原文。</p>}
      <form className="disclosure-actions" onSubmit={e => { e.preventDefault(); void search() }}><label>检索本份原文<input value={pageQuery} maxLength={200} onChange={e => setPageQuery(e.target.value)} /></label><button className="secondary-button workspace-button">定位原文页</button></form>
      {hits.length > 0 && <details open><summary>匹配的物理页（最多展示 100 页）</summary>{hits.map(hit => <button className="disclosure-hit workspace-button" key={hit.page_number} onClick={() => setPage(hit.page_number)}><strong>第 {hit.page_number} 页</strong><span>{hit.snippet}</span></button>)}</details>}
      <PdfReader key={detail.id} label="原始披露" url={detail.pdf_url} page={page} onPageChange={setPage}
        pageControls={<label className="pdf-page-jump disclosure-page-jump"><input aria-label="跳转原始披露物理页" type="number" min={1} max={detail.pages} value={page}
          onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= detail.pages) setPage(value) }} /><span>/ {detail.pages}</span></label>}
        actions={onDescribe || onDefineCondition ? <LibraryReadingActions context={`当前第 ${page} 页`} disabled={!detail.document_id || detail.id !== selected} onResearch={onDescribe ? () => onDescribe({ source_document_id: detail.document_id, source_page: page, title: detail.metadata.title }) : undefined} onScreening={onDefineCondition ? () => onDefineCondition({ source_document_id: detail.document_id, source_page: page, title: detail.metadata.title }) : undefined} /> : undefined} />
      <details><summary>第 {page} 页文字与定位</summary><pre className="disclosure-page-text">{pageText?.text || '本页暂无可提取文字，请查看 PDF 原文。'}</pre>{pageText?.next_offset != null && <button className="text-button workspace-button" onClick={() => void moreText()}>继续读取本页文字</button>}<small>版本 {detail.id} · 内容校验 {detail.sha256}</small></details>
      {detail.related.length > 0 && <details open><summary>相关原文与更正材料</summary>{detail.related.map(item => <button key={item.id} className="disclosure-row workspace-button" onClick={() => { setSelected(item.id); setEditing(null) }}>{item.metadata.title} · {types[item.metadata.document_type]} · 第 {item.version} 版{item.relationship_needs_review ? ' · 分类已变更，关联待复核' : ''}</button>)}</details>}
      {!!detail.sources?.length && <details><summary>原文导入来源记录</summary>{detail.sources.map(source => <p key={source.import_id}>{source.source_url ? <a href={source.source_url} target="_blank" rel="noreferrer">官方原文链接</a> : `上传：${source.filename}`} · {source.created_at}</p>)}</details>}
      <details><summary>分类修改记录</summary>{detail.metadata_history.map(item => <p key={item.revision}>分类第 {item.revision} 版 · {item.created_at} · {item.metadata.stock_code || '公司待核对'} · {item.metadata.report_period || '报告期待核对'} · {types[item.metadata.document_type]} · {forms[item.metadata.document_form]}</p>)}</details>
    </section>}
  </section>
}
