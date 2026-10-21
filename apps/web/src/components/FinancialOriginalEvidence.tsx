import { lazy, Suspense, useRef, useState } from 'react'
import { api } from '../api'
import { useRemoteResource } from '../useRemoteResource'

const PdfReader = lazy(() => import('./PdfReader'))
type Calculation = { calculation_id: string; request: { stock_code: string; as_of: string; start_year: number; basis: string; mode: string; metrics: string[] } }
type Link = { id: string; current_status: string; status: string; page_number: number | null; quote?: string; normalized_value?: string; difference?: string; tolerance?: string; document: { id: string; metadata: { title: string } } }
type Version = { id: string; pages: number; metadata: { title: string; revision: number } }
const statuses: Record<string, string> = { document_related: '仅关联文档', value_verified: '数值已核对', conflict: '数值冲突', classification_changed: '分类已变化，需复核', superseded_check: '旧核对记录', superseded_document: '旧披露版本的核对记录' }

export default function FinancialOriginalEvidence({ factId, record, calculation, metric, period, writable }: {
  factId: string; record: { report_period: string; scope: string }; calculation: Calculation; metric: string; period: string; writable: boolean
}) {
  const base = '/financial-facts/' + factId + '/original-evidence'
  const links = useRemoteResource<{ items: Link[] }>(base + '?' + new URLSearchParams({ as_of: calculation.request.as_of, mode: calculation.request.mode }))
  const versions = useRemoteResource<{ items: Version[] }>('/disclosures?' + new URLSearchParams({
    stock_code: calculation.request.stock_code, report_period: record.report_period, as_of: calculation.request.as_of, limit: '50',
    ...(calculation.request.mode === 'as_of' ? { observed_by: calculation.request.as_of } : {}),
  }))
  const [versionId, setVersion] = useState(''), [page, setPage] = useState(1), [offset, setOffset] = useState(0)
  const [quote, setQuote] = useState(''), [hint, setHint] = useState<number | null>(null), [value, setValue] = useState(''), [unit, setUnit] = useState('元')
  const [column, setColumn] = useState(''), [confirmed, setConfirmed] = useState(false), [pdfOpen, setPdfOpen] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [proof, setProof] = useState<{ id: string; title: string; citation_url: string } | null>(null)
  const original = useRef<HTMLPreElement>(null)
  const attempt = useRef<{ key: string; id: string } | null>(null)
  const version = versions.data?.items.find(item => item.id === versionId)
  const chunk = useRemoteResource<{ text: string; char_start: number; next_offset: number | null }>(version ? '/disclosures/versions/' + versionId + '/pages/' + page + '?' + new URLSearchParams({ as_of: calculation.request.as_of, offset: String(offset) }) : null)
  const pdfUrl = '/api/v1/disclosures/versions/' + versionId + '/pdf?as_of=' + calculation.request.as_of
  function takeQuote() {
    const selection = window.getSelection()
    if (!selection?.rangeCount || !original.current?.contains(selection.anchorNode) || !original.current.contains(selection.focusNode)) { setError('请在本页原文中选中摘录。'); return }
    const before = selection.getRangeAt(0).cloneRange()
    before.selectNodeContents(original.current); before.setEnd(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset)
    const selected = selection.toString(), leading = Array.from(selected.match(/^\s*/)?.[0] || '').length
    setQuote(selected.trim()); setHint((chunk.data?.char_start || 0) + Array.from(before.toString()).length + leading); setError('')
  }
  async function saveLink() {
    if (!version) return
    setBusy(true); setError(''); setNotice('')
    try {
      const payload = {
        version_id: versionId, metadata_revision: version.metadata.revision, as_of: calculation.request.as_of,
        page_number: page, quote, start_hint: hint, reported_value: confirmed ? value : null, reported_unit: unit,
        report_period: record.report_period, scope: ['consolidated', 'parent'].includes(record.scope) ? record.scope : 'unknown', currency: 'CNY', column_note: column, manually_confirmed: confirmed,
      }
      const key = JSON.stringify(payload)
      if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() }
      const result = await api<Link>(base, { method: 'POST', body: JSON.stringify({ ...payload, request_id: attempt.current.id }) })
      attempt.current = null
      setNotice(statuses[result.status] || result.status); links.retry()
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  async function cite() {
    setBusy(true); setError('')
    try {
      const saved = await api<{ id: string; title: string; citation_url: string }>('/research-evidence/financial', { method: 'POST',
        body: JSON.stringify({ query: calculation.request, expected_id: calculation.calculation_id, metric, period }) })
      setProof(saved)
    } catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="financial-original" aria-label="原文关联与独立数字依据">
    <h4>原文关联与独立数字依据</h4>
    <p>关联公司与报告期只表示找到相关文档；已核对的数值保留单元格、单位、合并范围和精度容差。</p>
    {links.error && <p role="alert">{links.error}<button type="button" className="text-button workspace-button" onClick={links.retry}>重读原文关联</button></p>}
    {links.data?.items.map(link => <article key={link.id}><strong>{statuses[link.current_status] || link.current_status} · {link.document.metadata.title}</strong>
      <p>物理页 {link.page_number || '未指定'}{link.normalized_value !== undefined ? ' · 标准值 ' + link.normalized_value + ' · 差异 ' + link.difference + ' · 容差 ' + link.tolerance : ''}</p>
      {link.quote && <blockquote>{link.quote}</blockquote>}
      <a href={'/api/v1/disclosures/versions/' + link.document.id + '/pdf?as_of=' + calculation.request.as_of + '#page=' + (link.page_number || 1)} target="_blank" rel="noopener noreferrer">查看关联原件</a>
    </article>)}
    {!links.loading && !links.data?.items.length && !links.error && <p>此输入事实尚无已保存的原文关联。</p>}
    {!!versions.data?.items.length && <details><summary>同公司同报告期相关披露（仅文档匹配）</summary>{versions.data.items.map(item => <p key={item.id}><a href={'/api/v1/disclosures/versions/' + item.id + '/pdf?as_of=' + calculation.request.as_of} target="_blank" rel="noopener noreferrer">{item.metadata.title} · 打开全文，数值尚待定位核对</a></p>)}</details>}
    {writable && <>
      <button type="button" className="secondary-button workspace-button" disabled={busy} onClick={() => void cite()}>保存独立数字依据</button>
      {proof && <div><a href={proof.citation_url} target="_blank" rel="noopener noreferrer">打开独立数字依据</a>
        <label>数字依据标识<input aria-label="数字依据标识" readOnly value={proof.id} /></label>
        <label>数字引用链接<input aria-label="数字引用链接" readOnly value={'[' + proof.title + '](' + proof.citation_url + ')'} /></label></div>}
      <details><summary>关联或核对本输入的原文</summary>
        {versions.error && <p role="alert">{versions.error}<button type="button" className="text-button workspace-button" onClick={versions.retry}>重新查找原文</button></p>}
        <label>对应报告期原文<select aria-label="对应报告期原文" value={versionId} onChange={event => { setVersion(event.target.value); setPage(1); setOffset(0); setQuote(''); setHint(null); setConfirmed(false); setPdfOpen(false) }}>
          <option value="">选择已确认的原始披露</option>{versions.data?.items.map(item => <option key={item.id} value={item.id}>{item.metadata.title}</option>)}</select></label>
        {!versions.loading && !versions.data?.items.length && !versions.error && <p>请先在原始披露中归档并确认该公司、报告期与披露日期。</p>}
        {version && <>
          <label>PDF 物理页<input aria-label="核对物理页" type="number" min={1} max={version.pages} value={page} onChange={event => { const next = Number(event.target.value); if (next >= 1 && next <= version.pages) { setPage(next); setOffset(0); setHint(null); setQuote(''); setConfirmed(false) } }} /></label>
          {chunk.error ? <p role="alert">{chunk.error}<button type="button" onClick={chunk.retry}>重读本页</button></p> : chunk.data ? <><pre ref={original} className="financial-original-text">{chunk.data.text}</pre><button type="button" className="text-button workspace-button" onClick={takeQuote}>采用选中原文</button>
            {chunk.data.next_offset !== null && <button type="button" onClick={() => setOffset(chunk.data!.next_offset!)}>继续读取本页</button>}{offset > 0 && <button type="button" onClick={() => setOffset(0)}>回到本页开头</button>}</> : <p>正在读取原文页…</p>}
          <details onToggle={event => setPdfOpen(event.currentTarget.open)}><summary>核对 PDF 原页</summary>{pdfOpen && <Suspense fallback={<p>正在打开原页…</p>}><PdfReader label="原始披露" url={pdfUrl} page={page} onPageChange={value => { setPage(value); setOffset(0); setQuote(''); setHint(null); setConfirmed(false) }} /></Suspense>}</details>
          <label>原文摘录<textarea aria-label="数值核对原文" maxLength={3000} value={quote} onChange={event => { setQuote(event.target.value); setHint(null) }} /></label>
          <label className="financial-original-confirm"><input aria-label="已核对期间列单位币种与合并范围" type="checkbox" disabled={!['consolidated', 'parent'].includes(record.scope)} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已人工核对 {record.report_period} 的期间列、单位、CNY 币种和 {record.scope === 'consolidated' ? '合并' : record.scope} 范围</label>
          {confirmed && <><label>原文单元格数值<input aria-label="原文单元格数值" value={value} onChange={event => setValue(event.target.value)} placeholder="保留原文小数位和正负号" /></label>
            <label>原文单位<select aria-label="原文单位" value={unit} onChange={event => setUnit(event.target.value)}>{['元', '千元', '万元', '亿元', '%', '倍'].map(item => <option key={item}>{item}</option>)}</select></label>
            <label>期间列与口径说明<input aria-label="期间列与口径说明" value={column} maxLength={500} onChange={event => setColumn(event.target.value)} placeholder="说明选取的本期/比较期列及合并范围" /></label></>}
          <button type="button" className="secondary-button workspace-button" disabled={busy || chunk.loading || !!chunk.error || confirmed && (!value || !quote.trim() || !column.trim())} onClick={() => void saveLink()}>{confirmed ? '保存数值核对' : '保存文档关联'}</button>
        </>}
      </details>
    </>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="workspace-error">{error}</p>}
  </section>
}
