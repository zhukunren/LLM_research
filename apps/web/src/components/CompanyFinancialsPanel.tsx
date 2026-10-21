import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import './company-financials.css'
import FinancialOriginalEvidence from './FinancialOriginalEvidence'

const Chart = lazy(() => import('echarts-for-react'))
type Point = {
  metric: string; period: string; value: string | null; unit: string; currency: string | null; status: string; reason: string
  actual_basis?: string; formula: string | null; input_fact_ids: string[]; source_record_ids: string[]
  comparability?: string; absolute_change?: string; change_classification?: string
  dependencies?: { metric: string; period: string; status: string; reason?: string }[]
}
type Result = {
  calculation_id: string; saved?: boolean; request: { stock_code: string; as_of: string; start_year: number; basis: string; mode: string; metrics: string[] }
  formula_version: string; metrics: { code: string; label: string; unit: string }[]
  rows: { period: string; values: Record<string, Point>; checks: { check: string; status: string; difference: string | null; reason: string }[] }[]
  coverage: { periods: number; cells: number; statuses: Record<string, number> }; notes: string[]
}
type Sync = {
  id: string; job_id: string; state: string; message: string; credential_matches: boolean
  summary: { planned: number; finished: number; source_versions: number; states: Record<string, number> }
}
type Status = {
  companies: { code: string; name: string; category: string }[]; can_sync: boolean; can_save: boolean
  latest: Sync | null; coverage: { stock_code: string; periods: number; source_versions: number; facts: number }[]
}
type Evidence = {
  fact: { value: string | null; raw_value: string | null; unit: string; raw_unit: string; source_field: string; currency: string | null; status: string }
  record: { family: string; report_period: string; report_type: string; scope: string; public_date: string | null; first_observed_at: string }
  observations: unknown[]; pilot_observations: unknown[]; note: string
}
const basisNames: Record<string, string> = { annual: '年度', cumulative: '本年累计', quarter: '单季', ttm: 'TTM', period_end: '期末余额', period_start: '现金流表期初', reported_ratio: '供应商原始比率' }
const changeNames: Record<string, string> = { turnaround: '扭亏或转为非负', turned_loss: '转亏', loss_narrowed: '亏损收窄', loss_widened: '亏损扩大', increase: '增加', decrease: '减少', unchanged: '不变' }
const formulaNames: Record<string, string> = {
  reported: '原始披露期间的供应商值', 'current_ytd - previous_same_year_ytd': '本年累计 − 同年上期累计',
  'previous_annual + current_ytd - previous_same_period_ytd': '上年全年 + 本年累计 − 上年同期累计',
}
function today() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const value = (name: string) => parts.find(part => part.type === name)?.value || ''
  return `${value('year')}-${value('month')}-${value('day')}`
}
function display(point: Point) {
  if (point.value === null) return '—'
  const value = Number(point.value) / (point.unit === '元' ? 1e8 : 1)
  return Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) : '数值超出显示范围'
}

export default function CompanyFinancialsPanel({ stockCode, asOf, writable = true, allowSync = false }: { stockCode?: string; asOf?: string; writable?: boolean; allowSync?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null), [catalog, setCatalog] = useState<Result['metrics']>([])
  const [code, setCode] = useState(stockCode || '600519.SH'), [cutoff, setCutoff] = useState(asOf || today())
  const [basis, setBasis] = useState('annual'), [mode, setMode] = useState('as_of'), [metric, setMetric] = useState('revenue')
  const [revision, setRevision] = useState(0), [syncRevision, setSyncRevision] = useState(0)
  const [loaded, setResult] = useState<Result | null>(null), [error, setError] = useState(''), [syncError, setSyncError] = useState('')
  const [selected, setSelected] = useState<Point | null>(null), [factId, setFactId] = useState(''), [evidence, setEvidence] = useState<Evidence | null>(null)
  const [saving, setSaving] = useState(false), [submitting, setSubmitting] = useState(false), [savedId, setSavedId] = useState('')
  const targetCode = stockCode || code, targetCutoff = asOf || cutoff
  const key = `${targetCode}|${targetCutoff}|${basis}|${mode}|${metric}`, currentKey = useRef(key)
  const result = loaded && loaded.request.stock_code === targetCode && loaded.request.as_of === targetCutoff && loaded.request.basis === basis && loaded.request.mode === mode && loaded.request.metrics[0] === metric ? loaded : null
  currentKey.current = key
  const lastFinished = useRef('')
  const observedActive = useRef(false)
  const [statusLoaded, setStatusLoaded] = useState(false)
  const active = !!status?.latest && ['queued', 'running'].includes(status.latest.state)
  useEffect(() => { if (stockCode) setCode(stockCode) }, [stockCode])
  useEffect(() => { if (asOf) setCutoff(asOf) }, [asOf])
  useEffect(() => {
    const controller = new AbortController()
    api<{ items: Result['metrics'] }>('/financial-data/metrics', { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setCatalog(value.items) })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function load() {
      try {
        const value = await api<Status>('/financial-data/series-status', { signal: controller.signal })
        if (controller.signal.aborted) return
        setStatus(value); setSyncError('')
        if (value.latest && ['queued', 'running'].includes(value.latest.state)) { observedActive.current = true; timer = setTimeout(() => void load(), 2000) }
        else if (value.latest && lastFinished.current !== value.latest.id) {
          if (observedActive.current || lastFinished.current) setRevision(v => v + 1)
          observedActive.current = false; lastFinished.current = value.latest.id
        }
      } catch (reason) { if (!controller.signal.aborted) setSyncError((reason as Error).message) }
      finally { if (!controller.signal.aborted) setStatusLoaded(true) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [syncRevision])
  useEffect(() => {
    const controller = new AbortController()
    setResult(null); setSelected(null); setFactId(''); setEvidence(null); setSavedId(''); setError('')
    if (!statusLoaded || !targetCutoff || !targetCode) return
    const params = new URLSearchParams({ as_of: targetCutoff, start_year: String(Number(targetCutoff.slice(0, 4)) - 5), basis, mode, metrics: metric })
    api<Result>(`/companies/${targetCode}/financials?${params}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setResult(value) })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [key, revision, statusLoaded])
  useEffect(() => {
    const controller = new AbortController()
    setEvidence(null)
    if (factId) api<Evidence>(`/financial-facts/${factId}/provenance`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setEvidence(value) })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [factId])
  async function sync(retry = false) {
    setSubmitting(true); setSyncError('')
    try {
      if (retry && status?.latest) await api(`/maintenance/financial-sync/${status.latest.id}/retry`, { method: 'POST' })
      else await api('/maintenance/financial-sync', { method: 'POST', body: JSON.stringify({ request_id: crypto.randomUUID(), as_of: today() }) })
      setSyncRevision(v => v + 1)
    } catch (reason) { setSyncError((reason as Error).message) }
    finally { setSubmitting(false) }
  }
  async function cancel() {
    if (!status?.latest) return
    try { await api(`/jobs/${status.latest.job_id}/cancel`, { method: 'POST' }); setSyncRevision(v => v + 1) }
    catch (reason) { setSyncError((reason as Error).message) }
  }
  async function save() {
    if (!result) return
    const expectedKey = currentKey.current
    setSaving(true); setError('')
    try {
      const saved = await api<Result>(`/financial-data/calculations?expected_id=${result.calculation_id}`, { method: 'POST', body: JSON.stringify(result.request) })
      if (expectedKey === currentKey.current) setSavedId(saved.calculation_id)
    } catch (reason) { if (expectedKey === currentKey.current) setError((reason as Error).message) }
    finally { setSaving(false) }
  }
  const unit = (result?.metrics[0]?.unit || catalog.find(item => item.code === metric)?.unit) === '元' ? '亿元' : result?.metrics[0]?.unit || ''
  const points = result?.rows.map(row => row.values[metric]) || []
  const available = points.some(point => point.value !== null)
  const label = result?.metrics[0]?.label || catalog.find(item => item.code === metric)?.label || '财务指标'
  return <section className="company-financials" aria-label="标准财务与指标计算">
    <h3>标准财务与指标计算</h3>
    {allowSync && <div className="financial-acquisition">
      <p>普通接口采集 10 家试点公司的最近五个完整年度及当年数据，并补取比较基期。</p>
      {status?.can_sync && writable && <div className="financial-series-actions"><button className="secondary-button workspace-button" disabled={active || submitting} onClick={() => void sync()}>更新十家公司财务</button>
        {active && <button className="text-button workspace-button" onClick={() => void cancel()}>停止财务采集</button>}
        {status.latest && ['partial', 'failed', 'cancelled'].includes(status.latest.state) && <button className="text-button workspace-button" disabled={submitting} onClick={() => void sync(true)}>继续未完成分片</button>}</div>}
      {status?.latest && <p role="status">{status.latest.message} · 已处理 {status.latest.summary.finished}/{status.latest.summary.planned} 个分片{!status.latest.credential_matches ? ' · 凭据已变化，历史采集不证明当前权限' : ''}</p>}
      {syncError && <p role="alert" className="workspace-error">{syncError}<button className="text-button workspace-button" onClick={() => setSyncRevision(v => v + 1)}>重试读取采集状态</button></p>}
    </div>}
    <div className="financial-series-controls">
      {!stockCode && <label>财务公司<select aria-label="财务公司" value={code} onChange={e => setCode(e.target.value)}>{(status?.companies || [{ code: '600519.SH', name: '贵州茅台' }]).map(company => <option key={company.code} value={company.code}>{company.name} · {company.code}</option>)}</select></label>}
      {!asOf && <label>财务截止日<input type="date" value={cutoff} onChange={e => setCutoff(e.target.value)} /></label>}
      <label>财务期间口径<select aria-label="财务期间口径" value={basis} onChange={e => setBasis(e.target.value)}>{['annual', 'cumulative', 'quarter', 'ttm'].map(value => <option key={value} value={value}>{basisNames[value]}</option>)}</select></label>
      <label>数据版本口径<select aria-label="数据版本口径" value={mode} onChange={e => setMode(e.target.value)}><option value="as_of">当时可验证口径</option><option value="latest">最新修订口径</option></select></label>
      <label>财务指标<select aria-label="财务指标" value={metric} onChange={e => setMetric(e.target.value)}>{(catalog.length ? catalog : [{ code: 'revenue', label: '营业收入', unit: '元' }]).map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
    </div>
    <p className="research-secondary">截至 {targetCutoff} · 合并报表优先。{mode === 'as_of' ? '仅使用截止日前已观察到的版本；今天补采的旧财报不会被当作过去已取得的证据。' : '按公告日期过滤当前取得的版本，可能包含后来修订，不代表历史当时可得。'}</p>
    {error && <p role="alert" className="workspace-error">{error}<button className="text-button workspace-button" onClick={() => setRevision(v => v + 1)}>重新读取财务</button></p>}
    {!result ? <p>{error ? '财务序列尚未读取成功。' : '正在读取财务序列…'}</p> : <>
      <div className="financial-series-actions"><strong>{label} · {unit}</strong><span>{points.filter(p => p.status === 'ok').length}/{points.length} 期有可用结果</span>
        {writable && status?.can_save && <button className="secondary-button workspace-button" disabled={saving || !available || savedId === result.calculation_id} onClick={() => void save()}>{savedId === result.calculation_id ? '本次计算已保存' : saving ? '正在保存…' : '保存本次计算'}</button>}</div>
      {available && <Suspense fallback={<p>正在绘制财务序列…</p>}><Chart style={{ height: 230 }} notMerge option={{
        animation: false, grid: { left: 65, right: 20, top: 25, bottom: 40 },
        tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: result.rows.map(row => row.period) },
        yAxis: { type: 'value', name: unit, scale: true },
        series: [{ name: label, type: 'line', connectNulls: false, data: points.map(point => point.value === null ? null : Number(point.value) / (point.unit === '元' ? 1e8 : 1)) }],
      }} /></Suspense>}
      <div className="financial-series-table"><table><thead><tr><th>报告期</th><th>{label}（{unit}）</th><th>实际口径</th><th>状态与依据</th></tr></thead><tbody>
        {[...result.rows].reverse().map(row => { const point = row.values[metric]; return <tr key={row.period}><td>{row.period}</td><td title={point.value === null ? point.reason : `${point.value} ${point.unit}`}>{display(point)}</td><td>{basisNames[point.actual_basis || ''] || '—'}</td><td>
          <span>{point.reason}{point.comparability && point.comparability !== 'provider_same_scope' ? ' · 重述口径待复核' : ''}</span>
          {point.change_classification && <span> · {changeNames[point.change_classification]}</span>}
          <button className="text-button workspace-button" onClick={() => { setSelected(point); setFactId(point.input_fact_ids[0] || '') }}>查看计算依据</button>
          {row.checks.some(check => check.status === 'mismatch') && <details><summary>勾稽差异待核对</summary>{row.checks.filter(c => c.status === 'mismatch').map(c => <p key={c.check}>{c.reason} · 差异 {c.difference} 元</p>)}</details>}
        </td></tr> })}
      </tbody></table></div>
      {!available && <p>当前范围没有可用数值，缺口原因已逐期列出；未补零或沿用其他报告期。</p>}
      {selected && <aside className="financial-series-evidence" aria-label="财务计算依据">
        <div className="financial-series-actions"><strong>{selected.period} · {label}</strong><button className="text-button workspace-button" onClick={() => { setSelected(null); setFactId('') }}>关闭依据</button></div>
        <p>{selected.reason} · 公式：{formulaNames[selected.formula || ''] || selected.formula || '未执行计算'}</p>
        {selected.absolute_change !== undefined && <p>绝对变化：{selected.absolute_change} 元</p>}
        {selected.dependencies?.map((dependency, index) => <p key={index}>{dependency.period} · {catalog.find(item => item.code === dependency.metric)?.label || dependency.metric} · {dependency.reason || dependency.status}</p>)}
        {!!selected.input_fact_ids.length && <label>核对输入来源<select aria-label="核对输入来源" value={factId} onChange={e => setFactId(e.target.value)}>{selected.input_fact_ids.map((id, index) => <option key={id} value={id}>输入来源 {index + 1} · {id.slice(0, 8)}</option>)}</select></label>}
        {evidence && <><p>{evidence.record.family} · {evidence.record.report_period} · {evidence.fact.source_field}</p>
          <p>源值 {evidence.fact.raw_value ?? '空值'} {evidence.fact.raw_unit} → 标准值 {evidence.fact.value ?? '空值'} {evidence.fact.unit} · {evidence.fact.currency || '无币种'}</p>
          <p>公告日期 {evidence.record.public_date || '未知'} · 首次观察 {evidence.record.first_observed_at}</p>
          <p>报表类型 {evidence.record.report_type || '供应商指标'} · {evidence.record.scope}</p><p>{evidence.note}</p></>}
        {evidence && result && <FinancialOriginalEvidence key={factId + result.calculation_id} factId={factId} record={evidence.record} calculation={result} metric={metric} period={selected.period} writable={writable && !!status?.can_save} />}
      </aside>}
      <details><summary>计算口径与局限</summary>{result.notes.map(note => <p key={note}>{note}</p>)}<p>公式版本 {result.formula_version} · 计算标识 {result.calculation_id}</p></details>
    </>}
  </section>
}
