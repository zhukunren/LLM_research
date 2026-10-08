import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, LoaderCircle, RefreshCw, Square } from 'lucide-react'
import { api } from '../../api'
import type { ResearchFile } from '../../research'
import ResearchFileList, { isOriginalFormatOnlyDiscovery, reportPending } from '../ResearchFileList'
import GeneratedFiles, { type GeneratedFile } from '../GeneratedFiles'

type Coverage = { target_total: number; true_count?: number; false_count?: number; unknown_count?: number; failed_count?: number; not_evaluated_count?: number }
type ScanSummary = {
  id: string; name: string; as_of: string; status: string; progress: number; message: string
  coverage: Coverage; export_url: string
}
type Scan = {
  id: string; status: string; as_of: string; execution_mode: string; export_url: string
  result: { coverage: Coverage; error?: string | null; result_valid: boolean; effective_market_date?: string }
  job: { progress: number; message: string }
}
type Decision = { stock_code: string; state: string; evaluation_status: string; explanation: string; metrics: Record<string, unknown>; units: Record<string, string> }
type Output = ResearchFile

const labels: Record<string, string> = { queued: '排队中', running: '计算中', succeeded: '已完成', partial: '部分结果', failed: '失败', cancelled: '已停止', true: '满足实验判据', false: '未满足实验判据', unknown: '未知' }
const pending = (status: string) => ['queued', 'running'].includes(status)
const PAGE_SIZE = 20

function metricText(item: Decision) {
  return Object.entries(item.metrics).map(([name, value]) => `${name}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}${item.units[name] || ''}`).join('; ')
}

export default function ResearchPanel({ conversationId, turnActive, refreshKey, showGenerate = false, onContentChange }: { conversationId: string; turnActive: boolean; refreshKey: number; showGenerate?: boolean; onContentChange?: (hasContent: boolean) => void }) {
  const [scans, setScans] = useState<ScanSummary[]>([])
  const [outputs, setOutputs] = useState<Output[]>([])
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedFile[]>([])
  const [generatedError, setGeneratedError] = useState('')
  const [selected, setSelected] = useState('')
  const [scan, setScan] = useState<Scan | null>(null)
  const [items, setItems] = useState<Decision[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [state, setState] = useState('')
  const [query, setQuery] = useState('')
  const [reload, setReload] = useState(0)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [loading, setLoading] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [reportBusy, setReportBusy] = useState('')
  const [reportNotice, setReportNotice] = useState('')
  const scansActive = scans.some(item => pending(item.status))
  const reportsActive = outputs.some(item => reportPending(item.status))

  useEffect(() => {
    onContentChange?.(showGenerate || !!scans.length || !!outputs.length || !!generatedFiles.length || !!error || !!generatedError)
  }, [showGenerate, scans.length, outputs.length, generatedFiles.length, error, generatedError, onContentChange])

  useEffect(() => {
    setScans([]); setOutputs([]); setGeneratedFiles([]); setSelected(''); setError(''); setGeneratedError('')
  }, [conversationId])

  useEffect(() => {
    if (!conversationId) return
    let active = true
    let reading = false
    const load = async () => {
      if (!active || reading) return
      reading = true
      try {
        const [nextScans, nextOutputs, nextGenerated] = await Promise.allSettled([
          api<{ items: ScanSummary[] }>(`/conversations/${conversationId}/research-scans`),
          api<{ items: Output[] }>(`/conversations/${conversationId}/research-files`),
          api<{ items: GeneratedFile[] }>(`/conversations/${conversationId}/generated-files`),
        ])
        if (active) {
          if (nextScans.status === 'fulfilled') {
            setScans(nextScans.value.items)
            setSelected(current => nextScans.value.items.some(item => item.id === current) ? current : nextScans.value.items[0]?.id || '')
          }
          if (nextOutputs.status === 'fulfilled') setOutputs(nextOutputs.value.items.filter(file => !isOriginalFormatOnlyDiscovery(file)))
          const failed = [nextScans, nextOutputs].find(result => result.status === 'rejected')
          setError(failed?.status === 'rejected' ? String(failed.reason?.message || '部分研究成果暂时无法读取') : '')
          if (nextGenerated.status === 'fulfilled' && Array.isArray(nextGenerated.value.items)) {
            setGeneratedFiles(nextGenerated.value.items); setGeneratedError('')
          } else setGeneratedError('生成文件暂时无法读取，请刷新重试。')
        }
      } catch (reason) { if (active) setError((reason as Error).message) }
      finally { reading = false }
    }
    void load()
    const timer = turnActive || scansActive || reportsActive ? globalThis.setInterval(() => { void load() }, 1500) : undefined
    return () => { active = false; globalThis.clearInterval(timer) }
  }, [conversationId, turnActive, scansActive, reportsActive, refreshKey, reload])

  useEffect(() => {
    setOffset(0); setState(''); setQuery(''); setScan(null); setItems([]); setDetailError('')
  }, [selected])

  const selectedStatus = scans.find(item => item.id === selected)?.status
  useEffect(() => {
    if (!selected || !conversationId) return
    let active = true
    let reading = false
    let completed = false
    let timer: ReturnType<typeof setInterval> | undefined
    setLoading(true)
    setItems([])
    setDetailError('')
    const load = async () => {
      if (!active || reading || completed) return
      reading = true
      try {
        const params = new URLSearchParams({ state, query, offset: String(offset), limit: String(PAGE_SIZE) })
        const [next, decisions] = await Promise.all([
          api<Scan>(`/conversations/${conversationId}/research-scans/${selected}`),
          api<{ items: Decision[]; total: number }>(`/conversations/${conversationId}/research-scans/${selected}/decisions?${params}`),
        ])
        if (active) {
          setScan(next); setItems(decisions.items); setTotal(decisions.total); setDetailError('')
          completed = !pending(next.status)
          if (completed) globalThis.clearInterval(timer)
        }
      } catch (reason) { if (active) setDetailError((reason as Error).message) }
      finally { reading = false; if (active) setLoading(false) }
    }
    const debounce = globalThis.setTimeout(() => { void load() }, 150)
    timer = globalThis.setInterval(() => { void load() }, 1500)
    return () => { active = false; globalThis.clearTimeout(debounce); globalThis.clearInterval(timer) }
  }, [conversationId, selected, selectedStatus, offset, state, query, reload])

  async function cancel() {
    if (!scan) return
    setCancelling(true)
    try {
      await api(`/conversations/${conversationId}/research-scans/${scan.id}/cancel`, { method: 'POST' })
      setReload(value => value + 1)
    } catch (reason) { setDetailError((reason as Error).message) }
    finally { setCancelling(false) }
  }

  async function generateReports(file?: ResearchFile) {
    setReportBusy(file?.id || 'generate'); setError('')
    try {
      await api(file?.retry_url ? file.retry_url.replace(/^\/api\/v1/, '') : `/conversations/${conversationId}/research-pdf-jobs`, { method: 'POST', ...(file?.retry_url ? {} : { body: JSON.stringify({ request_id: crypto.randomUUID() }) }) })
      setReportNotice('报告已提交后台生成。')
      setReload(value => value + 1)
    } catch (reason) { setError((reason as Error).message) }
    finally { setReportBusy('') }
  }

  if (!showGenerate && !scans.length && !outputs.length && !generatedFiles.length && !error && !generatedError) return null
  const coverage = scan?.result.coverage
  return <section className="conversation-research-section" aria-label="研究计算与成果">
    <div className="conversation-panel-heading"><h2>研究计算与成果</h2><button className="icon-button" title="刷新研究成果" aria-label="刷新研究成果" onClick={() => setReload(value => value + 1)}><RefreshCw size={15} /></button></div>
    <button className="text-button" disabled={!!reportBusy || turnActive} onClick={() => void generateReports()}>{reportBusy === 'generate' ? '正在提交…' : '生成已有报告'}</button>
    {reportNotice && <p role="status" className="conversation-muted">{reportNotice}</p>}
    {error && <p role="alert">{error}</p>}
    {!!scans.length && <>
      <select className="research-scan-select" aria-label="查看研究扫描" value={selected} onChange={event => setSelected(event.target.value)}>
        {scans.map(item => <option key={item.id} value={item.id}>{item.name} · {item.as_of} · {labels[item.status] || item.status}</option>)}
      </select>
      {scan && <>
        <div className="research-scan-status"><span>{labels[scan.status] || scan.status} · 截至 {scan.as_of}</span>{pending(scan.status)
          ? <button className="icon-button" title="停止研究扫描" aria-label="停止研究扫描" disabled={cancelling} onClick={() => void cancel()}><Square size={14} /></button>
          : <a className="icon-button" href={scan.export_url} title="下载研究扫描 PDF" aria-label="下载研究扫描 PDF"><Download size={15} /></a>}</div>
        {pending(scan.status) && <progress aria-label="研究扫描进度" value={scan.job.progress} max={1} />}
        <p className="conversation-muted">{scan.job.message}</p>
        {coverage && <p className="research-coverage">目标 {coverage.target_total} · 满足实验判据 {coverage.true_count || 0} · 未满足实验判据 {coverage.false_count || 0} · 未知 {coverage.unknown_count || 0} · 失败 {coverage.failed_count || 0} · 未处理 {coverage.not_evaluated_count || 0}</p>}
        {scan.result.error && <p role="alert" className="research-scan-error">{scan.result.error}</p>}
        {['failed', 'cancelled'].includes(scan.status) && items.length > 0 && <p className="research-scan-error">以下为中断前记录，未完成本次范围验证。</p>}
      </>}
      <div className="research-decision-filters"><select aria-label="研究结果状态" value={state} onChange={event => { setState(event.target.value); setOffset(0) }}><option value="">全部状态</option>{['true', 'false', 'unknown'].map(value => <option value={value} key={value}>{labels[value]}</option>)}</select><input aria-label="搜索研究证券" placeholder="证券代码" value={query} maxLength={32} onChange={event => { setQuery(event.target.value); setOffset(0) }} /></div>
      {detailError && <p role="alert">{detailError}</p>}
      {loading ? <p className="conversation-muted"><LoaderCircle size={14} className="spin" />正在读取研究结果</p> : <>
        <div className="research-decision-table"><table><thead><tr><th>证券</th><th>状态</th><th>指标与依据</th></tr></thead><tbody>{items.map(item => <tr key={item.stock_code}><td>{item.stock_code}</td><td>{labels[item.state] || item.state}</td><td>{metricText(item) && <div>{metricText(item)}</div>}<span>{item.explanation}</span></td></tr>)}</tbody></table></div>
        {!items.length && <p className="conversation-muted">暂无已提交记录</p>}
        <div className="research-pagination"><span>{total ? `${offset + 1}-${Math.min(offset + PAGE_SIZE, total)} / ${total}` : '0 / 0'}</span><button className="icon-button" title="上一页研究结果" aria-label="上一页研究结果" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}><ChevronLeft size={16} /></button><button className="icon-button" title="下一页研究结果" aria-label="下一页研究结果" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(value => value + PAGE_SIZE)}><ChevronRight size={16} /></button></div>
      </>}
    </>}
    {!!outputs.length && <section aria-label="PDF 报告"><h3>PDF 报告</h3><ResearchFileList files={outputs} busyId={reportBusy} onRetry={file => void generateReports(file)} /></section>}
    {generatedError && <p role="alert">{generatedError}</p>}
    <GeneratedFiles files={generatedFiles} />
  </section>
}
